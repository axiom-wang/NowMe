/**
 * 点数的存储（contracts 12）：余额、只追加的流水、兑换码、墙的额度设置。
 * 业务规则（谁能扣谁的、扣多少、何时退）在 services/billing.ts；这里只保证“余额与流水一起写、余额不为负”。
 */
import { generateId } from '@nowme/contracts';
import type { Database } from './database.js';

export type AccountKind = 'user' | 'wall';
export interface Account {
  kind: AccountKind;
  id: string;
}

export type CreditReason = 'redeem' | 'grant' | 'signup' | 'adjust' | 'sponsor_out' | 'sponsor_in' | 'sponsor_return' | 'job' | 'job_refund';

export interface CreditEntry {
  id: string;
  account: Account;
  delta: number;
  balanceAfter: number;
  reason: CreditReason;
  refId: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface RedeemCodeRecord {
  id: string;
  credits: number;
  batch: string | null;
  expiresAt: string | null;
  redeemedBy: string | null;
  redeemedAt: string | null;
  createdAt: string;
}

/** 余额不够（或会变成负数）。 */
export class InsufficientCredits extends Error {
  override name = 'InsufficientCredits';
}

function toEntry(row: Record<string, unknown>): CreditEntry {
  return {
    id: row.id as string,
    account: { kind: row.account_kind as AccountKind, id: row.account_id as string },
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    reason: row.reason as CreditReason,
    refId: (row.ref_id as string | null) ?? null,
    actorId: (row.actor_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function toCode(row: Record<string, unknown>): RedeemCodeRecord {
  return {
    id: row.id as string,
    credits: Number(row.credits),
    batch: (row.batch as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    redeemedBy: (row.redeemed_by as string | null) ?? null,
    redeemedAt: (row.redeemed_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export function createCreditsRepo(db: Database) {
  const balance = db.prepare('SELECT balance FROM credit_balances WHERE account_kind = ? AND account_id = ?');
  const upsertBalance = db.prepare(
    `INSERT INTO credit_balances (account_kind, account_id, balance, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_kind, account_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
  );
  const insertEntry = db.prepare(
    'INSERT INTO credit_entries (id, account_kind, account_id, delta, balance_after, reason, ref_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const entries = db.prepare('SELECT * FROM credit_entries WHERE account_kind = ? AND account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?');
  const entryFor = db.prepare('SELECT * FROM credit_entries WHERE reason = ? AND ref_id = ?');
  const wallUsedBy = db.prepare(
    "SELECT COALESCE(-SUM(delta), 0) AS used FROM credit_entries WHERE account_kind = 'wall' AND account_id = ? AND actor_id = ? AND reason IN ('job', 'job_refund')",
  );
  const wallSpent = db.prepare(
    "SELECT COALESCE(-SUM(delta), 0) AS used FROM credit_entries WHERE account_kind = 'wall' AND account_id = ? AND reason IN ('job', 'job_refund')",
  );
  const wallFunded = db.prepare("SELECT COALESCE(SUM(delta), 0) AS total FROM credit_entries WHERE account_kind = 'wall' AND account_id = ? AND reason = 'sponsor_in'");
  const unsettledJobs = db.prepare(
    `SELECT e.ref_id AS job_id
       FROM credit_entries e
       JOIN generation_jobs j ON j.id = e.ref_id
      WHERE e.reason = 'job'
        AND j.status IN ('failed', 'needs_input')
        AND NOT EXISTS (SELECT 1 FROM credit_entries r WHERE r.reason = 'job_refund' AND r.ref_id = e.ref_id)`,
  );
  const insertCode = db.prepare('INSERT INTO redeem_codes (id, code_hash, credits, batch, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const codeByHash = db.prepare('SELECT * FROM redeem_codes WHERE code_hash = ?');
  const markRedeemed = db.prepare('UPDATE redeem_codes SET redeemed_by = ?, redeemed_at = ? WHERE id = ? AND redeemed_by IS NULL');
  const memberCap = db.prepare('SELECT member_cap FROM wall_sponsorships WHERE wall_id = ?');
  const upsertCap = db.prepare(
    `INSERT INTO wall_sponsorships (wall_id, member_cap, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (wall_id) DO UPDATE SET member_cap = excluded.member_cap, updated_at = excluded.updated_at`,
  );

  const balanceOf = (account: Account): number => Number((balance.get(account.kind, account.id) as { balance: number } | undefined)?.balance ?? 0);

  return {
    balanceOf,
    /**
     * 记一笔并更新余额（调用方放在事务里）。余额会变成负数时抛 `InsufficientCredits`，什么都不写。
     * `job` / `job_refund` / `redeem` 按 ref_id 唯一：重复记账会被数据库拒绝（抛错，由调用方的事务回滚）。
     */
    post(input: { account: Account; delta: number; reason: CreditReason; refId?: string | null; actorId?: string | null; at: string }): CreditEntry {
      if (!Number.isInteger(input.delta) || input.delta === 0) throw new Error('点数变动必须是非零整数');
      const next = balanceOf(input.account) + input.delta;
      if (next < 0) throw new InsufficientCredits();
      const id = generateId('cre');
      // 先写流水（重复记账在这里被唯一约束拒绝），再改余额：即使调用方没有开事务，也不会出现“余额变了、流水没记”
      insertEntry.run(id, input.account.kind, input.account.id, input.delta, next, input.reason, input.refId ?? null, input.actorId ?? null, input.at);
      upsertBalance.run(input.account.kind, input.account.id, next, input.at);
      return { id, account: input.account, delta: input.delta, balanceAfter: next, reason: input.reason, refId: input.refId ?? null, actorId: input.actorId ?? null, createdAt: input.at };
    },
    /** 最近的流水，新的在前。 */
    listEntries(account: Account, limit: number): CreditEntry[] {
      return (entries.all(account.kind, account.id, limit) as Record<string, unknown>[]).map(toEntry);
    },
    /** 某个任务的扣点 / 退点流水（没有时为 null）。 */
    findJobEntry(reason: 'job' | 'job_refund', jobId: string): CreditEntry | null {
      const row = entryFor.get(reason, jobId) as Record<string, unknown> | undefined;
      return row ? toEntry(row) : null;
    },
    /** 这位成员已经用了这面墙多少点（扣点减去退点）。 */
    wallUsedBy(wallId: string, userId: string): number {
      return Number((wallUsedBy.get(wallId, userId) as { used: number }).used);
    },
    /** 这面墙的额度一共用掉多少、组织者一共充入多少（聚合数字，不含任何人的明细）。 */
    wallTotals(wallId: string): { spent: number; funded: number } {
      return { spent: Number((wallSpent.get(wallId) as { used: number }).used), funded: Number((wallFunded.get(wallId) as { total: number }).total) };
    },
    /** 扣了点、任务已经以失败 / 需要补充说明结束、但还没退点的任务。 */
    listUnsettledJobs(): string[] {
      return (unsettledJobs.all() as { job_id: string }[]).map((row) => row.job_id);
    },
    insertCode(input: { id: string; codeHash: string; credits: number; batch: string | null; expiresAt: string | null; createdAt: string }): void {
      insertCode.run(input.id, input.codeHash, input.credits, input.batch, input.expiresAt, input.createdAt);
    },
    findCodeByHash(codeHash: string): RedeemCodeRecord | null {
      const row = codeByHash.get(codeHash) as Record<string, unknown> | undefined;
      return row ? toCode(row) : null;
    },
    /** 标记为已兑换；已经被兑换过时返回 false。 */
    markCodeRedeemed(id: string, userId: string, at: string): boolean {
      return Number(markRedeemed.run(userId, at, id).changes) === 1;
    },
    memberCap(wallId: string): number {
      return Number((memberCap.get(wallId) as { member_cap: number } | undefined)?.member_cap ?? 0);
    },
    setMemberCap(wallId: string, cap: number, at: string): void {
      upsertCap.run(wallId, cap, at);
    },
  };
}
