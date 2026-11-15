/**
 * 注销过的邮箱（contracts 14.7）：只存 HMAC-SHA256，不存邮箱本身，只用于“同一邮箱注销后重新注册不再赠送点数”。
 *
 * 密钥由服务端票据密钥（`NOWME_TICKET_SECRET` / `<dataDir>/secret`）按用途派生：没有这把密钥无法从库里的值反推或比对邮箱。
 * 更换票据密钥后旧记录不再匹配（只会让少数人重新拿到一次赠送点数，不影响安全）。
 */
import { createHmac } from 'node:crypto';
import type { AppDeps } from '../context.js';

const KEY_PURPOSE = 'nowme:deleted-email:v1';

export function deletedEmailHmac(secret: string, email: string): string {
  const key = createHmac('sha256', secret).update(KEY_PURPOSE).digest();
  return createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex');
}

type Deps = Pick<AppDeps, 'db'> & { config: Pick<AppDeps['config'], 'ticketSecret'> };

/** 记下这个邮箱注销过（调用方放在注销事务里）。 */
export function recordDeletedEmail(deps: Deps, email: string, nowIso: string): void {
  deps.db
    .prepare('INSERT INTO deleted_emails (email_hmac, created_at) VALUES (?, ?) ON CONFLICT (email_hmac) DO NOTHING')
    .run(deletedEmailHmac(deps.config.ticketSecret, email), nowIso);
}

/** 这个邮箱以前注销过账号。 */
export function wasEmailDeleted(deps: Deps, email: string): boolean {
  return deps.db.prepare('SELECT 1 FROM deleted_emails WHERE email_hmac = ?').get(deletedEmailHmac(deps.config.ticketSecret, email)) !== undefined;
}
