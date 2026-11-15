/**
 * 墙的群像（contracts 19.3）：组织者请 AI 汇总“这群人”，结果全墙成员可见，可以一键复制发到群里。
 *
 * - 只有组织者能生成 / 刷新（用组织者自己的模型配置，没有时用平台 AI，不收点数，计入全站免费调用上限）；
 *   每面墙每 24 小时最多 `dailyPerWall` 次，同一面墙同时只跑一次。
 * - 输入只有墙上可见的发布快照（一行介绍、接话点）与这些人的必答题回答；不读渲染文字、草稿、采访、联系方式。
 *   至少 `minPages` 人上墙才能生成。
 * - 人数：必答题的统计由服务端按生成时墙上的人计算（准确），主题人数由服务端按模型列出的编号数（见 hosted/portrait.ts）。
 * - 展示条件：生成时用到的每一条发布都还在墙上，或只是被同一页的新版本替换（`superseded`）。有人撤下、被移出、
 *   退出、注销、页面被组织者或平台撤下后，群像不再展示，组织者后台提示重新生成。墙关闭时删除。
 */
import { loadSceneGuide } from '@nowme/skill';
import { PORTRAIT_LIMITS } from '../constants.js';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import { wallQueries, type PublishedEntry } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { clip, stripControl } from '../hosted/brief.js';
import { emptyUsage, type UsageTotals } from '../hosted/model-client.js';
import { modelFailureCode, type ModelAccessCode } from '../hosted/model-errors.js';
import { PortraitError, runPortrait, type PortraitInput, type PortraitTheme } from '../hosted/portrait.js';
import { answersForWall, questionStats, type QuestionStats } from './wall-questions.js';
import { parsePublishedCard } from './wall-view.js';

type PortraitDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'hosted' | 'log'>;

const L = PORTRAIT_LIMITS;
const DAY_MS = 24 * 3600 * 1000;

export interface PortraitView {
  summary: string;
  themes: PortraitTheme[];
  /** 生成时按必答题统计的人数（只算当时墙上的人）。 */
  stats: QuestionStats[];
  pageCount: number;
  createdAt: string;
  /** 生成之后更新过页面的人数（内容可能已经不一样了）。 */
  updated: number;
}

export type PortraitState =
  | { kind: 'none' }
  | { kind: 'hidden' }
  | { kind: 'ready'; view: PortraitView };

export type PortraitFailure = ModelAccessCode | 'busy' | 'daily' | 'too-few' | 'failed' | 'timeout';

export const PORTRAIT_ERROR_TEXT: Record<PortraitFailure, string> = {
  MODEL_CONFIG: '还没有可用的 AI 配置。请先在 AI 设置里保存模型服务，再回来试试。',
  MODEL_AUTH: '模型服务拒绝了凭证，请在 AI 设置里检查 API Key 和模型权限。',
  MODEL_RATE_LIMITED: '模型服务限流或余额不足，请稍后再试。',
  MODEL_UNAVAILABLE: '暂时连不上模型服务，请稍后再试。',
  busy: '群像还在生成，稍等一会儿再刷新页面。',
  daily: `今天生成群像的次数用完了（每面墙每 24 小时 ${L.dailyPerWall} 次），明天再来。`,
  'too-few': `至少 ${L.minPages} 个人上墙后才能生成群像，现在人还太少。`,
  failed: 'AI 这次没有给出可用的群像，没有保存。可以再试一次。',
  timeout: 'AI 想得太久了，这次没有结果。可以再试一次。',
};

interface StoredResult {
  summary: string;
  themes: PortraitTheme[];
  stats: QuestionStats[];
}

function parseResult(json: string): StoredResult | null {
  try {
    const raw = JSON.parse(json) as Partial<StoredResult>;
    if (typeof raw.summary !== 'string' || !Array.isArray(raw.themes) || !Array.isArray(raw.stats)) return null;
    return { summary: raw.summary, themes: raw.themes, stats: raw.stats };
  } catch {
    return null;
  }
}

/** 这面墙现在的群像（见文件头的展示条件）。 */
export function loadPortrait(deps: Pick<AppDeps, 'repos'>, wallId: string): PortraitState {
  const record = deps.repos.portraits.find(wallId);
  if (!record) return { kind: 'none' };
  const result = parseResult(record.resultJson);
  if (!result) return { kind: 'hidden' };
  const states = deps.repos.portraits.sourceStates(record.sources);
  let updated = 0;
  for (const id of record.sources) {
    const state = states.get(id);
    if (!state) return { kind: 'hidden' };
    if (state.endedAt === null) continue;
    if (state.endReason !== 'superseded') return { kind: 'hidden' };
    updated += 1;
  }
  return { kind: 'ready', view: { ...result, pageCount: record.pageCount, createdAt: record.createdAt, updated } };
}

function clean(text: string, max: number): string {
  return clip(stripControl(text).replace(/\s+/g, ' ').trim(), max);
}

/** 墙上可见的全部发布（不按查看者过滤拉黑：群像对全墙一样，且只有聚合内容）；超过上限时取最近发布的。 */
function sourceEntries(deps: Pick<AppDeps, 'db'>, wallId: string): PublishedEntry[] {
  const entries = wallQueries(deps.db).listPublished(wallId);
  return entries.length > L.maxPages ? entries.slice(entries.length - L.maxPages) : entries;
}

