/**
 * AI 介绍值得认识的人（contracts 20）：成员不用一页页翻墙，AI 读完他自己的资料和墙上的人，
 * 主动介绍几位适合他认识的人（能一起学习的、兴趣相投的、可以合作的），并说明为什么。
 *
 * 授权与隐私（S14）：
 * - 只有这面墙的有效成员能发起，只看这面墙；候选是墙上对他可见的、别人的已发布页面（不含自己、互相拉黑的人）。
 * - 交给模型的只有两类内容：查看者**自己的**资料（这面墙上已发布的页面、确认过的采访摘要、自己的必答题回答），
 *   和候选**已经公开在这面墙上**的内容（发布快照的一行介绍与接话点、公开的必答题回答、当前发布版本的渲染文字摘录）。
 *   不读任何人的草稿、未发布版本、采访、画像、联系方式，也不给模型名字。
 * - 模型按查看者自己的配置（`interview` 角色），没有时用平台 AI（不收点数，计入全站免费调用上限）。
 * - 结果只属于查看者：只按 `viewer_id` 读取；被介绍的人、组织者、其他成员都看不到，平台不发任何通知。
 *   每一位都绑定对方当时的发布：对方更新 / 撤下、拉黑、离开墙后那一位不再展示。
 * - 第一次是自动的：查看者在这面墙有了资料、从没发起过时，墙页加载后自动发起一次（失败也不再自动）；之后由他自己点。
 */
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  generateId,
  INTRO_CANDIDATE_TEXT_BUDGET,
  INTRO_CANDIDATE_TEXT_RANGE,
  INTRO_DAILY_PER_VIEWER,
  INTRO_DAILY_PER_WALL,
  INTRO_LIMITS,
  INTRO_TIMEOUT_MS,
  INTRO_VIEWER_TEXT_MAX,
} from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { IntroKind, IntroRecord } from '../db/intros.js';
import { wallQueries, type PublishedEntry } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { clip, stripControl } from '../hosted/brief.js';
import { viewerCorpus } from '../hosted/icebreaker.js';
import { IntroError, runIntro, type IntroCandidate, type IntroInput } from '../hosted/intro.js';
import { emptyUsage, type UsageTotals } from '../hosted/model-client.js';
import { modelFailureCode, type ModelAccessCode } from '../hosted/model-errors.js';
import { findMemberWall, type MemberWall } from './access.js';
import { viewerMaterial } from './icebreaker.js';
import { coverFilePath, coverPath, memberPagePath, parsePublishedCard } from './wall-view.js';
import { answersForWall } from './wall-questions.js';

type IntroDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'hosted' | 'log' | 'config'>;

const L = INTRO_LIMITS;
const DAY_MS = 24 * 3600 * 1000;

export const INTRO_KIND_LABEL: Record<IntroKind, string> = { learn: '能一起学习', interest: '兴趣相投', collab: '可以合作' };

/** 给查看者看的一位。 */
export interface IntroCardView {
  pageId: string;
  href: string;
  coverSrc: string | null;
  /** 名字取自对方的发布快照，不来自模型。 */
  displayName: string;
  kind: IntroKind;
  title: string;
  reason: string;
  mine: string;
  theirs: string;
}

export interface IntroView {
  id: string;
  createdAt: string;
  sources: { page: boolean; brief: boolean };
  picks: IntroCardView[];
}

/**
 * 墙上“AI 介绍给你的人”区块的状态。`candidates` 是墙上对查看者可见的别人的页面数。
 * - hidden：可以介绍的人太少（直接逛墙就好），不显示区块；
 * - no-material：查看者在这面墙还没有资料，AI 还不认识他；
 * - no-model：没有可用的 AI；
 * - start：可以开始；`auto` 表示从没发起过，墙页加载后自动发起；
 * - ready：有结果；`newcomers` 是生成之后墙上新来的人数；
 * - stale：有过结果，但介绍的人都更新、撤下或离开了。
 */
export type IntroPanel =
  | { kind: 'hidden' }
  | { kind: 'no-material'; candidates: number }
  | { kind: 'no-model'; candidates: number }
  | { kind: 'start'; candidates: number; auto: boolean }
  | { kind: 'ready'; candidates: number; view: IntroView; newcomers: number }
  | { kind: 'stale'; candidates: number; newcomers: number };

export type IntroFailure = ModelAccessCode | 'busy' | 'daily' | 'wall-daily' | 'too-few' | 'no-material' | 'failed' | 'timeout' | 'gone';
export type IntroResult = { ok: true } | { ok: false; error: IntroFailure };

