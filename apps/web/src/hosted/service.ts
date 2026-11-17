/**
 * 平台托管路线的服务（contracts 9 / hosted-route.md）：应用内采访的状态机、长期画像写回、生成 / 修改任务。
 *
 * 授权：所有方法的 `own` 必须来自路由里的 `findOwnPage(repos, 当前用户, wallId)`；`userId` 是当前登录用户。
 * 数据只按主人自己的 ID 读写（S7）。生成 / 修改任务在这里只入队；执行见 `hosted/job-runner.ts`
 * （在 worker 里运行，S8：独立临时目录、结束必删、平台重新校验；contracts 13）。
 */
import {
  BRIEF_ASSETS_MAX_COUNT,
  generateId,
  type HostedConfig,
  type SceneGuide,
} from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { BriefAsset, BriefRecord, GenerationJob, JobKind, JobModelSource, ProfileCategory } from '../db/hosted.js';
import type { EventProps } from '../db/events.js';
import { InsufficientCredits } from '../db/credits.js';
import { findOwnPage, type OwnPage } from '../services/access.js';
import { aiStatus, chargeJob, planJob, type AiStatus } from '../services/billing.js';
import type { JobDispatch } from '../worker/dispatch.js';
import { assetFileName, checkUpload, readAsset, writeAsset } from './assets.js';
import { normalizedProfileText } from './profile.js';
import { knownContext, type KnownContext } from './known-context.js';
import { eraseBriefRecord } from './data.js';
import {
  renderBriefMarkdown,
  toStructuredBrief,
  type BriefHook,
  type ReviewEdits,
  type FollowupAnswer,
  type FollowupState,
  type InterviewAnswers,
  type StructuredBrief,
} from './brief.js';
import { modelFailureCode, type ModelAccessCode } from './model-errors.js';
import type { ModelRole, ResolvedModel } from './user-models.js';
import type { UsageTotals } from './model-client.js';
import { InterviewError, runComposeBrief, runInterviewDraft } from './interview.js';

type HostedDeps = Pick<AppDeps, 'config' | 'db' | 'repos' | 'now' | 'kitFonts' | 'log'>;

export interface HostedServiceOptions {
  settings: HostedConfig;
  /**
   * 不收点数的调用（采访、和 TA 聊什么）用的客户端：用户有自己的模型配置就用自己的，否则用平台 AI（contracts 12）。
   * 采访与生成可以是不同的模型（hosted-route 1.1）。
   */
  resolve(userId: string, role: ModelRole): ResolvedModel;
  /** 这个用户现在能不能用 AI（自己的配置或平台 AI，任一可用）。 */
  ready(userId: string): boolean;
  /** 这个用户有没有自己的、可用的模型配置（不算平台 AI）。 */
  ownReady(userId: string): boolean;
  /** 平台 AI 是否可用。 */
  platformAvailable: boolean;
  /**
   * 入队时记下用户模型配置的版本号（只对 own 有意义，fake 模型时为 null）：worker 按它取模型，
   * 排队期间主人删除或更换了配置时任务以 MODEL_CONFIG 失败（S8：删除或更换后旧任务停止后续请求）。
   */
  pinModel(userId: string, source: JobModelSource): string | null;
  /** 任务队列（contracts 13）：入队后叫醒 worker；`idle` 等待同进程 worker 空闲。 */
  dispatch: Pick<JobDispatch, 'kick' | 'idle'>;
}

export type StepError =
  | ModelAccessCode
  | 'rate-limited'
  | 'model-failed'
  | 'wrong-state'
  | 'too-many-images'
  | 'image-type'
  | 'image-too-large'
  | 'need-two-hooks'
  | 'need-one-sentence'
  | 'hook-invalid'
  | 'note-empty';
export type StepResult = { ok: true } | { ok: false; error: StepError };

export type JobStartError = ModelAccessCode | 'busy' | 'daily' | 'no-brief' | 'no-revision' | 'bad-block' | 'bad-request' | 'credits';
export type JobStartResult = { ok: true; job: GenerationJob } | { ok: false; error: JobStartError };

