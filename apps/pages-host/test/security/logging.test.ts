/** 页面托管的请求 ID 与访问日志：票据在路径里，日志中必须打码（contracts 17）。 */
import { describe, expect, it } from 'vitest';
import { createPagesApp } from '../../src/app.js';
import { createLogger, pagesRouteLabel } from '../../src/logging.js';
import { REV_A, makeConfig, makeFixture } from '../helpers.js';

function setup(options: { trustRequestId?: boolean } = {}) {
  const { dataDir, ticket } = makeFixture();
  const lines: string[] = [];
  const logger = createLogger({ service: 'pages', json: true, write: (_l, line) => lines.push(line) });
  const app = createPagesApp(makeConfig(dataDir), { log: logger, accessLog: true, ...options });
  return { app, ticket, lines };
}

describe('页面托管访问日志', () => {
  it('票据打码，只留路径模板、状态码与耗时', async () => {
    const { app, ticket, lines } = setup();
    const t = ticket(REV_A);
    const res = await app.request(`/v/${t}/assets/a.png?x=secret-query`, { headers: { Cookie: 'a=cookie-secret' } });
    expect(res.status).toBe(200);
    await app.request(`/v/${t}x/`);
    const entries = lines.map((line) => JSON.parse(line));
    const request = entries.filter((entry) => String(entry.msg).includes('/v/:ticket'));
    expect(request.length).toBe(2);
    expect(request[0]).toMatchObject({ method: 'GET', route: '/v/:ticket/assets/a.png', status: 200, service: 'pages' });
    expect(typeof request[0].ms).toBe('number');
    const text = lines.join('\n');
    expect(text).not.toContain(t);
    expect(text).not.toContain(t.split('.')[2]!);
    expect(text).not.toContain('secret-query');
    expect(text).not.toContain('cookie-secret');
  });

  it('请求 ID：默认自己生成，声明可信代理后才沿用上游', async () => {
    const plain = setup();
    const res = await plain.app.request('/healthz', { headers: { 'X-Request-Id': 'upstream-id-12345' } });
    expect(res.headers.get('X-Request-Id')).not.toBe('upstream-id-12345');
    const trusted = setup({ trustRequestId: true });
    const res2 = await trusted.app.request('/healthz', { headers: { 'X-Request-Id': 'upstream-id-12345' } });
    expect(res2.headers.get('X-Request-Id')).toBe('upstream-id-12345');
  });

  it('日志行带 reqId，与响应头一致', async () => {
    const { app, lines } = setup();
    const res = await app.request('/healthz');
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.reqId).toBe(res.headers.get('X-Request-Id'));
  });

  it('路径模板：非法段与未知路径不原样输出', () => {
    expect(pagesRouteLabel('/v/abc.def.ghi/index.html')).toBe('/v/:ticket/index.html');
    expect(pagesRouteLabel('/v/abc.def.ghi/%41')).toBe('/v/:ticket/:invalid');
    expect(pagesRouteLabel('/_nowme/kit/v1/kit.css')).toBe('/_nowme/kit/:file');
    expect(pagesRouteLabel('/whatever/abc.def.ghi')).toBe('(other)');
  });
});
