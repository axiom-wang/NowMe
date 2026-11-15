/**
 * 服务端远程预览（contracts 4.1 `POST /api/agent/previews`）：给随 Skill 包分发的轻量 CLI 用。
 * 真实用户的机器上没有 Playwright 和浏览器，`nowme preview` 把页面文件发到这里，由 worker 用与提交相同的
 * 沙箱渲染管线（`buildRevision({ mode: 'preview' })`）截图并返回。
 *
 * - 只认页面凭证；文件过滤与提交相同（白名单外的丢弃，并在报告里加 IGNORED_FILE 警告）；
 * - **什么都不存**：不建版本、不写文件；只记一条 `remote_preview` 事件用于限流（不含内容）。
 *   执行期间的任务行（render_jobs）与暂存目录在主站取走结果后立即删除；
 * - 每页每 24 小时最多 REMOTE_PREVIEWS_PER_PAGE_PER_DAY 次；
 * - 由 worker 执行（contracts 13），与提交共用串行的渲染通道；主站进程不启动浏览器（separate 模式）。
 */
import {
  generateId,
  REMOTE_PREVIEWS_PER_PAGE_PER_DAY,
  type KitFont,
  type PageFiles,
  type RemotePreviewResponse,
  type ValidationReport,
} from '@nowme/contracts';
import { buildRevision, createRenderer, type Renderer } from '@nowme/render';
import { REVISION_RATE_WINDOW_HOURS } from '../constants.js';
import type { AgentAuth } from '../context.js';
import { transaction, type Database, type Repos } from '../db/index.js';
import type { RenderJob } from '../db/job-queue.js';
import type { JobDispatch } from '../worker/dispatch.js';
import type { JobContext } from '../worker/runtime.js';
import { readResult, readStaged, removeStaging, stageFiles, writeResult } from '../worker/staging.js';
import { revalidateAgentAuth } from './agent.js';
import type { SerialQueue } from './queue.js';
import { prepareUploadedFiles, withIgnoredFiles } from './submissions.js';

/** 一次渲染的结果（图片是 PNG 字节）。 */
export interface RemoteRenderResult {
  report: ValidationReport;
  rendered: boolean;
  cover: Uint8Array | null;
  full: Uint8Array | null;
  reducedMotion: Uint8Array | null;
  blocks: { id: string; top: number; height: number; png: Uint8Array }[];
}

/** 渲染器（测试可以注入假的）。 */
export interface RemoteRenderer {
  render(files: PageFiles, kitFonts: KitFont[]): Promise<RemoteRenderResult>;
  close(): Promise<void>;
}

/** 返回的分块截图上限（与托管路线给模型的数量同一量级，避免响应过大）。 */
export const REMOTE_PREVIEW_MAX_BLOCKS = 12;
/** 远程预览最多尝试次数（只有租约过期才重试）。 */
export const PREVIEW_MAX_ATTEMPTS = 2;
/** 主站等待预览结果的上限。 */
export const PREVIEW_WAIT_MS = 2 * 60_000;

