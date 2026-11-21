/**
 * 运行配置（contracts 0、0.1、4.3、4.4）。所有环境变量见仓库根 `.env.example`。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODERATION_FAILURE_MODES, type ModerationFailureMode } from './content-safety.js';
import {
  DATA_DB_FILE,
  DATA_OUTBOX_FILE,
  DATA_REVISIONS_DIR,
  DATA_SECRET_FILE,
  DEFAULT_AGENT_TOKEN_TTL_HOURS,
  DEFAULT_DATA_DIR_NAME,
  DEFAULT_NOWME_HOME_DIR_NAME,
  DEFAULT_PAGES_ORIGIN,
  DEFAULT_WEB_ORIGIN,
  DEFAULT_HOSTED_DAILY_ATTEMPTS,
  DEFAULT_HOSTED_MAX_TURNS,
  DEFAULT_INTERVIEW_DAILY_CALLS,
  HOSTED_DAILY_RANGE,
  HOSTED_MAX_TURNS_RANGE,
  SESSION_COOKIE_NAME,
} from './constants.js';
import { z } from 'zod';
import { normalizeOrigin } from './csp.js';
import { MODEL_PROVIDER_PRESETS, type ModelProtocol, type ModelProvider } from './model-providers.js';

/**
 * 仓库根目录。本文件位于 `packages/contracts/{src,dist}/config.*`，向上三级即仓库根。
 * 相对的 `NOWME_DATA_DIR` 按仓库根解析，因此不论在哪个包目录下启动都指向同一处。
 */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** 票据密钥最短长度（字符）。 */
export const TICKET_SECRET_MIN_LENGTH = 32;
/** `NOWME_AGENT_TOKEN_TTL_HOURS` 允许的范围（小时）。 */
export const AGENT_TOKEN_TTL_HOURS_RANGE = { min: 1, max: 24 * 30 } as const;

export type Env = Readonly<Record<string, string | undefined>>;

/** IP 直连的非默认端口使用独立会话名，避免 Demo 覆盖正式站登录。 */
export function sessionCookieName(webOrigin: string): string {
  const url = new URL(webOrigin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return isIpLiteral(hostname) && url.port ? `${SESSION_COOKIE_NAME}_${url.port}` : SESSION_COOKIE_NAME;
}

export interface NowmeConfig {
  /** 主站源（`NOWME_WEB_ORIGIN`），规范形式，无尾部斜杠。 */
  webOrigin: string;
  /** 页面托管源（`NOWME_PAGES_ORIGIN`）。 */
  pagesOrigin: string;
  /**
   * 监听主机与端口。默认由源推导（本地开发）；部署在反向代理之后时，对外的源是 https 域名，
   * 进程实际监听的地址用 `NOWME_WEB_LISTEN` / `NOWME_PAGES_LISTEN` 单独指定（contracts 10.1）。
   */
  web: { hostname: string; port: number };
  pages: { hostname: string; port: number };
  /**
   * 进程前面可信反向代理的层数（`NOWME_TRUST_PROXY`，0–5，默认 0）。
   * 大于 0 时客户端地址取 `X-Forwarded-For` 从右数第 N 个；为 0 时只用 TCP 连接地址，忽略该头。
   */
  trustProxyHops: number;
  /** 邮件发送（登录验证码）。不含 SMTP 密码本身。 */
  mail: MailConfig;
  /** 点数与平台 AI（contracts 12）。不含平台模型的 API key 本身。 */
  billing: BillingConfig;
  /** 内容安全检查的可选部分（contracts 16.1）。不含审核接口的密钥。 */
  moderation: ModerationConfig;
  /** 运营方联系邮箱（`NOWME_CONTACT_EMAIL`，可选），显示在用户协议与隐私政策里；没配置为 null。 */
  contactEmail: string | null;
  /** 本地数据目录（绝对路径，`NOWME_DATA_DIR`，默认 `<仓库根>/.data`）。 */
  dataDir: string;
  /** `NOWME_TICKET_SECRET`；为 null 时用 resolveTicketSecret() 读写 `<dataDir>/secret`。 */
  ticketSecret: string | null;
  /** 一次性 token 有效期（`NOWME_AGENT_TOKEN_TTL_HOURS`，默认 72）。 */
  agentTokenTtlHours: number;
  /** CLI 本地目录（`NOWME_HOME`，默认 `~/.nowme`），凭证存 `<NOWME_HOME>/credentials`。 */
  nowmeHome: string;
  /** `NODE_ENV === 'production'`。非生产环境才提供 `/dev/outbox`。 */
  isProduction: boolean;
  /** 平台托管路线（contracts 9 / hosted-route 1）。不含 API key 本身。 */
  hosted: HostedConfig;
  /**
   * Skill 市场渠道（contracts 4.5）：`NOWME_SKILL_MARKET_LABEL` 与 `NOWME_SKILL_MARKET_COMMAND` 同时设置时，
   * 安装页与 install.md 多显示一种安装方式；都不设为 null。
   */
  skillMarket: SkillMarketConfig | null;
  /**
   * 演示环境入口（contracts 10.1）：`NOWME_DEMO_URL`，https 绝对地址。设置后正式站顶栏固定显示“Demo”链接；
   * 不设为 null。演示环境自己不设置它。
   */
  demoUrl: string | null;
  /** 后台任务进程（contracts 13）：渲染与 AI 任务在主站进程内跑（inline）还是交给独立的 worker（separate）。 */
  worker: WorkerConfig;
}

/** `NOWME_WORKER_MODE`：inline（默认，开发与测试）或 separate（生产推荐，主站只入队）。 */
export const workerModeSchema = z.enum(['inline', 'separate']);
export type WorkerMode = z.infer<typeof workerModeSchema>;

export const WORKER_AI_CONCURRENCY_RANGE = { min: 1, max: 16 } as const;
export const DEFAULT_WORKER_AI_CONCURRENCY = 2;
export const WORKER_SHUTDOWN_GRACE_SECONDS_RANGE = { min: 0, max: 3600 } as const;
export const DEFAULT_WORKER_SHUTDOWN_GRACE_SECONDS = 30;

/** 后台任务进程配置（contracts 13.5）。 */
export interface WorkerConfig {
  mode: WorkerMode;
  /** 同时执行的 AI 生成 / 修改任务数（`NOWME_WORKER_AI_CONCURRENCY`，1–16，默认 2）。渲染始终串行。 */
  aiConcurrency: number;
  /** 收到 SIGTERM 后等待进行中任务的时间（`NOWME_WORKER_SHUTDOWN_GRACE_SECONDS`，默认 30 秒）。 */
  shutdownGraceMs: number;
}

const intFromEnv = (name: string, range: { min: number; max: number }, fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return fallback;
      if (!/^\d+$/.test(value) || Number(value) < range.min || Number(value) > range.max) {
        ctx.addIssue({ code: 'custom', message: `${name} 应为 ${range.min}–${range.max} 的整数：${value}` });
        return z.NEVER;
      }
      return Number(value);
    });

