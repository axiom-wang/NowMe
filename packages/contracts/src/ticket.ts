/**
 * 页面票据（contracts 4.4）：`<revisionId>.<expUnix>.<sig>`，
 * `sig = base64url(HMAC-SHA256(secret, "<revisionId>.<expUnix>"))`，无填充。
 *
 * 主站签发（授权检查通过后），页面托管校验，两边共用本模块。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TICKET_TTL_SECONDS } from './constants.js';
import { REVISION_ID_PATTERN } from './ids.js';

const EXP_PATTERN = /^[1-9][0-9]{0,11}$/;
/** HMAC-SHA256 是 32 字节，base64url 无填充为 43 个字符。 */
const SIG_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 票据整体长度上限（远大于实际长度 ~85，用于尽早拒绝异常输入）。 */
const TICKET_MAX_LENGTH = 256;

export interface SignTicketInput {
  /** `rev_` + 26 位 base32。 */
  revisionId: string;
  /** 过期时刻（向下取整到秒）。在该时刻及之后票据无效。 */
  expiresAt: Date;
  secret: string;
}

export type TicketFailureReason = 'malformed' | 'bad_signature' | 'expired';

export type VerifyTicketResult =
  | { ok: true; revisionId: string; expiresAt: Date }
  | { ok: false; reason: TicketFailureReason };

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('票据密钥为空：请设置 NOWME_TICKET_SECRET 或使用 resolveTicketSecret()');
  }
}

function computeSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export function signTicket({ revisionId, expiresAt, secret }: SignTicketInput): string {
  assertSecret(secret);
  if (!REVISION_ID_PATTERN.test(revisionId)) {
    throw new Error(`revisionId 格式不对：${revisionId}`);
  }
  const ms = expiresAt.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error('expiresAt 不是有效时间');
  }
  const exp = Math.floor(ms / 1000);
  if (!EXP_PATTERN.test(String(exp))) {
    throw new Error(`expiresAt 超出范围：${expiresAt.toISOString()}`);
  }
  const payload = `${revisionId}.${exp}`;
  return `${payload}.${computeSignature(payload, secret)}`;
}

/** 按默认有效期（30 分钟）签发。 */
export function issueTicket(
  revisionId: string,
  secret: string,
  now: Date = new Date(),
  ttlSeconds: number = TICKET_TTL_SECONDS,
): string {
  return signTicket({ revisionId, secret, expiresAt: new Date(now.getTime() + ttlSeconds * 1000) });
}

/**
 * 校验票据。先校验格式，再常量时间比较签名，最后检查是否过期。
 * 成功时返回的 revisionId 已匹配 `rev_[a-z2-7]{26}`，可安全用于拼接存储路径。
 */
export function verifyTicket(ticket: string, secret: string, now: Date = new Date()): VerifyTicketResult {
  assertSecret(secret);
  if (typeof ticket !== 'string' || ticket.length > TICKET_MAX_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = ticket.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [revisionId, expText, sig] = parts as [string, string, string];
  if (!REVISION_ID_PATTERN.test(revisionId) || !EXP_PATTERN.test(expText) || !SIG_PATTERN.test(sig)) {
    return { ok: false, reason: 'malformed' };
  }

  // 比较 base64url 字符串本身（而不是解码后的字节），避免同一签名的非规范编码也被接受。
  const expected = Buffer.from(computeSignature(`${revisionId}.${expText}`, secret), 'utf8');
  const actual = Buffer.from(sig, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const expSeconds = Number(expText);
  if (Math.floor(now.getTime() / 1000) >= expSeconds) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, revisionId, expiresAt: new Date(expSeconds * 1000) };
}
