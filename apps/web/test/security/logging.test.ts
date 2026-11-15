/** 结构化日志、请求 ID 与访问日志（contracts 17）：不记录查询串、cookie、表单内容、邮箱。 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, inferLevel, redactText, resolveRequestId } from '../../src/observability/logging.js';
import { createTestWeb, type TestWeb } from '../helpers.js';

const instances: TestWeb[] = [];
afterEach(async () => {
  while (instances.length > 0) await instances.pop()!.close();
});

function setup(env: Record<string, string> = {}) {
  const lines: string[] = [];
  const t = createTestWeb({ env, log: (line) => lines.push(line), accessLogEnabled: true });
  instances.push(t);
  return { t, lines };
}

describe('日志格式', () => {
  it('JSON 模式：固定字段 time / level / service / msg，邮箱与 token 打码', () => {
    const out: string[] = [];
    const log = createLogger({ service: 'web', json: true, now: () => new Date('2026-11-15T01:02:03.000Z'), write: (_l, line) => out.push(line) });
    log('[web] 发件箱 → alice@example.com：nmt_abcdefghijklmnop');
    const entry = JSON.parse(out[0]!);
    expect(entry).toMatchObject({ time: '2026-11-15T01:02:03.000Z', level: 'info', service: 'web' });
    expect(entry.msg).toBe('[web] 发件箱 → ***@example.com：nmt_***');
  });

  it('JSON 模式：业务字段不能覆盖 level', () => {
    const out: string[] = [];
    const log = createLogger({ service: 'web', json: true, write: (_l, line) => out.push(line) });
    log.warn('x', { level: 'debug', status: 404 });
    expect(JSON.parse(out[0]!)).toMatchObject({ level: 'warn', status: 404 });
  });

  it('开发模式保持原文', () => {
    const out: string[] = [];
    const log = createLogger({ service: 'web', json: false, write: (_l, line) => out.push(line) });
    log('[web] 发件箱 → alice@example.com：你好');
    expect(out).toEqual(['[web] 发件箱 → alice@example.com：你好']);
  });

  it('按措辞推断级别', () => {
    expect(inferLevel('[web] 未处理的错误 GET /x：boom')).toBe('error');
    expect(inferLevel('[web] 配置提醒：xxx')).toBe('warn');
    expect(inferLevel('[web] 已启动')).toBe('info');
    expect(redactText('plain')).toBe('plain');
  });
});

describe('请求 ID', () => {
  it('默认不接受上游传来的 ID', async () => {
    const { t } = setup();
    const res = await t.request('/healthz', { headers: { 'X-Request-Id': 'upstream-id-12345' } });
    const id = res.headers.get('X-Request-Id');
    expect(id).toBeTruthy();
    expect(id).not.toBe('upstream-id-12345');
  });

  it('声明了 NOWME_TRUST_PROXY 才接受上游 ID（且格式合法）', async () => {
    const { t } = setup({ NOWME_TRUST_PROXY: '1' });
    const res = await t.request('/healthz', { headers: { 'X-Request-Id': 'upstream-id-12345' } });
    expect(res.headers.get('X-Request-Id')).toBe('upstream-id-12345');
    const bad = await t.request('/healthz', { headers: { 'X-Request-Id': 'bad id with spaces' } });
    expect(bad.headers.get('X-Request-Id')).not.toContain(' ');
    expect(resolveRequestId('x', true)).not.toBe('x');
  });

  it('404 页面也带请求 ID', async () => {
    const { t } = setup();
    const res = await t.request('/no-such-page');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

describe('访问日志', () => {
  it('记录方法、路由模板、状态码、耗时；不含查询串、cookie 与表单内容', async () => {
    const { t, lines } = setup();
    await t.request('/healthz?token=nmt_secretsecretsecret&email=alice@example.com', {
      headers: { Cookie: 'nowme_session=SESSION-SECRET-VALUE' },
    });
    await t.request('/auth/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: t.config.webOrigin },
      body: 'email=alice%40example.com',
    });
    const text = lines.join('\n');
    expect(text).toMatch(/GET \/healthz 200 \d+ms/);
    expect(text).toMatch(/POST \S+ \d{3} \d+ms/);
    for (const secret of ['nmt_secretsecretsecret', 'alice@example.com', 'alice%40example.com', 'SESSION-SECRET-VALUE', 'token=']) {
      expect(text).not.toContain(secret);
    }
  });

  it('没有命中路由时不把完整路径写进日志', async () => {
    const { t, lines } = setup();
    await t.request('/walls/wal_aaaaaaaaaaaaaaaaaaaaaaaaaa/unknown/deeper');
    expect(lines.join('\n')).not.toContain('wal_aaaaaaaaaaaaaaaaaaaaaaaaaa/unknown/deeper');
  });
});

describe('JSON 日志里的令牌（T8.11 回归）', () => {
  const invite = `inv_${'a'.repeat(26)}`;
  const publicToken = `pub_${'B'.repeat(32)}`;

  it('邀请码与公开链接令牌在文字里打码', () => {
    expect(redactText(`/join/${invite} /s/${publicToken}`)).toBe('/join/inv_*** /s/pub_***');
  });

  it('没有命中路由时，访问日志的 route 字段与文字都不含邀请码 / 公开链接令牌', async () => {
    const out: string[] = [];
    const logger = createLogger({ service: 'web', json: true, write: (_l, line) => out.push(line) });
    const t = createTestWeb({ log: logger, accessLogEnabled: true });
    instances.push(t);
    await t.request(`/join/${invite}/extra`);
    await t.request(`/s/${publicToken}/extra`);
    const entries = out.map((line) => JSON.parse(line) as { route?: string });
    expect(entries.some((entry) => entry.route === '/join/inv_***/…')).toBe(true);
    const text = out.join('\n');
    expect(text).not.toContain(invite);
    expect(text).not.toContain(publicToken);
  });

  it('业务字段里的字符串也打码', () => {
    const out: string[] = [];
    const log = createLogger({ service: 'web', json: true, write: (_l, line) => out.push(line) });
    log.info('x', { route: `/s/${publicToken}`, email: 'alice@example.com', status: 404 });
    const entry = JSON.parse(out[0]!);
    expect(entry).toMatchObject({ route: '/s/pub_***', email: '***@example.com', status: 404 });
  });
});
