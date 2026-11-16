/**
 * 问墙：用一句话找人（contracts 21）。成员问一句（“谁会剪视频？”“谁也在准备考研？”），AI 读墙上的页面，
 * 找出写到这件事的人，并附上 TA 页面上的原话。
 *
 * 授权与隐私（S15）：
 * - 只有这面墙的有效成员能问，只问这面墙；候选是墙上对他可见的、别人的已发布页面（不含自己、互相拉黑的人）。
 * - 交给模型的只有提问本身，和候选**已经公开在这面墙上**的内容（发布快照的一行介绍与接话点、公开的必答题回答、
 *   当前发布版本的渲染文字摘录）。不读任何人的草稿、未发布版本、采访、画像、联系方式，也不给模型名字；
 *   不读提问的人自己的资料（这个功能用不到）。
 * - 模型按查看者自己的配置（`interview` 角色），没有时用平台 AI（不收点数，计入全站免费调用上限）。
 * - 提问与结果只属于提问的人：只按 `viewer_id` 读取；被找到的人、组织者、其他成员都看不到，平台不发任何通知。
 *   每一位都绑定对方当时的发布：对方更新 / 撤下、拉黑、离开墙后那一位不再展示。
 * - 事件只记数字与布尔，不记问题原文。
 */
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  ASK_CANDIDATE_TEXT_BUDGET,
  ASK_CANDIDATE_TEXT_RANGE,
  ASK_DAILY_PER_VIEWER,
  ASK_DAILY_PER_WALL,
  ASK_LIMITS,
  ASK_TIMEOUT_MS,
  generateId,
  type SceneType,
} from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import type { AppDeps } from '../context.js';
import type { AskRecord } from '../db/asks.js';
import { transaction } from '../db/index.js';
import { wallQueries, type PublishedEntry } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { AskError, normalizeQuestion, runAsk, type AskCandidate, type AskInput } from '../hosted/ask.js';
import { clip, stripControl } from '../hosted/brief.js';
import { emptyUsage, type UsageTotals } from '../hosted/model-client.js';
import { modelFailureCode, type ModelAccessCode } from '../hosted/model-errors.js';
import { findMemberWall, type MemberWall } from './access.js';
import { coverFilePath, coverPath, memberPagePath, parsePublishedCard } from './wall-view.js';
import { answersForWall } from './wall-questions.js';

type AskDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'hosted' | 'log' | 'config'>;

const L = ASK_LIMITS;
const DAY_MS = 24 * 3600 * 1000;

/** 输入框下面的示例问题（按墙的场景；点一下就直接问）。 */
export const ASK_SUGGESTIONS: Record<SceneType, readonly string[]> = {
  hackathon: ['谁在找队友？', '谁会做设计？', '谁写后端？'],
  interest: ['谁周末想约着一起玩？', '谁可以带新人入门？', '谁喜欢摄影？'],
  club: ['谁会剪视频？', '谁做过活动策划？', '谁是新来的？'],
  general: ['谁在找搭子？', '谁会摄影？', '谁在准备考研？'],
};

/** 给查看者看的一位。 */
export interface AskCardView {
  pageId: string;
  href: string;
  coverSrc: string | null;
  /** 名字取自对方的发布快照，不来自模型。 */
  displayName: string;
  reason: string;
  quote: string;
}

/** 查看者在这面墙最近一次提问。 */
export interface AskView {
  id: string;
  question: string;
  createdAt: string;
  /** 当时读了几位的页面。 */
  read: number;
  /** 当时找到几位（0 = AI 回答“没找到”）。 */
  found: number;
  /** 现在仍然有效的几位。 */
  matches: AskCardView[];
}

/**
 * 墙上“问墙”区块的状态。`candidates` 是墙上对查看者可见的别人的页面数。
 * - hidden：墙上的人太少（直接逛墙就好）、也没有问过，不显示区块；
 * - open：`last` 是最近一次提问与结果（没问过时为 null）；`blocked` 说明现在为什么不能再问
 *   （`no-model` 没有可用的 AI；`too-few` 墙上的人变少了），为 null 时显示提问框。
 */
