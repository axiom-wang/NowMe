/**
 * 组装一个 worker（contracts 13）：渲染通道、提交渲染、远程预览、托管生成 / 修改、维护任务。
 * inline 模式由 `createWebApp` 调用，separate 模式由 `src/worker.ts` 调用——两边执行的是同一份代码。
 *
 * 浏览器只在这里创建的处理器 / 渲染器 / 预览器里懒启动；主站在 separate 模式下不会调用这里。
 */
import type { KitFont } from '@nowme/contracts';
import type { WebConfig } from '../context.js';
import type { Database, Repos } from '../db/index.js';
import type { GenerationJob } from '../db/hosted.js';
import { createGenerationExecutor } from '../hosted/job-runner.js';
import type { PagePreviewer } from '../hosted/tools.js';
import type { ResolvedModel } from '../hosted/user-models.js';
import { refundUnsettledJobs } from '../services/billing.js';
import type { SubmissionProcessor } from '../services/processor.js';
import { createSerialQueue } from '../services/queue.js';
import { createRemotePreviewExecutor, type RemoteRenderer } from '../services/remote-preview.js';
import { createSubmissionStore } from '../services/submissions.js';
import { createBackgroundWorker, type BackgroundWorker } from './runtime.js';
import type { JobSignals } from './signals.js';
import { listStaging, removeStaging } from './staging.js';

/** 结束了的渲染任务行保留多久（提交）；远程预览的行在主站取走结果后就删了，遗留的 10 分钟后清理。 */
const RENDER_JOB_RETENTION_MS = 7 * 24 * 3600 * 1000;
const PREVIEW_LEFTOVER_MS = 10 * 60_000;
/** 进度事件保留多久。 */
const JOB_EVENT_RETENTION_MS = 30 * 24 * 3600 * 1000;
/** 没有对应任务（或任务已结束）的暂存目录，超过这个时间就删除。 */
const STAGING_LEFTOVER_MS = 10 * 60_000;

export interface WorkerRuntimeOptions {
  config: WebConfig;
  db: Database;
  repos: Repos;
  now: () => Date;
  kitFonts: KitFont[];
  log: (message: string) => void;
  processor: SubmissionProcessor;
  remoteRenderer: RemoteRenderer;
  previewer: PagePreviewer;
  resolveJob: (job: GenerationJob) => ResolvedModel;
  tempRoot?: string;
  signals?: JobSignals;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
}

export interface WorkerRuntime {
  worker: BackgroundWorker;
  /** 停止领取，等待进行中的任务（`graceMs` 默认无限），然后关闭渲染器。 */
  close(options?: { graceMs?: number }): Promise<void>;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const { config, db, repos, now, kitFonts, log, processor, remoteRenderer, previewer } = options;
  // 渲染通道：提交渲染、托管结果的平台校验渲染、远程预览、托管任务里的预览截图全部串行，同一时刻只渲染一页
  const lane = createSerialQueue();
  const lanePreviewer: PagePreviewer = {
    preview: (files, fonts) => lane.run(() => previewer.preview(files, fonts)),
    close: () => previewer.close(),
  };
  const store = createSubmissionStore({ config, db, repos, now, kitFonts, processor, lane, log });
  const preview = createRemotePreviewExecutor({ dataDir: config.dataDir, db, repos, now, kitFonts, renderer: remoteRenderer, lane });
  const generation = createGenerationExecutor(
    { config, db, repos, now, kitFonts, log },
    { settings: config.hosted, resolveJob: options.resolveJob, previewer: lanePreviewer, store, tempRoot: options.tempRoot },
  );

  async function maintenance(): Promise<void> {
    const at = now().getTime();
    // 扣了点、已经失败、还没退的任务（例如上次退出时没来得及结算）
    const refunded = refundUnsettledJobs({ db, repos, now });
    if (refunded > 0) log(`[worker] ${refunded} 个被打断的任务已退回点数`);
    repos.queue.pruneRender(new Date(at - RENDER_JOB_RETENTION_MS).toISOString());
    db.prepare("DELETE FROM render_jobs WHERE kind = 'preview' AND status IN ('done', 'failed') AND finished_at < ?").run(new Date(at - PREVIEW_LEFTOVER_MS).toISOString());
    repos.jobEvents.prune(new Date(at - JOB_EVENT_RETENTION_MS).toISOString());
    for (const { jobId, mtimeMs } of await listStaging(config.dataDir)) {
      if (Date.now() - mtimeMs < STAGING_LEFTOVER_MS) continue;
      const job = repos.queue.findRender(jobId);
      if (!job || job.status === 'done' || job.status === 'failed') await removeStaging(config.dataDir, jobId);
    }
  }

  const worker = createBackgroundWorker({
    repos,
    now,
    log,
    aiConcurrency: config.worker.aiConcurrency,
    signals: options.signals,
    workerId: options.workerId,
    leaseMs: options.leaseMs,
    pollMs: options.pollMs,
    handlers: {
      render: (job, ctx) =>
        job.kind === 'submission' ? store.runSubmission(job, ctx) : job.kind === 'owner-edit' ? store.runOwnerEdit(job, ctx) : preview.run(job, ctx),
      // 提交失败时暂存可以删；预览与直接改文字的暂存由主站取结果时删除（主站可能还在等）
      renderFailed: async (job) => {
        if (job.kind === 'submission') await removeStaging(config.dataDir, job.id);
      },
      generation: (jobId, ctx) => generation.run(jobId, ctx),
      interruptGeneration: (jobId) => generation.interrupt(jobId),
      maintenance,
    },
  });

  return {
    worker,
    async close(closeOptions) {
      await worker.close(closeOptions);
      await processor.close();
      await remoteRenderer.close();
      await previewer.close();
    },
  };
}
