/**
 * 完成通知（contracts 18，迁移 `015_notify_prefs.sql`）：用户的邮件开关与每个任务的通知判定。
 *
 * `job_notices` 只存任务 ID、判定结果与时间；判定用 `claim()` 抢占（主键冲突即已被别的实例 / 上一次运行处理），
 * 所以同一个任务最多发一封信。
 */
import type { Database } from './database.js';
import type { GenerationJob } from './hosted.js';

export type JobNoticeOutcome = 'pending' | 'sent' | 'present' | 'off' | 'skipped' | 'failed';

/** 刚结束、还没判定过的任务（只有通知需要的字段）。 */
export interface FinishedJob {
  id: string;
  pageId: string;
  ownerId: string;
  kind: GenerationJob['kind'];
  status: 'succeeded' | 'failed' | 'needs_input';
  revisionId: string | null;
  errorCode: string | null;
  finishedAt: string;
}

export function createNotifyRepo(db: Database) {
  const getPref = db.prepare('SELECT notify_job_email AS enabled FROM users WHERE id = ?');
  const setPref = db.prepare('UPDATE users SET notify_job_email = ? WHERE id = ?');
  const claim = db.prepare("INSERT INTO job_notices (job_id, outcome, created_at) VALUES (?, 'pending', ?) ON CONFLICT (job_id) DO NOTHING");
  const resolve = db.prepare('UPDATE job_notices SET outcome = ? WHERE job_id = ?');
  const outcome = db.prepare('SELECT outcome FROM job_notices WHERE job_id = ?');
  const unnoticed = db.prepare(
    `SELECT j.id, j.page_id, j.owner_id, j.kind, j.status, j.revision_id, j.error_code, j.finished_at
       FROM generation_jobs j LEFT JOIN job_notices n ON n.job_id = j.id
      WHERE j.finished_at >= ? AND j.status IN ('succeeded', 'failed', 'needs_input') AND n.job_id IS NULL
      ORDER BY j.finished_at LIMIT ?`,
  );
  const prune = db.prepare('DELETE FROM job_notices WHERE created_at < ?');

  return {
    /** 生成 / 修改结束时要不要发邮件提醒（默认开启；用户不存在时为 false）。 */
    jobEmailEnabled(userId: string): boolean {
      const row = getPref.get(userId) as { enabled: number } | undefined;
      return row?.enabled === 1;
    },
    setJobEmail(userId: string, enabled: boolean): void {
      setPref.run(enabled ? 1 : 0, userId);
    },
    /** `since` 之后结束、还没判定过的任务（按结束时间升序）。 */
    listUnnoticed(since: string, limit = 50): FinishedJob[] {
      return (unnoticed.all(since, limit) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        pageId: row.page_id as string,
        ownerId: row.owner_id as string,
        kind: row.kind as GenerationJob['kind'],
        status: row.status as FinishedJob['status'],
        revisionId: (row.revision_id as string | null) ?? null,
        errorCode: (row.error_code as string | null) ?? null,
        finishedAt: row.finished_at as string,
      }));
    },
    /** 抢占一个任务的判定权：成功返回 true；已经判定过（或别的实例正在判定）返回 false。 */
    claim(jobId: string, at: string): boolean {
      return Number(claim.run(jobId, at).changes) === 1;
    },
    resolve(jobId: string, result: Exclude<JobNoticeOutcome, 'pending'>): void {
      resolve.run(result, jobId);
    },
    outcomeOf(jobId: string): JobNoticeOutcome | null {
      const row = outcome.get(jobId) as { outcome: JobNoticeOutcome } | undefined;
      return row?.outcome ?? null;
    },
    prune(before: string): number {
      return Number(prune.run(before).changes);
    },
  };
}

export type NotifyRepo = ReturnType<typeof createNotifyRepo>;