export type AskPanel =
  | { kind: 'hidden' }
  | { kind: 'open'; candidates: number; suggestions: readonly string[]; last: AskView | null; blocked: 'no-model' | 'too-few' | null };

export type AskFailure = ModelAccessCode | 'busy' | 'daily' | 'wall-daily' | 'too-few' | 'bad-question' | 'failed' | 'timeout' | 'gone';
export type AskResult = { ok: true } | { ok: false; error: AskFailure };

/** 失败时给查看者看的固定文案（不含模型输出）。 */
export const ASK_ERROR_TEXT: Record<AskFailure, string> = {
  MODEL_CONFIG: '现在还没有可用的 AI。先到“AI 设置”里填上你自己的模型，再回来问。',
  MODEL_AUTH: '你的模型服务不认这个 Key（可能填错了、已过期，或没有权限）。到“AI 设置”里检查一下。',
  MODEL_RATE_LIMITED: '模型服务那边限流了，或者账户余额不够。过几分钟再试。',
  MODEL_UNAVAILABLE: '暂时连不上模型服务。过几分钟再试一次。',
  busy: 'AI 还在找你上一个问题的答案，等十来秒再刷新一下。',
  daily: `今天问墙的次数用完了（每 24 小时 ${ASK_DAILY_PER_VIEWER} 次）。明天再来，或者先用下面的搜索框找找。`,
  'wall-daily': `这面墙今天已经问过 ${ASK_DAILY_PER_WALL} 次了。明天再来，或者去全员群里直接问一句。`,
  'too-few': `墙上还不到 ${L.minCandidates} 个人，直接逛逛就能看完。`,
  'bad-question': `问题写得再具体一点：${L.questionMin}–${L.question} 个字，比如“谁会剪视频？”`,
  failed: 'AI 这次没给出站得住的答案，没有保存。换个问法再试一次。',
  timeout: 'AI 找得太久了，这次没有结果。可以再问一次。',
  gone: '刚才找到的几位更新了页面或离开了墙。再问一次吧。',
};