const workerEnvSchema = z.object({
  NOWME_WORKER_MODE: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? 'inline' : value))
    .pipe(workerModeSchema),
  NOWME_WORKER_AI_CONCURRENCY: intFromEnv('NOWME_WORKER_AI_CONCURRENCY', WORKER_AI_CONCURRENCY_RANGE, DEFAULT_WORKER_AI_CONCURRENCY),
  NOWME_WORKER_SHUTDOWN_GRACE_SECONDS: intFromEnv('NOWME_WORKER_SHUTDOWN_GRACE_SECONDS', WORKER_SHUTDOWN_GRACE_SECONDS_RANGE, DEFAULT_WORKER_SHUTDOWN_GRACE_SECONDS),
});

/** 后台任务进程配置（zod 校验）。 */
export function loadWorkerConfig(env: Env): WorkerConfig {
  const parsed = workerEnvSchema.safeParse({
    NOWME_WORKER_MODE: env.NOWME_WORKER_MODE,
    NOWME_WORKER_AI_CONCURRENCY: env.NOWME_WORKER_AI_CONCURRENCY,
    NOWME_WORKER_SHUTDOWN_GRACE_SECONDS: env.NOWME_WORKER_SHUTDOWN_GRACE_SECONDS,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const name = String(issue?.path[0] ?? 'NOWME_WORKER_MODE');
    throw new ConfigError(name === 'NOWME_WORKER_MODE' ? 'NOWME_WORKER_MODE 只能是 inline 或 separate' : (issue?.message ?? `${name} 不合法`));
  }
  return {
    mode: parsed.data.NOWME_WORKER_MODE,
    aiConcurrency: parsed.data.NOWME_WORKER_AI_CONCURRENCY,
    shutdownGraceMs: parsed.data.NOWME_WORKER_SHUTDOWN_GRACE_SECONDS * 1000,
  };
}

/** 内容安全检查的可选部分：外部词表文件与外部审核接口。两者都不配置时只用内置规则。 */
export interface ModerationConfig {
  /** 外部词表文件（`NOWME_BLOCKLIST_FILE`，绝对路径；相对路径按仓库根解析）；没配置为 null。 */
  blocklistFile: string | null;
  /** 外部审核接口（`NOWME_MODERATION_URL`，只允许 https）；没配置为 null（默认关闭）。密钥 `NOWME_MODERATION_API_KEY` 只从环境变量读。 */
  url: string | null;
  /** 审核接口超时或失败时：`allow` 放行并记日志（默认）；`block` 拦截（`NOWME_MODERATION_ON_FAILURE`）。 */
  onFailure: ModerationFailureMode;
}

/**
 * 点数与平台 AI（contracts 12）。
 *
 * 没有自己模型 Key 的用户用平台的 AI：采访与“和 TA 聊什么”不收点数（有每日上限），生成与修改页面按价目扣点数。
 * 点数来自个人余额（兑换码）或墙的额度（组织者为整面墙买单）。用自己 Key 的用户不消耗点数。
 */
export interface BillingConfig {
  /**
   * 平台 AI 的模型服务（`NOWME_PLATFORM_PROVIDER` 等）；没有配置时为 null——此时只有自带 Key 的用户能用 AI，行为与之前相同。
   * `ready` 只表示端点信息完整；API key（`NOWME_PLATFORM_API_KEY`）由主站从环境变量读取，不进配置对象。
   */
  platform: { interview: ModelEndpointConfig; generate: ModelEndpointConfig } | null;
  /** 价目（点数）：生成一版页面、修改一次。0 表示不收。 */
  prices: { generate: number; edit: number };
  /** 新用户注册时赠送的点数（默认 0）。 */
  signupCredits: number;
  /** 平台 AI 免费调用（采访、和 TA 聊什么）的全站每日上限：防止批量注册消耗平台的模型费用。 */
  freeDailyCalls: number;
}

/** 邮件发送方式（contracts 10.2）。SMTP 连接串含密码，只从环境变量读，不进配置对象。 */
export interface MailConfig {
  /** `file`：写进 `<dataDir>/outbox.log`（开发）；`smtp`：经 `NOWME_SMTP_URL` 真实发送。 */
  transport: 'file' | 'smtp';
  /** 发件人（`NOWME_MAIL_FROM`），例如 `NOWMe <no-reply@example.com>`；`smtp` 时必填。 */
  from: string | null;
}

export interface SkillMarketConfig {
  /** 市场名称，例如 “SkillHub”。 */
  label: string;
  /** 在终端运行的安装命令，例如 `npx skills add nowme/nowme-page`。 */
  command: string;
}

/**
 * 网页创作运行限制与表单默认端点，不含用户或平台 Key。
 */
export interface HostedConfig {
  /** 网页创作始终开启；未配置的用户会被引导到 AI 设置。 */
  enabled: boolean;
  /** `NOWME_MODEL_FAKE=1`（旧名 `NOWME_CLAUDE_FAKE`）：使用确定性的假客户端（只在非生产环境允许）。 */
  fake: boolean;
  /** 采访用的模型服务（便宜、够用）。 */
  interview: ModelEndpointConfig;
  /** 生成与修改用的模型服务（效果更好）。 */
  generate: ModelEndpointConfig;
  maxTurns: number;
  dailyAttempts: number;
  interviewDailyCalls: number;
}

export interface ModelEndpointConfig {
  provider: ModelProvider;
  /** 界面与日志里显示的服务名。 */
  label: string;
  protocol: ModelProtocol;
  /** OpenAI 兼容服务的 API 根地址；Anthropic 为 null 时用 SDK 默认地址。 */
  baseUrl: string | null;
  /** 模型 ID；没配置且预设没有默认值时为 null（用户必须填写）。 */
  model: string | null;
  /** 兼容端点元数据；账号凭证从不从环境变量读取，此值始终为 null。 */
  apiKeyEnv: string | null;
  /** key 是否必需；显式开发配置的本机 Ollama 可以不提供。 */
  apiKeyRequired: boolean;
  hasApiKey: boolean;
  /** 是否把图片交给模型。 */
  vision: boolean;
  maxOutputTokens: number;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** 这个角色可以使用：有模型、需要 key 时有 key、需要 baseUrl 时有 baseUrl。 */
  ready: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function listenAddress(origin: string): { hostname: string; port: number } {
  const url = new URL(origin);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  // IPv6 字面量在 URL 中带方括号，监听时去掉
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { hostname, port };
}

/** IPv4 点分十进制或 IPv6 字面量（`listenAddress` 已去掉方括号）。 */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

/** `NOWME_*_LISTEN`：`端口`、`主机:端口` 或 `[IPv6]:端口`。没设置时用由源推导的地址。 */
function parseListen(env: Env, name: string, fallback: { hostname: string; port: number }): { hostname: string; port: number } {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const match = /^(?:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):)?(\d{1,5})$/.exec(raw);
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535) {
    throw new ConfigError(`${name} 应为 端口、主机:端口 或 [IPv6]:端口，例如 0.0.0.0:3000：${raw}`);
  }
  const hostname = (match[1] ?? fallback.hostname).replace(/^\[(.*)\]$/, '$1');
  return { hostname, port };
}