/** 解析后的 brief 状态（只给主人）。 */
export interface BriefView {
  record: BriefRecord;
  answers: InterviewAnswers | null;
  followups: FollowupState | null;
  brief: StructuredBrief | null;
  assets: BriefAsset[];
}

export interface HostedOverview {
  modelReady: boolean;
  /** 用谁的模型、要不要点数、够不够（contracts 12）。 */
  ai: AiStatus;
  brief: BriefView | null;
  activeJob: GenerationJob | null;
  recentJobs: GenerationJob[];
}

export type ConfirmEdits = ReviewEdits;

export interface JobRequest {
  kind: JobKind;
  baseRevisionId?: string | null;
  targetBlock?: string | null;
  request?: string | null;
  rememberFacts?: boolean;
}

export interface HostedService {
  readonly settings: HostedConfig;
  overview(own: OwnPage, userId: string): HostedOverview;
  loadBrief(own: OwnPage, userId: string): BriefView | null;
  scene(own: OwnPage): SceneGuide;
  known(own: OwnPage, userId: string): KnownContext;
  startInterview(own: OwnPage, userId: string, answers: InterviewAnswers, uploads: Uint8Array[]): Promise<StepResult>;
  answerFollowups(own: OwnPage, userId: string, answers: Record<string, FollowupAnswer>, edits?: ConfirmEdits): Promise<StepResult>;
  revise(own: OwnPage, userId: string, note: string): Promise<StepResult>;
  confirm(own: OwnPage, userId: string, edits: ConfirmEdits): StepResult;
  /** 返回填写页，保留答案与图片。 */
  restart(own: OwnPage, userId: string): Promise<void>;
  readAssetFile(userId: string, assetId: string, pageId: string): Promise<{ asset: BriefAsset; bytes: Uint8Array } | null>;
  startJob(own: OwnPage, userId: string, request: JobRequest): JobStartResult;
  findJob(own: OwnPage, userId: string, jobId: string): GenerationJob | null;
  /** 这个用户有没有可用的模型配置。 */
  modelReady(userId: string): boolean;
  /** 取这个用户的模型客户端（只能用于他本人发起的请求）。没有可用配置时抛 ModelAccessError。 */
  resolveModel(userId: string, role: ModelRole): ResolvedModel;
  /** 等待同进程 worker 把任务做完（测试用；separate 模式下立即返回）。 */
  idle(): Promise<void>;
}

const DAY_MS = 24 * 3600 * 1000;

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** 主人自己的 brief 状态（只按主人 ID 读，S7）。 */
export function loadBriefView(repos: AppDeps['repos'], own: OwnPage, userId: string): BriefView | null {
  const record = repos.briefs.findForPage(own.page.id, userId);
  if (!record) return null;
  return {
    record,
    answers: parse<InterviewAnswers>(record.answersJson),
    followups: parse<FollowupState>(record.followupsJson),
    brief: parse<StructuredBrief>(record.briefJson),
    assets: repos.briefAssets.listForBrief(record.id, userId),
  };
}

