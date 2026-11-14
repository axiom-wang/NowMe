/**
 * 部署相关的配置（contracts 10.1、10.2）：监听地址与对外的源分开、反向代理层数、邮件发送、生产环境启动检查。
 */
import { describe, expect, it } from 'vitest';
import { assertProductionConfig, checkProductionConfig, ConfigError, loadBillingConfig, loadConfig, loadMailConfig, registrableDomainGuess } from '../src/index.js';

const KEY = 'a'.repeat(64);
const PROD = {
  NODE_ENV: 'production',
  NOWME_WEB_ORIGIN: 'https://nowme.example',
  NOWME_PAGES_ORIGIN: 'https://nowme-pages.example',
  NOWME_WEB_LISTEN: '0.0.0.0:3000',
  NOWME_PAGES_LISTEN: '0.0.0.0:4000',
  NOWME_TICKET_SECRET: 's'.repeat(40),
  NOWME_TRUST_PROXY: '1',
  NOWME_AI_ENCRYPTION_KEY: KEY,
  NOWME_MAIL_TRANSPORT: 'smtp',
  NOWME_SMTP_URL: 'smtps://user:secret-pass@smtp.example.com:465',
  NOWME_MAIL_FROM: 'NOWMe <no-reply@nowme.example>',
};

describe('监听地址（NOWME_*_LISTEN）', () => {
  it('没设置时由源推导', () => {
    const config = loadConfig({ NOWME_WEB_ORIGIN: 'http://localhost:3300', NOWME_PAGES_ORIGIN: 'http://127.0.0.1:4300' });
    expect(config.web).toEqual({ hostname: 'localhost', port: 3300 });
    expect(config.pages).toEqual({ hostname: '127.0.0.1', port: 4300 });
  });

  it('对外是 https 域名时，进程监听的地址单独指定', () => {
    const config = loadConfig(PROD);
    expect(config.webOrigin).toBe('https://nowme.example');
    expect(config.web).toEqual({ hostname: '0.0.0.0', port: 3000 });
    expect(config.pages).toEqual({ hostname: '0.0.0.0', port: 4000 });
  });

  it('只写端口时主机名沿用源的主机名；支持 IPv6', () => {
    expect(loadConfig({ NOWME_WEB_LISTEN: '8080' }).web).toEqual({ hostname: 'localhost', port: 8080 });
    expect(loadConfig({ NOWME_WEB_LISTEN: '[::]:8080' }).web).toEqual({ hostname: '::', port: 8080 });
  });

  it.each(['abc', '0', '70000', 'host:', ':3000', 'a b:3000', 'http://x:3000'])('格式不对时报错：%s', (value) => {
    expect(() => loadConfig({ NOWME_WEB_LISTEN: value })).toThrow(ConfigError);
  });
});

describe('NOWME_TRUST_PROXY', () => {
  it('默认 0；只接受 0–5 的整数', () => {
    expect(loadConfig({}).trustProxyHops).toBe(0);
    expect(loadConfig({ NOWME_TRUST_PROXY: '2' }).trustProxyHops).toBe(2);
    for (const value of ['-1', '6', 'true', '1.5']) expect(() => loadConfig({ NOWME_TRUST_PROXY: value })).toThrow(ConfigError);
  });
});

