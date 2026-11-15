/**
 * ID 与令牌（contracts 3）。
 *
 * - ID：`<前缀>_<16 字节随机 base32 小写>`（RFC 4648 字母表、小写、无填充，26 个字符）。
 * - 令牌：见 TOKEN_FORMATS。一次性 token、页面凭证、会话令牌、登录验证码只存 SHA-256 哈希（hashToken）；
 *   邀请码与公开链接令牌明文保存。
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { LOGIN_CODE_DIGITS } from './constants.js';

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32，小写，无填充。 */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/** base64url，无填充。 */
export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** n 字节编码后的字符数。 */
const base32Length = (bytes: number): number => Math.ceil((bytes * 8) / 5);
const base64UrlLength = (bytes: number): number => Math.ceil((bytes * 8) / 6);

// ---------------------------------------------------------------------------
// ID
// ---------------------------------------------------------------------------

export const ID_RANDOM_BYTES = 16;
export const ID_RANDOM_LENGTH = base32Length(ID_RANDOM_BYTES); // 26

/**
 * 各实体的 ID 前缀。
 * contracts 3 的表给出了 usr / wal / mem / pg / rev / pbl / evt；
 * login_codes、agent_tokens、page_credentials 的 `id` 前缀 contracts 未指定，
 * 这里 [T0.2 暂定] 为 lgc / agt / crd（避开令牌前缀 nmt / nmc / nms / inv / pub）。
 * sessions 的 `id` 是会话令牌的哈希，不用 generateId。
 */
