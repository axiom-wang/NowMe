/**
 * 墙与成员页的展示数据（W13、W14、contracts 4.2）。
 *
 * 墙上与成员页上的名字、一行介绍、接话点、开场白**一律取自 publication 的 card_json**（主人发布时确认过的快照），
 * 联系方式取自 publication 的 contact_json（发布时快照），不读 revision 原始 card、不读 pages 表上的当前联系方式。
 *
 * 快照格式由发布流程（T3.2）写入。这里宽松解析：
 * - card：`{ displayName, tagline, hooks: [{ id?, kind?, text, opener }] }`（与 card.json 相同的字段；hook 缺 id 时按位置补 `hook-<n>`）；
 * - contact：`null` 表示发布时没有公开联系方式；否则 `{ channel, value }`（也接受 `contactChannel` / `contactValue`），
 *   若带 `public` / `contactPublic` 字段，必须为 true 才算公开。
 */
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NM_ID_PATTERN } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import type { PageDisplayState } from '../db/publications.js';
import { wallQueries, type PublishedEntry } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import type { MemberWall, PublishedMemberPage } from './access.js';
import { REVISION_COVER_FILE, revisionDir } from './revision-storage.js';
import type { IssuedTicket } from './tickets.js';
import { loadPortrait, type PortraitState } from './portrait.js';
import { answersForWall, cardAnswers, questionStats, type CardAnswer, type QuestionStats } from './wall-questions.js';
import { introducedPages } from './intro.js';

export interface PublishedHook {
  id: string;
  /** 在 card.hooks 中的位置（0 起），事件里只记这个数字。 */
  index: number;
  text: string;
  opener: string;
}

export interface PublishedCard {
  displayName: string;
  tagline: string;
  hooks: PublishedHook[];
}