describe('邮件发送配置', () => {
  it('默认写本地文件', () => {
    expect(loadMailConfig({})).toEqual({ transport: 'file', from: null });
  });

  it('smtp 需要连接串和发件人；配置对象里不含连接串', () => {
    const mail = loadMailConfig(PROD);
    expect(mail).toEqual({ transport: 'smtp', from: 'NOWMe <no-reply@nowme.example>' });
    expect(JSON.stringify(loadConfig(PROD))).not.toContain('secret-pass');
    expect(() => loadMailConfig({ ...PROD, NOWME_MAIL_FROM: '' })).toThrow(ConfigError);
    expect(() => loadMailConfig({ ...PROD, NOWME_SMTP_URL: '' })).toThrow(ConfigError);
  });

  it('连接串不合法时报错，错误信息里不带连接串', () => {
    for (const url of ['https://user:secret-pass@smtp.example.com', 'user:secret-pass@smtp']) {
      let message = '';
      try {
        loadMailConfig({ ...PROD, NOWME_SMTP_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('NOWME_SMTP_URL');
      expect(message).not.toContain('secret-pass');
    }
  });

  it('发件人必须是一行并包含邮箱；传输方式只能是 file / smtp', () => {
    expect(() => loadMailConfig({ NOWME_MAIL_FROM: 'NOWMe' })).toThrow(ConfigError);
    expect(() => loadMailConfig({ NOWME_MAIL_FROM: 'a@b.c\nBcc: x@y.z' })).toThrow(ConfigError);
    expect(() => loadMailConfig({ NOWME_MAIL_TRANSPORT: 'sendmail' })).toThrow(ConfigError);
  });
});

describe('registrableDomainGuess', () => {
  it.each([
    ['nowme.example', 'nowme.example'],
    ['app.nowme.example', 'nowme.example'],
    ['pages.nowme.com.cn', 'nowme.com.cn'],
    ['a.fly.dev', 'a.fly.dev'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
  ])('%s → %s', (host, expected) => {
    expect(registrableDomainGuess(host)).toBe(expected);
  });
});

describe('生产环境启动检查', () => {
  it('完整配置：没有错误也没有提醒', () => {
    const config = loadConfig(PROD);
    expect(checkProductionConfig(config, PROD, 'web')).toEqual({ errors: [], warnings: [] });
    expect(assertProductionConfig(config, PROD, 'web')).toEqual([]);
  });

  it('非生产环境不检查', () => {
    expect(assertProductionConfig(loadConfig({}), {}, 'web')).toEqual([]);
  });

  it('http 源、没有凭证库密钥、邮件只写文件：拒绝启动，并一次列出全部问题', () => {
    const env = { NODE_ENV: 'production', NOWME_WEB_ORIGIN: 'http://nowme.example', NOWME_PAGES_ORIGIN: 'https://nowme-pages.example' };
    const config = loadConfig(env);
    const { errors } = checkProductionConfig(config, env, 'web');
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toMatch(/NOWME_WEB_ORIGIN[\s\S]*NOWME_AI_ENCRYPTION_KEY[\s\S]*NOWME_MAIL_TRANSPORT/);
    expect(() => assertProductionConfig(config, env, 'web')).toThrow(ConfigError);
  });

  it('页面托管不需要凭证库密钥和邮件', () => {
    const env = { NODE_ENV: 'production', NOWME_WEB_ORIGIN: PROD.NOWME_WEB_ORIGIN, NOWME_PAGES_ORIGIN: PROD.NOWME_PAGES_ORIGIN, NOWME_TRUST_PROXY: '1', NOWME_TICKET_SECRET: PROD.NOWME_TICKET_SECRET };
    expect(checkProductionConfig(loadConfig(env), env, 'pages')).toEqual({ errors: [], warnings: [] });
  });

  it('主站与用户页面在同一个可注册域名下、没有显式票据密钥、没有声明代理层数：给出提醒但不拒绝', () => {
    const env = { ...PROD, NOWME_PAGES_ORIGIN: 'https://pages.nowme.example', NOWME_TICKET_SECRET: '', NOWME_TRUST_PROXY: '0' };
    const { errors, warnings } = checkProductionConfig(loadConfig(env), env, 'web');
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('同一个可注册域名');
  });

  it('错误与提醒里不出现任何密钥', () => {
    const env = { ...PROD, NOWME_WEB_ORIGIN: 'http://nowme.example', NOWME_AI_ENCRYPTION_KEY: 'not-a-key-but-secret' };
    const { errors, warnings } = checkProductionConfig(loadConfig(env), env, 'web');
    const text = [...errors, ...warnings].join('\n');
    for (const secret of ['secret-pass', 'not-a-key-but-secret', PROD.NOWME_TICKET_SECRET]) expect(text).not.toContain(secret);
  });
});

describe('点数与平台 AI 的配置（contracts 12）', () => {
  it('默认：平台 AI 关闭，价目 10 / 4，不赠送', () => {
    expect(loadBillingConfig({})).toEqual({ platform: null, prices: { generate: 10, edit: 4 }, signupCredits: 0, freeDailyCalls: 3000 });
  });

  it('设置模型服务后开启：采访与生成各用预设的模型，可以分别覆盖；配置里没有 key', () => {
    const env = { NOWME_PLATFORM_PROVIDER: 'deepseek', NOWME_PLATFORM_API_KEY: 'sk-platform-secret' };
    const billing = loadBillingConfig(env);
    expect(billing.platform?.generate).toMatchObject({ provider: 'deepseek', protocol: 'openai', ready: true });
    expect(billing.platform?.generate.model).toBeTruthy();
    expect(billing.platform?.interview.model).toBeTruthy();
    expect(JSON.stringify(loadConfig(env))).not.toContain('sk-platform-secret');
    const custom = loadBillingConfig({ ...env, NOWME_PLATFORM_MODEL: 'big', NOWME_PLATFORM_INTERVIEW_MODEL: 'small', NOWME_PLATFORM_BASE_URL: 'https://llm.example.com/v1/', NOWME_PLATFORM_VISION: '1' });
    expect(custom.platform?.generate).toMatchObject({ model: 'big', baseUrl: 'https://llm.example.com/v1', vision: true });
    expect(custom.platform?.interview.model).toBe('small');
  });

  it('预设没有默认模型的服务：只给生成模型时，采访沿用它；都不给就报错', () => {
    const base = { NOWME_PLATFORM_PROVIDER: 'openai-compatible', NOWME_PLATFORM_BASE_URL: 'https://llm.example.com/v1' };
    const billing = loadBillingConfig({ ...base, NOWME_PLATFORM_MODEL: 'only-one' });
    expect([billing.platform?.interview.model, billing.platform?.generate.model]).toEqual(['only-one', 'only-one']);
    expect(() => loadBillingConfig(base)).toThrow(ConfigError);
    expect(() => loadBillingConfig({ NOWME_PLATFORM_PROVIDER: 'openai-compatible', NOWME_PLATFORM_MODEL: 'm' })).toThrow(/NOWME_PLATFORM_BASE_URL/);
  });

  it('取值不对时报错：未知服务、负的价目、非法的图片开关', () => {
    expect(() => loadBillingConfig({ NOWME_PLATFORM_PROVIDER: 'nope' })).toThrow(ConfigError);
    expect(() => loadBillingConfig({ NOWME_PRICE_GENERATE: '-1' })).toThrow(ConfigError);
    expect(() => loadBillingConfig({ NOWME_PRICE_EDIT: '2.5' })).toThrow(ConfigError);
    expect(() => loadBillingConfig({ NOWME_PLATFORM_PROVIDER: 'deepseek', NOWME_PLATFORM_VISION: 'yes' })).toThrow(ConfigError);
    expect(loadBillingConfig({ NOWME_PRICE_GENERATE: '0', NOWME_PRICE_EDIT: '0', NOWME_SIGNUP_CREDITS: '20' })).toMatchObject({ prices: { generate: 0, edit: 0 }, signupCredits: 20 });
  });

  it('生产环境：配置了平台 AI 却没有 key → 拒绝启动', () => {
    const env = { ...PROD, NOWME_PLATFORM_PROVIDER: 'deepseek' };
    const { errors } = checkProductionConfig(loadConfig(env), env, 'web');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('NOWME_PLATFORM_API_KEY');
    const withKey = { ...env, NOWME_PLATFORM_API_KEY: 'sk-platform-secret' };
    expect(checkProductionConfig(loadConfig(withKey), withKey, 'web').errors).toEqual([]);
  });
});