function clean(text: string | null | undefined, max: number): string {
  return clip(stripControl(text ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'), max);
}

/** 墙上对查看者可见的、别人的已发布页面（拉黑双向生效）。 */
function visibleCandidates(deps: Pick<AppDeps, 'db' | 'repos'>, wallId: string, viewerId: string): PublishedEntry[] {
  const hidden = deps.repos.moderation.hiddenPeers(viewerId);
  return wallQueries(deps.db).listPublished(wallId).filter((entry) => entry.ownerId !== viewerId && !hidden.has(entry.ownerId));
}

function withinLimits(deps: Pick<AppDeps, 'repos' | 'now'>, viewerId: string, wallId: string): AskFailure | null {
  const since = new Date(deps.now().getTime() - DAY_MS).toISOString();
  if (deps.repos.asks.countAttemptsSince(viewerId, since) >= ASK_DAILY_PER_VIEWER) return 'daily';
  if (deps.repos.asks.countAttemptsForWallSince(viewerId, wallId, since) >= ASK_DAILY_PER_WALL) return 'wall-daily';
  return null;
}

/** 保存的结果里仍然有效的几位：对方现在的发布必须还是当时那一条、仍对查看者可见。 */
function liveMatches(deps: Pick<AppDeps, 'repos' | 'config'>, record: AskRecord, wallId: string, visible: Map<string, PublishedEntry>): AskCardView[] {
  return record.matches.flatMap((match) => {
    const entry = visible.get(match.pageId);
    if (!entry || entry.publicationId !== match.publicationId) return [];
    const card = parsePublishedCard(entry.cardJson, deps.repos.users.findById(entry.ownerId)?.nickname ?? '成员');
    return [
      {
        pageId: entry.pageId,
        href: memberPagePath(wallId, entry.pageId),
        coverSrc: existsSync(coverFilePath(deps.config.dataDir, entry.revisionId)) ? coverPath(wallId, entry.pageId) : null,
        displayName: card.displayName,
        reason: match.reason,
        quote: match.quote,
      },
    ];
  });
}

function toView(deps: Pick<AppDeps, 'repos' | 'config'>, record: AskRecord, wallId: string, candidates: PublishedEntry[]): AskView {
  const visible = new Map(candidates.map((entry) => [entry.pageId, entry]));
  return { id: record.id, question: record.question, createdAt: record.createdAt, read: record.candidates, found: record.found, matches: liveMatches(deps, record, wallId, visible) };
}

export function loadAskPanel(deps: Pick<AppDeps, 'db' | 'repos' | 'hosted' | 'config'>, member: MemberWall): AskPanel {
  const wallId = member.wall.id;
  const viewerId = member.membership.userId;
  const candidates = visibleCandidates(deps, wallId, viewerId);
  const record = deps.repos.asks.findForViewerWall(viewerId, wallId);
  const last = record ? toView(deps, record, wallId, candidates) : null;
  const tooFew = candidates.length < L.minCandidates;
  // 墙上的人变少以后，已有的提问仍然给他看（可以清除），只是不再提供新的提问
  if (tooFew && !last) return { kind: 'hidden' };
  const blocked = tooFew ? 'too-few' : deps.hosted?.modelReady(viewerId) ? null : 'no-model';
  return { kind: 'open', candidates: candidates.length, suggestions: ASK_SUGGESTIONS[member.wall.sceneType] ?? ASK_SUGGESTIONS.general, last, blocked };
}

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

function buildInput(deps: AskDeps, wall: Wall, question: string, entries: PublishedEntry[]): AskInput {
  const { repos } = deps;
  const questions = repos.questions.listForWall(wall.id);
  const answers = answersForWall(deps, wall.id, questions);
  const perPage = Math.max(ASK_CANDIDATE_TEXT_RANGE.min, Math.min(ASK_CANDIDATE_TEXT_RANGE.max, Math.floor(ASK_CANDIDATE_TEXT_BUDGET / Math.max(1, entries.length))));
  const candidates: AskCandidate[] = entries.map((entry) => {
    const card = parsePublishedCard(entry.cardJson, repos.users.findById(entry.ownerId)?.nickname ?? '成员');
    const mine = answers.get(entry.ownerId);
    return {
      name: card.displayName,
      tagline: clean(card.tagline, 120),
      hooks: card.hooks.map((hook) => clean(hook.text, 60)).filter(Boolean),
      answers: questions.flatMap((item) => {
        const chosen = mine?.get(item.id);
        return chosen ? [`${clean(item.prompt, 30)}：${chosen.join('、')}`] : [];
      }),
      pageText: clean(repos.revisions.findById(entry.revisionId)?.renderedText, perPage),
    };
  });
  return { wall: { name: wall.name, description: clean(wall.description, 200), sceneLabel: loadSceneGuide(wall.sceneType).label }, question, candidates };
}

const inFlight = new WeakMap<object, Set<string>>();

/**
 * 问一次。按查看者限流；同一查看者同时只跑一次。
 * 模型调用结束后重新做一次授权检查：查看者失去访问、墙关闭 → 不保存；找到的人里更新 / 撤下 / 拉黑 / 离开的去掉，
 * 找到过人但一位都不剩时不保存（`gone`）。AI 明确回答“没找到”时照常保存（界面如实说明）。
 */
export async function askWall(deps: AskDeps, member: MemberWall, rawQuestion: string | null | undefined): Promise<AskResult> {
  const { repos } = deps;
  const wall = member.wall;
  const viewerId = member.membership.userId;
  const hosted = deps.hosted;
  if (!hosted || !hosted.modelReady(viewerId)) return { ok: false, error: 'MODEL_CONFIG' };
  const question = normalizeQuestion(rawQuestion);
  if (!question) return { ok: false, error: 'bad-question' };
  const all = visibleCandidates(deps, wall.id, viewerId);
  if (all.length < L.minCandidates) return { ok: false, error: 'too-few' };
  const limited = withinLimits(deps, viewerId, wall.id);
  if (limited) return { ok: false, error: limited };

  let busy = inFlight.get(deps.db);
  if (!busy) inFlight.set(deps.db, (busy = new Set()));
  if (busy.has(viewerId)) return { ok: false, error: 'busy' };
  busy.add(viewerId);

  const started = Date.now();
  let usage: UsageTotals = emptyUsage();
  // 候选每次随机排列（不按热度，W13）；人太多时随机取样
  const entries = shuffled(all).slice(0, L.maxCandidates);
  const record = (ok: boolean, matches: number) =>
    repos.events.record({
      type: 'ask_generate',
      wallId: wall.id,
      pageId: null,
      actorId: viewerId,
      props: {
        ok,
        durationMs: Date.now() - started,
        candidates: entries.length,
        matches,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      createdAt: deps.now().toISOString(),
    });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
  try {
    const input = buildInput(deps, wall, question, entries);
    const model = hosted.resolveModel(viewerId, 'interview');
    const result = await runAsk(model.client, model.endpoint.model!, input, { signal: controller.signal });
    usage = result.usage;
    // 模型调用期间：查看者可能离开、墙可能关闭、找到的人可能更新 / 撤下 / 拉黑
    if (!findMemberWall(repos, viewerId, wall.id)) {
      record(false, 0);
      return { ok: false, error: 'gone' };
    }
    const now = new Map(visibleCandidates(deps, wall.id, viewerId).map((entry) => [entry.pageId, entry.publicationId]));
    const matches = result.matches.flatMap((match) => {
      const entry = entries[match.member - 1];
      if (!entry || now.get(entry.pageId) !== entry.publicationId) return [];
      return [{ pageId: entry.pageId, publicationId: entry.publicationId, reason: match.reason, quote: match.quote }];
    });
    if (result.matches.length > 0 && matches.length === 0) {
      record(false, 0);
      return { ok: false, error: 'gone' };
    }
    transaction(deps.db, () => {
      repos.asks.replace({
        id: generateId('ask'),
        wallId: wall.id,
        viewerId,
        question,
        candidates: entries.length,
        found: matches.length,
        createdAt: deps.now().toISOString(),
        matches,
      });
      record(true, matches.length);
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AskError) {
      usage = error.usage;
      record(false, 0);
      if (error.code === 'TIMEOUT') return { ok: false, error: 'timeout' };
      return { ok: false, error: error.accessCode ?? 'failed' };
    }
    record(false, 0);
    const accessCode = modelFailureCode(error);
    if (accessCode) return { ok: false, error: accessCode };
    deps.log(`[web] 问墙：处理出错（${error instanceof Error ? error.name : 'unknown'}）`);
    return { ok: false, error: 'failed' };
  } finally {
    clearTimeout(timer);
    busy.delete(viewerId);
  }
}

/** 数据导出（contracts 14）：他在仍是成员的墙上最近一次提问，和当前仍会展示给他的结果。 */
export function exportAsks(deps: Pick<AppDeps, 'db' | 'repos' | 'config'>, userId: string) {
  return deps.repos.asks.wallsForViewer(userId).flatMap((wallId) => {
    const member = findMemberWall(deps.repos, userId, wallId);
    const record = member ? deps.repos.asks.findForViewerWall(userId, wallId) : null;
    if (!member || !record) return [];
    const view = toView(deps, record, wallId, visibleCandidates(deps, wallId, userId));
    return [
      {
        wallId,
        wallName: member.wall.name,
        question: view.question,
        createdAt: view.createdAt,
        matches: view.matches.map(({ displayName, reason, quote }) => ({ about: displayName, reason, quote })),
      },
    ];
  });
}

/** 查看者清除自己在这面墙的提问与结果。 */
export function clearAsk(deps: Pick<AppDeps, 'repos'>, member: MemberWall): number {
  return deps.repos.asks.deleteForViewerWall(member.membership.userId, member.wall.id);
}