const MAIL_FROM_MAX = 200;

/** 邮件发送配置。`smtp` 需要 `NOWME_SMTP_URL`（smtp:// 或 smtps://）与 `NOWME_MAIL_FROM`。 */
export function loadMailConfig(env: Env): MailConfig {
  const transport = nonEmpty(env.NOWME_MAIL_TRANSPORT) ?? 'file';
  if (transport !== 'file' && transport !== 'smtp') throw new ConfigError(`NOWME_MAIL_TRANSPORT 只能是 file 或 smtp：${transport}`);
  const from = nonEmpty(env.NOWME_MAIL_FROM) ?? null;
  if (from !== null && (from.length > MAIL_FROM_MAX || /[\u0000-\u001f\u007f]/.test(from) || !/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(from))) {
    throw new ConfigError('NOWME_MAIL_FROM 应为一行，并包含发件邮箱，例如 NOWMe <no-reply@example.com>');
  }
  if (transport === 'smtp') {
    const url = nonEmpty(env.NOWME_SMTP_URL);
    let protocol: string | null = null;
    try {
      protocol = url ? new URL(url).protocol : null;
    } catch {
      protocol = null;
    }
    // 不把连接串写进错误信息：里面有密码。
    if (protocol !== 'smtp:' && protocol !== 'smtps:') throw new ConfigError('NOWME_MAIL_TRANSPORT=smtp 时，NOWME_SMTP_URL 应为 smtp:// 或 smtps:// 开头的连接串');
    if (from === null) throw new ConfigError('NOWME_MAIL_TRANSPORT=smtp 时必须设置 NOWME_MAIL_FROM');
  }
  return { transport, from };
}