/** 失败时给查看者看的固定文案（不含模型输出）。 */
export const INTRO_ERROR_TEXT: Record<IntroFailure, string> = {
  MODEL_CONFIG: '现在还没有可用的 AI。先到“AI 设置”里填上你自己的模型，再回来试一次。',
  MODEL_AUTH: '你的模型服务不认这个 Key（可能填错了、已过期，或没有权限）。到“AI 设置”里检查一下。',
  MODEL_RATE_LIMITED: '模型服务那边限流了，或者账户余额不够。过几分钟再试。',
  MODEL_UNAVAILABLE: '暂时连不上模型服务。过几分钟再试一次。',
  busy: 'AI 还在看墙上的人，等十来秒再刷新一下。',
  daily: `今天请 AI 介绍的次数用完了（每 24 小时 ${INTRO_DAILY_PER_VIEWER} 次）。明天再来，或者先自己逛逛墙。`,
  'wall-daily': `这面墙今天已经帮你换过 ${INTRO_DAILY_PER_WALL} 次了。不如先去认识一下上面这几位。`,
  'too-few': `墙上还不到 ${L.minCandidates} 个人，直接逛逛就能看完。`,
  'no-material': 'AI 还不认识这面墙上的你。先做好你的一页（或者和 AI 聊完采访），它才知道该介绍谁。',
  failed: 'AI 这次没找到站得住的理由，没有保存。可以再试一次。',
  timeout: 'AI 看得太久了，这次没有结果。可以再试一次。',
  gone: '刚才那几位更新了页面或离开了墙。再试一次吧。',
};

