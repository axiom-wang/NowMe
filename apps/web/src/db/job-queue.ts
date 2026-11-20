/**
 * 后台任务队列（contracts 13，迁移 010）：`render_jobs`、`generation_jobs` 的租约列、`job_events`。
 *
 * - 领取：`BEGIN IMMEDIATE` 事务里选最早的 queued 任务并改成 running，写入租约（worker ID + 到期时间）、尝试次数 +1；
 * - 续约 / 结束：都带 `lease_owner = ?` 条件，租约被别人回收后旧 worker 的写入一律无效；
 * - 回收：租约过期的 running 任务——渲染任务还有次数就回到 queued（重试），AI 任务不重试（由调用方标记失败并退点）。
 *
 * 只存 ID、状态、计数与时间，不存内容。
 */
import { transaction, type Database } from './database.js';

// ---------------------------------------------------------------------------
// render_jobs
// ---------------------------------------------------------------------------

export type RenderJobKind = 'submission' | 'preview' | 'owner-edit';
export type RenderJobStatus = 'queued' | 'running' | 'done' | 'failed';
/** `credential_invalid`：发起方（页面凭证，或直接改文字的主人）已失去这一页；`rejected`：直接改文字后没通过校验（报告在暂存目录）。 */
export type RenderJobOutcome = 'stored' | 'rendered' | 'rate_limited' | 'credential_invalid' | 'rejected';

