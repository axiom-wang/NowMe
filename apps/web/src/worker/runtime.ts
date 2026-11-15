/**
 * 后台任务循环（contracts 13）：从数据库队列领取任务、续约、回收过期租约、优雅退出。
 *
 * - 渲染任务（提交渲染、远程预览）同一时刻只执行 1 个；AI 生成 / 修改最多 `aiConcurrency` 个并行。
 *   所有浏览器渲染另外经过同一条串行“渲染通道”（见 compose.ts），AI 任务里的预览截图也不会并发渲染。
 * - 租约：领取时写入 `lease_owner` + 到期时间（默认 60 秒），每 1/3 租期续约一次；续约失败（租约被别的 worker 回收）
 *   时取消这个任务，它之后的写入都带租约条件，不会生效。
 * - 回收：别人持有、已经过期的 running 任务——渲染任务还有次数就回到队列；AI 任务不重试，交给 `interruptGeneration`
 *   （标记 INTERRUPTED 并退点）。
 * - 退出：`close({ graceMs })` 停止领取，等待进行中的任务；超时后渲染任务交还租约（回到队列，由下一个 worker 重做），
 *   AI 任务被取消（INTERRUPTED、退点）。
 *
 * inline 模式下由主站进程创建（`createWebApp`），separate 模式下由 `src/worker.ts` 创建；两者代码相同。
 */
import { randomBytes } from 'node:crypto';
import type { Repos } from '../db/index.js';
import type { JobEventProps, JobStage, RenderJob } from '../db/job-queue.js';
import type { JobSignals } from './signals.js';

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_POLL_MS = 1_000;
/** 维护（清理过期的任务行、进度事件与暂存目录）的间隔。 */
export const MAINTENANCE_INTERVAL_MS = 10 * 60_000;
/** 退出时，取消 AI 任务之后再等它们收尾的时间。 */
const ABORT_SETTLE_MS = 10_000;

export type AbortReason = 'shutdown' | 'lease-lost';

export interface JobContext {
  readonly jobId: string;
  readonly workerId: string;
  /** 优雅退出超时或租约丢失时取消。 */
  readonly signal: AbortSignal;
  abortReason(): AbortReason | null;
  /** 写一条进度事件（阶段 + 少量数值）。 */
  progress(stage: JobStage, props?: JobEventProps): void;
}

export interface WorkerHandlers {
  /** 执行一个渲染任务；结束时自己调用 `repos.queue.completeRender / failRender`（带租约）。抛错时由循环标记 INTERNAL。 */
  render(job: RenderJob, ctx: JobContext): Promise<void>;
  /** 渲染任务失败（抛错、重试次数用完）之后的清理（例如删除暂存目录）。 */
  renderFailed?(job: Pick<RenderJob, 'id' | 'kind'>): Promise<void> | void;
  /** 执行一个 AI 任务；结束时自己写结果（带租约）。 */
  generation(jobId: string, ctx: JobContext): Promise<void>;
  /** 别的 worker 留下的、租约过期的 AI 任务：不重试，标记失败并退点。 */
  interruptGeneration(jobId: string): void;
  /** 启动时与每隔一段时间执行的维护。 */
  maintenance?(): Promise<void> | void;
}

export interface BackgroundWorkerOptions {
  repos: Pick<Repos, 'queue' | 'jobEvents'>;
  now: () => Date;
  log: (message: string) => void;
  handlers: WorkerHandlers;
  aiConcurrency: number;
  signals?: JobSignals;
  workerId?: string;
  leaseMs?: number;
  /** 轮询间隔：发现别的进程入队的任务、回收过期租约。 */
  pollMs?: number;
}

