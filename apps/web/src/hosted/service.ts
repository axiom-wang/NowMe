/**
 * 平台托管路线的服务（contracts 9 / hosted-route.md）：应用内采访的状态机、长期画像写回、生成 / 修改任务。
 *
 * 授权：所有方法的 `own` 必须来自路由里的 `findOwnPage(repos, 当前用户, wallId)`；`userId` 是当前登录用户。
 * 数据只按主人自己的 ID 读写（S7）。任务执行见 `runJob`（S8：独立临时目录、结束必删、平台重新校验）。
 */
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIEF_ASSETS_MAX_COUNT,
  generateId,
  HOSTED_JOB_TIMEOUT_MS,
  type HostedConfig,
  type SceneGuide,
  type ValidationIssue,
} from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import { validatePage } from '@nowme/validator';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { BriefAsset, BriefRecord, GenerationJob, JobKind, JobUsage, ProfileCategory } from '../db/hosted.js';
import type { EventProps } from '../db/events.js';
import { findOwnPage, type OwnPage } from '../services/access.js';
import { buildAgentContext } from '../services/agent.js';
import { createSerialQueue } from '../services/queue.js';
import { revisionDir, REVISION_ORIGINAL_DIR } from '../services/revision-storage.js';
import { assetFileName, checkUpload, readAsset, writeAsset } from './assets.js';
import { eraseBriefRecord } from './data.js';
import {
  renderBriefMarkdown,
  toStructuredBrief,
  type BriefHook,
  type FollowupAnswer,
  type FollowupState,
  type InterviewAnswers,
  type StructuredBrief,
} from './brief.js';
import { modelFailureCode, type ModelAccessCode } from './model-errors.js';
import type { ModelRole, ResolvedModel } from './user-models.js';
import { untrusted, type UsageTotals } from './model-client.js';
import { InterviewError, runComposeBrief, runFollowups } from './interview.js';
import { RunError, runGeneration } from './runner.js';
import { GenerationWorkspace, type PagePreviewer } from './tools.js';

type HostedDeps = Pick<AppDeps, 'config' | 'db' | 'repos' | 'now' | 'kitFonts' | 'submissions' | 'log'>;

export interface HostedServiceOptions {
  settings: HostedConfig;
  /** 采访与生成各用一个客户端（可以是不同的模型服务，hosted-route 1.1）。 */
  resolve(userId: string, role: ModelRole): ResolvedModel;
  ready(userId: string): boolean;
  previewer: PagePreviewer;
  /** 任务临时目录的父目录，默认 `os.tmpdir()`（测试用来断言任务结束后目录被删除）。 */
  tempRoot?: string;
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

export type JobStartError = ModelAccessCode | 'busy' | 'daily' | 'no-brief' | 'no-revision' | 'bad-block' | 'bad-request';
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
  brief: BriefView | null;
  activeJob: GenerationJob | null;
  recentJobs: GenerationJob[];
}

export interface ConfirmEdits {
  aiView: { text: string; drop: boolean }[];
  hooks: { text: string; opener: string; drop: boolean }[];
  /** 勾选写回画像的 profileSuggestions 下标。 */
  keepProfile: number[];
}

export interface JobRequest {
  kind: JobKind;
  baseRevisionId?: string | null;
  targetBlock?: string | null;
  request?: string | null;
}

