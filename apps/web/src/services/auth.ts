/**
 * 邮箱验证码登录与会话（W01、contracts 3、4.2）。
 *
 * - 验证码：6 位数字，10 分钟，最多 5 次尝试；只存 SHA-256（`"<id>.<code>"`）；新验证码作废同一邮箱的旧验证码；
 *   同一邮箱 10 分钟内最多 5 次（简单限流）。不论邮箱是否已注册都发码，不暴露账号是否存在。
 * - 会话：`nms_` 令牌明文只在 cookie 里，库里只有哈希；CSRF 令牌随会话生成。
 */
import { randomBytes } from 'node:crypto';
import {
  codePointLength,
  constantTimeEqual,
  generateId,
  generateLoginCode,
  generateToken,
  hashToken,
  isTokenFormat,
  LOGIN_CODE_DIGITS,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_TTL_SECONDS,
  SESSION_TTL_SECONDS,
} from '@nowme/contracts';
import { EMAIL_MAX_LENGTH, LOGIN_CODE_RATE_MAX, LOGIN_CODE_RATE_WINDOW_SECONDS, NICKNAME_LIMITS } from '../constants.js';
import type { AppDeps, SessionAuth } from '../context.js';
import { transaction } from '../db/index.js';
import type { User } from '../db/users.js';
import { grantSignupCredits } from './billing.js';
import { wasEmailDeleted } from './deleted-emails.js';

