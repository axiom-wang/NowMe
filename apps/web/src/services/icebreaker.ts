/**
 * “和 TA 聊什么”（contracts 11）：查看者在别人的成员页上，请 AI 找出两人的连接点并起草开场白。
 *
 * 授权与隐私（S9）：
 * - 只有这面墙的有效成员、看的是墙上可见的别人的页面时才能发起；`found` 必须来自 `findPublishedMemberPage`。
 * - 交给模型的只有两类内容：查看者**自己的**资料（自己已发布的页面、自己确认过的采访摘要），和对方**已经公开在这面墙上**的页面。
 *   不读对方的草稿、未发布版本、采访、画像、联系方式，也不读任何第三人的内容。
 * - 模型请求使用查看者自己的模型配置（`deps.hosted.resolveModel(viewerId, 'interview')`）。
 * - 结果只属于查看者：只按 `viewer_id` 读取；绑定对方当时的发布，对方更新 / 撤下、任一方离开墙、墙关闭后不再展示。
 * - 开场白只是草稿：预填到私聊输入框，由查看者修改后主动发送（平台不代发）。
 */
import {
  generateId,
  ICEBREAKER_DAILY_PER_TARGET,
  ICEBREAKER_DAILY_PER_VIEWER,
  ICEBREAKER_TARGET_TEXT_MAX,
  ICEBREAKER_TIMEOUT_MS,
  ICEBREAKER_VIEWER_TEXT_MAX,
  isId,
} from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import { wallQueries } from '../db/wall-queries.js';
import { clip, stripControl, type StructuredBrief } from '../hosted/brief.js';
import { IcebreakerError, runIcebreaker, viewerCorpus, type IcebreakerInput, type IcebreakerLink, type IcebreakerOpener } from '../hosted/icebreaker.js';
import { emptyUsage, type UsageTotals } from '../hosted/model-client.js';
import { modelFailureCode, type ModelAccessCode } from '../hosted/model-errors.js';
import { findOwnPage, findPublishedMemberPage, type PublishedMemberPage } from './access.js';
import { parsePublishedCard } from './wall-view.js';

type IcebreakerDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'hosted' | 'log'>;

const DAY_MS = 24 * 3600 * 1000;

/** 给查看者看的结果。 */
export interface IcebreakerView {
  id: string;
  links: IcebreakerLink[];
  openers: IcebreakerOpener[];
  /** 这次用了查看者的哪些资料（界面上如实说明）。 */
  sources: { page: boolean; brief: boolean };
  createdAt: string;
}

/** 成员页上“和 TA 聊什么”区块的状态。 */
export interface IcebreakerPanel {
  /** 查看者能不能发起（已配置模型）。 */
  modelReady: boolean;
  /** 查看者有没有可用的自己的资料（没有时只能从对方页面出发）。 */
  hasMaterial: boolean;
  view: IcebreakerView | null;
}

export type IcebreakerFailure = ModelAccessCode | 'busy' | 'daily' | 'target-daily' | 'failed' | 'timeout' | 'gone';
export type IcebreakerStartResult = { ok: true; view: IcebreakerView } | { ok: false; error: IcebreakerFailure };

/** 失败时给查看者看的固定文案（不含模型输出）。 */
export const ICEBREAKER_ERROR_TEXT: Record<IcebreakerFailure, string> = {
  MODEL_CONFIG: '现在还没有可用的 AI。先到“AI 设置”里填上你自己的模型，再回来试一次。',
  MODEL_AUTH: '你的模型服务不认这个 Key（可能填错了、已过期，或没有权限）。到“AI 设置”里检查一下。',
  MODEL_RATE_LIMITED: '模型服务那边限流了，或者账户余额不够。过几分钟再试；还是不行的话，去服务商那里看看余额。',
  MODEL_UNAVAILABLE: '暂时连不上模型服务。过几分钟再试一次。',
  busy: '上一次还没出结果，等十来秒再点。',
  daily: `今天找话题的次数用完了（每 24 小时 ${ICEBREAKER_DAILY_PER_VIEWER} 次）。明天再来，或者直接给 TA 发条私信。`,
  'target-daily': `这一页今天已经帮你换过 ${ICEBREAKER_DAILY_PER_TARGET} 次了。不如挑一句改成你的话，直接发出去。`,
  failed: 'AI 这次没想出合适的话题。再点一次试试。',
  timeout: 'AI 想了太久，这次没有结果。再点一次试试。',
  gone: '这一页刚刚更新了，或者已经从墙上撤下。刷新一下再看看。',
};

