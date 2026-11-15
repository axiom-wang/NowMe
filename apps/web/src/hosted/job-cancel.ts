/**
 * 中止某个用户排队中 / 执行中的托管生成 / 修改任务（contracts 13.4）：停用账号（contracts 15）、注销账号（contracts 14）时调用。
 *
 * 每个任务在一个事务里：标记失败（清掉租约）+ 全额退点（`settleJob`，只退一次）；然后写 `failed` 进度事件。
 * 执行它的 worker（可能在另一个进程）在下一轮调用模型前、或下一次续约时发现租约已不在，停止后续模型请求；
 * 之后的写入都带租约条件，不会存版本、不会再结算。
 */
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import { settleJob } from '../services/billing.js';

export type CancelReason = 'SUSPENDED' | 'PAGE_GONE';

/** 返回中止的任务数。可以放在调用方的事务里（嵌套为 SAVEPOINT）。 */
export function cancelActiveJobsForUser(deps: Pick<AppDeps, 'db' | 'repos' | 'now'>, userId: string, reason: CancelReason): number {
  let cancelled = 0;
  for (const jobId of deps.repos.jobs.listActiveIdsForOwner(userId)) {
    const done = transaction(deps.db, () => {
      const nowIso = deps.now().toISOString();
      if (!deps.repos.jobs.cancel(jobId, reason, nowIso)) return false;
      settleJob(deps, jobId, false);
      deps.repos.jobEvents.append(jobId, 'failed', nowIso);
      return true;
    });
    if (done) cancelled += 1;
  }
  return cancelled;
}