/**
 * 内容安全配置（contracts 16.1）。词表文件在这里只解析路径；文件是否存在、每一行是否合法在主站启动时检查
 * （`loadBlocklistFile`，不合法就拒绝启动）。审核接口地址是否为公网 HTTPS 在这里检查语法，建立连接时再逐次解析 DNS 检查地址。
 */
export function loadModerationConfig(env: Env): ModerationConfig {
  const fileRaw = nonEmpty(env.NOWME_BLOCKLIST_FILE);
  const blocklistFile = fileRaw === undefined ? null : isAbsolute(fileRaw) ? resolve(fileRaw) : resolve(REPO_ROOT, fileRaw);
  const urlRaw = nonEmpty(env.NOWME_MODERATION_URL);
  let url: string | null = null;
  if (urlRaw !== undefined) {
    try {
      const parsed = new URL(urlRaw);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || urlRaw.length > 2048) throw new Error();
      url = parsed.toString();
    } catch {
      throw new ConfigError('NOWME_MODERATION_URL 只允许 https 地址（不含账号密码）');
    }
  }
  const failure = nonEmpty(env.NOWME_MODERATION_ON_FAILURE) ?? 'allow';
  if (!(MODERATION_FAILURE_MODES as readonly string[]).includes(failure)) throw new ConfigError('NOWME_MODERATION_ON_FAILURE 只能是 allow 或 block');
  return { blocklistFile, url, onFailure: failure as ModerationFailureMode };
}

/** 运营方联系邮箱（可选）：一行、含 @。 */
export function loadContactEmail(env: Env): string | null {
  const value = nonEmpty(env.NOWME_CONTACT_EMAIL);
  if (value === undefined) return null;
  if (value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) throw new ConfigError('NOWME_CONTACT_EMAIL 应为一个邮箱地址');
  return value;
}

export const TRUST_PROXY_HOPS_RANGE = { min: 0, max: 5 } as const;

export const PRICE_RANGE = { min: 0, max: 10000 } as const;
export const DEFAULT_PRICE_GENERATE = 10;
export const DEFAULT_PRICE_EDIT = 4;
export const DEFAULT_PLATFORM_FREE_DAILY_CALLS = 3000;
export const PLATFORM_FREE_DAILY_CALLS_RANGE = { min: 1, max: 1000000 } as const;

/**
 * 点数与平台 AI 的配置。`NOWME_PLATFORM_PROVIDER` 没设置时平台 AI 关闭。
 * 地址是否为公网 HTTPS 由主站在建立连接时校验（security/model-network.ts），这里只检查取值范围。
 */
