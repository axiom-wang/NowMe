import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWebCsp } from '@nowme/contracts';
import { createTestWeb, get, login, seedWall, type TestWeb } from './helpers.js';

describe('主站基础', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('未登录访问 / 看到正式首页；需要登录的页面重定向到登录页', async () => {
    const response = await get(t, '/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('给你的圈子');
    const messages = await get(t, '/messages');
    expect(messages.status).toBe(303);
    expect(messages.headers.get('location')).toBe('/login?next=%2Fmessages');
  });

  it('登录页是完整的中文 HTML 文档，带主站 CSP', async () => {
    const response = await get(t, '/login');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toBe(buildWebCsp({ pagesOrigin: t.config.pagesOrigin }));
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('<title>登录 · NOWMe</title>');
    expect(html).toMatch(/href="\/static\/app\.[0-9a-f]{10}\.css"/);
    expect(html).toMatch(/href="\/static\/auth\.[0-9a-f]{10}\.css"/);
    expect(html).not.toMatch(/\/static\/(wall|workspace|admin|home)\./);
  });

  it('提供 static/ 下的样式与脚本，拒绝其他路径', async () => {
    const css = await get(t, '/static/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const js = await get(t, '/static/page-frame.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    for (const name of ['font-display.woff2', 'font-grotesk-500.woff2', 'font-grotesk-700.woff2', 'font-mono-500.woff2']) {
      const font = await get(t, `/static/${name}`);
      expect(font.status, name).toBe(200);
      expect(font.headers.get('content-type'), name).toBe('font/woff2');
    }
    for (const path of ['/static/missing.css', '/static/..%2Fpackage.json', '/static/%2e%2e%2fsrc%2fapp.tsx', '/static/.hidden.js']) {
      expect((await get(t, path)).status, path).toBe(404);
    }
  });

  it('未知路径：页面 404 HTML，API 404 JSON', async () => {
    const page = await get(t, '/nope');
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('这里没有你要找的内容');
    const api = await get(t, '/api/agent/nope');
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  it('“我的”列出加入的墙与工作区入口', async () => {
    const session = await login(t, 'ayou@example.com', '阿柚');
    const { wall } = seedWall(t, session.userId, '周末黑客松');
    const response = await get(t, '/', { cookie: session.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('你好，阿柚');
    expect(html).toContain('周末黑客松');
    expect(html).toContain(`href="/w/${wall.id}/me"`);
    expect(html).toContain('未发布');
    expect(html).toContain('黑客松');
  });
});
