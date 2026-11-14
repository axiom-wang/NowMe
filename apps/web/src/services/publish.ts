/**
 * 发布、撤下、恢复旧版本、公开链接（W10、W11、W12、W15，contracts 3、4.2）。
 * 调用方（路由）负责确认请求者是页面主人（`findOwnPage`）；这里只处理这一页自己的数据。
 *
 * 发布确认（`POST /w/:wallId/me/publish`，也用于“恢复旧版本”）：
 * - 版本必须属于这一页、通过校验、没有被删除；
 * - 表单字段：`revisionId`、`displayName`、`tagline`、`hooks[i][id|text|opener|remove]`（i < 3）、
 *   `contactChannel`、`contactValue`、`contactPublic=1`、`confirm=1`；
 * - 接话点只能来自这个版本的 card.json（按 id），主人可以改写文字与开场白或删掉，保留 2–3 个；
 *   长度按 contracts 1.2（码点）检查；**存进发布记录的只有主人确认后的内容**；
 * - 旧的活跃发布以 `superseded` 结束，新建发布；`contact_json` 只在公开时存快照；同时更新页面的联系方式
 *   （下次预填“主人上次的选择”）；事件 `publish`。校验失败不改变任何状态，已发布的版本不受影响（W12）。
 *
 * 预填：缩略卡取这个版本上次发布时主人确认的内容（恢复旧版本不会让删掉的接话点重新出现），没有发布过则取 card.json；
 * 联系方式取主人上次的选择，从没选过时“公开联系方式”默认取场景指南的 `defaults.contactPublic`。
 * 恢复旧版本不改变公开链接的开关，也不会自动公开联系方式。
 */
import {
  CARD_LIMITS,
  cardSchema,
  codePointLength,
  generateId,
  generateToken,
  PAGE_SCHEMA_VERSION,
  REVISION_ID_PATTERN,
  type Card,
  type Hook,
  type SceneType,
} from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import type { AppDeps, FormFields } from '../context.js';
import { transaction } from '../db/index.js';
import {
  isContactChannel,
  parsePublishedCard,
  parsePublishedContact,
  type ContactChannel,
  type PageDisplayState,
  type Publication,
  type PublishedContact,
} from '../db/publications.js';
import type { Revision, RevisionListItem } from '../db/revisions.js';
import type { OwnPage } from './access.js';
import { isRevisionUsable } from './page-lifecycle.js';

/** [T3.2 暂定] 联系方式的最大长度（码点）。 */
export const CONTACT_VALUE_MAX = 64;
/** 公开链接的路径前缀：`/s/<pub_...>`。 */
export const PUBLIC_LINK_PATH_PREFIX = '/s/';

export function publicLinkUrl(webOrigin: string, publicToken: string): string {
  return `${webOrigin}${PUBLIC_LINK_PATH_PREFIX}${publicToken}`;
}

// ---------------------------------------------------------------------------
// 场景默认值
// ---------------------------------------------------------------------------

const contactPublicDefaults = new Map<SceneType, boolean>();