export interface HostedService {
  readonly settings: HostedConfig;
  overview(own: OwnPage, userId: string): HostedOverview;
  loadBrief(own: OwnPage, userId: string): BriefView | null;
  scene(own: OwnPage): SceneGuide;
  startInterview(own: OwnPage, userId: string, answers: InterviewAnswers, uploads: Uint8Array[]): Promise<StepResult>;
  answerFollowups(own: OwnPage, userId: string, answers: Record<string, FollowupAnswer>): Promise<StepResult>;
  revise(own: OwnPage, userId: string, note: string): Promise<StepResult>;
  confirm(own: OwnPage, userId: string, edits: ConfirmEdits): StepResult;
  /** 删除这一页的采访（brief 与素材）。 */
  restart(own: OwnPage, userId: string): Promise<void>;
  readAssetFile(userId: string, assetId: string, pageId: string): Promise<{ asset: BriefAsset; bytes: Uint8Array } | null>;
  startJob(own: OwnPage, userId: string, request: JobRequest): JobStartResult;
  findJob(own: OwnPage, userId: string, jobId: string): GenerationJob | null;
  /** 等待排队的任务全部结束（测试与关闭时用）。 */
  idle(): Promise<void>;
  close(): Promise<void>;
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

function usageProps(usage: UsageTotals): EventProps {
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
  MODEL_UNAVAILABLE: '暂时连不上你配置的模型服务，请检查服务地址或稍后再试。',
  REJECTED: '生成的页面没有通过平台校验，没有保存。可以再试一次。',
  MAX_TURNS: '这次生成用了太多步还没完成，已停止。可以再试一次。',
  NO_FINISH: '这次生成没有正常结束。可以再试一次。',
  TIMEOUT: '这次生成超时了。可以再试一次。',
  API_ERROR: '暂时连不上生成服务。请检查 AI 设置或稍后再试。',
  REFUSED: '生成服务拒绝了这次请求。可以换一种说法再试。',
  RATE_LIMITED: '这一页今天的版本数已达上限，明天再试。',
  PAGE_GONE: '这一页已经不可用（可能已退出墙或页面已删除），结果没有保存。',
  INTERRUPTED: '服务重启打断了这次生成。可以再试一次。',
  INTERNAL: '服务器处理时出错了。可以再试一次。',
};

export function createHostedService(deps: HostedDeps, options: HostedServiceOptions): HostedService {
  const { repos, db, config } = deps;
  const { settings, previewer } = options;
  const queue = createSerialQueue();

  const interrupted = repos.jobs.interruptAll(deps.now().toISOString());
  if (interrupted > 0) deps.log(`[web] ${interrupted} 个托管任务因服务重启被标记为失败`);

  const sinceDay = () => new Date(deps.now().getTime() - DAY_MS).toISOString();
  const countInterviewCalls = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hosted_interview_call' AND page_id = ? AND created_at > ?");

  const record = (type: Parameters<typeof repos.events.record>[0]['type'], own: OwnPage | { wallId: string; pageId: string }, actorId: string, props: EventProps) => {
    const ids = 'page' in own ? { wallId: own.wall.id, pageId: own.page.id } : own;
    repos.events.record({ type, wallId: ids.wallId, pageId: ids.pageId, actorId, props, createdAt: deps.now().toISOString() });
  };

  const loadBrief = (own: OwnPage, userId: string): BriefView | null => {
    const record = repos.briefs.findForPage(own.page.id, userId);
    if (!record) return null;
    return {
      record,
      answers: parse<InterviewAnswers>(record.answersJson),
      followups: parse<FollowupState>(record.followupsJson),
      brief: parse<StructuredBrief>(record.briefJson),
      assets: repos.briefAssets.listForBrief(record.id, userId),
    };
  };

  const scene = (own: OwnPage): SceneGuide => loadSceneGuide(own.wall.sceneType);

  const interviewAllowed = (pageId: string): boolean =>
    Number((countInterviewCalls.get(pageId, sinceDay()) as { n: number }).n) < settings.interviewDailyCalls;

  const recordCall = (own: OwnPage, userId: string, step: number, ok: boolean, started: number, usage: UsageTotals) =>
    record('hosted_interview_call', own, userId, { step, ok, durationMs: Date.now() - started, ...usageProps(usage) });

  const saveBrief = (view: BriefView, patch: Partial<BriefRecord>) => {
    repos.briefs.update({ ...view.record, ...patch, updatedAt: deps.now().toISOString() });
  };

  /** 调用 #2 / #3。成功后状态 review。 */
  async function compose(own: OwnPage, userId: string, view: BriefView, note: string | null): Promise<StepResult> {
    if (!view.answers || !view.followups) return { ok: false, error: 'wrong-state' };
    if (!interviewAllowed(own.page.id)) return { ok: false, error: 'rate-limited' };
    const started = Date.now();
    const sceneGuide = scene(own);
    try {
      const model = options.resolve(userId, 'interview');
      const result = await runComposeBrief(
        model.client,
        model.endpoint.model!,
        {
          wall: own.wall,
          scene: sceneGuide,
          answers: view.answers,
          profile: repos.profileEntries.listForUser(userId),
          imageFiles: view.assets.map((asset) => asset.fileName),
        },
        view.followups,
        note && view.brief ? { previous: view.brief, note } : null,
      );
      recordCall(own, userId, note ? 3 : 2, true, started, result.usage);
      const files = new Set(view.assets.map((asset) => asset.fileName));
      const output = { ...result.output, images: result.output.images.filter((image) => files.has(image.file)) };
      const structured = toStructuredBrief(output, view.answers);
      saveBrief(view, {
        status: 'review',
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

  // -------------------------------------------------------------------------
  // 任务
  // -------------------------------------------------------------------------

  const stillValid = (pageId: string, ownerId: string, wallId: string) => () => {
    const own = findOwnPage(repos, ownerId, wallId);
    return own !== null && own.page.id === pageId;
  };

  function firstMessage(own: OwnPage, job: GenerationJob, briefMd: string | null, assets: BriefAsset[], baseNumber: number | null, imageNotes: Map<string, string>): string {
    const context = buildAgentContext({ repos, config, kitFonts: deps.kitFonts }, own.wall, own.page);
    const parts = [
      job.kind === 'generate' ? '任务：按 brief 生成主人的页面（Skill 第 4–5 步），完成后调用 finish。' : '任务：按主人的修改要求修改页面（Skill 第 6 步），完成后调用 finish。',
      untrusted('wall_context', JSON.stringify({ wall: context.wall, kit: { version: context.kit.version, basePath: context.kit.basePath, fonts: context.kit.fonts.map(({ id, family, cjk, weights }) => ({ id, family, cjk, weights })) }, limits: context.limits }, null, 2)),
      untrusted('scene_guide', JSON.stringify(scene(own), null, 2)),
      briefMd ? untrusted('owner_brief', briefMd) : '（这一页没有应用内采访的 brief；修改时只用页面里已有的内容和修改要求里主人新说的话。）',
      assets.length > 0
        ? `page/assets/ 里已有主人上传的图片：\n${assets.map((asset) => `- assets/${asset.fileName}${imageNotes.get(asset.fileName) ? `：${imageNotes.get(asset.fileName)}` : ''}`).join('\n')}`
        : 'page/assets/ 里没有主人上传的图片；装饰请用内联 SVG / CSS。',
    ];
    if (job.kind === 'edit') {
      parts.push(`基础版本：第 ${baseNumber ?? '?'} 版，文件已经在 page/ 里（先用 read_page_file 读）。`);
      parts.push(`目标区块：${job.targetBlock ? `data-nm-id="${job.targetBlock}"（只改这个区块）` : '主人没有指定；从修改要求判断，范围不清时用 finish 的 clarify 提问'}`);
      parts.push(untrusted('owner_edit_request', job.requestText ?? ''));
    }
    return parts.join('\n\n');
  }

  async function prepareDir(own: OwnPage, job: GenerationJob, view: BriefView | null): Promise<{ dir: string; baseBlocks: string[] | null; baseNumber: number | null }> {
    const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'nowme-gen-'));
    const pageDir = join(dir, 'page');
    await mkdir(join(pageDir, 'assets'), { recursive: true });
    let baseBlocks: string[] | null = null;
    let baseNumber: number | null = null;
    if (job.kind === 'edit' && job.baseRevisionId) {
      const base = repos.revisions.findById(job.baseRevisionId);
      if (!base || base.pageId !== own.page.id) throw new Error('基础版本不存在');
      baseBlocks = base.report.stats.blocks;
      baseNumber = base.number;
      await cp(join(revisionDir(config.dataDir, base.id), REVISION_ORIGINAL_DIR), pageDir, { recursive: true, force: true });
      // 封面会由平台重新生成，避免修改后封面不更新
      await rm(join(pageDir, 'cover.png'), { force: true });
    }
    if (view) {
      const present = new Set(await readdir(join(pageDir, 'assets')));
      for (const asset of view.assets) {
        if (present.has(asset.fileName)) continue;
        await writeFile(join(pageDir, 'assets', asset.fileName), await readAsset(config.dataDir, own.page.id, asset.fileName));
      }
      if (view.record.briefMd) await writeFile(join(dir, 'brief.md'), view.record.briefMd, 'utf8');
    }
    const context = buildAgentContext({ repos, config, kitFonts: deps.kitFonts }, own.wall, own.page);
    await writeFile(join(dir, 'context.json'), JSON.stringify(context, null, 2), 'utf8');
    return { dir, baseBlocks, baseNumber };
  }

  async function runJob(jobId: string, model: ResolvedModel): Promise<void> {
    const job = repos.jobs.findById(jobId);
    if (!job || !repos.jobs.markRunning(jobId, deps.now().toISOString())) return;
    const page = repos.pages.findById(job.pageId);
    const own = page ? findOwnPage(repos, job.ownerId, page.wallId) : null;
    const started = Date.now();
    let usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let turns = 0;
    let dir: string | null = null;

    const finish = (status: 'succeeded' | 'failed' | 'needs_input', input: { revisionId?: string; errorCode?: string; message?: string; httpStatus?: number | null }) => {
      const ok = status === 'succeeded';
      const jobUsage: JobUsage = { turns, ...usage };
      repos.jobs.finish(jobId, {
        status,
        revisionId: input.revisionId ?? null,
        errorCode: input.errorCode ?? null,
        resultMessage: input.message ?? null,
        charged: false,
        usage: jobUsage,
        finishedAt: deps.now().toISOString(),
      });
      if (page) {
        record(job.kind === 'generate' ? 'hosted_generate' : 'hosted_edit', { wallId: page.wallId, pageId: page.id }, job.ownerId, {
          ok,
          clarify: status === 'needs_input',
          turns,
          durationMs: Date.now() - started,
          ...usageProps(usage),
          ...(job.kind === 'edit' ? { targeted: job.targetBlock !== null } : {}),
        });
      }
      deps.log(`[web] 托管任务 ${jobId}（${job.kind}）：${status}${input.errorCode ? ` ${input.errorCode}` : ''}${input.httpStatus ? `（HTTP ${input.httpStatus}）` : ''}，${turns} 轮`);
    };

    if (!own || !page) {
      finish('failed', { errorCode: 'PAGE_GONE' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOSTED_JOB_TIMEOUT_MS);
    try {
      const view = loadBrief(own, job.ownerId);
      const briefMd = view?.record.status === 'confirmed' ? view.record.briefMd : null;
      const prepared = await prepareDir(own, job, view?.record.status === 'confirmed' ? view : null);
      dir = prepared.dir;
      const notes = new Map((view?.brief?.images ?? []).map((image) => [image.file, image.description]));
      const workspace = new GenerationWorkspace(dir, deps.kitFonts, previewer);
      const result = await runGeneration({
        client: model.client,
        model: model.endpoint.model!,
        maxTurns: settings.maxTurns,
        workspace,
        firstMessage: firstMessage(own, job, briefMd, view?.record.status === 'confirmed' ? view.assets : [], prepared.baseNumber, notes),
        signal: controller.signal,
      });
      usage = result.usage;
      turns = result.turns;
      if (result.finish.outcome === 'clarify') {
        finish('needs_input', { message: result.finish.message || '需要你说得再具体一点：想改哪一块？' });
        return;
      }
      const files = await workspace.readFiles();
      const extraWarnings: ValidationIssue[] = [];
      if (job.kind === 'edit' && job.targetBlock && prepared.baseBlocks) {
        const after = validatePage(files, { kitFonts: deps.kitFonts }).stats.blocks;
        const same = after.length === prepared.baseBlocks.length && after.every((block) => prepared.baseBlocks?.includes(block));
        if (!same) {
          extraWarnings.push({
            code: 'HOSTED_BLOCKS_CHANGED',
            severity: 'warning',
            file: 'index.html',
            message: `这次只要求修改区块 ${job.targetBlock}，但页面的区块从 ${prepared.baseBlocks.join('、')} 变成了 ${after.join('、')}`,
            hint: '预览时留意其他区块是否被改动；不满意可以继续修改，或发布之前的版本。',
          });
        }
      }
      const stored = await deps.submissions.storeHosted({ pageId: page.id, stillValid: stillValid(page.id, job.ownerId, page.wallId), files, extraWarnings });
      switch (stored.kind) {
        case 'stored':
          finish('succeeded', { revisionId: stored.revisionId, message: result.finish.message });
          return;
        case 'rejected':
          finish('failed', { errorCode: 'REJECTED' });
          return;
        case 'rate_limited':
          finish('failed', { errorCode: 'RATE_LIMITED' });
          return;
        case 'page_invalid':
          finish('failed', { errorCode: 'PAGE_GONE' });
          return;
      }
    } catch (error) {
      if (error instanceof RunError) {
        usage = error.usage;
        turns = error.turns;
        finish('failed', { errorCode: error.code, httpStatus: error.status });
      } else {
        deps.log(`[web] 托管任务 ${jobId} 出错`);
        finish('failed', { errorCode: modelFailureCode(error) ?? 'INTERNAL' });
      }
    } finally {
      clearTimeout(timer);
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    settings,
    loadBrief,
    scene,
    overview(own, userId) {
      return {
        modelReady: options.ready(userId),
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
      try {
        const model = options.resolve(userId, 'interview');
        const result = await runFollowups(model.client, model.endpoint.model!, {
          wall: own.wall,
          scene: sceneGuide,
          answers,
          profile: repos.profileEntries.listForUser(userId),
          images,
        });
        recordCall(own, userId, 1, true, started, result.usage);
        const files = new Set(images.map((image) => image.asset.fileName));
        followups = {
          facts: result.output.facts,
          imageNotes: result.output.imageNotes.filter((note) => files.has(note.file)),
          missing: result.output.missing,
          questions: result.output.questions.map((question, index) => ({ id: `f${index + 1}`, question: question.question, options: question.options })),
          answers: {},
        };
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
      if (!view) return { ok: false, error: 'wrong-state' };
      saveBrief(view, { status: 'followups', followupsJson: JSON.stringify(followups) });
      if (followups.questions.length === 0) {
        const fresh = loadBrief(own, userId);
        if (fresh) return compose(own, userId, fresh, null);
      }
      return { ok: true };
    },

    async answerFollowups(own, userId, answers) {
      const view = loadBrief(own, userId);
      if (!view || view.record.status !== 'followups' || !view.followups) return { ok: false, error: 'wrong-state' };
      const followups: FollowupState = { ...view.followups, answers };
      saveBrief(view, { followupsJson: JSON.stringify(followups) });
      const fresh = loadBrief(own, userId);
      return fresh ? compose(own, userId, fresh, null) : { ok: false, error: 'wrong-state' };
    },

    async revise(own, userId, note) {
      const view = loadBrief(own, userId);
      if (!view || view.record.status !== 'review' || !view.brief) return { ok: false, error: 'wrong-state' };
      if (note.trim().length === 0) return { ok: false, error: 'note-empty' };
      return compose(own, userId, view, note.trim());
    },

    confirm(own, userId, edits) {
      const view = loadBrief(own, userId);
      if (!view || view.record.status !== 'review' || !view.brief) return { ok: false, error: 'wrong-state' };
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
      const confirmed: StructuredBrief = { ...brief, aiView, hooks, confirmedAt: nowIso };
      const keep = new Set(edits.keepProfile);
      const chosen = brief.profileSuggestions.filter((_, index) => keep.has(index));
      let saved = 0;
      transaction(db, () => {
        for (const suggestion of chosen) {
          const category = suggestion.category as ProfileCategory;
          if (repos.profileEntries.has(userId, category, suggestion.text)) continue;
          repos.profileEntries.insert({
            id: generateId('pfe'),
            userId,
            category,
            text: suggestion.text,
            source: 'interview',
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
      await eraseBrief(existing);
      record('brief_delete', own, userId, { count: 1 });
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
      if (!options.ready(userId)) return { ok: false, error: 'MODEL_CONFIG' };
      const model = options.resolve(userId, 'generate');
      const nowIso = deps.now().toISOString();
      const result = transaction(db, (): JobStartResult => {
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
        repos.jobs.create({ id, pageId: own.page.id, ownerId: userId, kind: request.kind, baseRevisionId, targetBlock, requestText, createdAt: nowIso });
        return { ok: true, job: repos.jobs.findById(id) as GenerationJob };
      });
      if (result.ok) {
        const jobId = result.job.id;
        void queue.run(() => runJob(jobId, model)).catch((error: unknown) => deps.log(`[web] 托管任务 ${jobId} 未捕获的错误`));
      }
      return result;
    },

    findJob(own, userId, jobId) {
      return repos.jobs.findForOwner(jobId, own.page.id, userId);
    },

    idle: () => queue.idle(),
    async close() {
      await queue.idle();
      await previewer.close();
    },
  };
}

