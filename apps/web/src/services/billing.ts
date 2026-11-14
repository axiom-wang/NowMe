/**
 * 点数（contracts 12）：谁为一次生成 / 修改付点数、怎么扣、什么时候退。
 *
 * 规则（S10）：
 * - 用自己模型 Key 的用户不消耗点数，也不占用平台的模型。
 * - 用平台 AI 时：采访与“和 TA 聊什么”不收点数；生成、修改按价目收。先看这面墙的额度（组织者为成员买单，
 *   受“每位成员上限”约束），不够再看个人余额；都不够就不开始任务。
 * - 任务开始时扣点，和创建任务在同一个事务里；任务没有产出新版本（失败、被打断、需要补充说明）时全额退回。
 *   同一个任务只扣一次、只退一次（数据库唯一约束）。
 * - 余额不会为负；流水只追加。兑换码只存哈希，用过即作废。
 * - 组织者只能看到墙额度的聚合数字（余额、已用、每人上限），看不到任何成员用了多少。
 * - 墙关闭时，剩余额度退回组织者的个人余额。
 */
import { randomBytes } from 'node:crypto';
import { generateId, hashToken, REDEEM_CODE_PATTERN, REDEEM_CREDITS_RANGE, SPONSOR_CREDITS_RANGE, SPONSOR_MEMBER_CAP_RANGE } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { InsufficientCredits, type Account, type CreditEntry } from '../db/credits.js';
import { transaction } from '../db/index.js';
import type { JobKind } from '../db/hosted.js';
import type { Wall } from '../db/walls.js';

type LedgerDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;
type BillingDeps = LedgerDeps & { config: Pick<AppDeps['config'], 'billing'> };

export const userAccount = (userId: string): Account => ({ kind: 'user', id: userId });
export const wallAccount = (wallId: string): Account => ({ kind: 'wall', id: wallId });

// ---------------------------------------------------------------------------
// 兑换码
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 生成一个兑换码明文：`NM-XXXX-XXXX-XXXX-XXXX`（80 bit 随机）。 */
export function generateRedeemCode(): string {
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let body = '';
  for (let i = 0; i < 16; i += 1) {
    body = CROCKFORD[Number(bits & 31n)] + body;
    bits >>= 5n;
  }
  return `NM-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
}

/**
 * 把用户输入规范成兑换码的标准写法：忽略大小写、空格与连字符，容易混淆的字母按 Crockford 规则归一（O→0，I / L→1）。
 * 不是合法的兑换码时返回 null。
 */
export function normalizeRedeemCode(raw: string): string | null {
  const compact = raw.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = (compact.length === 18 && compact.startsWith('NM') ? compact.slice(2) : compact).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length !== 16) return null;
  const code = `NM-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
  return REDEEM_CODE_PATTERN.test(code) ? code : null;
}

export interface CreateCodesInput {
  count: number;
  credits: number;
  batch?: string | null;
  /** ISO 8601；不填表示不过期。 */
  expiresAt?: string | null;
}

/** 生成一批兑换码，返回明文（只有这一次机会看到；库里只存哈希）。运营脚本调用。 */
export function createRedeemCodes(deps: LedgerDeps, input: CreateCodesInput): string[] {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 1000) throw new Error('一次生成 1–1000 个兑换码');
  if (!Number.isInteger(input.credits) || input.credits < REDEEM_CREDITS_RANGE.min || input.credits > REDEEM_CREDITS_RANGE.max) {
    throw new Error(`每个兑换码的点数应为 ${REDEEM_CREDITS_RANGE.min}–${REDEEM_CREDITS_RANGE.max}`);
  }
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw new Error('过期时间格式不对');
  const createdAt = deps.now().toISOString();
  const codes: string[] = [];
  transaction(deps.db, () => {
    for (let i = 0; i < input.count; i += 1) {
      const code = generateRedeemCode();
      deps.repos.credits.insertCode({
        id: generateId('rdc'),
        codeHash: hashToken(code),
        credits: input.credits,
        batch: input.batch?.trim().slice(0, 80) || null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        createdAt,
      });
      codes.push(code);
    }
  });
  return codes;
}