const EMAIL_PATTERN = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`.]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 规范化邮箱（去首尾空白、转小写）；不合法时返回 null。 */
export function normalizeEmail(raw: string | undefined): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  if (email.length < 3 || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** 校验昵称：去首尾空白后 1–24 个字符，不含控制字符。返回错误说明或 null。 */
export function nicknameProblem(nickname: string): string | null {
  const length = codePointLength(nickname);
  if (length < NICKNAME_LIMITS.min || length > NICKNAME_LIMITS.max) {
    return `昵称应为 ${NICKNAME_LIMITS.min}–${NICKNAME_LIMITS.max} 个字`;
  }
  if (CONTROL_CHARS.test(nickname)) return '昵称不能包含换行等控制字符';
  return null;
}

/** 验证码哈希：SHA-256(`<id>.<code>`)（登录与注销确认共用）。 */
export function codeHash(codeId: string, code: string): string {
  return hashToken(`${codeId}.${code}`);
}

export type RequestCodeResult = { ok: true } | { ok: false; reason: 'rate_limited' | 'send_failed' };

/** 邮件正文（纯文本 + 简单的 HTML）。验证码放在主题最前面：手机通知里一眼能看到。 */
export function loginCodeMail(code: string): { subject: string; body: string; html: string } {
  const minutes = LOGIN_CODE_TTL_SECONDS / 60;
  return {
    subject: `${code} 是你的 NOWMe 登录验证码`,
    body: `你的验证码是 ${code}，${minutes} 分钟内有效。不是你本人操作请忽略。`,
    html: [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#16150f;max-width:420px;margin:0 auto;padding:24px 8px">',
      '<p style="font-size:18px;font-weight:700;margin:0 0 16px">NOW<span style="background:#d4f54a;border:1.5px solid #16150f;border-radius:8px;padding:0 6px;margin-left:2px">Me</span></p>',
      '<p style="font-size:15px;line-height:1.6;margin:0 0 12px">你的登录验证码：</p>',
      `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>`,
      `<p style="font-size:14px;line-height:1.6;color:#45413a;margin:0 0 8px">${minutes} 分钟内有效，只能用一次。</p>`,
      '<p style="font-size:13px;line-height:1.6;color:#776f62;margin:0">不是你本人操作的话，忽略这封邮件就好，不需要做任何事。</p>',
      '</div>',
    ].join(''),
  };
}

/**
 * 签发验证码并交给发件箱。真实邮件发不出去时返回 `send_failed`：这个验证码立即作废
 * （用户没收到，不该留着一个可用的码），但仍计入限流次数。
 */
export async function requestLoginCode(deps: Pick<AppDeps, 'db' | 'repos' | 'now' | 'outbox'>, email: string): Promise<RequestCodeResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - LOGIN_CODE_RATE_WINDOW_SECONDS * 1000).toISOString();
  const code = generateLoginCode();
  const issued = transaction(deps.db, () => {
    if (deps.repos.loginCodes.countCreatedSince(email, windowStart) >= LOGIN_CODE_RATE_MAX) return false;
    deps.repos.loginCodes.invalidateUnused(email, nowIso);
    const id = generateId('lgc');
    deps.repos.loginCodes.create({
      id,
      email,
      codeHash: codeHash(id, code),
      expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_SECONDS * 1000).toISOString(),
      createdAt: nowIso,
    });
    return true;
  });
  if (!issued) return { ok: false, reason: 'rate_limited' };
  try {
    await deps.outbox.send({ at: nowIso, to: email, ...loginCodeMail(code) });
  } catch {
    deps.repos.loginCodes.invalidateUnused(email, deps.now().toISOString());
    return { ok: false, reason: 'send_failed' };
  }
  return { ok: true };
}

export type VerifyCodeResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'no_code' | 'locked' | 'suspended' }
  | { ok: false; reason: 'mismatch'; remaining: number };

/** 校验验证码；成功时找到或创建用户。每次尝试都计数，第 5 次失败后验证码作废。 */
export function verifyLoginCode(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now' | 'config'>,
  email: string,
  rawCode: string | undefined,
): VerifyCodeResult {
  const nowIso = deps.now().toISOString();
  const input = (rawCode ?? '').replace(/\s+/g, '');
  const { repos } = deps;
  return transaction(deps.db, (): VerifyCodeResult => {
    const record = repos.loginCodes.findLatestUsable(email, nowIso);
    if (!record) return { ok: false, reason: 'no_code' };
    if (record.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      repos.loginCodes.markUsed(record.id, nowIso);
      return { ok: false, reason: 'locked' };
    }
    const attempts = repos.loginCodes.incrementAttempts(record.id);
    const wellFormed = new RegExp(`^\\d{${LOGIN_CODE_DIGITS}}$`).test(input);
    if (!wellFormed || !constantTimeEqual(codeHash(record.id, input), record.codeHash)) {
      if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
        repos.loginCodes.markUsed(record.id, nowIso);
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'mismatch', remaining: LOGIN_CODE_MAX_ATTEMPTS - attempts };
    }
    if (!repos.loginCodes.markUsed(record.id, nowIso)) return { ok: false, reason: 'no_code' };
    const existing = repos.users.findByEmail(email);
    // 停用的账号不能登录（contracts 15）；验证码照常作废
    if (existing && repos.moderation.isSuspended(existing.id)) return { ok: false, reason: 'suspended' };
    const user = existing ?? repos.users.create({ id: generateId('usr'), email, nickname: null, createdAt: nowIso });
    // 新用户的注册赠送点数（contracts 12；配置为 0 时不做任何事）
    // 同一邮箱注销后重新注册不再赠送（contracts 14.7）
    if (!existing && !wasEmailDeleted(deps, email)) grantSignupCredits(deps, user.id);
    return { ok: true, user };
  });
}

export interface CreatedSession {
  /** 会话令牌明文（只写进 cookie）。 */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export function createSession(deps: Pick<AppDeps, 'repos' | 'now'>, userId: string): CreatedSession {
  const now = deps.now();
  const token = generateToken('session');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  deps.repos.sessions.create({
    id: hashToken(token),
    userId,
    csrfToken,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return { token, csrfToken, expiresAt };
}

/** 由 cookie 中的会话令牌找到会话与用户。格式不对（例如拿页面凭证冒充）、不存在、过期都返回 null。 */
export function loadSession(deps: Pick<AppDeps, 'repos' | 'now'>, token: string | undefined): SessionAuth | null {
  if (!token || !isTokenFormat(token, 'session')) return null;
  const session = deps.repos.sessions.findValid(hashToken(token), deps.now().toISOString());
  if (!session) return null;
  const user = deps.repos.users.findById(session.userId);
  // 注销的账号不能有会话（注销时会话已全部删除，这里再挡一次）
  if (!user || user.deletedAt || deps.repos.moderation.isSuspended(user.id)) return null;
  return { user, session };
}

export function destroySession(deps: Pick<AppDeps, 'repos'>, token: string | undefined): void {
  if (!token || !isTokenFormat(token, 'session')) return;
  deps.repos.sessions.delete(hashToken(token));
}
