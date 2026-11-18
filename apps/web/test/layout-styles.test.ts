/**
 * 页面样式归属（views/layout.tsx 的 `styleBundlesFor`）：枚举主站所有 GET 路由，
 * 每条要么登记了它该加载的样式包（或明确只用 app.css），要么明确标注“不是页面”（JSON / 文件 / 图片 / 健康检查）。
 * 新增 GET 路由而没有在这里登记，测试会失败——避免新路径前缀悄悄只加载 app.css 而丢了页面样式。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STYLE_BUNDLES, styleBundlesFor, stylesheetsFor, type StyleBundle } from '../src/views/layout.js';
import { createTestWeb, type TestWeb } from './helpers.js';

/** 页面路由 → 期望加载的功能包（`[]` 表示只用 app.css）。键是 Hono 的路由模式。 */
const PAGE_STYLES: Record<string, StyleBundle[]> = {
  '/login': ['auth'],
  '/welcome': ['auth'],
  '/consent': ['auth'],
  '/dev/outbox': ['auth'],
  '/join/:inviteCode': ['auth'],
  '/terms': [], // 协议与隐私：app.css 里的 .legal
  '/privacy': [],
  '/skill': [], // 安装页：app.css 里的 .skill-page
  '/walls/new': ['admin', 'tools'],
  '/w/:wallId/admin': ['admin', 'tools'],
  '/w/:wallId/questions': ['admin', 'tools'],
  '/w/:wallId': ['wall', 'tools'],
  '/w/:wallId/p/:pageId': ['wall', 'tools'],
  '/w/:wallId/me': ['workspace'],
  '/w/:wallId/me/delete': ['workspace'],
  '/w/:wallId/leave': ['workspace'],
  '/w/:wallId/me/text': ['workspace'],
  '/w/:wallId/me/create': ['workspace'],
  '/w/:wallId/me/jobs/:jobId': ['workspace'],
  '/w/:wallId/me/brief': ['workspace'],
  '/s/:publicToken': ['workspace'],
  '/messages': ['messages'],
  '/messages/wall/:wallId': ['messages'],
  '/messages/:id': ['messages'],
  '/account/data': ['account'],
  '/account/ai': ['account'],
  '/account/credits': ['account'],
  '/account/delete': ['account'],
};

/** 不是页面（返回 JSON、文件、图片、纯文本或重定向），不加载样式。 */
const NOT_PAGES = new Set([
  '/healthz',
  '/readyz',
  '/static/:name',
  '/api/agent/context',
  '/skill/install.md',
  '/skill/manifest.json',
  '/skill/:file',
  '/messages/list',
  '/messages/unread',
  '/messages/:id/items',
  '/w/:wallId/me/create/assets/:assetId',
  '/w/:wallId/me/jobs/:jobId/status',
  '/w/:wallId/me/jobs/:jobId/progress',
  '/w/:wallId/p/:pageId/stage',
  '/account/avatar',
  '/account/export',
  '/hosted/examples/:file',
  '/w/:wallId/members/:userId/avatar',
  '/w/:wallId/covers/:file',
  '/w/:wallId/admin/members.csv',
  '/w/:wallId/cover',
]);

/** 首页按登录状态换布局（由 bodyClass 决定），单独登记。 */
const HOME_ROUTE = '/';

describe('页面样式归属', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  function getRoutes(): string[] {
    return [...new Set(t.web.app.routes.filter((route) => route.method === 'GET').map((route) => route.path))];
  }

  it('每条 GET 路由都登记过：要么是页面（写明样式包），要么明确不是页面', () => {
    const unregistered = getRoutes().filter((path) => path !== HOME_ROUTE && !(path in PAGE_STYLES) && !NOT_PAGES.has(path));
    expect(unregistered, '新增的 GET 路由请在 layout-styles.test.ts 里登记它的样式包（或标注不是页面）').toEqual([]);
  });

  it('登记表里没有已经不存在的路由', () => {
    const routes = new Set(getRoutes());
    const stale = [...Object.keys(PAGE_STYLES), ...NOT_PAGES, HOME_ROUTE].filter((path) => !routes.has(path));
    expect(stale).toEqual([]);
  });

  it('每条页面路由都映射到期望的样式包，并且样式文件存在', () => {
    for (const [pattern, expected] of Object.entries(PAGE_STYLES)) {
      const sample = pattern.replace(/:[A-Za-z]+/g, 'x1');
      expect(styleBundlesFor(sample), pattern).toEqual(expected);
      expect(stylesheetsFor(sample), pattern).toEqual(['app.css', ...expected.map((bundle) => STYLE_BUNDLES[bundle])]);
    }
  });

  it('首页：访客是 landing，登录后是 home', () => {
    expect(styleBundlesFor('/', 'page--landing')).toEqual(['landing']);
    expect(styleBundlesFor('/', 'page--home')).toEqual(['home']);
  });

  it('未登记的新路径前缀只加载 app.css（所以新页面必须先登记）', () => {
    expect(styleBundlesFor('/brand-new/page')).toEqual([]);
  });
});