function parseView(record: { id: string; resultJson: string; createdAt: string }): IcebreakerView | null {
  try {
    const raw = JSON.parse(record.resultJson) as Partial<IcebreakerView>;
    if (!Array.isArray(raw.links) || !Array.isArray(raw.openers) || raw.openers.length === 0) return null;
    return {
      id: record.id,
      links: raw.links,
      openers: raw.openers,
      sources: { page: raw.sources?.page === true, brief: raw.sources?.brief === true },
      createdAt: record.createdAt,
    };
  } catch {
    return null;
  }
}

function clean(text: string | null | undefined, max: number): string {
  return clip(stripControl(text ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'), max);
}

/**
 * 查看者自己在这面墙上的资料：已发布的页面（卡片 + 渲染文字）与确认过的采访摘要。只读查看者本人的数据。
 * “AI 介绍值得认识的人”（contracts 20）读的是同一份。
 */
export function viewerMaterial(deps: Pick<AppDeps, 'db' | 'repos'>, viewerId: string, wallId: string): IcebreakerInput['viewer'] {
  const { repos } = deps;
  const name = repos.users.findById(viewerId)?.nickname ?? '成员';
  const own = findOwnPage(repos, viewerId, wallId);
  if (!own) return { name, card: null, pageText: '', brief: null, avoid: [] };
  const entry = wallQueries(deps.db).findPublished(wallId, own.page.id);
  let card: IcebreakerInput['viewer']['card'] = null;
  let pageText = '';
  let displayName = name;
  if (entry && entry.ownerId === viewerId) {
    const parsed = parsePublishedCard(entry.cardJson, name);
    displayName = parsed.displayName;
    card = { tagline: clean(parsed.tagline, 120), hooks: parsed.hooks.map((hook) => clean(hook.text, 60)).filter(Boolean) };
    pageText = clean(repos.revisions.findById(entry.revisionId)?.renderedText, ICEBREAKER_VIEWER_TEXT_MAX);
  }
  let brief: IcebreakerInput['viewer']['brief'] = null;
  let avoid: string[] = [];
  const record = repos.briefs.findForPage(own.page.id, viewerId);
  if (record?.status === 'confirmed' && record.briefJson) {
    try {
      const structured = JSON.parse(record.briefJson) as Partial<StructuredBrief>;
      brief = {
        aiView: (structured.aiView ?? []).map((line) => clean(line, 120)).filter(Boolean).slice(0, 5),
        hooks: (structured.hooks ?? []).map((hook) => clean(hook.text, 60)).filter(Boolean).slice(0, 3),
        intent: clean(structured.intentAspect, 120),
      };
      if (brief.aiView.length === 0 && brief.hooks.length === 0 && !brief.intent) brief = null;
      avoid = [...(structured.boundaries?.hidden ?? []), ...(structured.boundaries?.rejected ?? [])].map((line) => clean(line, 80)).filter(Boolean).slice(0, 12);
    } catch {
      brief = null;
    }
  }
  return { name: displayName, card, pageText, brief, avoid };
}

function buildInput(deps: IcebreakerDeps, found: PublishedMemberPage, viewerId: string): IcebreakerInput {
  const { repos } = deps;
  const { wall, entry } = found;
  const card = parsePublishedCard(entry.cardJson, repos.users.findById(entry.ownerId)?.nickname ?? '成员');
  return {
    wall: { name: wall.name, description: clean(wall.description, 200), sceneLabel: loadSceneGuide(wall.sceneType).label },
    viewer: viewerMaterial(deps, viewerId, wall.id),
    target: {
      name: card.displayName,
      tagline: clean(card.tagline, 120),
      hooks: card.hooks.map((hook) => clean(hook.text, 60)).filter(Boolean),
      pageText: clean(repos.revisions.findById(entry.revisionId)?.renderedText, ICEBREAKER_TARGET_TEXT_MAX),
    },
  };
}

/** 查看者对这一页的最新结果；对方的发布变了、不是这面墙的、解析不了都当作没有。 */
export function loadIcebreaker(deps: Pick<AppDeps, 'repos'>, found: PublishedMemberPage, viewerId: string): IcebreakerView | null {
  if (found.own) return null;
  const record = deps.repos.icebreakers.findLatest(viewerId, found.entry.pageId);
  if (!record || record.wallId !== found.wall.id || record.publicationId !== found.entry.publicationId) return null;
  return parseView(record);
}

export function loadIcebreakerPanel(deps: IcebreakerDeps, found: PublishedMemberPage, viewerId: string): IcebreakerPanel {
  return {
    modelReady: deps.hosted?.modelReady(viewerId) ?? false,
    hasMaterial: viewerCorpus({ viewer: viewerMaterial(deps, viewerId, found.wall.id) }).length > 0,
    view: loadIcebreaker(deps, found, viewerId),
  };
}

/** 查看者用某一句开场白开聊时取草稿：结果必须是本人的、关于这一页、且仍然有效。 */
export function icebreakerOpener(deps: Pick<AppDeps, 'repos'>, found: PublishedMemberPage, viewerId: string, icebreakerId: string, index: number): string | null {
  if (found.own || !isId(icebreakerId, 'ice')) return null;
  const record = deps.repos.icebreakers.findById(icebreakerId, viewerId);
  if (!record || record.pageId !== found.entry.pageId || record.wallId !== found.wall.id || record.publicationId !== found.entry.publicationId) return null;
  return parseView(record)?.openers[index]?.text ?? null;
}

const inFlight = new WeakMap<object, Set<string>>();

/**
 * 发起一次（或“换一批”）。按查看者限流；同一查看者同时只跑一次。
 * 模型调用结束后重新做一次授权检查：期间对方更新 / 撤下、任一方离开墙、墙关闭 → 不保存。
 */
export async function generateIcebreaker(deps: IcebreakerDeps, found: PublishedMemberPage, viewerId: string): Promise<IcebreakerStartResult> {
  const { repos } = deps;
  if (found.own) return { ok: false, error: 'gone' };
  const hosted = deps.hosted;
  if (!hosted || !hosted.modelReady(viewerId)) return { ok: false, error: 'MODEL_CONFIG' };
  const since = new Date(deps.now().getTime() - DAY_MS).toISOString();
  if (repos.icebreakers.countAttemptsSince(viewerId, since) >= ICEBREAKER_DAILY_PER_VIEWER) return { ok: false, error: 'daily' };
  if (repos.icebreakers.countAttemptsForPageSince(viewerId, found.entry.pageId, since) >= ICEBREAKER_DAILY_PER_TARGET) return { ok: false, error: 'target-daily' };

  let busy = inFlight.get(deps.db);
  if (!busy) inFlight.set(deps.db, (busy = new Set()));
  if (busy.has(viewerId)) return { ok: false, error: 'busy' };
  busy.add(viewerId);

  const started = Date.now();
  const wallId = found.wall.id;
  const pageId = found.entry.pageId;
  let usage: UsageTotals = emptyUsage();
  let input: IcebreakerInput | null = null;
  const record = (ok: boolean, counts: { links: number; openers: number }) =>
    repos.events.record({
      type: 'icebreaker_generate',
      wallId,
      pageId,
      actorId: viewerId,
      props: {
        ok,
        durationMs: Date.now() - started,
        links: counts.links,
        openers: counts.openers,
        hasPage: !!input?.viewer.pageText || !!input?.viewer.card,
        hasBrief: !!input?.viewer.brief,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      createdAt: deps.now().toISOString(),
    });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICEBREAKER_TIMEOUT_MS);
  try {
    input = buildInput(deps, found, viewerId);
    const model = hosted.resolveModel(viewerId, 'interview');
    const result = await runIcebreaker(model.client, model.endpoint.model!, input, { signal: controller.signal });
    usage = result.usage;
    const current = findPublishedMemberPage(deps, viewerId, wallId, pageId);
    if (!current || current.own || current.entry.publicationId !== found.entry.publicationId) {
      record(false, { links: 0, openers: 0 });
      return { ok: false, error: 'gone' };
    }
    const createdAt = deps.now().toISOString();
    const id = generateId('ice');
    const sources = { page: !!input.viewer.pageText || !!input.viewer.card, brief: !!input.viewer.brief };
    transaction(deps.db, () => {
      repos.icebreakers.replace({
        id,
        wallId,
        viewerId,
        pageId,
        publicationId: found.entry.publicationId,
        resultJson: JSON.stringify({ links: result.output.links, openers: result.output.openers, sources }),
        createdAt,
      });
      record(true, { links: result.output.links.length, openers: result.output.openers.length });
    });
    return { ok: true, view: { id, links: result.output.links, openers: result.output.openers, sources, createdAt } };
  } catch (error) {
    if (error instanceof IcebreakerError) {
      usage = error.usage;
      record(false, { links: 0, openers: 0 });
      if (error.code === 'TIMEOUT') return { ok: false, error: 'timeout' };
      return { ok: false, error: error.accessCode ?? 'failed' };
    }
    record(false, { links: 0, openers: 0 });
    const accessCode = modelFailureCode(error);
    if (accessCode) return { ok: false, error: accessCode };
    deps.log(`[web] 和 TA 聊什么：处理出错（${error instanceof Error ? error.name : 'unknown'}）`);
    return { ok: false, error: 'failed' };
  } finally {
    clearTimeout(timer);
    busy.delete(viewerId);
  }
}

/** 查看者清除自己对这一页的结果。 */
export function clearIcebreaker(deps: Pick<AppDeps, 'repos'>, found: PublishedMemberPage, viewerId: string): number {
  return deps.repos.icebreakers.deleteForViewerPage(viewerId, found.entry.pageId);
}