export function usageProps(usage: UsageTotals): EventProps {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

/** 任务失败时给主人看的固定文案（不含模型输出）。 */
export const JOB_ERROR_TEXT: Record<string, string> = {
  MODEL_CONFIG: 'AI 配置缺失、已更换或无法解密，请在 AI 设置中重新保存后再试。',
  MODEL_AUTH: '模型服务拒绝了凭证，请在 AI 设置中检查 API Key、模型权限和服务地址。',
  MODEL_RATE_LIMITED: '模型服务限流或账号余额不足，请检查服务商账号后再试。',
  MODEL_UNAVAILABLE: '暂时连不上 AI 模型服务，请稍后再试。',
  REJECTED: '生成的页面没有通过平台校验，没有保存。可以再试一次。',
  MAX_TURNS: '这次生成用了太多步还没完成，已停止。可以再试一次。',
  NO_FINISH: '这次生成没有正常结束。可以再试一次。',
  TIMEOUT: '这次生成超时了。可以再试一次。',
  API_ERROR: '暂时连不上生成服务，请稍后再试。',
  REFUSED: '生成服务拒绝了这次请求。可以换一种说法再试。',
  RATE_LIMITED: '这一页今天的版本数已达上限，明天再试。',
  PAGE_GONE: '这一页已经不可用（可能已退出墙或页面已删除），结果没有保存。',
  INTERRUPTED: '服务重启打断了这次生成。可以再试一次。',
  SUSPENDED: '账号已被停用，这次生成已停止，点数已全额退回。',
  INTERNAL: '服务器处理时出错了。可以再试一次。',
};

export function createHostedService(deps: HostedDeps, options: HostedServiceOptions): HostedService {
  const { repos, db, config } = deps;
  const { settings } = options;
  // 任务执行在 worker 里（hosted/job-runner.ts）；被打断任务的退点由 worker 启动与回收租约时处理（contracts 13.4）
  const access = (userId: string) => ({ ownReady: options.ownReady(userId), platformAvailable: options.platformAvailable });

  const sinceDay = () => new Date(deps.now().getTime() - DAY_MS).toISOString();
  const countInterviewCalls = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_interview_call' AND page_id = ? AND created_at > ?");

  const record = (type: Parameters<typeof repos.events.record>[0]['type'], own: OwnPage | { wallId: string; pageId: string }, actorId: string, props: EventProps) => {
    const ids = 'page' in own ? { wallId: own.wall.id, pageId: own.page.id } : own;
    repos.events.record({ type, wallId: ids.wallId, pageId: ids.pageId, actorId, props, createdAt: deps.now().toISOString() });
  };

  const loadBrief = (own: OwnPage, userId: string): BriefView | null => loadBriefView(repos, own, userId);

  const scene = (own: OwnPage): SceneGuide => loadSceneGuide(own.wall.sceneType);

  const interviewAllowed = (pageId: string): boolean =>
    Number((countInterviewCalls.get(pageId, sinceDay()) as { n: number }).n) < settings.interviewDailyCalls;

  const recordCall = (own: OwnPage, userId: string, step: number, ok: boolean, started: number, usage: UsageTotals) =>
    record('hosted_interview_call', own, userId, { step, ok, durationMs: Date.now() - started, ...usageProps(usage) });

  const saveBrief = (view: BriefView, patch: Partial<BriefRecord>) => {
    repos.briefs.update({ ...view.record, ...patch, updatedAt: deps.now().toISOString() });
  };

  /** 调用 #2 / #3。成功后状态 review。 */
  async function compose(own: OwnPage, userId: string, view: BriefView, note: string | null, edits?: ConfirmEdits): Promise<StepResult> {
    if (!view.answers || !view.followups) return { ok: false, error: 'wrong-state' };
    note ??= view.followups.correction ?? null;
    if (!interviewAllowed(own.page.id)) return { ok: false, error: 'rate-limited' };
    const started = Date.now();
    const sceneGuide = scene(own);
    try {
      const model = options.resolve(userId, 'interview');
      const known = knownContext(repos, own, userId, sceneGuide);
      const result = await runComposeBrief(
        model.client,
        model.endpoint.model!,
        {
          wall: own.wall,
          scene: sceneGuide,
          answers: view.answers,
          profile: known.profile,
          knownAnswers: [...(known.nickname ? [{ question: '账号昵称（可更改）', answers: [known.nickname] }] : []), ...known.knownAnswers],
          imageFiles: view.assets.map((asset) => asset.fileName),
        },
        view.followups,
        note && view.brief ? { previous: view.brief, note } : null,
      );
      recordCall(own, userId, note ? 3 : 2, true, started, result.usage);
      const current = loadBrief(own, userId);
      if (!findOwnPage(repos, userId, own.wall.id) || current?.record.id !== view.record.id || current.record.briefJson !== view.record.briefJson || current.record.status !== view.record.status || current.record.followupsJson !== view.record.followupsJson || current.record.answersJson !== view.record.answersJson) return { ok: false, error: 'wrong-state' };
      const files = new Set(view.assets.map((asset) => asset.fileName));
      const output = { ...result.output, images: result.output.images.filter((image) => files.has(image.file)) };
      const structured = toStructuredBrief(output, view.answers);
      const reviewEdits = edits ?? view.followups.reviewEdits;
      // 同时提交的改写和边界优先于模型重新整理，不能因为补一个例子而丢掉。
      if (reviewEdits && view.brief) {
        structured.profileSelection = view.brief.profileSuggestions.filter((_, i) => reviewEdits.keepProfile.includes(i)).map((p) => p.text);
        if (reviewEdits.displayName) structured.displayName = reviewEdits.displayName;
        if (reviewEdits.boundaries) structured.boundaries = reviewEdits.boundaries;
        structured.aiView = structured.aiView.map((sentence, i) => reviewEdits.aiView[i] && reviewEdits.aiView[i]!.text !== view.brief!.aiView[i] ? reviewEdits.aiView[i]!.text : sentence).filter((_, i) => !reviewEdits.aiView[i]?.drop);
        structured.hooks = structured.hooks.map((hook, i) => {
          const edit = reviewEdits.hooks[i]; const old = view.brief!.hooks[i];
          return edit && old ? { ...hook, text: edit.text !== old.text ? edit.text : hook.text, opener: edit.opener !== old.opener ? edit.opener : hook.opener } : hook;
        }).filter((_, i) => !reviewEdits.hooks[i]?.drop);
      }
      saveBrief(view, {
        status: 'review',
        followupsJson: JSON.stringify({ ...view.followups, pending: false, reviewEdits: undefined, correction: undefined }),
        answersJson: JSON.stringify({ ...view.answers, updates: [...(view.answers.updates ?? []), ...(note ? [note] : [])] }),
        briefJson: JSON.stringify(structured),
        briefMd: renderBriefMarkdown(structured, own.wall, sceneGuide),
        confirmedAt: null,
      });
      return { ok: true };
    } catch (error) {
      recordCall(own, userId, note ? 3 : 2, false, started, error instanceof InterviewError ? error.usage : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      if (error instanceof InterviewError) return { ok: false, error: error.accessCode ?? 'model-failed' };
      const accessCode = modelFailureCode(error);
      if (accessCode) return { ok: false, error: accessCode };
      throw error;
    }
  }

  const eraseBrief = (brief: BriefRecord) => eraseBriefRecord(deps, brief);

  return {
    settings,
    loadBrief,
    scene,
    known: (own, userId) => knownContext(repos, own, userId, scene(own)),
    modelReady: (userId) => options.ready(userId),
    resolveModel: (userId, role) => options.resolve(userId, role),
    overview(own, userId) {
      return {
        modelReady: options.ready(userId),
        ai: aiStatus(deps, userId, own.wall.id, access(userId)),
        brief: loadBrief(own, userId),
        activeJob: repos.jobs.findActive(own.page.id),
        recentJobs: repos.jobs.listRecent(own.page.id, userId, 5),
      };
    },

    async startInterview(own, userId, answers, uploads) {
      if (uploads.length > BRIEF_ASSETS_MAX_COUNT) return { ok: false, error: 'too-many-images' };
      let checked = uploads.map(checkUpload);
      for (const check of checked) {
        if (!check.ok) return { ok: false, error: check.reason === 'too-large' ? 'image-too-large' : 'image-type' };
      }
      if (!interviewAllowed(own.page.id)) return { ok: false, error: 'rate-limited' };

      if (!options.ready(userId)) return { ok: false, error: 'MODEL_CONFIG' };

      // 重新采访：旧的 brief 与素材整体替换
      const existing = repos.briefs.findForPage(own.page.id, userId);
      if (existing && existing.status !== 'collecting') return { ok: false, error: 'wrong-state' };
      const previousAnswers = parse<InterviewAnswers>(existing?.answersJson ?? null);
      answers.updates = previousAnswers?.updates ?? [];
      // 重试时沿用已保存的图片；模型失败不会让用户重新上传。
      if (existing && uploads.length === 0) {
        for (const asset of repos.briefAssets.listForBrief(existing.id, userId)) uploads.push(await readAsset(config.dataDir, own.page.id, asset.fileName));
      }
      checked = uploads.map(checkUpload);
      if (existing) await eraseBrief(existing);
      const nowIso = deps.now().toISOString();
      const brief: BriefRecord = {
        id: generateId('brf'),
        pageId: own.page.id,
        ownerId: userId,
        status: 'collecting',
        answersJson: JSON.stringify(answers),
        followupsJson: null,
        briefJson: null,
        briefMd: null,
        confirmedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      repos.briefs.insert(brief);
      const images: { asset: BriefAsset; bytes: Uint8Array }[] = [];
      for (const [index, bytes] of uploads.entries()) {
        const check = checked[index];
        if (!check?.ok) continue;
        const fileName = assetFileName(index + 1, check.mime);
        const sha256 = await writeAsset(config.dataDir, own.page.id, fileName, bytes);
        const asset: BriefAsset = { id: generateId('bas'), briefId: brief.id, pageId: own.page.id, ownerId: userId, fileName, mime: check.mime, bytes: bytes.byteLength, sha256, createdAt: nowIso };
        repos.briefAssets.insert(asset);
        images.push({ asset, bytes });
      }

      const started = Date.now();
      const sceneGuide = scene(own);
      let followups: FollowupState;
      let draft: StructuredBrief;
      try {
        const model = options.resolve(userId, 'interview');
        const known = knownContext(repos, own, userId, sceneGuide);
        const result = await runInterviewDraft(model.client, model.endpoint.model!, {
          wall: own.wall,
          scene: sceneGuide,
          answers,
          profile: known.profile,
          knownAnswers: [...(known.nickname ? [{ question: '账号昵称（可更改）', answers: [known.nickname] }] : []), ...known.knownAnswers],
          images,
        });
        recordCall(own, userId, 1, true, started, result.usage);
        const files = new Set(images.map((image) => image.asset.fileName));
        followups = {
          facts: result.output.followups.facts,
          imageNotes: result.output.followups.imageNotes.filter((note) => files.has(note.file)),
          missing: result.output.followups.missing,
          questions: result.output.followups.questions.map((question, index) => ({ id: `f${index + 1}`, question: question.question, options: question.options })),
          answers: {},
        };
        draft = toStructuredBrief({ ...result.output.brief, images: result.output.brief.images.filter((image) => files.has(image.file)) }, answers);
      } catch (error) {
        if (error instanceof InterviewError) {
          recordCall(own, userId, 1, false, started, error.usage);
          return { ok: false, error: error.accessCode ?? 'model-failed' };
        }
        const accessCode = modelFailureCode(error);
        if (accessCode) return { ok: false, error: accessCode };
        throw error;
      }
      const view = loadBrief(own, userId);
      if (!view || view.record.id !== brief.id || view.record.status !== 'collecting' || !findOwnPage(repos, userId, own.wall.id)) return { ok: false, error: 'wrong-state' };
      saveBrief(view, { status: 'review', followupsJson: JSON.stringify(followups), briefJson: JSON.stringify(draft), briefMd: renderBriefMarkdown(draft, own.wall, sceneGuide) });
      return { ok: true };
    },

    async answerFollowups(own, userId, answers, edits) {
      const view = loadBrief(own, userId);
      if (!view || !['review', 'followups'].includes(view.record.status) || !view.followups) return { ok: false, error: 'wrong-state' };
      const additions = Object.fromEntries(Object.entries(answers).filter(([, a]) => !a.skipped));
      if (view.brief && !view.followups.pending && Object.keys(additions).length === 0) return { ok: true };
      const followups: FollowupState = { ...view.followups, ...(edits ? { reviewEdits: edits } : {}), pending: true, answers: { ...view.followups.answers, ...additions } };
      saveBrief(view, { followupsJson: JSON.stringify(followups) });
      const fresh = loadBrief(own, userId);
      return fresh ? compose(own, userId, fresh, null, edits) : { ok: false, error: 'wrong-state' };
    },

    async revise(own, userId, note) {
      const view = loadBrief(own, userId);
      if (!view || view.record.status !== 'review' || !view.brief) return { ok: false, error: 'wrong-state' };
      if (note.trim().length === 0) return { ok: false, error: 'note-empty' };
      saveBrief(view, { followupsJson: JSON.stringify({ ...view.followups, pending: true, correction: note.trim() }) });
      const fresh = loadBrief(own, userId);
      return fresh ? compose(own, userId, fresh, note.trim()) : { ok: false, error: 'wrong-state' };
    },

    confirm(own, userId, edits) {
      const view = loadBrief(own, userId);
      if (!view || view.record.status !== 'review' || !view.brief) return { ok: false, error: 'wrong-state' };
      if (view.followups?.pending) return { ok: false, error: 'wrong-state' };
      const brief = view.brief;
      const aiView = edits.aiView
        .slice(0, brief.aiView.length)
        .filter((item) => !item.drop)
        .map((item) => Array.from(item.text.trim()).slice(0, 120).join(''))
        .filter((item) => item.length > 0);
      if (aiView.length === 0) return { ok: false, error: 'need-one-sentence' };
      const hooks: BriefHook[] = [];
      for (const [index, item] of edits.hooks.slice(0, brief.hooks.length).entries()) {
        if (item.drop) continue;
        const text = item.text.trim();
        const opener = item.opener.trim();
        const textLength = Array.from(text).length;
        const openerLength = Array.from(opener).length;
        if (textLength < 2 || textLength > 32 || openerLength < 1 || openerLength > 80) return { ok: false, error: 'hook-invalid' };
        hooks.push({ kind: brief.hooks[index]?.kind ?? '', text, opener });
      }
      if (hooks.length < 2) return { ok: false, error: 'need-two-hooks' };

      const nowIso = deps.now().toISOString();
      const confirmed: StructuredBrief = { ...brief, aiView, hooks, displayName: edits.displayName?.trim() || brief.displayName, boundaries: edits.boundaries ?? brief.boundaries, confirmedAt: nowIso };
      const keep = new Set(edits.keepProfile);
      const chosen = brief.profileSuggestions.filter((_, index) => keep.has(index));
      let saved = 0;
      transaction(db, () => {
        for (const suggestion of chosen) {
          const category = suggestion.category as ProfileCategory;
          const scope = category === 'boundary' ? `wall:${own.wall.id}` : own.wall.sceneType;
          if (repos.profileEntries.listForUser(userId).some((entry) => entry.category === category && entry.scope === scope && normalizedProfileText(entry.text) === normalizedProfileText(suggestion.text))) continue;
          const questionId = Object.entries(view.answers?.choices ?? {}).find(([, a]) => a.selected.includes(suggestion.text) || a.text === suggestion.text)?.[0];
          repos.profileEntries.insert({
            id: generateId('pfe'),
            userId,
            category,
            text: suggestion.text,
            source: 'interview',
            scope,
            sourceWallId: own.wall.id,
            questionKey: questionId ? `${own.wall.sceneType}:${questionId}` : null,
            confirmation: 'owner-confirmed',
            createdAt: nowIso,
            updatedAt: nowIso,
          });
          saved += 1;
        }
        saveBrief(view, {
          status: 'confirmed',
          briefJson: JSON.stringify(confirmed),
          briefMd: renderBriefMarkdown(confirmed, own.wall, scene(own)),
          confirmedAt: nowIso,
        });
      });
      record('hosted_brief_confirm', own, userId, { mustHaveMissing: brief.mustHaveMissing.length, profileEntriesSaved: saved });
      return { ok: true };
    },

    async restart(own, userId) {
      const existing = repos.briefs.findForPage(own.page.id, userId);
      if (!existing) return;
      const previous = loadBrief(own, userId);
      const additions = previous?.followups?.questions.flatMap((q) => { const a = previous.followups?.answers[q.id]; return a && !a.skipped ? [`${q.question}：${[a.selected, a.text].filter(Boolean).join('；')}`] : []; }) ?? [];
      repos.briefs.update({ ...existing, answersJson: JSON.stringify({ ...previous?.answers, updates: [...new Set([...(previous?.answers?.updates ?? []), ...(previous?.followups?.correction ? [previous.followups.correction] : []), ...additions])] }), status: 'collecting', confirmedAt: null, updatedAt: deps.now().toISOString() });
    },

    async readAssetFile(userId, assetId, pageId) {
      const asset = repos.briefAssets.findById(assetId, userId);
      if (!asset || asset.pageId !== pageId) return null;
      try {
        return { asset, bytes: await readAsset(config.dataDir, pageId, asset.fileName) };
      } catch {
        return null;
      }
    },

    startJob(own, userId, request) {
      // 用谁的模型、收多少点、谁付（contracts 12）。这里只是计划；扣点在下面创建任务的事务里，届时再检查一次余额
      const plan = planJob(deps, userId, own.wall.id, request.kind, access(userId));
      if (!plan.ok) return { ok: false, error: plan.error };
      // 模型来源与配置版本在入队时记下：worker 按它取模型，排队期间配置变了就不再用（S8）
      const modelVersion = options.pinModel(userId, plan.source);
      const nowIso = deps.now().toISOString();
      const start = (): JobStartResult => transaction(db, (): JobStartResult => {
        if (repos.jobs.findActive(own.page.id)) return { ok: false, error: 'busy' };
        if (repos.jobs.countSince(own.page.id, sinceDay()) >= settings.dailyAttempts) return { ok: false, error: 'daily' };
        let baseRevisionId: string | null = null;
        let targetBlock: string | null = null;
        let requestText: string | null = null;
        if (request.kind === 'generate') {
          const brief = repos.briefs.findForPage(own.page.id, userId);
          if (!brief || brief.status !== 'confirmed') return { ok: false, error: 'no-brief' };
        } else {
          const base = request.baseRevisionId ? repos.revisions.findById(request.baseRevisionId) : null;
          if (!base || base.pageId !== own.page.id || base.status !== 'accepted' || base.report.validatorVersion === 'deleted') {
            return { ok: false, error: 'no-revision' };
          }
          const text = (request.request ?? '').trim();
          const length = Array.from(text).length;
          if (length < 1 || length > 500) return { ok: false, error: 'bad-request' };
          if (request.targetBlock) {
            if (!base.report.stats.blocks.includes(request.targetBlock)) return { ok: false, error: 'bad-block' };
            targetBlock = request.targetBlock;
          }
          baseRevisionId = base.id;
          requestText = text;
        }
        const id = generateId('gen');
        repos.jobs.create({ id, pageId: own.page.id, ownerId: userId, kind: request.kind, baseRevisionId, targetBlock, requestText, createdAt: nowIso, modelSource: plan.source, modelVersion });
        db.prepare('UPDATE generation_jobs SET remember_facts = ? WHERE id = ?').run(request.rememberFacts ? 1 : 0, id);
        chargeJob(deps, id, plan, userId);
        repos.jobEvents.append(id, 'queued', nowIso);
        return { ok: true, job: repos.jobs.findById(id) as GenerationJob };
      });
      let result: JobStartResult;
      try {
        result = start();
      } catch (error) {
        // 计划之后余额被别的任务用掉了：事务已回滚，任务没有创建
        if (!(error instanceof InsufficientCredits)) throw error;
        result = { ok: false, error: 'credits' };
      }
      // 只入队：执行在 worker（inline 模式下是本进程里的 worker 循环）
      if (result.ok) options.dispatch.kick();
      return result;
    },

    findJob(own, userId, jobId) {
      return repos.jobs.findForOwner(jobId, own.page.id, userId);
    },

    idle: () => options.dispatch.idle(),
  };
}