export interface PublishedContact {
  channel: string;
  /** 给人看的渠道名，例如“微信”。 */
  channelLabel: string;
  value: string;
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  wechat: '微信',
  weixin: '微信',
  qq: 'QQ',
  email: '邮箱',
  phone: '手机',
  mobile: '手机',
  telegram: 'Telegram',
  feishu: '飞书',
  lark: '飞书',
  dingtalk: '钉钉',
  other: '联系方式',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 解析发布快照中的 card（见文件头）。`fallbackName` 用于快照里没有名字的情况。 */
export function parsePublishedCard(cardJson: string, fallbackName: string): PublishedCard {
  const raw = parseJson(cardJson);
  const card = isRecord(raw) ? raw : {};
  const hooks: PublishedHook[] = [];
  const seen = new Set<string>();
  const rawHooks = Array.isArray(card.hooks) ? card.hooks : [];
  rawHooks.forEach((item, index) => {
    if (!isRecord(item)) return;
    const hookText = text(item.text);
    if (!hookText) return;
    let id = typeof item.id === 'string' && NM_ID_PATTERN.test(item.id) ? item.id : `hook-${index + 1}`;
    if (seen.has(id)) id = `hook-${index + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    hooks.push({ id, index, text: hookText, opener: text(item.opener) });
  });
  return {
    displayName: text(card.displayName) || fallbackName,
    tagline: text(card.tagline),
    hooks,
  };
}

/** 解析发布快照中的联系方式；没有公开时返回 null（见文件头）。 */
export function parsePublishedContact(contactJson: string | null): PublishedContact | null {
  const raw = parseJson(contactJson);
  if (!isRecord(raw)) return null;
  if ('public' in raw && raw.public !== true) return null;
  if ('contactPublic' in raw && raw.contactPublic !== true) return null;
  const value = text(raw.value) || text(raw.contactValue);
  if (!value) return null;
  const channel = text(raw.channel) || text(raw.contactChannel) || 'other';
  return { channel, channelLabel: CHANNEL_LABELS[channel.toLowerCase()] ?? channel, value };
}

/** 均匀随机打乱（Fisher–Yates，crypto 随机数）：墙上每次请求随机排序，不按热度（W13）。 */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** 某个发布版本的封面文件路径（`revisions/<id>/cover.png`）。 */
export function coverFilePath(dataDir: string, revisionId: string): string {
  return join(revisionDir(dataDir, revisionId), REVISION_COVER_FILE);
}

/** 墙上封面的地址（成员才能取）。 */
export function coverPath(wallId: string, pageId: string): string {
  return `/w/${wallId}/covers/${pageId}.png`;
}

export function memberPagePath(wallId: string, pageId: string): string {
  return `/w/${wallId}/p/${pageId}`;
}

// ---------------------------------------------------------------------------
// 墙（GET /w/:wallId）
// ---------------------------------------------------------------------------

export interface WallCard {
  pageId: string;
  href: string;
  /** 有封面文件时为封面地址，否则 null（显示占位）。 */
  coverSrc: string | null;
  card: PublishedCard;
  own: boolean;
  /** 查看者已经为这一页找过话题，且对方之后没有更新过页面（contracts 11；只有查看者自己看得到）。 */
  hasTalk: boolean;
  /** AI 把这一位介绍给了查看者，且对方之后没有更新过页面（contracts 20；只有查看者自己看得到）。 */
  introduced: boolean;
  /** 页面主人对必答题的回答（contracts 19.1；墙上可见）。 */
  answers: CardAnswer[];
}

export interface WallModel {
  wall: Wall;
  role: MemberWall['membership']['role'];
  /** 我的页面：发布状态与入口。 */
  myPage: { pageId: string | null; state: PageDisplayState; href: string | null };
  /** 随机排序后的已发布卡片。 */
  cards: WallCard[];
  /** 这面墙的有效成员数（含还没发布的；只是数字，不含任何人的信息）。 */
  memberCount: number;
  /** 必答题与按回答的人数（只算查看者在墙上看得到的卡片），用于筛选。没有题目时为空数组。 */
  questions: QuestionStats[];
  /** 查看者自己有没有答完必答题（没有题目时为 true）。 */
  answeredAll: boolean;
  /** 墙的群像（contracts 19.3）。 */
  portrait: PortraitState;
}

function nicknameOf(deps: Pick<AppDeps, 'repos'>, userId: string): string {
  return deps.repos.users.findById(userId)?.nickname ?? '成员';
}

function toWallCard(deps: Pick<AppDeps, 'repos' | 'config'>, wallId: string, entry: PublishedEntry, viewerId: string, talks: Map<string, string>, answers: CardAnswer[], introduced: Set<string>): WallCard {
  const hasCover = existsSync(coverFilePath(deps.config.dataDir, entry.revisionId));
  return {
    pageId: entry.pageId,
    href: memberPagePath(wallId, entry.pageId),
    coverSrc: hasCover ? coverPath(wallId, entry.pageId) : null,
    card: parsePublishedCard(entry.cardJson, nicknameOf(deps, entry.ownerId)),
    own: entry.ownerId === viewerId,
    hasTalk: entry.ownerId !== viewerId && talks.get(entry.pageId) === entry.publicationId,
    introduced: entry.ownerId !== viewerId && introduced.has(entry.pageId),
    answers,
  };
}

export function loadWallModel(deps: Pick<AppDeps, 'db' | 'repos' | 'config'>, member: MemberWall): WallModel {
  const { wall, membership } = member;
  // 拉黑双向生效：互相看不到对方的卡片（contracts 15）
  const hidden = deps.repos.moderation.hiddenPeers(membership.userId);
  const entries = wallQueries(deps.db).listPublished(wall.id).filter((entry) => !hidden.has(entry.ownerId));
  const myPage = deps.repos.pages.findByMembership(membership.id);
  const myState: PageDisplayState = myPage ? deps.repos.publications.displayState(myPage.id) : 'unpublished';
  const myEntry = entries.find((entry) => entry.ownerId === membership.userId) ?? null;
  const talks = deps.repos.icebreakers.publicationsForViewerWall(membership.userId, wall.id);
  const questions = deps.repos.questions.listForWall(wall.id);
  const answers = answersForWall(deps, wall.id, questions);
  const mine = answers.get(membership.userId);
  const introduced = introducedPages(deps, membership.userId, wall.id, entries);
  return {
    wall,
    role: membership.role,
    myPage: {
      pageId: myPage?.id ?? null,
      state: myState,
      href: myEntry ? memberPagePath(wall.id, myEntry.pageId) : null,
    },
    cards: shuffle(entries.map((entry) => toWallCard(deps, wall.id, entry, membership.userId, talks, cardAnswers(questions, answers.get(entry.ownerId)), introduced))),
    memberCount: deps.repos.memberships.countActiveForWall(wall.id),
    questions: questionStats(questions, answers, entries.map((entry) => entry.ownerId)),
    answeredAll: questions.every((question) => mine?.has(question.id)),
    portrait: loadPortrait(deps, wall.id),
  };
}

// ---------------------------------------------------------------------------
// 成员页（GET /w/:wallId/p/:pageId）与想聊这个
// ---------------------------------------------------------------------------

export interface StageModel {
  pageId: string;
  displayName: string;
  tagline: string;
  src: string;
  position: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
}

export interface MemberStageModel {
  wallId: string;
  pageId: string;
  prevId: string | null;
  nextId: string | null;
  position: number;
  total: number;
  name: string;
  tagline: string;
}

export interface MemberPageModel {
  wall: Wall;
  pageId: string;
  card: PublishedCard;
  /** 发布快照里公开的联系方式；null 表示没有公开（不显示“想聊这个”）。 */
  contact: PublishedContact | null;
  own: boolean;
  /** 当前发布版本的票据（授权检查通过后签发）。 */
  ticket: IssuedTicket;
  stage: MemberStageModel;
}

function loadStage(deps: Pick<AppDeps, 'db' | 'repos' | 'tickets'>, found: PublishedMemberPage): { model: StageModel; ticket: IssuedTicket } {
  const { entry } = found;
  const hidden = deps.repos.moderation.hiddenPeers(found.membership.userId);
  // listPublished 使用 published_at,rowid 的固定顺序，不采用墙上的随机展示顺序。
  const entries = wallQueries(deps.db).listPublished(found.wall.id).filter((item) => !hidden.has(item.ownerId));
  const index = entries.findIndex((item) => item.pageId === entry.pageId);
  const total = entries.length;
  const card = parsePublishedCard(entry.cardJson, nicknameOf(deps, entry.ownerId));
  // 授权已通过，只给当前发布版本签发票据。
  const ticket = deps.tickets.issue(entry.revisionId);
  return {
    ticket,
    model: {
      pageId: entry.pageId,
      displayName: card.displayName,
      tagline: card.tagline,
      src: ticket.src,
      position: index + 1,
      total,
      prevId: total > 1 ? (entries[(index - 1 + total) % total]?.pageId ?? null) : null,
      nextId: total > 1 ? (entries[(index + 1) % total]?.pageId ?? null) : null,
    },
  };
}

export function loadStageModel(deps: Pick<AppDeps, 'db' | 'repos' | 'tickets'>, found: PublishedMemberPage): StageModel {
  return loadStage(deps, found).model;
}

export function loadMemberPageModel(deps: Pick<AppDeps, 'db' | 'repos' | 'tickets'>, found: PublishedMemberPage): MemberPageModel {
  const { entry } = found;
  const { model: stage, ticket } = loadStage(deps, found);
  return {
    wall: found.wall,
    pageId: entry.pageId,
    card: parsePublishedCard(entry.cardJson, nicknameOf(deps, entry.ownerId)),
    contact: parsePublishedContact(entry.contactJson),
    own: found.own,
    ticket,
    stage: {
      wallId: found.wall.id,
      pageId: stage.pageId,
      prevId: stage.prevId,
      nextId: stage.nextId,
      position: stage.position,
      total: stage.total,
      name: stage.displayName,
      tagline: stage.tagline,
    },
  };
}

export interface ChatModel {
  wall: Wall;
  pageId: string;
  displayName: string;
  hook: PublishedHook;
  contact: PublishedContact;
}

/**
 * “想聊这个”：只在发布快照里公开了联系方式、接话点存在、且不是自己的页面时可用；否则 null（路由回 404）。
 * `hookId` 可以是接话点 id，也可以是位置编号（0 起）。
 */
export function resolveChat(deps: Pick<AppDeps, 'repos'>, found: PublishedMemberPage, hookId: string): ChatModel | null {
  if (found.own) return null;
  const contact = parsePublishedContact(found.entry.contactJson);
  if (!contact) return null;
  const card = parsePublishedCard(found.entry.cardJson, nicknameOf(deps, found.entry.ownerId));
  const hook = card.hooks.find((item) => item.id === hookId) ?? (/^\d{1,2}$/.test(hookId) ? card.hooks.find((item) => item.index === Number(hookId)) : undefined);
  if (!hook) return null;
  return { wall: found.wall, pageId: found.entry.pageId, displayName: card.displayName, hook, contact };
}
