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

function codeHash(codeId: string, code: string): string {
  return hashToken(`${codeId}.${code}`);
}

export type RequestCodeResult = { ok: true } | { ok: false; reason: 'rate_limited' };

/** 签发验证码并写入发件箱。 */
export function requestLoginCode(deps: Pick<AppDeps, 'db' | 'repos' | 'now' | 'outbox'>, email: string): RequestCodeResult {
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
  deps.outbox.send({
    at: nowIso,
    to: email,
    subject: 'NOWMe 登录验证码',
    body: `你的验证码是 ${code}，${LOGIN_CODE_TTL_SECONDS / 60} 分钟内有效。不是你本人操作请忽略。`,
  });
  return { ok: true };
}

export type VerifyCodeResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'no_code' | 'locked' }
  | { ok: false; reason: 'mismatch'; remaining: number };

/** 校验验证码；成功时找到或创建用户。每次尝试都计数，第 5 次失败后验证码作废。 */
export function verifyLoginCode(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now'>,
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
    const user =
      repos.users.findByEmail(email) ??
      repos.users.create({ id: generateId('usr'), email, nickname: null, createdAt: nowIso });
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
  return user ? { user, session } : null;
}

export function destroySession(deps: Pick<AppDeps, 'repos'>, token: string | undefined): void {
  if (!token || !isTokenFormat(token, 'session')) return;
  deps.repos.sessions.delete(hashToken(token));
}
