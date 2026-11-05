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