export function canGeneratePortrait(deps: Pick<AppDeps, 'db'>, wallId: string): boolean {
  return wallQueries(deps.db).countPublished(wallId) >= L.minPages;
}

function buildInput(deps: PortraitDeps, wall: Wall, entries: PublishedEntry[]): { input: PortraitInput; stats: QuestionStats[] } {
  const questions = deps.repos.questions.listForWall(wall.id);
  const answers = answersForWall(deps, wall.id, questions);
  const names: string[] = [];
  const pages = entries.map((entry) => {
    const nickname = deps.repos.users.findById(entry.ownerId)?.nickname ?? '';
    const card = parsePublishedCard(entry.cardJson, nickname);
    names.push(card.displayName, nickname);
    const mine = answers.get(entry.ownerId);
    return {
      tagline: clean(card.tagline, 80),
      hooks: card.hooks.slice(0, 4).map((hook) => clean(hook.text, 50)).filter(Boolean),
      answers: questions.flatMap((question) => {
        const chosen = mine?.get(question.id);
        return chosen ? [`${clean(question.prompt, 30)}：${chosen.join('、')}`] : [];
      }),
    };
  });
  return {
    input: { wall: { name: wall.name, description: clean(wall.description, 200), sceneLabel: loadSceneGuide(wall.sceneType).label }, pages, names: names.filter(Boolean) },
    stats: questionStats(questions, answers, entries.map((entry) => entry.ownerId)),
  };
}

const inFlight = new WeakMap<object, Set<string>>();

export type PortraitResult = { ok: true } | { ok: false; error: PortraitFailure };

/** 组织者生成 / 刷新群像（调用方已确认是这面墙的组织者）。 */
export async function generatePortrait(deps: PortraitDeps, wall: Wall, organizerId: string): Promise<PortraitResult> {
  const hosted = deps.hosted;
  if (!hosted || !hosted.modelReady(organizerId)) return { ok: false, error: 'MODEL_CONFIG' };
  const entries = sourceEntries(deps, wall.id);
  if (entries.length < L.minPages) return { ok: false, error: 'too-few' };
  const since = new Date(deps.now().getTime() - DAY_MS).toISOString();
  const attempts = deps.repos.events.countForWallSince(wall.id, 'wall_portrait_generate', since);
  if (attempts >= L.dailyPerWall) return { ok: false, error: 'daily' };

  let busy = inFlight.get(deps.db);
  if (!busy) inFlight.set(deps.db, (busy = new Set()));
  if (busy.has(wall.id)) return { ok: false, error: 'busy' };
  busy.add(wall.id);

  const started = Date.now();
  let usage: UsageTotals = emptyUsage();
  const record = (ok: boolean, themes: number) =>
    deps.repos.events.record({
      type: 'wall_portrait_generate',
      wallId: wall.id,
      pageId: null,
      actorId: organizerId,
      props: { ok, durationMs: Date.now() - started, pages: entries.length, themes, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      createdAt: deps.now().toISOString(),
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), L.timeoutMs);
  try {
    const { input, stats } = buildInput(deps, wall, entries);
    const model = hosted.resolveModel(organizerId, 'interview');
    const result = await runPortrait(model.client, model.endpoint.model!, input, { signal: controller.signal });
    usage = result.usage;
    // 模型调用期间墙可能被关闭、组织者可能换人：重新确认
    const current = deps.repos.walls.findById(wall.id);
    if (!current || current.status !== 'open' || current.organizerId !== organizerId) {
      record(false, 0);
      return { ok: false, error: 'failed' };
    }
    transaction(deps.db, () => {
      deps.repos.portraits.replace({
        wallId: wall.id,
        resultJson: JSON.stringify({ summary: result.output.summary, themes: result.output.themes, stats }),
        sources: entries.map((entry) => entry.publicationId),
        pageCount: entries.length,
        createdBy: organizerId,
        createdAt: deps.now().toISOString(),
      });
      record(true, result.output.themes.length);
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof PortraitError) {
      usage = error.usage;
      record(false, 0);
      if (error.code === 'TIMEOUT') return { ok: false, error: 'timeout' };
      return { ok: false, error: error.accessCode ?? 'failed' };
    }
    record(false, 0);
    const accessCode = modelFailureCode(error);
    if (accessCode) return { ok: false, error: accessCode };
    deps.log(`[web] 墙的群像：处理出错（${error instanceof Error ? error.name : 'unknown'}）`);
    return { ok: false, error: 'failed' };
  } finally {
    clearTimeout(timer);
    busy.delete(wall.id);
  }
}

/** 发到群里的文字（全墙成员都能复制）。 */
export function portraitShareText(wall: Wall, view: PortraitView, wallUrl: string): string {
  const lines = [`「${wall.name}」的群像 · ${view.pageCount} 人上墙`];
  if (view.summary) lines.push(view.summary);
  for (const stat of view.stats) {
    const top = stat.options.filter((option) => option.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
    if (top.length > 0) lines.push(`${stat.prompt}：${top.map((option) => `${option.label} ${option.count}`).join(' · ')}`);
  }
  if (view.themes.length > 0) lines.push(`大家最想聊：${view.themes.map((theme) => `${theme.title}（${theme.count} 人）`).join('、')}`);
  lines.push(`来墙上找人：${wallUrl}`);
  return lines.join('\n');
}