/** 真实渲染器：与 `nowme preview` 相同的双源沙箱渲染；封面总是用截图重新生成。 */
export function createRealRemoteRenderer(): RemoteRenderer {
  let renderer: Promise<Renderer> | null = null;
  const getRenderer = (): Promise<Renderer> => {
    if (!renderer) {
      renderer = createRenderer().catch((error: unknown) => {
        renderer = null;
        throw error;
      });
    }
    return renderer;
  };
  return {
    async render(files, kitFonts) {
      const result = await buildRevision({
        files,
        kitFonts,
        mode: 'preview',
        renderer: await getRenderer(),
        forceCover: true,
        // 服务端的字体源文件缺失是配置问题，与提交一致：直接报错，不悄悄回退
        missingFontSource: 'error',
      });
      return {
        report: result.report,
        rendered: result.rendered,
        cover: result.cover,
        full: result.fullScreenshot,
        reducedMotion: result.reducedMotionScreenshot,
        blocks: result.blockScreenshots.map((block) => ({ id: block.id, top: block.top, height: block.height, png: block.png })),
      };
    },
    async close() {
      const pending = renderer;
      renderer = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
  };
}

export type RemotePreviewOutcome =
  | { kind: 'rendered'; response: RemotePreviewResponse }
  | { kind: 'rate_limited' }
  | { kind: 'credential_invalid' }
  | { kind: 'failed' }
  | { kind: 'unavailable' };

export interface RemotePreviewService {
  /** `files`：已通过 revisionsRequestSchema 校验的 `{ 路径: base64 }`。 */
  preview(agent: AgentAuth, files: Readonly<Record<string, string>>): Promise<RemotePreviewOutcome>;
}

export interface RemotePreviewServiceOptions {
  dataDir: string;
  db: Database;
  repos: Repos;
  now: () => Date;
  dispatch: JobDispatch;
  waitMs?: number;
}

const toBase64 = (bytes: Uint8Array | null): string | null => (bytes ? Buffer.from(bytes).toString('base64') : null);

function overLimitFor(repos: Repos, now: () => Date) {
  return (pageId: string): boolean => {
    const since = new Date(now().getTime() - REVISION_RATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    return repos.events.countForPageSince(pageId, 'remote_preview', since) >= REMOTE_PREVIEWS_PER_PAGE_PER_DAY;
  };
}

/** 主站一侧：暂存、入队、等待、取走结果并删除任务行与暂存目录。 */
export function createRemotePreviewService(options: RemotePreviewServiceOptions): RemotePreviewService {
  const { dataDir, db, repos, now, dispatch } = options;
  const overLimit = overLimitFor(repos, now);
  const waitMs = options.waitMs ?? PREVIEW_WAIT_MS;

  const discard = async (jobId: string) => {
    repos.queue.deleteRender(jobId);
    await removeStaging(dataDir, jobId);
  };

  return {
    async preview(agent, input) {
      if (overLimit(agent.page.id)) return { kind: 'rate_limited' };
      const prepared = prepareUploadedFiles(input);
      const jobId = generateId('job');
      await stageFiles(dataDir, jobId, prepared.files, prepared.ignored);
      try {
        transaction(db, () =>
          repos.queue.enqueueRender({ id: jobId, kind: 'preview', pageId: agent.page.id, credentialId: agent.credential.id, maxAttempts: PREVIEW_MAX_ATTEMPTS, createdAt: now().toISOString() }),
        );
      } catch (error) {
        await removeStaging(dataDir, jobId);
        throw error;
      }
      dispatch.kick();
      const job = await dispatch.waitRender(jobId, waitMs);
      if (!job) return { kind: 'failed' };
      if (job.status === 'queued' || job.status === 'running') {
        // 正在执行的留给 worker 的维护任务清理
        if (repos.queue.abandonRender(jobId, now().toISOString())) await discard(jobId);
        return { kind: 'unavailable' };
      }
      const result = job.status === 'done' && job.outcome === 'rendered' ? await readResult<RemotePreviewResponse>(dataDir, jobId) : null;
      await discard(jobId);
      if (job.status === 'failed') return { kind: 'failed' };
      if (job.outcome === 'rate_limited') return { kind: 'rate_limited' };
      if (job.outcome === 'credential_invalid') return { kind: 'credential_invalid' };
      return result ? { kind: 'rendered', response: result } : { kind: 'failed' };
    },
  };
}

export interface RemotePreviewExecutorOptions {
  dataDir: string;
  db: Database;
  repos: Repos;
  now: () => Date;
  kitFonts: KitFont[];
  renderer: RemoteRenderer;
  lane: SerialQueue;
}

/** worker 一侧：执行一个远程预览任务，结果写到暂存目录的 result.json。 */
export function createRemotePreviewExecutor(options: RemotePreviewExecutorOptions): { run(job: RenderJob, ctx: JobContext): Promise<void> } {
  const { dataDir, db, repos, now, kitFonts, renderer, lane } = options;
  const overLimit = overLimitFor(repos, now);
  return {
    async run(job, ctx) {
      const complete = (outcome: 'rendered' | 'rate_limited' | 'credential_invalid') =>
        repos.queue.completeRender(job.id, ctx.workerId, { outcome, now: now().toISOString() });
      // 排队期间凭证可能已被断开，或者额度已被用完
      const auth = revalidateAgentAuth(repos, job.credentialId);
      if (!auth) return void complete('credential_invalid');
      const prepared = await readStaged(dataDir, job.id);
      // 第一次尝试才检查额度并记事件（租约过期后的重试不重复计数）。
      // 先记事件再渲染：渲染失败也计入额度（防止反复触发昂贵的失败渲染）
      if (job.attempts <= 1) {
        const limited = transaction(db, () => {
          if (overLimit(auth.page.id)) return true;
          const nowIso = now().toISOString();
          repos.events.record({
            type: 'remote_preview',
            wallId: auth.wall.id,
            pageId: auth.page.id,
            actorId: auth.page.ownerId,
            props: { files: prepared.files.size, ignored: prepared.ignored.length },
            createdAt: nowIso,
          });
          repos.credentials.touch(auth.credential.id, nowIso);
          return false;
        });
        if (limited) return void complete('rate_limited');
      }
      const result = await lane.run(() => renderer.render(prepared.files, kitFonts));
      const response: RemotePreviewResponse = {
        report: withIgnoredFiles(result.report, prepared.ignored),
        rendered: result.rendered,
        cover: toBase64(result.cover),
        full: toBase64(result.full),
        reducedMotion: toBase64(result.reducedMotion),
        blocks: result.blocks.slice(0, REMOTE_PREVIEW_MAX_BLOCKS).map((block) => ({
          id: block.id,
          top: block.top,
          height: block.height,
          png: Buffer.from(block.png).toString('base64'),
        })),
      };
      if (!repos.queue.holdsRender(job.id, ctx.workerId)) return;
      await writeResult(dataDir, job.id, response);
      complete('rendered');
    },
  };
}