export type RedeemResult = { ok: true; credits: number; balance: number } | { ok: false; error: 'invalid' | 'used' | 'expired' };

/** 兑换。格式不对与不存在的码返回同一种错误（不区分）。 */
export function redeemCode(deps: LedgerDeps, userId: string, raw: string): RedeemResult {
  const code = normalizeRedeemCode(raw);
  if (!code) return { ok: false, error: 'invalid' };
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, (): RedeemResult => {
    const record = deps.repos.credits.findCodeByHash(hashToken(code));
    if (!record) return { ok: false, error: 'invalid' };
    if (record.redeemedBy) return { ok: false, error: 'used' };
    if (record.expiresAt && record.expiresAt <= nowIso) return { ok: false, error: 'expired' };
    if (!deps.repos.credits.markCodeRedeemed(record.id, userId, nowIso)) return { ok: false, error: 'used' };
    const entry = deps.repos.credits.post({ account: userAccount(userId), delta: record.credits, reason: 'redeem', refId: record.id, actorId: userId, at: nowIso });
    deps.repos.events.record({ type: 'credits_redeem', wallId: null, pageId: null, actorId: userId, props: { credits: record.credits }, createdAt: nowIso });
    return { ok: true, credits: record.credits, balance: entry.balanceAfter };
  });
}

/** 运营给某个用户发放（正数）或调整（可为负，但余额不会变成负数）。 */
export function grantCredits(deps: LedgerDeps, userId: string, credits: number, reason: 'grant' | 'adjust' = 'grant'): CreditEntry {
  if (!Number.isInteger(credits) || credits === 0 || (reason === 'grant' && credits < 0)) throw new Error('点数必须是非零整数（发放只能为正）');
  return transaction(deps.db, () => deps.repos.credits.post({ account: userAccount(userId), delta: credits, reason, at: deps.now().toISOString() }));
}

/** 注册赠送（每个用户至多一次；配置为 0 时不做任何事）。 */
export function grantSignupCredits(deps: BillingDeps, userId: string): void {
  const credits = deps.config.billing.signupCredits;
  if (credits <= 0) return;
  deps.repos.credits.post({ account: userAccount(userId), delta: credits, reason: 'signup', refId: userId, at: deps.now().toISOString() });
}

// ---------------------------------------------------------------------------
// 墙的额度
// ---------------------------------------------------------------------------

export interface WallCredits {
  /** 墙的额度还剩多少。 */
  balance: number;
  /** 每位成员最多能用多少（0 表示不限）。 */
  memberCap: number;
  /** 一共用掉多少、组织者一共充入多少（聚合数字）。 */
  spent: number;
  funded: number;
}

export function wallCredits(deps: Pick<AppDeps, 'repos'>, wallId: string): WallCredits {
  const totals = deps.repos.credits.wallTotals(wallId);
  return { balance: deps.repos.credits.balanceOf(wallAccount(wallId)), memberCap: deps.repos.credits.memberCap(wallId), ...totals };
}

/** 这面墙现在还能为这位成员出多少点。 */
export function wallAllowance(deps: Pick<AppDeps, 'repos'>, wallId: string, userId: string): number {
  const balance = deps.repos.credits.balanceOf(wallAccount(wallId));
  if (balance <= 0) return 0;
  const cap = deps.repos.credits.memberCap(wallId);
  if (cap === 0) return balance;
  return Math.max(0, Math.min(balance, cap - deps.repos.credits.wallUsedBy(wallId, userId)));
}

export type SponsorResult = { ok: true; wall: WallCredits; balance: number } | { ok: false; error: 'bad-amount' | 'bad-cap' | 'insufficient' };

/**
 * 组织者把个人点数转给墙，并设置每位成员上限。`credits` 为 0 表示只改上限。
 * 调用方必须已经确认 `organizerId` 是这面墙的组织者（`findOrganizerWall`）。
 */