export const ID_PREFIXES = {
  user: 'usr',
  conversation: 'cnv',
  wall: 'wal',
  membership: 'mem',
  page: 'pg',
  revision: 'rev',
  publication: 'pbl',
  event: 'evt',
  loginCode: 'lgc',
  agentToken: 'agt',
  pageCredential: 'crd',
  // 平台托管路线（contracts 9 / hosted-route 4）
  profileEntry: 'pfe',
  brief: 'brf',
  briefAsset: 'bas',
  generationJob: 'gen',
  // “和 TA 聊什么”（contracts 11）
  icebreaker: 'ice',
  // 点数（contracts 12）
  creditEntry: 'cre',
  redeemCode: 'rdc',
  // 举报与处理（contracts 15）
  report: 'rpt',
  moderationAction: 'mda',
  // 后台任务队列（contracts 13）：提交渲染、远程预览
  renderJob: 'job',
  // 组织者工具（contracts 19）
  wallQuestion: 'wqn',
  wallReminder: 'rmd',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ID_PREFIX_SET: ReadonlySet<string> = new Set(Object.values(ID_PREFIXES));

/** 生成 `<prefix>_<26 位 base32 小写>`。 */
export function generateId(prefix: IdPrefix): string {
  if (!ID_PREFIX_SET.has(prefix)) {
    throw new Error(`未知的 ID 前缀：${String(prefix)}`);
  }
  return `${prefix}_${base32Lower(randomBytes(ID_RANDOM_BYTES))}`;
}

/** 某个前缀的 ID 正则（完整匹配）。 */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[a-z2-7]{${ID_RANDOM_LENGTH}}$`);
}

export function isId(value: unknown, prefix: IdPrefix): value is string {
  return typeof value === 'string' && idPattern(prefix).test(value);
}

export const REVISION_ID_PATTERN = idPattern(ID_PREFIXES.revision);
export const WALL_ID_PATTERN = idPattern(ID_PREFIXES.wall);
export const PAGE_ID_PATTERN = idPattern(ID_PREFIXES.page);
export const PROFILE_ENTRY_ID_PATTERN = idPattern(ID_PREFIXES.profileEntry);
export const BRIEF_ID_PATTERN = idPattern(ID_PREFIXES.brief);
export const BRIEF_ASSET_ID_PATTERN = idPattern(ID_PREFIXES.briefAsset);
export const GENERATION_JOB_ID_PATTERN = idPattern(ID_PREFIXES.generationJob);
export const ICEBREAKER_ID_PATTERN = idPattern(ID_PREFIXES.icebreaker);
export const REPORT_ID_PATTERN = idPattern(ID_PREFIXES.report);
export const RENDER_JOB_ID_PATTERN = idPattern(ID_PREFIXES.renderJob);
export const WALL_QUESTION_ID_PATTERN = idPattern(ID_PREFIXES.wallQuestion);

// ---------------------------------------------------------------------------
// 令牌
// ---------------------------------------------------------------------------

interface TokenFormat {
  readonly prefix: string;
  readonly bytes: number;
  readonly encoding: 'base64url' | 'base32';
  /** 是否只存哈希（否则明文保存，可随时轮换）。 */
  readonly storedAsHash: boolean;
}

/** contracts 3 的令牌格式表。 */
export const TOKEN_FORMATS = {
  /** 一次性 token：`nmt_` + 32 字节 base64url。 */
  agentToken: { prefix: 'nmt_', bytes: 32, encoding: 'base64url', storedAsHash: true },
  /** 页面凭证：`nmc_` + 32 字节 base64url。 */
  pageCredential: { prefix: 'nmc_', bytes: 32, encoding: 'base64url', storedAsHash: true },
  /** 会话令牌：`nms_` + 32 字节 base64url。 */
  session: { prefix: 'nms_', bytes: 32, encoding: 'base64url', storedAsHash: true },
  /** 邀请码：`inv_` + 16 字节 base32 小写。 */
  invite: { prefix: 'inv_', bytes: 16, encoding: 'base32', storedAsHash: false },
  /** 公开链接令牌：`pub_` + 24 字节 base64url（publication ID 用 `pbl_`，注意区分）。 */
  publicLink: { prefix: 'pub_', bytes: 24, encoding: 'base64url', storedAsHash: false },
} as const satisfies Record<string, TokenFormat>;

export type TokenKind = keyof typeof TOKEN_FORMATS;

function tokenBodyPattern(format: TokenFormat): string {
  return format.encoding === 'base32'
    ? `[a-z2-7]{${base32Length(format.bytes)}}`
    : `[A-Za-z0-9_-]{${base64UrlLength(format.bytes)}}`;
}

/** 某类令牌的正则（完整匹配）。 */
export function tokenPattern(kind: TokenKind): RegExp {
  const format: TokenFormat = TOKEN_FORMATS[kind];
  return new RegExp(`^${format.prefix}${tokenBodyPattern(format)}$`);
}

export function isTokenFormat(value: unknown, kind: TokenKind): value is string {
  return typeof value === 'string' && tokenPattern(kind).test(value);
}

export function generateToken(kind: TokenKind): string {
  const format: TokenFormat = TOKEN_FORMATS[kind];
  if (!format) {
    throw new Error(`未知的令牌类型：${String(kind)}`);
  }
  const bytes = randomBytes(format.bytes);
  const body = format.encoding === 'base32' ? base32Lower(bytes) : base64Url(bytes);
  return `${format.prefix}${body}`;
}

/**
 * 凭证字符串的检测正则（不锚定、非全局，可安全复用），供校验器 CREDENTIAL_LEAK 与 CLI 上传前检查共用。
 * 匹配 `nmc_` / `nmt_` 后跟至少 16 个 base64url 字符（宽松，宁可多报）。
 * 需要找出全部位置时用 `new RegExp(CREDENTIAL_LIKE_PATTERN.source, 'g')`。
 */
export const CREDENTIAL_LIKE_PATTERN = /nm[ct]_[A-Za-z0-9_-]{16,}/;

export function containsCredentialLike(text: string): boolean {
  return CREDENTIAL_LIKE_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// 哈希与常量时间比较
// ---------------------------------------------------------------------------

/** SHA-256 hex（小写，64 字符）。用于一次性 token、页面凭证、会话令牌、登录验证码入库。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 常量时间比较两个字符串。先各自做 SHA-256 再 timingSafeEqual，
 * 因此比较耗时与输入内容、长度是否相同无关。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** 生成 6 位数字登录验证码（含前导零）。 */
export function generateLoginCode(): string {
  return randomInt(0, 10 ** LOGIN_CODE_DIGITS)
    .toString()
    .padStart(LOGIN_CODE_DIGITS, '0');
}
