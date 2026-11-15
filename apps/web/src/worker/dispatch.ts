/**
 * 主站一侧的队列入口（contracts 13）：入队后叫醒同进程的 worker（inline），并等待渲染任务结束。
 *
 * separate 模式下主站没有 worker：`kick()` 什么都不做，等待靠按间隔读数据库（`render_jobs.status`）。
 */
import type { Repos } from '../db/index.js';
import { TERMINAL_RENDER_STATUSES, type RenderJob } from '../db/job-queue.js';
import type { BackgroundWorker } from './runtime.js';
import type { JobSignals } from './signals.js';

/** separate 模式下读数据库的间隔。 */
export const SEPARATE_POLL_MS = 250;
/** inline 模式下的兜底间隔（正常情况下由同进程通知唤醒）。 */
export const INLINE_POLL_MS = 1_000;

export interface JobDispatch {
  /** 有新任务入队。 */
  kick(): void;
  /** 等待渲染任务结束（done / failed）或超时；返回最后读到的任务行（不存在时为 null）。 */
  waitRender(jobId: string, timeoutMs: number): Promise<RenderJob | null>;
  /** 等待同进程 worker 空闲（separate 模式下立即返回）。 */
  idle(): Promise<void>;
}

export function createJobDispatch(options: { repos: Pick<Repos, 'queue'>; signals: JobSignals; worker: () => BackgroundWorker | null }): JobDispatch {
  const { repos, signals } = options;
  return {
    kick() {
      options.worker()?.kick();
    },
    async waitRender(jobId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const pollMs = options.worker() ? INLINE_POLL_MS : SEPARATE_POLL_MS;
      for (;;) {
        const job = repos.queue.findRender(jobId);
        if (!job || TERMINAL_RENDER_STATUSES.has(job.status)) return job;
        const left = deadline - Date.now();
        if (left <= 0) return job;
        await signals.wait(jobId, Math.min(pollMs, left));
      }
    },
    async idle() {
      await options.worker()?.idle();
    },
  };
}