export function sponsorWall(deps: LedgerDeps, wall: Wall, organizerId: string, input: { credits: number; memberCap: number }): SponsorResult {
  const { credits, memberCap } = input;
  if (!Number.isInteger(credits) || credits < 0 || credits > SPONSOR_CREDITS_RANGE.max) return { ok: false, error: 'bad-amount' };
  if (!Number.isInteger(memberCap) || memberCap < SPONSOR_MEMBER_CAP_RANGE.min || memberCap > SPONSOR_MEMBER_CAP_RANGE.max) return { ok: false, error: 'bad-cap' };
  const nowIso = deps.now().toISOString();
  try {
    return transaction(deps.db, (): SponsorResult => {
      if (credits > 0) {
        deps.repos.credits.post({ account: userAccount(organizerId), delta: -credits, reason: 'sponsor_out', refId: wall.id, actorId: organizerId, at: nowIso });
        deps.repos.credits.post({ account: wallAccount(wall.id), delta: credits, reason: 'sponsor_in', refId: wall.id, actorId: organizerId, at: nowIso });
        deps.repos.events.record({ type: 'credits_sponsor', wallId: wall.id, pageId: null, actorId: organizerId, props: { credits, memberCap }, createdAt: nowIso });
      }
      deps.repos.credits.setMemberCap(wall.id, memberCap, nowIso);
      return { ok: true, wall: wallCredits(deps, wall.id), balance: deps.repos.credits.balanceOf(userAccount(organizerId)) };
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, error: 'insufficient' };
    throw error;
  }
}

/** 墙关闭时：剩余额度退回组织者（调用方放在关闭墙的事务里）。返回退回的点数。 */
export function returnWallCredits(deps: Pick<AppDeps, 'repos' | 'now'>, wall: Pick<Wall, 'id' | 'organizerId'>): number {
  const balance = deps.repos.credits.balanceOf(wallAccount(wall.id));
  if (balance <= 0) return 0;
  const nowIso = deps.now().toISOString();
  deps.repos.credits.post({ account: wallAccount(wall.id), delta: -balance, reason: 'sponsor_return', refId: wall.id, actorId: wall.organizerId, at: nowIso });
  deps.repos.credits.post({ account: userAccount(wall.organizerId), delta: balance, reason: 'sponsor_return', refId: wall.id, actorId: wall.organizerId, at: nowIso });
  return balance;
}

// ---------------------------------------------------------------------------
// 任务的扣点与退点
// ---------------------------------------------------------------------------

/** 一次生成 / 修改用谁的模型、收多少点、由谁付。 */
export type JobPlan =
  | { ok: true; source: 'own'; price: 0; payer: null }
  | { ok: true; source: 'platform'; price: number; payer: Account | null }
  | { ok: false; error: 'MODEL_CONFIG' }
  | { ok: false; error: 'credits'; price: number; balance: number; wallAllowance: number };

export function priceOf(deps: BillingDeps, kind: JobKind): number {
  return kind === 'generate' ? deps.config.billing.prices.generate : deps.config.billing.prices.edit;
}

/**
 * 计划一次任务。`access`：这个用户有没有自己的模型配置、平台 AI 是否可用（由调用方给出）。
 * 这里只读余额；真正扣点在 `chargeJob`（与创建任务同一个事务，届时会再检查一次）。
 */
export function planJob(deps: BillingDeps, userId: string, wallId: string, kind: JobKind, access: { ownReady: boolean; platformAvailable: boolean }): JobPlan {
  if (access.ownReady) return { ok: true, source: 'own', price: 0, payer: null };
  if (!access.platformAvailable) return { ok: false, error: 'MODEL_CONFIG' };
  const price = priceOf(deps, kind);
  if (price === 0) return { ok: true, source: 'platform', price: 0, payer: null };
  const allowance = wallAllowance(deps, wallId, userId);
  if (allowance >= price) return { ok: true, source: 'platform', price, payer: wallAccount(wallId) };
  const balance = deps.repos.credits.balanceOf(userAccount(userId));
  if (balance >= price) return { ok: true, source: 'platform', price, payer: userAccount(userId) };
  return { ok: false, error: 'credits', price, balance, wallAllowance: allowance };
}

/**
 * 按计划扣点（放在创建任务的事务里）。余额在计划之后被别的任务用掉、或墙的额度不再够这位成员用时抛 `InsufficientCredits`，
 * 调用方的事务随之回滚（任务不会被创建）。
 */
export function chargeJob(deps: LedgerDeps, jobId: string, plan: Extract<JobPlan, { ok: true }>, userId: string): void {
  if (!plan.payer || plan.price <= 0) return;
  if (plan.payer.kind === 'wall' && wallAllowance(deps, plan.payer.id, userId) < plan.price) throw new InsufficientCredits();
  deps.repos.credits.post({ account: plan.payer, delta: -plan.price, reason: 'job', refId: jobId, actorId: userId, at: deps.now().toISOString() });
}

/**
 * 任务结束时结算：成功则保留扣点，返回 true（“这次收了点数”）；没有产出新版本则全额退回，返回 false。
 * 没扣过点的任务什么都不做。重复调用不会重复退。
 * 墙已经关闭（额度已退回组织者）时，退点直接退给组织者，避免点数留在一面已经不存在的墙上。
 */
export function settleJob(deps: LedgerDeps, jobId: string, succeeded: boolean): boolean {
  return transaction(deps.db, () => {
    const charge = deps.repos.credits.findJobEntry('job', jobId);
    if (!charge) return false;
    if (succeeded) return true;
    if (deps.repos.credits.findJobEntry('job_refund', jobId)) return false;
    let account = charge.account;
    if (account.kind === 'wall') {
      const wall = deps.repos.walls.findById(account.id);
      if (wall && wall.status !== 'open') account = userAccount(wall.organizerId);
    }
    deps.repos.credits.post({ account, delta: -charge.delta, reason: 'job_refund', refId: jobId, actorId: charge.actorId, at: deps.now().toISOString() });
    return false;
  });
}

/** 启动时：把“扣了点、任务已经失败、还没退”的任务全部退掉（服务重启打断的任务）。返回退了几个。 */
export function refundUnsettledJobs(deps: LedgerDeps): number {
  const jobs = deps.repos.credits.listUnsettledJobs();
  for (const jobId of jobs) settleJob(deps, jobId, false);
  return jobs.length;
}

// ---------------------------------------------------------------------------
// 给界面用的状态
// ---------------------------------------------------------------------------

/** 这个用户在这面墙上用 AI 的方式与费用。 */
export interface AiStatus {
  /** own：用自己的模型 Key（不收点数）；platform：用平台的 AI；none：两者都没有。 */
  mode: 'own' | 'platform' | 'none';
  prices: { generate: number; edit: number };
  /** 个人余额。 */
  balance: number;
  /** 这面墙现在还能为我出多少点。 */
  wallAllowance: number;
}

export function aiStatus(deps: BillingDeps, userId: string, wallId: string, access: { ownReady: boolean; platformAvailable: boolean }): AiStatus {
  return {
    mode: access.ownReady ? 'own' : access.platformAvailable ? 'platform' : 'none',
    prices: deps.config.billing.prices,
    balance: deps.repos.credits.balanceOf(userAccount(userId)),
    wallAllowance: wallAllowance(deps, wallId, userId),
  };
}

/** 平台模式下，这次任务够不够点数（给按钮旁边的说明用）。 */
export function affordable(status: AiStatus, kind: JobKind): boolean {
  const price = kind === 'generate' ? status.prices.generate : status.prices.edit;
  return status.mode === 'own' || (status.mode === 'platform' && (price === 0 || status.wallAllowance >= price || status.balance >= price));
}
