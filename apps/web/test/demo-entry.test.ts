import { afterEach, describe, expect, it } from 'vitest';
import { createTestWeb, elements, get, login, type TestWeb } from './helpers.js';

const DEMO_URL = 'https://demo.example.com:8444';
const DEMO_HREF = 'https://demo.example.com:8444/';

let t: TestWeb;
afterEach(async () => { await t?.close(); });

function header(html: string): string {
  return html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] ?? '';
}

function demoLinks(html: string) {
  return elements(header(html)).filter((el) => el.tag === 'a' && el.attrs.href === DEMO_HREF);
}

describe('顶栏 Demo 入口（NOWME_DEMO_URL）', () => {
  it('未配置时任何页面都没有 Demo 入口', async () => {
    t = createTestWeb();
    const { cookie } = await login(t, 'plain@example.com', '小江');
    for (const [path, opts] of [['/', {}], ['/login', {}], ['/', { cookie }], ['/messages', { cookie }]] as const) {
      const html = await (await get(t, path, opts)).text();
      expect(header(html), path).not.toContain('Demo');
    }
  });

  it('访客在首页与登录页都能看到指向演示环境的外链，且排在登录按钮之前', async () => {
    t = createTestWeb({ env: { NOWME_DEMO_URL: DEMO_URL } });
    for (const path of ['/', '/login']) {
      const html = await (await get(t, path)).text();
      const links = demoLinks(html);
      expect(links, path).toHaveLength(1);
      expect(links[0]!.attrs.rel).toContain('noopener');
      expect(links[0]!.attrs.target).toBeUndefined();
    }
    const home = header(await (await get(t, '/')).text());
    expect(home.indexOf('site-header__demo')).toBeGreaterThan(0);
    expect(home.indexOf('site-header__demo')).toBeLessThan(home.indexOf('site-header__login'));
    const loginPage = header(await (await get(t, '/login')).text());
    expect(loginPage).not.toContain('site-header__login');
  });

  it('登录用户在主导航里有 Demo，账号菜单里另有窄屏用的入口，且不参与高亮', async () => {
    t = createTestWeb({ env: { NOWME_DEMO_URL: DEMO_URL } });
    const { cookie } = await login(t, 'member@example.com', '小江');
    for (const path of ['/', '/messages', '/account/data', '/missing-page']) {
      const html = await (await get(t, path, { cookie })).text();
      const head = header(html);
      expect(demoLinks(html), path).toHaveLength(2);
      const nav = head.split('<nav class="site-nav"')[1]?.split('</nav>')[0] ?? '';
      expect(nav).toContain(`href="${DEMO_HREF}"`);
      expect(nav).toContain('site-nav__demo');
      expect(nav).not.toMatch(/site-nav__demo[^>]*(is-active|aria-current)/);
      const menu = head.split('<div class="popover account-menu__panel">')[1] ?? '';
      expect(menu).toContain('account-menu__demo');
      expect(menu).not.toContain('action="' + DEMO_HREF);
    }
  });

  it('演示模式不显示 Demo 入口，演示环境首页保持原样', async () => {
    t = createTestWeb({ demo: true, env: { NOWME_DEMO_URL: DEMO_URL } });
    const html = await (await get(t, '/')).text();
    expect(header(html)).not.toContain('Demo');
    expect(header(html)).toContain('site-header__login" href="/login">体验</a>');
  });
});