export function loadBillingConfig(env: Env): BillingConfig {
  const prices = {
    generate: parseIntRange(env, 'NOWME_PRICE_GENERATE', DEFAULT_PRICE_GENERATE, PRICE_RANGE),
    edit: parseIntRange(env, 'NOWME_PRICE_EDIT', DEFAULT_PRICE_EDIT, PRICE_RANGE),
  };
  const base = {
    prices,
    signupCredits: parseIntRange(env, 'NOWME_SIGNUP_CREDITS', 0, PRICE_RANGE),
    freeDailyCalls: parseIntRange(env, 'NOWME_PLATFORM_FREE_DAILY_CALLS', DEFAULT_PLATFORM_FREE_DAILY_CALLS, PLATFORM_FREE_DAILY_CALLS_RANGE),
  };
  const provider = nonEmpty(env.NOWME_PLATFORM_PROVIDER);
  if (provider === undefined) return { ...base, platform: null };
  if (!(provider in MODEL_PROVIDER_PRESETS)) throw new ConfigError(`NOWME_PLATFORM_PROVIDER 不是支持的模型服务：${provider}`);
  const visionRaw = nonEmpty(env.NOWME_PLATFORM_VISION);
  if (visionRaw !== undefined && visionRaw !== '0' && visionRaw !== '1') throw new ConfigError('NOWME_PLATFORM_VISION 只能是 1 或 0');
  const endpoint = (role: 'interview' | 'generate'): ModelEndpointConfig => {
    const value = defaultModelEndpoint(provider as ModelProvider, role);
    const baseUrl = nonEmpty(env.NOWME_PLATFORM_BASE_URL);
    if (baseUrl !== undefined) value.baseUrl = baseUrl.replace(/\/+$/, '');
    // 明确指定的优先；采访模型没单独指定时用服务预设的采访模型，预设也没有就和生成用同一个
    const explicit = nonEmpty(role === 'interview' ? env.NOWME_PLATFORM_INTERVIEW_MODEL : env.NOWME_PLATFORM_MODEL);
    value.model = explicit ?? value.model ?? (role === 'interview' ? (nonEmpty(env.NOWME_PLATFORM_MODEL) ?? null) : null);
    if (!value.model || !/^[A-Za-z0-9][A-Za-z0-9._\-:@/\[\]]{0,199}$/.test(value.model)) {
      throw new ConfigError(`平台 AI 缺少${role === 'interview' ? '采访' : '生成'}模型：请设置 NOWME_PLATFORM_${role === 'interview' ? 'INTERVIEW_' : ''}MODEL`);
    }
    if (value.protocol === 'openai' && !value.baseUrl) throw new ConfigError('这个模型服务需要设置 NOWME_PLATFORM_BASE_URL');
    if (visionRaw !== undefined) value.vision = visionRaw === '1';
    value.ready = true;
    return value;
  };
  return { ...base, platform: { interview: endpoint('interview'), generate: endpoint('generate') } };
}

function parseOrigin(env: Env, name: string, fallback: string): string {
  const raw = nonEmpty(env[name]) ?? fallback;
  try {
    return normalizeOrigin(raw, name);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

function parseTtlHours(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (value === undefined) return DEFAULT_AGENT_TOKEN_TTL_HOURS;
  const { min, max } = AGENT_TOKEN_TTL_HOURS_RANGE;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new ConfigError(`NOWME_AGENT_TOKEN_TTL_HOURS 应为 ${min}–${max} 的整数：${raw}`);
  }
  return Number(value);
}

function parseIntRange(env: Env, name: string, fallback: number, range: { min: number; max: number }): number {
  const value = nonEmpty(env[name]);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < range.min || Number(value) > range.max) {
    throw new ConfigError(`${name} 应为 ${range.min}–${range.max} 的整数：${value}`);
  }
  return Number(value);
}

/** 无用户凭证的初始端点，仅用于表单默认值；绝不读取平台模型 Key。 */
export function defaultModelEndpoint(provider: ModelProvider = 'anthropic', role: 'interview' | 'generate' = 'generate'): ModelEndpointConfig {
  const preset = MODEL_PROVIDER_PRESETS[provider];
  return {
    provider, label: preset.label, protocol: preset.protocol, baseUrl: preset.baseUrl,
    model: role === 'interview' ? preset.interviewModel : preset.generateModel,
    apiKeyEnv: null, apiKeyRequired: provider !== 'ollama', hasApiKey: false,
    vision: preset.vision, maxOutputTokens: preset.maxOutputTokens, maxTokensField: preset.maxTokensField, ready: false,
  };
}

