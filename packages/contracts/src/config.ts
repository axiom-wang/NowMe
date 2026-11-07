/**
 * 运行配置（contracts 0、0.1、4.3、4.4）。所有环境变量见仓库根 `.env.example`。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  DEFAULT_GENERATE_MODEL,
  DEFAULT_HOSTED_DAILY_ATTEMPTS,
  DEFAULT_HOSTED_FREE_QUOTA,
  DEFAULT_HOSTED_MAX_TURNS,
  DEFAULT_INTERVIEW_DAILY_CALLS,
  DEFAULT_INTERVIEW_MODEL,
  HOSTED_DAILY_RANGE,
  HOSTED_FREE_QUOTA_RANGE,
  HOSTED_MAX_TURNS_RANGE,
} from './constants.js';
import { normalizeOrigin } from './csp.js';

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

export interface NowmeConfig {
  /** 主站源（`NOWME_WEB_ORIGIN`），规范形式，无尾部斜杠。 */
  webOrigin: string;
  /** 页面托管源（`NOWME_PAGES_ORIGIN`）。 */
  pagesOrigin: string;
  /** 由源推导出的监听主机与端口。 */
  web: { hostname: string; port: number };
  pages: { hostname: string; port: number };
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
}

export interface SkillMarketConfig {
  /** 市场名称，例如 “SkillHub”。 */
  label: string;
  /** 在终端运行的安装命令，例如 `npx skills add nowme/nowme-page`。 */
  command: string;
}

/**
 * 平台托管路线的配置。`ANTHROPIC_API_KEY` **不进入配置对象**（只记录有没有），
 * 由主站进程入口直接从环境变量读取并交给 Claude 客户端，避免随配置被打印或序列化。
 */
export interface HostedConfig {
  /** 托管功能是否开启：有 API key，或非生产环境下 `NOWME_CLAUDE_FAKE=1`。 */
  enabled: boolean;
  /** `NOWME_CLAUDE_FAKE=1`：使用确定性的假客户端（只在非生产环境允许）。 */
  fake: boolean;
  hasApiKey: boolean;
  interviewModel: string;
  generateModel: string;
  freeQuota: number;
  maxTurns: number;
  dailyAttempts: number;
  interviewDailyCalls: number;
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

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.\-:@\[\]]{1,99}$/;

function parseModel(env: Env, name: string, fallback: string): string {
  const value = nonEmpty(env[name]) ?? fallback;
  if (!MODEL_ID_PATTERN.test(value)) throw new ConfigError(`${name} 不是合法的模型 ID：${value}`);
  return value;
}

/** 托管路线配置（hosted-route 1）。生产环境拒绝 `NOWME_CLAUDE_FAKE=1`。 */
export function loadHostedConfig(env: Env, isProduction: boolean): HostedConfig {
  const fakeRaw = nonEmpty(env.NOWME_CLAUDE_FAKE);
  if (fakeRaw !== undefined && fakeRaw !== '1' && fakeRaw !== '0') {
    throw new ConfigError(`NOWME_CLAUDE_FAKE 只能是 1 或 0：${fakeRaw}`);
  }
  const fake = fakeRaw === '1';
  if (fake && isProduction) throw new ConfigError('生产环境不能使用 NOWME_CLAUDE_FAKE=1（假的 Claude 客户端只用于开发与测试）');
  const hasApiKey = nonEmpty(env.ANTHROPIC_API_KEY) !== undefined;
  return {
    enabled: hasApiKey || fake,
    fake,
    hasApiKey,
    interviewModel: parseModel(env, 'NOWME_INTERVIEW_MODEL', DEFAULT_INTERVIEW_MODEL),
    generateModel: parseModel(env, 'NOWME_GENERATE_MODEL', DEFAULT_GENERATE_MODEL),
    freeQuota: parseIntRange(env, 'NOWME_HOSTED_FREE_QUOTA', DEFAULT_HOSTED_FREE_QUOTA, HOSTED_FREE_QUOTA_RANGE),
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

/** 读取配置并校验。默认值见 contracts 0.1。不读写文件。 */
export function loadConfig(env: Env = process.env): NowmeConfig {
  const webOrigin = parseOrigin(env, 'NOWME_WEB_ORIGIN', DEFAULT_WEB_ORIGIN);
  const pagesOrigin = parseOrigin(env, 'NOWME_PAGES_ORIGIN', DEFAULT_PAGES_ORIGIN);
  const web = listenAddress(webOrigin);
  const pages = listenAddress(pagesOrigin);

  // 主站与页面托管必须是不同站点：cookie 不按端口隔离，同主机不同端口会共享 cookie。
  if (web.hostname === pages.hostname) {
    throw new ConfigError(
      `NOWME_WEB_ORIGIN 与 NOWME_PAGES_ORIGIN 的主机名不能相同（${web.hostname}），` +
        '例如主站用 localhost、页面托管用 127.0.0.1',
    );
  }

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
    dataDir,
    ticketSecret,
    agentTokenTtlHours: parseTtlHours(env.NOWME_AGENT_TOKEN_TTL_HOURS),
    nowmeHome,
    isProduction: env.NODE_ENV === 'production',
    hosted: loadHostedConfig(env, env.NODE_ENV === 'production'),
    skillMarket: loadSkillMarketConfig(env),
  };
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