/** 场景指南 `defaults.contactPublic`（contracts 7）。 */
export function sceneContactPublicDefault(sceneType: SceneType): boolean {
  let value = contactPublicDefaults.get(sceneType);
  if (value === undefined) {
    value = loadSceneGuide(sceneType).defaults.contactPublic;
    contactPublicDefaults.set(sceneType, value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

export interface PublishHookInput {
  id: string;
  text: string;
  opener: string;
  remove: boolean;
}

export interface PublishFormValues {
  revisionId: string;
  displayName: string;
  tagline: string;
  hooks: PublishHookInput[];
  contactChannel: string;
  contactValue: string;
  contactPublic: boolean;
  confirm: boolean;
}

/**
 * 字段错误。键：`form`、`displayName`、`tagline`、`hooks`、`hooks.<i>.text`、`hooks.<i>.opener`、
 * `contactChannel`、`contactValue`、`confirm`（`<i>` 是表单中的行号）。
 */
export type PublishFormErrors = Partial<Record<string, string>>;

/** 解析发布确认表单（不做校验）。 */
export function readPublishForm(fields: FormFields): PublishFormValues {
  const hooks: PublishHookInput[] = [];
  for (let index = 0; index < CARD_LIMITS.hooks.max; index += 1) {
    const id = fields[`hooks[${index}][id]`];
    if (id === undefined) continue;
    hooks.push({
      id,
      text: fields[`hooks[${index}][text]`] ?? '',
      opener: fields[`hooks[${index}][opener]`] ?? '',
      remove: fields[`hooks[${index}][remove]`] === '1',
    });
  }
  return {
    revisionId: fields.revisionId ?? '',
    displayName: fields.displayName ?? '',
    tagline: fields.tagline ?? '',
    hooks,
    contactChannel: fields.contactChannel ?? '',
    contactValue: fields.contactValue ?? '',
    contactPublic: fields.contactPublic === '1',
    confirm: fields.confirm === '1',
  };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 去掉首尾空白；换行（多行输入框里的回车）换成一个空格。 */
export function normalizeLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function lengthProblem(label: string, value: string, min: number, max: number): string | null {
  if (CONTROL_CHARS.test(value)) return `${label}不能包含制表符等特殊字符。`;
  const length = codePointLength(value);
  if (length === 0) return `${label}不能为空。`;
  if (length < min) return `${label}至少 ${min} 个字，现在 ${length} 个。`;
  if (length > max) return `${label}最多 ${max} 个字，现在 ${length} 个，请精简一下。`;
  return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 -]{4,19}$/;
const QQ_PATTERN = /^[1-9][0-9]{4,11}$/;

function contactValueProblem(channel: ContactChannel, value: string): string | null {
  if (CONTROL_CHARS.test(value)) return '联系方式不能包含制表符等特殊字符。';
  const length = codePointLength(value);
  if (length > CONTACT_VALUE_MAX) return `联系方式最多 ${CONTACT_VALUE_MAX} 个字，现在 ${length} 个。`;
  if (channel === 'email' && !EMAIL_PATTERN.test(value)) return '邮箱格式不对，例如 name@example.com。';
  if (channel === 'phone' && !PHONE_PATTERN.test(value)) return '手机号格式不对：只填数字（可以带 + 与空格），例如 138 0000 0000。';
  if (channel === 'qq' && !QQ_PATTERN.test(value)) return 'QQ 号应为 5–12 位数字。';
  return null;
}

/** 主人确认的联系方式（存进 `pages`；公开时快照进 `publications.contact_json`）。 */
export interface ConfirmedContact {
  channel: ContactChannel;
  /** 空字符串存为 null。 */
  value: string | null;
  isPublic: boolean;
}

export type PublishCheck = { ok: true; card: Card; contact: ConfirmedContact } | { ok: false; errors: PublishFormErrors };

/** 版本 card.json（`revisions.card_json`）；格式不对返回 null。 */
export function revisionCard(revision: Pick<Revision | RevisionListItem, 'cardJson'>): Card | null {
  if (!revision.cardJson) return null;
  try {
    const result = cardSchema.safeParse(JSON.parse(revision.cardJson));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** 校验发布确认表单（W11、W12、W19：每个问题给出具体原因与改法）。 */
export function validatePublishForm(values: PublishFormValues, base: Card): PublishCheck {
  const errors: PublishFormErrors = {};

  const displayName = normalizeLine(values.displayName);
  const nameProblem = lengthProblem('名字', displayName, CARD_LIMITS.displayName.min, CARD_LIMITS.displayName.max);
  if (nameProblem) errors.displayName = nameProblem;
  const tagline = normalizeLine(values.tagline);
  const taglineProblem = lengthProblem('一行介绍', tagline, CARD_LIMITS.tagline.min, CARD_LIMITS.tagline.max);
  if (taglineProblem) errors.tagline = taglineProblem;

  const baseHooks = new Map(base.hooks.map((hook) => [hook.id, hook]));
  const seen = new Set<string>();
  const hooks: Hook[] = [];
  let mismatch = false;
  values.hooks.forEach((input, index) => {
    const original = baseHooks.get(input.id);
    if (!original || seen.has(input.id)) {
      mismatch = true;
      return;
    }
    seen.add(input.id);
    if (input.remove) return;
    const text = normalizeLine(input.text);
    const opener = normalizeLine(input.opener);
    const textProblem = lengthProblem('接话点', text, CARD_LIMITS.hookText.min, CARD_LIMITS.hookText.max);
    if (textProblem) errors[`hooks.${index}.text`] = textProblem;
    const openerProblem = lengthProblem('开场白', opener, CARD_LIMITS.hookOpener.min, CARD_LIMITS.hookOpener.max);
    if (openerProblem) errors[`hooks.${index}.opener`] = openerProblem;
    hooks.push({ id: original.id, ...(original.kind ? { kind: original.kind } : {}), text, opener });
  });
  if (mismatch) {
    errors.hooks = '接话点和这个版本对不上（页面可能已经过期）。请刷新工作区后重新确认。';
  } else {
    const kept = values.hooks.filter((hook) => !hook.remove).length;
    if (kept < CARD_LIMITS.hooks.min) {
      errors.hooks = `至少保留 ${CARD_LIMITS.hooks.min} 个接话点（现在 ${kept} 个）。不满意的接话点可以直接改写，不用删掉。`;
    } else if (kept > CARD_LIMITS.hooks.max) {
      errors.hooks = `最多保留 ${CARD_LIMITS.hooks.max} 个接话点（现在 ${kept} 个）。`;
    }
  }

  let contact: ConfirmedContact | null = null;
  const channel = values.contactChannel;
  const contactValue = values.contactValue.trim();
  if (!isContactChannel(channel)) {
    errors.contactChannel = '请选择联系方式的渠道：微信、QQ、邮箱、手机或其他。';
  } else {
    const problem = contactValue ? contactValueProblem(channel, contactValue) : null;
    if (problem) errors.contactValue = problem;
    else if (values.contactPublic && !contactValue) {
      errors.contactValue = '要公开联系方式，先填写你的账号或号码；不想公开就取消勾选“公开联系方式”。';
    } else contact = { channel, value: contactValue || null, isPublic: values.contactPublic };
  }

  if (!values.confirm) errors.confirm = '请勾选“发布后，以上内容对这面墙的成员可见”，确认后再发布。';

  if (Object.keys(errors).length > 0 || !contact) return { ok: false, errors };
  const card = cardSchema.safeParse({ schemaVersion: PAGE_SCHEMA_VERSION, displayName, tagline, hooks });
  if (!card.success) {
    return { ok: false, errors: { form: `缩略卡的内容不符合要求：${card.error.issues[0]?.message ?? '格式不对'}。请修改后再发布。` } };
  }
  return { ok: true, card: card.data, contact };
}

/** 这一页的某个版本；ID 格式不对或不属于这一页返回 null（路由回 404）。 */
export function findOwnRevision(deps: Pick<AppDeps, 'repos'>, own: OwnPage, revisionId: string | undefined): Revision | null {
  if (!revisionId || !REVISION_ID_PATTERN.test(revisionId)) return null;
  const revision = deps.repos.revisions.findById(revisionId);
  return revision && revision.pageId === own.page.id ? revision : null;
}

/** 预填值（见文件头）。 */
export function publishDefaults(
  deps: Pick<AppDeps, 'repos'>,
  own: OwnPage,
  revision: RevisionListItem,
): { values: PublishFormValues; prefill: 'card' | 'publication' } | null {
  const base = revisionCard(revision);
  if (!base) return null;
  const previous = deps.repos.publications.findLatestForRevision(revision.id);
  const previousCard = previous ? parsePublishedCard(previous.cardJson) : null;
  const card = previousCard ?? base;
  const { page, wall } = own;
  const chosen = page.contactChannel !== null;
  return {
    prefill: previousCard ? 'publication' : 'card',
    values: {
      revisionId: revision.id,
      displayName: card.displayName,
      tagline: card.tagline,
      hooks: card.hooks.map((hook) => ({ id: hook.id, text: hook.text, opener: hook.opener, remove: false })),
      contactChannel: chosen && isContactChannel(page.contactChannel) ? page.contactChannel : 'wechat',
      contactValue: page.contactValue ?? '',
      contactPublic: chosen ? page.contactPublic : sceneContactPublicDefault(wall.sceneType),
      confirm: false,
    },
  };
}

// ---------------------------------------------------------------------------
// 状态改变
// ---------------------------------------------------------------------------

type MutationDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;

export interface PublishResult {
  publication: Publication;
  /** 被替换的旧发布（以 superseded 结束）。 */
  replaced: Publication | null;
}

/**
 * 发布（或恢复）：结束旧的活跃发布（superseded）→ 新建发布 → 更新页面联系方式 → 事件 `publish`。
 * 事务里再确认一次版本仍可用（没有被删除）；不可用时返回 null、不改变状态。
 */
export function publishRevision(
  deps: MutationDeps,
  own: OwnPage,
  revision: Revision,
  confirmed: { card: Card; contact: ConfirmedContact },
  actorId: string,
): PublishResult | null {
  const { repos } = deps;
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, (): PublishResult | null => {
    const current = repos.revisions.findById(revision.id);
    if (!current || current.pageId !== own.page.id || !isRevisionUsable(current)) return null;
    const replaced = repos.publications.endActive(own.page.id, 'superseded', nowIso);
    const { contact } = confirmed;
    const snapshot: PublishedContact | null = contact.isPublic && contact.value ? { channel: contact.channel, value: contact.value } : null;
    const publication = repos.publications.create({
      id: generateId('pbl'),
      pageId: own.page.id,
      revisionId: current.id,
      cardJson: JSON.stringify(confirmed.card),
      contactJson: snapshot ? JSON.stringify(snapshot) : null,
      publishedAt: nowIso,
    });
    repos.pages.setContact(own.page.id, contact, nowIso);
    const replacedNumber = replaced ? (repos.revisions.findById(replaced.revisionId)?.number ?? null) : null;
    repos.events.record({
      type: 'publish',
      wallId: own.wall.id,
      pageId: own.page.id,
      actorId,
      props: {
        revisionNumber: current.number,
        hookCount: confirmed.card.hooks.length,
        contactPublic: snapshot !== null,
        replaced: replaced !== null,
        restored: replacedNumber !== null && current.number < replacedNumber,
      },
      createdAt: nowIso,
    });
    return { publication, replaced };
  });
}

/** 撤下：活跃发布以 withdrawn 结束，事件 `withdraw`。没有活跃发布时返回 false。 */
export function withdrawPublication(deps: MutationDeps, own: OwnPage, actorId: string): boolean {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const ended = deps.repos.publications.endActive(own.page.id, 'withdrawn', nowIso);
    if (!ended) return false;
    deps.repos.events.record({ type: 'withdraw', wallId: own.wall.id, pageId: own.page.id, actorId, createdAt: nowIso });
    return true;
  });
}

/**
 * 公开链接开关（W15）：开启时每次都生成新的 `pub_` 令牌（旧链接立即失效），事件 `public_link_on`；
 * 关闭时置空，事件 `public_link_off`（本来就关着时不记事件）。返回新的令牌（关闭时为 null）。
 */
export function setPublicLink(deps: MutationDeps, own: OwnPage, enabled: boolean, actorId: string): string | null {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const page = deps.repos.pages.findById(own.page.id);
    const wasOn = page?.publicToken != null;
    if (enabled) {
      const token = generateToken('publicLink');
      deps.repos.pages.setPublicToken(own.page.id, token, nowIso);
      deps.repos.events.record({
        type: 'public_link_on',
        wallId: own.wall.id,
        pageId: own.page.id,
        actorId,
        props: { rotated: wasOn },
        createdAt: nowIso,
      });
      return token;
    }
    if (wasOn) {
      deps.repos.pages.setPublicToken(own.page.id, null, nowIso);
      deps.repos.events.record({ type: 'public_link_off', wallId: own.wall.id, pageId: own.page.id, actorId, createdAt: nowIso });
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// 工作区里的发布状态
// ---------------------------------------------------------------------------

/**
 * 表单的用途（决定标题与按钮文字）：
 * first 第一次发布；relaunch 撤下后重新发布；update 用更新的版本替换；restore 恢复为更早的版本；
 * republish 墙上就是这一版，只改缩略卡或联系方式。
 */
export type PublishMode = 'first' | 'relaunch' | 'update' | 'restore' | 'republish';

export interface PublishFormModel {
  revisionId: string;
  revisionNumber: number;
  mode: PublishMode;
  values: PublishFormValues;
  errors: PublishFormErrors;
  /** 预填来源；`input` 表示显示的是主人刚提交、没通过校验的输入。 */
  prefill: 'card' | 'publication' | 'input';
  /** 页面从没确认过联系方式，“公开联系方式”用的是场景默认值。 */
  sceneDefault: boolean;
  /** 这一版的 card.json 读不出来（不应发生），不能发布。 */
  unavailable: boolean;
}

export interface ActivePublicationView {
  publication: Publication;
  revisionNumber: number | null;
  card: Card | null;
  contact: PublishedContact | null;
}

export interface PublishModel {
  state: PageDisplayState;
  active: ActivePublicationView | null;
  /** 撤下状态下最近一次结束的时间。 */
  lastEndedAt: string | null;
  /** 撤下状态下，最近一次是不是被组织者 / 平台请下墙的（contracts 15）。 */
  takenDownBy: 'organizer' | 'platform' | null;
  publicLinkUrl: string | null;
  isOrganizer: boolean;
  /** 选中版本的发布确认（没有可发布的选中版本时为 null）。 */
  form: PublishFormModel | null;
}

export interface PublishFormState {
  values: PublishFormValues;
  errors: PublishFormErrors;
}

export function loadPublishModel(
  deps: Pick<AppDeps, 'repos' | 'config'>,
  own: OwnPage,
  revisions: readonly RevisionListItem[],
  selected: RevisionListItem | null,
  submitted?: PublishFormState | null,
): PublishModel {
  const { repos } = deps;
  const { page } = own;
  const activePublication = repos.publications.findActiveForPage(page.id);
  const activeNumber = activePublication ? (revisions.find((revision) => revision.id === activePublication.revisionId)?.number ?? null) : null;
  const active: ActivePublicationView | null = activePublication
    ? {
        publication: activePublication,
        revisionNumber: activeNumber,
        card: parsePublishedCard(activePublication.cardJson),
        contact: parsePublishedContact(activePublication.contactJson),
      }
    : null;
  const state = repos.publications.displayState(page.id);
  const lastEnded = state === 'withdrawn' ? repos.publications.findLatestEndedForPage(page.id) : null;

  let form: PublishFormModel | null = null;
  if (selected && isRevisionUsable(selected)) {
    let mode: PublishMode;
    if (activePublication && activeNumber !== null) {
      if (activePublication.revisionId === selected.id) mode = 'republish';
      else mode = selected.number < activeNumber ? 'restore' : 'update';
    } else mode = state === 'withdrawn' ? 'relaunch' : 'first';
    const defaults = publishDefaults(deps, own, selected);
    const useSubmitted = submitted && submitted.values.revisionId === selected.id;
    form = {
      revisionId: selected.id,
      revisionNumber: selected.number,
      mode,
      values: useSubmitted ? submitted.values : (defaults?.values ?? emptyValues(selected.id)),
      errors: useSubmitted ? submitted.errors : {},
      prefill: useSubmitted ? 'input' : (defaults?.prefill ?? 'card'),
      sceneDefault: page.contactChannel === null,
      unavailable: defaults === null,
    };
  }

  return {
    state,
    active,
    lastEndedAt: lastEnded?.endedAt ?? null,
    takenDownBy: lastEnded ? repos.moderation.takedownActorFor(lastEnded.id) : null,
    publicLinkUrl: page.publicToken ? publicLinkUrl(deps.config.webOrigin, page.publicToken) : null,
    isOrganizer: own.membership.role === 'organizer',
    form,
  };
}

function emptyValues(revisionId: string): PublishFormValues {
  return {
    revisionId,
    displayName: '',
    tagline: '',
    hooks: [],
    contactChannel: 'wechat',
    contactValue: '',
    contactPublic: false,
    confirm: false,
  };
}