/** 网页创作始终可见。平台只配置运行限制，模型凭证由账号提供。 */
export function loadHostedConfig(env: Env, isProduction: boolean): HostedConfig {
  const fakeName = nonEmpty(env.NOWME_MODEL_FAKE) !== undefined ? 'NOWME_MODEL_FAKE' : 'NOWME_CLAUDE_FAKE';
  const fakeRaw = nonEmpty(env[fakeName]);
  if (fakeRaw !== undefined && fakeRaw !== '1' && fakeRaw !== '0') throw new ConfigError(`${fakeName} 只能是 1 或 0`);
  const fake = fakeRaw === '1';
  if (fake && isProduction) throw new ConfigError('生产环境不能使用假模型客户端');
  return {
    enabled: true, fake,
    interview: defaultModelEndpoint('anthropic', 'interview'), generate: defaultModelEndpoint(),
    maxTurns: parseIntRange(env, 'NOWME_HOSTED_MAX_TURNS', DEFAULT_HOSTED_MAX_TURNS, HOSTED_MAX_TURNS_RANGE),
    dailyAttempts: parseIntRange(env, 'NOWME_HOSTED_DAILY_ATTEMPTS', DEFAULT_HOSTED_DAILY_ATTEMPTS, HOSTED_DAILY_RANGE),
    interviewDailyCalls: parseIntRange(env, 'NOWME_INTERVIEW_DAILY_CALLS', DEFAULT_INTERVIEW_DAILY_CALLS, HOSTED_DAILY_RANGE),
  };
}

/** [原型默认] 市场名称与安装命令的长度上限。 */
const SKILL_MARKET_LABEL_MAX = 40;
const SKILL_MARKET_COMMAND_MAX = 300;

/** Skill 市场渠道（contracts 4.5）：两个变量必须同时设置或同时不设；命令只能是一行可打印字符。 */
export function loadSkillMarketConfig(env: Env): SkillMarketConfig | null {
  const label = nonEmpty(env.NOWME_SKILL_MARKET_LABEL);
  const command = nonEmpty(env.NOWME_SKILL_MARKET_COMMAND);
  if (label === undefined && command === undefined) return null;
  if (label === undefined || command === undefined) {
    throw new ConfigError('NOWME_SKILL_MARKET_LABEL 与 NOWME_SKILL_MARKET_COMMAND 要同时设置（或都不设）');
  }
  if (label.length > SKILL_MARKET_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new ConfigError(`NOWME_SKILL_MARKET_LABEL 应为一行、不超过 ${SKILL_MARKET_LABEL_MAX} 个字符`);
  }
  if (command.length > SKILL_MARKET_COMMAND_MAX || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new ConfigError(`NOWME_SKILL_MARKET_COMMAND 应为一行、不超过 ${SKILL_MARKET_COMMAND_MAX} 个字符`);
  }
  return { label, command };
}

