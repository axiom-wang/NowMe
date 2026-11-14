/**
 * `login_codes` 表（contracts 3）：只存哈希；10 分钟、最多 5 次尝试。
 * `purpose`（迁移 011）：`login` 登录；`account_delete` 注销账号前的二次确认（contracts 14）。两种用途互不通用。
 */
import type { Database } from './database.js';

export type LoginCodePurpose = 'login' | 'account_delete';

export interface LoginCode {
  id: string;
  email: string;
  codeHash: string;
  attempts: number;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface LoginCodeRow {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function toLoginCode(row: LoginCodeRow | undefined): LoginCode | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    codeHash: row.code_hash,
    attempts: Number(row.attempts),
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export function createLoginCodesRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO login_codes (id, email, code_hash, attempts, expires_at, used_at, created_at, purpose) VALUES (?, ?, ?, 0, ?, NULL, ?, ?)',
  );
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?');
  const invalidate = db.prepare('UPDATE login_codes SET used_at = ? WHERE email = ? AND used_at IS NULL');
  const invalidatePurpose = db.prepare('UPDATE login_codes SET used_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL');
  const latestUsable = db.prepare(
    'SELECT * FROM login_codes WHERE email = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );
  const deleteForEmail = db.prepare('DELETE FROM login_codes WHERE email = ?');
  const bumpAttempts = db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? RETURNING attempts');
  const markUsed = db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL');
  const deleteBefore = db.prepare('DELETE FROM login_codes WHERE expires_at <= ?');

  return {
    create(code: Omit<LoginCode, 'attempts' | 'usedAt'>, purpose: LoginCodePurpose = 'login'): void {
      insert.run(code.id, code.email, code.codeHash, code.expiresAt, code.createdAt, purpose);
    },
    /** 某邮箱在 `since` 之后签发的验证码个数（限流用）。 */
    countCreatedSince(email: string, since: string): number {
      return Number((countSince.get(email, since) as { n: number }).n);
    },
    /** 作废该邮箱未使用的验证码（给出 `purpose` 时只作废这种用途的）。 */
    invalidateUnused(email: string, now: string, purpose?: LoginCodePurpose): void {
      if (purpose) invalidatePurpose.run(now, email, purpose);
      else invalidate.run(now, email);
    },
    /** 该邮箱最新的、未使用且未过期的、这种用途（默认登录）的验证码。 */
    findLatestUsable(email: string, now: string, purpose: LoginCodePurpose = 'login'): LoginCode | null {
      return toLoginCode(latestUsable.get(email, purpose, now) as LoginCodeRow | undefined);
    },
    /** 删除该邮箱的全部验证码记录（注销账号时）。 */
    deleteForEmail(email: string): number {
      return Number(deleteForEmail.run(email).changes);
    },
    /** 尝试次数 +1，返回新的次数。 */
    incrementAttempts(id: string): number {
      return Number((bumpAttempts.get(id) as { attempts: number }).attempts);
    },
    /** 标记为已使用；已经用过时返回 false。 */
    markUsed(id: string, now: string): boolean {
      return Number(markUsed.run(now, id).changes) === 1;
    },
    deleteExpiredBefore(time: string): number {
      return Number(deleteBefore.run(time).changes);
    },
  };
}

export type LoginCodesRepo = ReturnType<typeof createLoginCodesRepo>;
