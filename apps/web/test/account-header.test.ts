import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, DEMO_WALL_NAME } from '../src/demo-access.js';
import { createTestWeb, createUser, get, login, postForm, seedMember, seedWall, sessionTokenFrom, type TestWeb } from './helpers.js';

let t: TestWeb;
afterEach(async () => { await t?.close(); });

describe.each([false, true])('账号顶栏（演示模式：%s）', (demo) => {
  it('模型与切换身份页复用主页导航和账号菜单，菜单不重复“我的资料”', async () => {
    t = createTestWeb({ demo });
    let cookie: string;
    if (demo) {
      const memberId = createUser(t, DEMO_ACCOUNTS[0].email, '体验成员');
      const organizerId = createUser(t, DEMO_ACCOUNTS[1].email, '体验组织者');
      const { wall } = seedWall(t, organizerId, DEMO_WALL_NAME);
      seedMember(t, wall, memberId);
      const response = await postForm(t, '/login/demo', { identity: 'member' });
      expect(response.status).toBe(303);
      cookie = `nowme_session=${sessionTokenFrom(response)}`;
    } else {
      cookie = (await login(t, 'header@example.com', '小江')).cookie;
    }

    const headers: string[] = [];
    for (const path of ['/', '/account/ai', '/messages', '/account/data', ...(demo ? ['/login'] : [])]) {
      const response = await get(t, path, { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] ?? '';
      expect(header).toContain('class="site-header home-header"');
      expect(html).toContain('href="/static/home.css"');
      expect(html).toContain('src="/static/home.js" defer');
      expect(header).toContain('href="/account/data"');
      const menu = header.split('<div class="home-account__menu">')[1] ?? '';
      expect(menu).toContain(demo ? '演示模型' : 'AI 设置');
      expect(menu).toContain('action="/logout"');
      expect(menu).not.toContain('我的资料');
      expect(menu).not.toContain('href="/account/data"');
      if (demo) expect(menu).toContain('切换身份');
      if (path === '/account/ai' || path === '/login') expect(header).not.toContain('aria-current="page"');
      if (path === '/login') {
        expect(html).toContain('以成员身份体验');
        expect(html).toContain('以组织者身份体验');
      }
      headers.push(header.replaceAll(' home-nav__active', '').replaceAll(' aria-current="page"', ''));
    }
    expect(new Set(headers).size).toBe(1);
    if (demo) {
      const failed = await postForm(t, '/login/demo', { identity: 'invalid' }, { cookie });
      expect(failed.status).toBe(400);
      const html = await failed.text();
      expect(html).toContain('class="site-header home-header"');
      expect(html).toContain('体验登录失败');
      const anonymous = await (await get(t, '/login')).text();
      expect(anonymous).not.toContain('class="home-nav"');
      expect(anonymous).not.toContain('class="home-account"');
    }
  });
});