/** `NOWME_DEMO_URL`：只接受 https 绝对地址，不带账号口令；空值为 null。 */
export function loadDemoUrl(env: Env): string | null {
  const raw = nonEmpty(env.NOWME_DEMO_URL);
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`NOWME_DEMO_URL 不是有效的网址：${raw}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ConfigError('NOWME_DEMO_URL 必须是 https 地址，且不能带账号口令');
  }
  return url.href;
}

/** 读取配置并校验。默认值见 contracts 0.1。不读写文件。 */
export function loadConfig(env: Env = process.env): NowmeConfig {
  const webOrigin = parseOrigin(env, 'NOWME_WEB_ORIGIN', DEFAULT_WEB_ORIGIN);
  const pagesOrigin = parseOrigin(env, 'NOWME_PAGES_ORIGIN', DEFAULT_PAGES_ORIGIN);
  const webPublic = listenAddress(webOrigin);
  const pagesPublic = listenAddress(pagesOrigin);

  // 主站与页面托管必须是不同站点：cookie 不按端口隔离，同主机不同端口会共享 cookie。
  // 例外（contracts 10.1）：没有域名、只能用同一个公网 IP 直连时，显式设置 NOWME_ALLOW_SAME_IP_ORIGINS=1
  // 才允许“同一个 IP、不同端口”。只对 IP 字面量生效，域名一律不放行。
  if (webPublic.hostname === pagesPublic.hostname) {
    const allowRaw = nonEmpty(env.NOWME_ALLOW_SAME_IP_ORIGINS);
    if (allowRaw !== undefined && allowRaw !== '0' && allowRaw !== '1') throw new ConfigError('NOWME_ALLOW_SAME_IP_ORIGINS 只能是 1 或 0');
    if (allowRaw !== '1' || !isIpLiteral(webPublic.hostname)) {
      throw new ConfigError(
        `NOWME_WEB_ORIGIN 与 NOWME_PAGES_ORIGIN 的主机名不能相同（${webPublic.hostname}），` +
          '例如主站用 localhost、页面托管用 127.0.0.1',
      );
    }
    if (webPublic.port === pagesPublic.port) {
      throw new ConfigError('NOWME_WEB_ORIGIN 与 NOWME_PAGES_ORIGIN 用同一个 IP 时端口必须不同');
    }
  }
  const web = parseListen(env, 'NOWME_WEB_LISTEN', webPublic);
  const pages = parseListen(env, 'NOWME_PAGES_LISTEN', pagesPublic);

  const dataDirRaw = nonEmpty(env.NOWME_DATA_DIR);
  const dataDir = dataDirRaw
    ? isAbsolute(dataDirRaw)
      ? resolve(dataDirRaw)
      : resolve(REPO_ROOT, dataDirRaw)
    : resolve(REPO_ROOT, DEFAULT_DATA_DIR_NAME);

  const ticketSecret = nonEmpty(env.NOWME_TICKET_SECRET) ?? null;
  if (ticketSecret !== null && ticketSecret.length < TICKET_SECRET_MIN_LENGTH) {
    throw new ConfigError(`NOWME_TICKET_SECRET 至少 ${TICKET_SECRET_MIN_LENGTH} 个字符`);
  }

  const homeRaw = nonEmpty(env.NOWME_HOME);
  const nowmeHome = homeRaw ? resolve(homeRaw) : join(homedir(), DEFAULT_NOWME_HOME_DIR_NAME);

  return {
    webOrigin,
    pagesOrigin,
    web,
    pages,
    trustProxyHops: parseIntRange(env, 'NOWME_TRUST_PROXY', 0, TRUST_PROXY_HOPS_RANGE),
    mail: loadMailConfig(env),
    billing: loadBillingConfig(env),
    moderation: loadModerationConfig(env),
    contactEmail: loadContactEmail(env),
    dataDir,
    ticketSecret,
    agentTokenTtlHours: parseTtlHours(env.NOWME_AGENT_TOKEN_TTL_HOURS),
    nowmeHome,
    isProduction: env.NODE_ENV === 'production',
    hosted: loadHostedConfig(env, env.NODE_ENV === 'production'),
    skillMarket: loadSkillMarketConfig(env),
    demoUrl: loadDemoUrl(env),
    worker: loadWorkerConfig(env),
  };
}

/** 常见的两段式公共后缀：判断“是否同一个可注册域名”时多取一段。不求完整，只用于启动时的提醒。 */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'com.tw', 'co.jp', 'co.uk', 'org.uk', 'co.kr', 'com.au', 'com.sg',
  'github.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'fly.dev', 'onrender.com', 'railway.app', 'herokuapp.com', 'web.app',
]);

/** 粗略的可注册域名（没有完整的公共后缀表）；IP 与单段主机名原样返回。 */
export function registrableDomainGuess(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return hostname;
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const take = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-take).join('.');
}

export interface ProductionCheck {
  /** 必须修复，否则拒绝启动。 */
  errors: string[];
  /** 建议修复，启动时打印。 */
  warnings: string[];
}

/**
 * 生产环境启动前的配置检查（contracts 10.1）。只在 `NODE_ENV=production` 时由进程入口调用；
 * `role` 区分主站、后台任务进程与页面托管（凭证库密钥主站与 worker 需要，邮件只有主站需要）。不读写文件，不把任何密钥写进返回的文字。
 */
export function checkProductionConfig(config: NowmeConfig, env: Env, role: 'web' | 'pages' | 'worker'): ProductionCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, origin] of [['NOWME_WEB_ORIGIN', config.webOrigin], ['NOWME_PAGES_ORIGIN', config.pagesOrigin]] as const) {
    if (!origin.startsWith('https://')) errors.push(`${name} 在生产环境必须是 https 源（当前 ${origin}）：会话 cookie 的 Secure 属性与 HSTS 都依赖它`);
  }
  const webHost = new URL(config.webOrigin).hostname;
  const pagesHost = new URL(config.pagesOrigin).hostname;
  if (webHost === pagesHost) {
    warnings.push(
      `NOWME_ALLOW_SAME_IP_ORIGINS=1：主站与页面托管共用同一个 IP（${webHost}），cookie 不按端口隔离，` +
        '主站的会话 cookie 会随请求带到页面托管端口；这只是没有域名时的临时做法，有了两个域名后请去掉这个变量',
    );
  } else if (registrableDomainGuess(webHost) === registrableDomainGuess(pagesHost)) {
    warnings.push(
      `主站（${webHost}）与页面托管（${pagesHost}）看起来在同一个可注册域名下。子域名之间属于“同站”，` +
        'SameSite cookie 不把它们当作跨站；建议给用户页面单独注册一个域名（类似 githubusercontent.com 的做法）',
    );
  }
  if (config.ticketSecret === null) {
    warnings.push('没有设置 NOWME_TICKET_SECRET：将使用数据目录里的 secret 文件，主站与页面托管必须挂载同一个数据目录');
  }
  if (config.trustProxyHops === 0) {
    warnings.push('NOWME_TRUST_PROXY=0：如果进程在反向代理或负载均衡之后，所有请求会被当成同一个来源地址，按地址的限流会误伤正常用户');
  }
  if (role === 'web' || role === 'worker') {
    if (!/^[0-9a-fA-F]{64}$/.test(nonEmpty(env.NOWME_AI_ENCRYPTION_KEY) ?? '')) {
      errors.push('NOWME_AI_ENCRYPTION_KEY 必须是 64 位十六进制（openssl rand -hex 32）：没有它用户无法保存模型 Key，网页创作不可用');
    }
    if (config.billing.platform && nonEmpty(env.NOWME_PLATFORM_API_KEY) === undefined) {
      errors.push('设置了 NOWME_PLATFORM_PROVIDER 但没有 NOWME_PLATFORM_API_KEY：平台 AI 无法调用模型');
    }
  }
  if (role === 'web') {
    if (config.mail.transport === 'file') {
      errors.push('NOWME_MAIL_TRANSPORT=file 只把验证码写进本地文件，真实用户收不到：生产环境请配置 smtp');
    }
    if (config.worker.mode === 'inline') {
      warnings.push(
        'NOWME_WORKER_MODE=inline：渲染与 AI 任务在主站进程内执行，渲染占用内存会拖慢网页请求；' +
          '生产环境建议设为 separate，并单独运行 worker 进程（pnpm --filter @nowme/web start:worker）',
      );
    }
  }
  return { errors, warnings };
}

/** 生产环境配置有错误时抛出 ConfigError（列出全部问题）；返回提醒列表。非生产环境直接返回空。 */
export function assertProductionConfig(config: NowmeConfig, env: Env, role: 'web' | 'pages' | 'worker'): string[] {
  if (!config.isProduction) return [];
  const { errors, warnings } = checkProductionConfig(config, env, role);
  if (errors.length > 0) throw new ConfigError(`生产环境配置不完整：\n${errors.map((line) => `- ${line}`).join('\n')}`);
  return warnings;
}

/** 本地数据目录内的约定路径（contracts 0、3）。 */
export function dataPaths(dataDir: string): {
  db: string;
  revisions: string;
  outbox: string;
  secret: string;
  revision: (revisionId: string) => string;
} {
  return {
    db: join(dataDir, DATA_DB_FILE),
    revisions: join(dataDir, DATA_REVISIONS_DIR),
    outbox: join(dataDir, DATA_OUTBOX_FILE),
    secret: join(dataDir, DATA_SECRET_FILE),
    revision: (revisionId: string) => join(dataDir, DATA_REVISIONS_DIR, revisionId),
  };
}

/**
 * 取票据密钥：优先 `NOWME_TICKET_SECRET`；否则读 `<dataDir>/secret`，不存在就生成
 * （32 字节随机 base64url，文件权限 0600）。主站与页面托管各自调用，得到同一个密钥。
 */
export function resolveTicketSecret(config: Pick<NowmeConfig, 'dataDir' | 'ticketSecret'>): string {
  if (config.ticketSecret) return config.ticketSecret;
  const file = dataPaths(config.dataDir).secret;
  const read = (): string | null => {
    try {
      const value = readFileSync(file, 'utf8').trim();
      return value.length > 0 ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const existing = read();
  if (existing !== null) {
    if (existing.length < TICKET_SECRET_MIN_LENGTH) {
      throw new ConfigError(`${file} 中的密钥太短（至少 ${TICKET_SECRET_MIN_LENGTH} 个字符）`);
    }
    return existing;
  }
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  try {
    // wx：文件已存在则失败（两个进程同时启动时，后者读取前者写入的密钥）
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = read();
    if (raced === null) throw new ConfigError(`无法读取 ${file}`);
    return raced;
  }
}

/**
 * 仓库根有 `.env` 时载入到 process.env（Node 内置 process.loadEnvFile；已存在的环境变量优先）。
 * 主站与页面托管启动时调用；CLI 不调用（CLI 在用户的工作目录里运行）。
 */
export function loadRepoDotEnv(file: string = join(REPO_ROOT, '.env')): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