export interface RenderJob {
  id: string;
  kind: RenderJobKind;
  status: RenderJobStatus;
  pageId: string;
  /** 本地 Agent 的提交与预览：页面凭证；直接改文字：null。 */
  credentialId: string | null;
  /** 直接改文字：页面主人；其他：null。 */
  ownerId: string | null;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  outcome: RenderJobOutcome | null;
  revisionId: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toRenderJob(row: Record<string, unknown> | undefined): RenderJob | null {
  if (!row) return null;
  return {
    id: row.id as string,
    kind: row.kind as RenderJobKind,
    status: row.status as RenderJobStatus,
    pageId: row.page_id as string,
    credentialId: (row.credential_id as string | null) ?? null,
    ownerId: (row.owner_id as string | null) ?? null,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    outcome: (row.outcome as RenderJobOutcome | null) ?? null,
    revisionId: (row.revision_id as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

export const TERMINAL_RENDER_STATUSES: ReadonlySet<RenderJobStatus> = new Set(['done', 'failed']);

export interface Lease {
  owner: string;
  /** 新的到期时间（ISO）。 */
  expiresAt: string;
  now: string;
}

export interface ReclaimResult {
  /** 回到队列等待重试的渲染任务。 */
  retried: RenderJob[];
  /** 次数用完、标记为失败的渲染任务。 */
  failed: RenderJob[];
  /** 租约过期的 AI 任务 ID（调用方标记失败并退点）。 */
  generation: string[];
}

export function createJobQueueRepo(db: Database) {
  const insertRender = db.prepare(
    `INSERT INTO render_jobs (id, kind, status, page_id, credential_id, owner_id, max_attempts, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
  );
  const renderById = db.prepare('SELECT * FROM render_jobs WHERE id = ?');
  const nextRender = db.prepare("SELECT id FROM render_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1");
  const claimRender = db.prepare(
    `UPDATE render_jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status = 'queued'`,
  );
  const renewRender = db.prepare("UPDATE render_jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'");
  const completeRender = db.prepare(
    `UPDATE render_jobs SET status = 'done', outcome = ?, revision_id = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'running'`,
  );
  const failRender = db.prepare(
    `UPDATE render_jobs SET status = 'failed', error_code = ?, lease_owner = NULL, lease_expires_at = NULL, finished_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'running'`,
  );
  const releaseRender = db.prepare(
    `UPDATE render_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, attempts = MAX(attempts - 1, 0)
      WHERE id = ? AND lease_owner = ? AND status = 'running'`,
  );
  const abandonRender = db.prepare("UPDATE render_jobs SET status = 'failed', error_code = 'ABANDONED', finished_at = ? WHERE id = ? AND status = 'queued'");
  const holdsRender = db.prepare("SELECT 1 FROM render_jobs WHERE id = ? AND lease_owner = ? AND status = 'running'");
  const expiredRender = db.prepare(
    "SELECT * FROM render_jobs WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?) AND (lease_owner IS NULL OR lease_owner <> ?)",
  );
  const requeueRender = db.prepare("UPDATE render_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'running'");
  const exhaustRender = db.prepare(
    "UPDATE render_jobs SET status = 'failed', error_code = 'INTERRUPTED', lease_owner = NULL, lease_expires_at = NULL, finished_at = ? WHERE id = ? AND status = 'running'",
  );
  const deleteRender = db.prepare('DELETE FROM render_jobs WHERE id = ?');
  const pruneRender = db.prepare("DELETE FROM render_jobs WHERE status IN ('done', 'failed') AND finished_at < ?");
  const countClaimableRender = db.prepare("SELECT COUNT(*) AS n FROM render_jobs WHERE status = 'queued'");

  const nextGeneration = db.prepare("SELECT id FROM generation_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1");
  const claimGeneration = db.prepare(
    `UPDATE generation_jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, started_at = ?
      WHERE id = ? AND status = 'queued'`,
  );
  const renewGeneration = db.prepare("UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'");
  const holdsGeneration = db.prepare("SELECT 1 FROM generation_jobs WHERE id = ? AND lease_owner = ? AND status = 'running'");
  const expiredGeneration = db.prepare(
    "SELECT id FROM generation_jobs WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?) AND (lease_owner IS NULL OR lease_owner <> ?)",
  );
  const countClaimableGeneration = db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE status = 'queued'");

  return {
    // ---- 渲染任务 ----
    /** 提交与预览带 `credentialId`；直接改文字带 `ownerId`（两者恰好一个，表的 CHECK 约束兜底）。 */
    enqueueRender(input: { id: string; kind: RenderJobKind; pageId: string; credentialId?: string | null; ownerId?: string | null; maxAttempts: number; createdAt: string }): void {
      insertRender.run(input.id, input.kind, input.pageId, input.credentialId ?? null, input.ownerId ?? null, input.maxAttempts, input.createdAt);
    },
    findRender(id: string): RenderJob | null {
      return toRenderJob(renderById.get(id) as Record<string, unknown> | undefined);
    },
    /** 领取最早的排队渲染任务；没有时返回 null。 */
    claimRender(lease: Lease): RenderJob | null {
      return transaction(db, () => {
        const row = nextRender.get() as { id: string } | undefined;
        if (!row) return null;
        if (Number(claimRender.run(lease.owner, lease.expiresAt, lease.now, row.id).changes) !== 1) return null;
        return toRenderJob(renderById.get(row.id) as Record<string, unknown>);
      });
    },
    renewRender(id: string, lease: Lease): boolean {
      return Number(renewRender.run(lease.expiresAt, id, lease.owner).changes) === 1;
    },
    holdsRender(id: string, owner: string): boolean {
      return holdsRender.get(id, owner) !== undefined;
    },
    /** 成功结束（必须仍持有租约）。放在写版本的同一个事务里调用。 */
    completeRender(id: string, owner: string, input: { outcome: RenderJobOutcome; revisionId?: string | null; now: string }): boolean {
      return Number(completeRender.run(input.outcome, input.revisionId ?? null, input.now, id, owner).changes) === 1;
    },
    failRender(id: string, owner: string, errorCode: string, now: string): boolean {
      return Number(failRender.run(errorCode, now, id, owner).changes) === 1;
    },
    /** 优雅退出时交还租约：回到队列，这次不计入尝试次数。 */
    releaseRender(id: string, owner: string): boolean {
      return Number(releaseRender.run(id, owner).changes) === 1;
    },
    /** 等待方放弃（超时）：还在排队的任务直接失败，不再执行。已经在执行的不受影响。 */
    abandonRender(id: string, now: string): boolean {
      return Number(abandonRender.run(now, id).changes) === 1;
    },
    deleteRender(id: string): void {
      deleteRender.run(id);
    },
    pruneRender(before: string): number {
      return Number(pruneRender.run(before).changes);
    },

    // ---- AI 生成 / 修改任务（generation_jobs） ----
    claimGeneration(lease: Lease): string | null {
      return transaction(db, () => {
        const row = nextGeneration.get() as { id: string } | undefined;
        if (!row) return null;
        return Number(claimGeneration.run(lease.owner, lease.expiresAt, lease.now, row.id).changes) === 1 ? row.id : null;
      });
    },
    renewGeneration(id: string, lease: Lease): boolean {
      return Number(renewGeneration.run(lease.expiresAt, id, lease.owner).changes) === 1;
    },
    holdsGeneration(id: string, owner: string): boolean {
      return holdsGeneration.get(id, owner) !== undefined;
    },

    /** 有没有可以领取的任务（`idle()` 用）。 */
    hasClaimable(): { render: boolean; generation: boolean } {
      return {
        render: Number((countClaimableRender.get() as { n: number }).n) > 0,
        generation: Number((countClaimableGeneration.get() as { n: number }).n) > 0,
      };
    },

    /**
     * 回收租约过期的 running 任务（不含 `self` 自己持有的）。渲染任务：还有次数 → 回到队列；用完 → 失败。
     * AI 任务只返回 ID，由调用方按“不重试、标记失败、退点”处理。
     */
    reclaimExpired(now: string, self: string): ReclaimResult {
      return transaction(db, () => {
        const result: ReclaimResult = { retried: [], failed: [], generation: [] };
        for (const row of expiredRender.all(now, self) as Record<string, unknown>[]) {
          const job = toRenderJob(row) as RenderJob;
          if (job.attempts < job.maxAttempts) {
            if (Number(requeueRender.run(job.id).changes) === 1) result.retried.push(job);
          } else if (Number(exhaustRender.run(now, job.id).changes) === 1) {
            result.failed.push(job);
          }
        }
        result.generation = (expiredGeneration.all(now, self) as { id: string }[]).map((row) => row.id);
        return result;
      });
    },
  };
}

export type JobQueueRepo = ReturnType<typeof createJobQueueRepo>;

// ---------------------------------------------------------------------------
// job_events（进度）
// ---------------------------------------------------------------------------

/** 进度阶段（contracts 13.3）。 */
export const JOB_STAGES = ['queued', 'reading', 'designing', 'generating', 'validating', 'rendering', 'retrying', 'succeeded', 'needs_input', 'failed'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/** 给界面用的中文阶段名（第二阶段的实时进度会用）。 */
export const JOB_STAGE_LABELS: Record<JobStage, string> = {
  queued: '排队中',
  reading: '读取资料',
  designing: '设计',
  generating: '生成中',
  validating: '校验',
  rendering: '渲染截图',
  retrying: '重新排队',
  succeeded: '完成',
  needs_input: '需要补充说明',
  failed: '失败',
};

export const TERMINAL_JOB_STAGES: ReadonlySet<JobStage> = new Set(['succeeded', 'needs_input', 'failed']);

/** 进度事件的数值属性：只允许这些键，值必须是非负整数。 */
export const JOB_EVENT_PROP_KEYS = ['turn', 'attempt', 'maxTurns', 'files'] as const;
export type JobEventProps = Partial<Record<(typeof JOB_EVENT_PROP_KEYS)[number], number>>;

export interface JobEvent {
  jobId: string;
  seq: number;
  stage: JobStage;
  props: JobEventProps;
  createdAt: string;
}

const STAGE_SET: ReadonlySet<string> = new Set(JOB_STAGES);
const PROP_KEY_SET: ReadonlySet<string> = new Set(JOB_EVENT_PROP_KEYS);

function cleanProps(props: JobEventProps | undefined): JobEventProps {
  const out: JobEventProps = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (!PROP_KEY_SET.has(key)) throw new Error(`进度事件不支持的属性：${key}`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) throw new Error(`进度事件属性必须是非负整数：${key}`);
    out[key as keyof JobEventProps] = value;
  }
  return out;
}

export function createJobEventsRepo(db: Database) {
  // 序号在同一条语句里计算：并发写入同一个任务也不会重号（主键兜底）
  const insert = db.prepare(
    `INSERT INTO job_events (job_id, seq, stage, props_json, created_at)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM job_events WHERE job_id = ?
     RETURNING seq`,
  );
  const after = db.prepare('SELECT * FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?');
  const last = db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY seq DESC LIMIT 1');
  const removeFor = db.prepare('DELETE FROM job_events WHERE job_id = ?');
  const prune = db.prepare('DELETE FROM job_events WHERE created_at < ?');

  const toEvent = (row: Record<string, unknown>): JobEvent => ({
    jobId: row.job_id as string,
    seq: Number(row.seq),
    stage: row.stage as JobStage,
    props: JSON.parse((row.props_json as string) || '{}') as JobEventProps,
    createdAt: row.created_at as string,
  });

  return {
    /** 追加一条进度事件，返回序号。 */
    append(jobId: string, stage: JobStage, createdAt: string, props?: JobEventProps): number {
      if (!STAGE_SET.has(stage)) throw new Error(`未知的进度阶段：${String(stage)}`);
      const row = insert.get(jobId, stage, JSON.stringify(cleanProps(props)), createdAt, jobId) as { seq: number };
      return Number(row.seq);
    },
    /**
     * 某个任务序号 `afterSeq` 之后的事件（按序号升序，最多 `limit` 条）。第二阶段的实时进度（SSE）用它续传。
     * 调用方必须先确认查看者是任务的主人（`repos.jobs.findForOwner`）；这里不做授权。
     */
    listAfter(jobId: string, afterSeq = 0, limit = 100): JobEvent[] {
      return (after.all(jobId, afterSeq, Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[]).map(toEvent);
    },
    latest(jobId: string): JobEvent | null {
      const row = last.get(jobId) as Record<string, unknown> | undefined;
      return row ? toEvent(row) : null;
    },
    removeForJob(jobId: string): void {
      removeFor.run(jobId);
    },
    prune(before: string): number {
      return Number(prune.run(before).changes);
    },
  };
}

export type JobEventsRepo = ReturnType<typeof createJobEventsRepo>;
