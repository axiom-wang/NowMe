/**
 * 静态资源指纹与缓存头（routes/static.ts）、按页加载的样式包（views/layout.tsx）。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStaticAssets, IMMUTABLE_CACHE, REVALIDATE_CACHE } from '../src/routes/static.js';
import { styleBundlesFor, stylesheetsFor } from '../src/views/layout.js';
import { createTestWeb, get, login, seedWall, type TestWeb } from './helpers.js';

const HASHED = /^\/static\/([a-z0-9-]+)\.([0-9a-f]{10})\.(css|js|woff2|svg)$/;

function linkedAssets(html: string): string[] {
  return [...html.matchAll(/<(?:link rel="stylesheet" href|script src)="([^"]+)"/g)].map((m) => m[1]!);
}

describe('静态资源指纹', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('页面里的样式与脚本都带内容哈希；带哈希的响应长期缓存，HTML 仍然 no-store', async () => {
    const page = await get(t, '/login');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const assets = linkedAssets(await page.text());
    expect(assets.length).toBeGreaterThanOrEqual(3);
    for (const url of assets) {
      expect(url, url).toMatch(HASHED);
      const response = await get(t, url);
      expect(response.status, url).toBe(200);
      expect(response.headers.get('cache-control'), url).toBe(IMMUTABLE_CACHE);
      expect(response.headers.get('cross-origin-resource-policy'), url).toBe('same-origin');
    }
  });

  it('不带哈希或哈希过期：返回当前内容但要求重新验证；不合规的名字 404', async () => {
    const plain = await get(t, '/static/app.css');
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe(REVALIDATE_CACHE);
    const stale = await get(t, '/static/app.0000000000.css');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('cache-control')).toBe(REVALIDATE_CACHE);
    expect(await stale.text()).toBe(await plain.text());
    for (const path of ['/static/app.ZZZZZZZZZZ.css', '/static/app.123.css', '/static/missing.0123456789.css', '/static/..%2Fapp.css', '/static/app.css.map']) {
      expect((await get(t, path)).status, path).toBe(404);
    }
  });

  it('CSS 里引用的字体改写成带哈希的地址，也能长期缓存', async () => {
    const page = await get(t, '/login');
    const appCss = linkedAssets(await page.text()).find((url) => url.startsWith('/static/app.'))!;
    const css = await (await get(t, appCss)).text();
    const fonts = [...css.matchAll(/url\('([^']+\.woff2)'\)/g)].map((m) => m[1]!);
    expect(fonts).toHaveLength(4);
    for (const font of fonts) {
      expect(font).toMatch(/^font-[a-z0-9-]+\.[0-9a-f]{10}\.woff2$/);
      const response = await get(t, `/static/${font}`);
      expect(response.status, font).toBe(200);
      expect(response.headers.get('content-type')).toBe('font/woff2');
      expect(response.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
    }
  });

  it('内容变了哈希就变；样式表引用的文件变了，样式表的哈希也变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-static-'));
    try {
      writeFileSync(join(dir, 'a.css'), "body { background: url('dot.svg'); }");
      writeFileSync(join(dir, 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      const assets = createStaticAssets(dir);
      const first = assets.url('a.css');
      expect(first).toMatch(HASHED);
      expect(new TextDecoder().decode(assets.load('a.css')!.body)).toMatch(/url\('dot\.[0-9a-f]{10}\.svg'\)/);
      expect(assets.url('a.css')).toBe(first);
      writeFileSync(join(dir, 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2"/>');
      utimesSync(join(dir, 'dot.svg'), new Date(), new Date(Date.now() + 5000));
      const second = assets.url('a.css');
      expect(second).not.toBe(first);
      writeFileSync(join(dir, 'a.css'), "body { color: red; background: url('dot.svg'); }");
      utimesSync(join(dir, 'a.css'), new Date(), new Date(Date.now() + 10000));
      expect(assets.url('a.css')).not.toBe(second);
      expect(assets.url('missing.css')).toBe('/static/missing.css');
      expect(assets.load('../a.css')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('按页加载样式包', () => {
  it('每页只加载基础样式和自己的功能包', () => {
    expect(stylesheetsFor('/', 'page--landing')).toEqual(['app.css', 'landing.css']);
    expect(stylesheetsFor('/', 'page--home')).toEqual(['app.css', 'home.css']);
    expect(styleBundlesFor('/login')).toEqual(['auth']);
    expect(styleBundlesFor('/welcome')).toEqual(['auth']);
    expect(styleBundlesFor('/join/inv_abc')).toEqual(['auth']);
    expect(styleBundlesFor('/w/wal_1')).toEqual(['wall', 'tools']);
    expect(styleBundlesFor('/w/wal_1/p/pag_1')).toEqual(['wall', 'tools']);
    expect(styleBundlesFor('/w/wal_1/admin')).toEqual(['admin', 'tools']);
    expect(styleBundlesFor('/walls/new')).toEqual(['admin', 'tools']);
    expect(styleBundlesFor('/w/wal_1/me')).toEqual(['workspace']);
    expect(styleBundlesFor('/w/wal_1/me/jobs/gen_1')).toEqual(['workspace']);
    expect(styleBundlesFor('/s/tok')).toEqual(['workspace']);
    expect(styleBundlesFor('/messages/cnv_1')).toEqual(['messages']);
    expect(styleBundlesFor('/account/credits')).toEqual(['account']);
    expect(styleBundlesFor('/terms')).toEqual([]);
    expect(stylesheetsFor('/w/wal_1', undefined, [])).toEqual(['app.css']);
  });

  it('真实页面：墙页面不加载工作区、后台、消息的样式；404 只加载基础样式', async () => {
    const t = createTestWeb();
    try {
      const me = await login(t, 'bundles@example.com', '小包');
      const { wall } = seedWall(t, me.userId, '样式包测试墙');
      const names = async (path: string) => linkedAssets(await (await get(t, path, { cookie: me.cookie })).text()).filter((url) => url.endsWith('.css')).map((url) => HASHED.exec(url)?.[1]);
      expect(await names(`/w/${wall.id}`)).toEqual(['app', 'wall', 'tools']);
      expect(await names(`/w/${wall.id}/me`)).toEqual(['app', 'workspace']);
      expect(await names('/account/data')).toEqual(['app', 'account']);
      expect(await names('/')).toEqual(['app', 'home']);
      expect(await names(`/w/${wall.id}/nope`)).toEqual(['app']);
    } finally {
      await t.close();
    }
  });
});
