import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  dataPaths,
  loadConfig,
  REPO_ROOT,
  resolveTicketSecret,
  MODEL_PROVIDER_PRESETS,
  MODEL_PROVIDERS,
} from '../src/index.js';

describe('REPO_ROOT', () => {
  it('指向仓库根', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('loadConfig', () => {
  it('默认值（contracts 0.1）', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      webOrigin: 'http://localhost:3000',
      pagesOrigin: 'http://127.0.0.1:4000',
      web: { hostname: 'localhost', port: 3000 },
      pages: { hostname: '127.0.0.1', port: 4000 },
      trustProxyHops: 0,
      mail: { transport: 'file', from: null },
      billing: { platform: null, prices: { generate: 10, edit: 4 }, signupCredits: 0, freeDailyCalls: 3000 },
      moderation: { blocklistFile: null, url: null, onFailure: 'allow' },
      contactEmail: null,
      dataDir: resolve(REPO_ROOT, '.data'),
      ticketSecret: null,
      agentTokenTtlHours: 72,
      nowmeHome: join(homedir(), '.nowme'),
      isProduction: false,
      hosted: {
        enabled: true,
        fake: false,
        interview: {
          provider: 'anthropic',
          label: 'Anthropic Claude',
          protocol: 'anthropic',
          baseUrl: null,
          model: 'claude-haiku-5-5',
          apiKeyEnv: null,
          apiKeyRequired: true,
          hasApiKey: false,
          vision: true,
          maxOutputTokens: 32000,
          maxTokensField: 'max_tokens',
          ready: false,
        },
        generate: {
          provider: 'anthropic',
          label: 'Anthropic Claude',
          protocol: 'anthropic',
          baseUrl: null,
          model: 'claude-sonnet-5-5',
          apiKeyEnv: null,
          apiKeyRequired: true,
          hasApiKey: false,
          vision: true,
          maxOutputTokens: 32000,
          maxTokensField: 'max_tokens',
          ready: false,
        },
        maxTurns: 30,
        dailyAttempts: 10,
        interviewDailyCalls: 20,
      },
      skillMarket: null,
      worker: { mode: 'inline', aiConcurrency: 2, shutdownGraceMs: 30_000 },
    });
  });

  it('Skill 市场渠道：两个变量同时设置才生效；只设一个、多行或过长都报错', () => {
    expect(loadConfig({}).skillMarket).toBeNull();
    expect(
      loadConfig({ NOWME_SKILL_MARKET_LABEL: 'SkillHub', NOWME_SKILL_MARKET_COMMAND: ' npx skills add nowme/nowme-page ' }).skillMarket,
    ).toEqual({ label: 'SkillHub', command: 'npx skills add nowme/nowme-page' });
    expect(() => loadConfig({ NOWME_SKILL_MARKET_LABEL: 'SkillHub' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOWME_SKILL_MARKET_COMMAND: 'npx skills add x' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOWME_SKILL_MARKET_LABEL: 'A', NOWME_SKILL_MARKET_COMMAND: 'a\nrm -rf ~' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOWME_SKILL_MARKET_LABEL: 'x'.repeat(41), NOWME_SKILL_MARKET_COMMAND: 'a' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOWME_SKILL_MARKET_LABEL: 'A', NOWME_SKILL_MARKET_COMMAND: 'a'.repeat(301) })).toThrow(ConfigError);
  });

  it('网页创作始终可见，不读取平台模型凭证或旧额度', () => {
    const key = 'sk-platform-secret';
    const config = loadConfig({ ANTHROPIC_API_KEY: key, NOWME_MODEL_API_KEY: key, NOWME_MODEL_PROVIDER: 'deepseek', NOWME_HOSTED_FREE_QUOTA: '0' });
    expect(config.hosted.enabled).toBe(true);
    expect(config.hosted.generate).toMatchObject({ provider: 'anthropic', hasApiKey: false, apiKeyEnv: null, ready: false });
    expect(config.hosted).not.toHaveProperty('freeQuota');
    expect(JSON.stringify(config)).not.toContain(key);
    expect(loadConfig({ NOWME_MODEL_FAKE: '1' }).hosted.fake).toBe(true);
    expect(loadConfig({ NOWME_CLAUDE_FAKE: '1' }).hosted.fake).toBe(true);
    expect(() => loadConfig({ NOWME_MODEL_FAKE: '1', NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOWME_MODEL_FAKE: 'yes' })).toThrow(ConfigError);
    expect(() => loadConfig({ NOWME_HOSTED_DAILY_ATTEMPTS: '-1' })).toThrow(ConfigError);
    for (const provider of MODEL_PROVIDERS) expect(MODEL_PROVIDER_PRESETS[provider].label.length).toBeGreaterThan(0);
  });

  it('读取环境变量；源末尾斜杠被去掉；空字符串视为未设置', () => {
    const config = loadConfig({
      NOWME_WEB_ORIGIN: 'https://nowme.example/',
      NOWME_PAGES_ORIGIN: 'https://pages.nowme-usercontent.example:8443',
      NOWME_DATA_DIR: '/tmp/nowme-data',
      NOWME_TICKET_SECRET: 's'.repeat(40),
      NOWME_AGENT_TOKEN_TTL_HOURS: '24',
      NOWME_HOME: '/tmp/nowme-home',
      NODE_ENV: 'production',
    });
    expect(config.webOrigin).toBe('https://nowme.example');
    expect(config.web).toEqual({ hostname: 'nowme.example', port: 443 });
    expect(config.pagesOrigin).toBe('https://pages.nowme-usercontent.example:8443');
    expect(config.pages).toEqual({ hostname: 'pages.nowme-usercontent.example', port: 8443 });
    expect(config.dataDir).toBe('/tmp/nowme-data');
    expect(config.ticketSecret).toBe('s'.repeat(40));
    expect(config.agentTokenTtlHours).toBe(24);
    expect(config.nowmeHome).toBe('/tmp/nowme-home');
    expect(config.isProduction).toBe(true);
    expect(loadConfig({ NOWME_WEB_ORIGIN: '', NOWME_TICKET_SECRET: '  ' }).webOrigin).toBe('http://localhost:3000');
  });

  it('相对的 NOWME_DATA_DIR 按仓库根解析', () => {
    expect(loadConfig({ NOWME_DATA_DIR: '.data/test' }).dataDir).toBe(resolve(REPO_ROOT, '.data/test'));
  });

  it('非法的源报 ConfigError', () => {
    for (const value of ['localhost:3000', 'ftp://localhost', 'http://localhost:3000/app', 'http://*.local:3000']) {
      expect(() => loadConfig({ NOWME_WEB_ORIGIN: value }), value).toThrow(ConfigError);
    }
  });

  it('主站与页面托管不能是同一主机（同主机不同端口会共享 cookie）', () => {
    expect(() => loadConfig({ NOWME_PAGES_ORIGIN: 'http://localhost:4000' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ NOWME_WEB_ORIGIN: 'http://127.0.0.1:3000', NOWME_PAGES_ORIGIN: 'http://127.0.0.1:4000' }),
    ).toThrow(/不能相同/);
  });

  it('NOWME_AGENT_TOKEN_TTL_HOURS 为 1–720 的整数', () => {
    expect(loadConfig({ NOWME_AGENT_TOKEN_TTL_HOURS: '1' }).agentTokenTtlHours).toBe(1);
    expect(loadConfig({ NOWME_AGENT_TOKEN_TTL_HOURS: '720' }).agentTokenTtlHours).toBe(720);
    for (const value of ['0', '721', '-1', '1.5', 'abc', '72h']) {
      expect(() => loadConfig({ NOWME_AGENT_TOKEN_TTL_HOURS: value }), value).toThrow(ConfigError);
    }
  });

  it('NOWME_TICKET_SECRET 太短报错', () => {
    expect(() => loadConfig({ NOWME_TICKET_SECRET: 'short' })).toThrow(ConfigError);
  });
});