export interface BackgroundWorker {
  readonly id: string;
  /** 开始轮询（启动时先做一次回收与维护）。 */
  start(): void;
  /** 有新任务入队：尽快领取（同进程入队时调用；跨进程靠轮询）。 */
  kick(): void;
  /** 等到没有进行中、也没有可领取的任务（测试与脚本用）。 */
  idle(): Promise<void>;
  /** 停止领取；等待进行中的任务（`graceMs` 默认无限）。 */
  close(options?: { graceMs?: number }): Promise<void>;
  /** 正在执行的任务数。 */
  readonly activeCount: number;
}

interface ActiveJob {
  kind: 'render' | 'generation';
  controller: AbortController;
  reason: AbortReason | null;
  promise: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

export function createBackgroundWorker(options: BackgroundWorkerOptions): BackgroundWorker {
  const { repos, now, log, handlers } = options;
  const id = options.workerId ?? `wkr_${process.pid}_${randomBytes(6).toString('hex')}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const aiConcurrency = Math.max(1, options.aiConcurrency);
  const active = new Map<string, ActiveJob>();
  let renderActive = 0;
  let aiActive = 0;
  let stopping = false;
  let started = false;
  let scheduled = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let renewTimer: NodeJS.Timeout | null = null;
  let lastMaintenance = 0;

  const lease = () => {
    const at = now();
    return { owner: id, now: at.toISOString(), expiresAt: new Date(at.getTime() + leaseMs).toISOString() };
  };

  const progress = (jobId: string, stage: JobStage, props?: JobEventProps) => {
    try {
      repos.jobEvents.append(jobId, stage, now().toISOString(), props);
    } catch (error) {
      log(`[worker] 写进度事件失败 ${jobId}：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const context = (jobId: string, entry: Omit<ActiveJob, 'promise'>): JobContext => ({
    jobId,
    workerId: id,
    signal: entry.controller.signal,
    abortReason: () => entry.reason,
    progress: (stage, props) => progress(jobId, stage, props),
  });

  const abort = (jobId: string, reason: AbortReason) => {
    const entry = active.get(jobId);
    if (!entry || entry.controller.signal.aborted) return;
    entry.reason = reason;
    entry.controller.abort(reason);
  };

  function launch(jobId: string, kind: ActiveJob['kind'], run: (ctx: JobContext) => Promise<void>): void {
    const entry: Omit<ActiveJob, 'promise'> = { kind, controller: new AbortController(), reason: null };
    if (kind === 'render') renderActive += 1;
    else aiActive += 1;
    const promise = (async () => {
      try {
        await run(context(jobId, entry));
      } finally {
        active.delete(jobId);
        if (kind === 'render') renderActive -= 1;
        else aiActive -= 1;
        options.signals?.notify(jobId);
        kick();
      }
    })();
    active.set(jobId, { ...entry, promise });
  }

  async function runRender(job: RenderJob, ctx: JobContext): Promise<void> {
    try {
      await handlers.render(job, ctx);
    } catch (error) {
      log(`[worker] 渲染任务 ${job.id}（${job.kind}）出错：${error instanceof Error ? error.message : String(error)}`);
      if (repos.queue.failRender(job.id, id, 'INTERNAL', now().toISOString())) {
        progress(job.id, 'failed');
        await handlers.renderFailed?.(job);
      }
    }
  }

  async function runGeneration(jobId: string, ctx: JobContext): Promise<void> {
    try {
      await handlers.generation(jobId, ctx);
    } catch (error) {
      log(`[worker] AI 任务 ${jobId} 未捕获的错误：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reclaim(): void {
    const result = repos.queue.reclaimExpired(now().toISOString(), id);
    for (const job of result.retried) {
      progress(job.id, 'retrying', { attempt: job.attempts });
      log(`[worker] 渲染任务 ${job.id} 的租约已过期，重新排队（第 ${job.attempts} 次尝试被打断）`);
    }
    for (const job of result.failed) {
      progress(job.id, 'failed', { attempt: job.attempts });
      options.signals?.notify(job.id);
      void Promise.resolve(handlers.renderFailed?.(job)).catch(() => undefined);
      log(`[worker] 渲染任务 ${job.id} 重试次数用完，标记失败`);
    }
    for (const jobId of result.generation) {
      try {
        handlers.interruptGeneration(jobId);
      } catch (error) {
        log(`[worker] 回收 AI 任务 ${jobId} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
      options.signals?.notify(jobId);
    }
  }

  function maybeMaintenance(): void {
    if (!handlers.maintenance) return;
    const at = Date.now();
    if (lastMaintenance !== 0 && at - lastMaintenance < MAINTENANCE_INTERVAL_MS) return;
    lastMaintenance = at;
    void Promise.resolve()
      .then(() => handlers.maintenance?.())
      .catch((error: unknown) => log(`[worker] 维护任务出错：${error instanceof Error ? error.message : String(error)}`));
  }

  function tick(): void {
    if (stopping) return;
    try {
      maybeMaintenance();
      reclaim();
      while (!stopping && renderActive < 1) {
        const job = repos.queue.claimRender(lease());
        if (!job) break;
        launch(job.id, 'render', (ctx) => runRender(job, ctx));
      }
      while (!stopping && aiActive < aiConcurrency) {
        const jobId = repos.queue.claimGeneration(lease());
        if (!jobId) break;
        launch(jobId, 'generation', (ctx) => runGeneration(jobId, ctx));
      }
    } catch (error) {
      // 例如 SQLITE_BUSY 超过 busy_timeout：下一次轮询再试
      log(`[worker] 领取任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function renew(): void {
    for (const [jobId, entry] of active) {
      if (entry.controller.signal.aborted) continue;
      try {
        const held = entry.kind === 'render' ? repos.queue.renewRender(jobId, lease()) : repos.queue.renewGeneration(jobId, lease());
        if (!held) {
          log(`[worker] 任务 ${jobId} 的租约已被回收，停止执行`);
          abort(jobId, 'lease-lost');
        }
      } catch (error) {
        // 数据库暂时忙：不当作丢失租约，下次再续
        log(`[worker] 续约失败 ${jobId}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function kick(): void {
    if (stopping || !started || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      tick();
    });
  }

  return {
    id,
    get activeCount() {
      return active.size;
    },
    start() {
      if (started) return;
      started = true;
      pollTimer = setInterval(tick, pollMs);
      pollTimer.unref();
      renewTimer = setInterval(renew, Math.max(10, Math.floor(leaseMs / 3)));
      renewTimer.unref();
      kick();
    },
    kick,
    async idle() {
      for (;;) {
        if (started) tick();
        if (active.size === 0) return;
        await Promise.race([...active.values()].map((entry) => entry.promise));
      }
    },
    async close(closeOptions = {}) {
      stopping = true;
      if (pollTimer) clearInterval(pollTimer);
      const graceMs = closeOptions.graceMs ?? Number.POSITIVE_INFINITY;
      const all = () => Promise.allSettled([...active.values()].map((entry) => entry.promise)).then(() => undefined);
      if (active.size > 0) {
        if (Number.isFinite(graceMs)) await Promise.race([all(), sleep(graceMs)]);
        else await all();
      }
      if (active.size > 0) {
        for (const [jobId, entry] of active) {
          if (entry.kind === 'render') {
            // 交还：回到队列，由下一个 worker 重做（渲染幂等）
            try {
              if (repos.queue.releaseRender(jobId, id)) progress(jobId, 'retrying');
            } catch {
              // 租约到期后也会被回收
            }
          }
          abort(jobId, 'shutdown');
        }
        log(`[worker] 退出：${active.size} 个任务未在 ${Math.round(graceMs / 1000)} 秒内结束，渲染任务已交还队列，AI 任务已取消并退点`);
        await Promise.race([all(), sleep(ABORT_SETTLE_MS)]);
      }
      if (renewTimer) clearInterval(renewTimer);
    },
  };
}