function clean(text: string | null | undefined, max: number): string {
  return clip(stripControl(text ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'), max);
}

/** 墙上对查看者可见的、别人的已发布页面（拉黑双向生效）。 */
function visibleCandidates(deps: Pick<AppDeps, 'db' | 'repos'>, wallId: string, viewerId: string): PublishedEntry[] {
  const hidden = deps.repos.moderation.hiddenPeers(viewerId);
  return wallQueries(deps.db).listPublished(wallId).filter((entry) => entry.ownerId !== viewerId && !hidden.has(entry.ownerId));
}

function hasViewerMaterial(deps: Pick<AppDeps, 'db' | 'repos'>, viewerId: string, wallId: string): boolean {
  return viewerCorpus({ viewer: viewerMaterial(deps, viewerId, wallId) }).length > 0;
}

function withinLimits(deps: Pick<AppDeps, 'repos' | 'now'>, viewerId: string, wallId: string): IntroFailure | null {
  const since = new Date(deps.now().getTime() - DAY_MS).toISOString();
  if (deps.repos.intros.countAttemptsSince(viewerId, since) >= INTRO_DAILY_PER_VIEWER) return 'daily';
  if (deps.repos.intros.countAttemptsForWallSince(viewerId, wallId, since) >= INTRO_DAILY_PER_WALL) return 'wall-daily';
  return null;
}

/** 保存的结果里仍然有效的几位：对方现在的发布必须还是当时那一条、仍对查看者可见。 */
function livePicks(deps: Pick<AppDeps, 'repos' | 'config'>, record: IntroRecord, wallId: string, visible: Map<string, PublishedEntry>): IntroCardView[] {
  return record.picks.flatMap((pick) => {
    const entry = visible.get(pick.pageId);
    if (!entry || entry.publicationId !== pick.publicationId) return [];
    const card = parsePublishedCard(entry.cardJson, deps.repos.users.findById(entry.ownerId)?.nickname ?? '成员');
    return [
      {
        pageId: entry.pageId,
        href: memberPagePath(wallId, entry.pageId),
        coverSrc: existsSync(coverFilePath(deps.config.dataDir, entry.revisionId)) ? coverPath(wallId, entry.pageId) : null,
        displayName: card.displayName,
        kind: pick.kind,
        title: pick.title,
        reason: pick.reason,
        mine: pick.mine,
        theirs: pick.theirs,
      },
    ];
  });
}

export function loadIntroPanel(deps: Pick<AppDeps, 'db' | 'repos' | 'now' | 'hosted' | 'config'>, member: MemberWall): IntroPanel {
  const wallId = member.wall.id;
  const viewerId = member.membership.userId;
  const candidates = visibleCandidates(deps, wallId, viewerId);
  const record = deps.repos.intros.findForViewerWall(viewerId, wallId);
  if (record) {
    const visible = new Map(candidates.map((entry) => [entry.pageId, entry]));
    const seen = new Set(record.seen);
    const newcomers = candidates.filter((entry) => !seen.has(entry.pageId)).length;
    const picks = livePicks(deps, record, wallId, visible);
    const count = candidates.length;
    if (picks.length > 0) return { kind: 'ready', candidates: count, view: { id: record.id, createdAt: record.createdAt, sources: record.sources, picks }, newcomers };
    if (count >= L.minCandidates) return { kind: 'stale', candidates: count, newcomers };
  }
  const count = candidates.length;
  if (count < L.minCandidates) return { kind: 'hidden' };
  if (!hasViewerMaterial(deps, viewerId, wallId)) return { kind: 'no-material', candidates: count };
  if (!deps.hosted?.modelReady(viewerId)) return { kind: 'no-model', candidates: count };
  const auto = !deps.repos.intros.hasAttempted(viewerId, wallId) && withinLimits(deps, viewerId, wallId) === null;
  return { kind: 'start', candidates: count, auto };
}

/** 查看者在这面墙被 AI 介绍过、且仍然有效的页面（墙上卡片的小标记；只有查看者自己看得到）。 */
export function introducedPages(deps: Pick<AppDeps, 'repos'>, viewerId: string, wallId: string, entries: PublishedEntry[]): Set<string> {
  const record = deps.repos.intros.findForViewerWall(viewerId, wallId);
  if (!record) return new Set();
  const current = new Map(entries.map((entry) => [entry.pageId, entry.publicationId]));
  return new Set(record.picks.filter((pick) => current.get(pick.pageId) === pick.publicationId).map((pick) => pick.pageId));
}

/** 成员页上“AI 为什么介绍你们认识”：查看者对这一页仍然有效的那一条介绍。 */
export function introForPage(deps: Pick<AppDeps, 'repos'>, viewerId: string, wallId: string, entry: PublishedEntry): { kind: IntroKind; title: string; reason: string } | null {
  if (entry.ownerId === viewerId) return null;
  const pick = deps.repos.intros.findForViewerWall(viewerId, wallId)?.picks.find((item) => item.pageId === entry.pageId && item.publicationId === entry.publicationId);
  return pick ? { kind: pick.kind, title: pick.title, reason: pick.reason } : null;
}

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

function answerLines(questions: ReturnType<AppDeps['repos']['questions']['listForWall']>, mine: Map<string, string[]> | undefined): string[] {
  return questions.flatMap((question) => {
    const chosen = mine?.get(question.id);
    return chosen ? [`${clean(question.prompt, 30)}：${chosen.join('、')}`] : [];
  });
}

function buildInput(deps: IntroDeps, wall: Wall, viewerId: string, entries: PublishedEntry[], previousPages: Set<string>): IntroInput {
  const { repos } = deps;
  const questions = repos.questions.listForWall(wall.id);
  const answers = answersForWall(deps, wall.id, questions);
  const perPage = Math.max(INTRO_CANDIDATE_TEXT_RANGE.min, Math.min(INTRO_CANDIDATE_TEXT_RANGE.max, Math.floor(INTRO_CANDIDATE_TEXT_BUDGET / Math.max(1, entries.length))));
  const viewer = viewerMaterial(deps, viewerId, wall.id);
  const candidates: IntroCandidate[] = entries.map((entry) => {
    const card = parsePublishedCard(entry.cardJson, repos.users.findById(entry.ownerId)?.nickname ?? '成员');
    return {
      name: card.displayName,
      tagline: clean(card.tagline, 120),
      hooks: card.hooks.map((hook) => clean(hook.text, 60)).filter(Boolean),
      answers: answerLines(questions, answers.get(entry.ownerId)),
      pageText: clean(repos.revisions.findById(entry.revisionId)?.renderedText, perPage),
    };
  });
  return {
    wall: { name: wall.name, description: clean(wall.description, 200), sceneLabel: loadSceneGuide(wall.sceneType).label },
    viewer: { ...viewer, pageText: clip(viewer.pageText, INTRO_VIEWER_TEXT_MAX), answers: answerLines(questions, answers.get(viewerId)) },
    candidates,
    previous: entries.flatMap((entry, index) => (previousPages.has(entry.pageId) ? [index + 1] : [])),
  };
}

const inFlight = new WeakMap<object, Set<string>>();

/**
 * 发起一次（首次自动或“换一批”）。按查看者限流；同一查看者同时只跑一次。
 * 模型调用结束后重新做一次授权检查：查看者失去访问、墙关闭 → 不保存；介绍的人里更新 / 撤下 / 拉黑 / 离开的去掉，
 * 一位都不剩时不保存（`gone`）。
 */
export async function generateIntro(deps: IntroDeps, member: MemberWall): Promise<IntroResult> {
  const { repos } = deps;
  const wall = member.wall;
  const viewerId = member.membership.userId;
  const hosted = deps.hosted;
  if (!hosted || !hosted.modelReady(viewerId)) return { ok: false, error: 'MODEL_CONFIG' };
  if (!hasViewerMaterial(deps, viewerId, wall.id)) return { ok: false, error: 'no-material' };
  const all = visibleCandidates(deps, wall.id, viewerId);
  if (all.length < L.minCandidates) return { ok: false, error: 'too-few' };
  const limited = withinLimits(deps, viewerId, wall.id);
  if (limited) return { ok: false, error: limited };

  let busy = inFlight.get(deps.db);
  if (!busy) inFlight.set(deps.db, (busy = new Set()));
  if (busy.has(viewerId)) return { ok: false, error: 'busy' };
  busy.add(viewerId);

  // 这面墙上的第一次（墙页自动发起的就是这一次）：由服务端按记录判断，不信任客户端
  const first = !repos.intros.hasAttempted(viewerId, wall.id);
  const started = Date.now();
  let usage: UsageTotals = emptyUsage();
  let input: IntroInput | null = null;
  // 候选每次随机排列（不按热度，W13）；人太多时随机取样
  const entries = shuffled(all).slice(0, L.maxCandidates);
  const record = (ok: boolean, picks: number) =>
    repos.events.record({
      type: 'intro_generate',
      wallId: wall.id,
      pageId: null,
      actorId: viewerId,
      props: {
        ok,
        first,
        durationMs: Date.now() - started,
        candidates: entries.length,
        picks,
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
  const timer = setTimeout(() => controller.abort(), INTRO_TIMEOUT_MS);
  try {
    const previous = new Set(repos.intros.findForViewerWall(viewerId, wall.id)?.picks.map((pick) => pick.pageId) ?? []);
    input = buildInput(deps, wall, viewerId, entries, previous);
    const model = hosted.resolveModel(viewerId, 'interview');
    const result = await runIntro(model.client, model.endpoint.model!, input, { signal: controller.signal });
    usage = result.usage;
    // 模型调用期间：查看者可能离开、墙可能关闭、介绍的人可能更新 / 撤下 / 拉黑
    if (!findMemberWall(repos, viewerId, wall.id)) {
      record(false, 0);
      return { ok: false, error: 'gone' };
    }
    const now = new Map(visibleCandidates(deps, wall.id, viewerId).map((entry) => [entry.pageId, entry.publicationId]));
    const picks = result.picks.flatMap((pick) => {
      const entry = entries[pick.member - 1];
      if (!entry || now.get(entry.pageId) !== entry.publicationId) return [];
      return [{ pageId: entry.pageId, publicationId: entry.publicationId, kind: pick.kind, title: pick.title, reason: pick.reason, mine: pick.mine, theirs: pick.theirs }];
    });
    if (picks.length === 0) {
      record(false, 0);
      return { ok: false, error: 'gone' };
    }
    const sources = { page: !!input.viewer.pageText || !!input.viewer.card, brief: !!input.viewer.brief };
    transaction(deps.db, () => {
      repos.intros.replace({
        id: generateId('itr'),
        wallId: wall.id,
        viewerId,
        sources,
        seen: all.map((entry) => entry.pageId),
        createdAt: deps.now().toISOString(),
        picks,
      });
      record(true, picks.length);
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof IntroError) {
      usage = error.usage;
      record(false, 0);
      if (error.code === 'TIMEOUT') return { ok: false, error: 'timeout' };
      return { ok: false, error: error.accessCode ?? 'failed' };
    }
    record(false, 0);
    const accessCode = modelFailureCode(error);
    if (accessCode) return { ok: false, error: accessCode };
    deps.log(`[web] AI 介绍：处理出错（${error instanceof Error ? error.name : 'unknown'}）`);
    return { ok: false, error: 'failed' };
  } finally {
    clearTimeout(timer);
    busy.delete(viewerId);
  }
}

/** 数据导出（contracts 14）：只导出当前仍会展示给他的介绍（仍是成员、对方仍在墙上且发布没变）。 */
export function exportIntros(deps: Pick<AppDeps, 'db' | 'repos' | 'config'>, userId: string) {
  return deps.repos.intros.wallsForViewer(userId).flatMap((wallId) => {
    const member = findMemberWall(deps.repos, userId, wallId);
    const record = member ? deps.repos.intros.findForViewerWall(userId, wallId) : null;
    if (!member || !record) return [];
    const visible = new Map(visibleCandidates(deps, wallId, userId).map((entry) => [entry.pageId, entry]));
    const picks = livePicks(deps, record, wallId, visible).map(({ displayName, kind, title, reason, mine, theirs }) => ({ about: displayName, kind, title, reason, mine, theirs }));
    return picks.length > 0 ? [{ wallId, wallName: member.wall.name, createdAt: record.createdAt, picks }] : [];
  });
}

/** 查看者清除自己在这面墙的结果。 */
export function clearIntro(deps: Pick<AppDeps, 'repos'>, member: MemberWall): number {
  return deps.repos.intros.deleteForViewerWall(member.membership.userId, member.wall.id);
}