describe('dataPaths', () => {
  it('contracts 0 的目录布局', () => {
    const paths = dataPaths('/d');
    expect(paths).toMatchObject({
      db: '/d/db.sqlite',
      revisions: '/d/revisions',
      outbox: '/d/outbox.log',
      secret: '/d/secret',
    });
    expect(paths.revision('rev_x')).toBe('/d/revisions/rev_x');
  });
});

describe('resolveTicketSecret', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-secret-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('优先使用 NOWME_TICKET_SECRET，不读写文件', () => {
    const dataDir = join(tempDir(), 'data');
    expect(resolveTicketSecret({ dataDir, ticketSecret: 'e'.repeat(32) })).toBe('e'.repeat(32));
    expect(existsSync(dataDir)).toBe(false);
  });

  it('否则生成 <dataDir>/secret（0600），之后读取同一个值', () => {
    const dataDir = join(tempDir(), 'data');
    const first = resolveTicketSecret({ dataDir, ticketSecret: null });
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = dataPaths(dataDir).secret;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(resolveTicketSecret({ dataDir, ticketSecret: null })).toBe(first);
  });

  it('已有文件中的密钥太短时报错', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'secret'), 'short\n');
    expect(() => resolveTicketSecret({ dataDir, ticketSecret: null })).toThrow(ConfigError);
  });
});
