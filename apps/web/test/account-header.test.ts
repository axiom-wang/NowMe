import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, DEMO_WALL_NAME } from '../src/demo-access.js';
import { createTestWeb, createUser, get, login, postForm, seedMember, seedWall, sessionTokenFrom, type TestWeb } from './helpers.js';

let t: TestWeb;
afterEach(async () => { await t?.close(); });

describe.each([false, true])('账号顶栏（演示模式：%s）', (demo) => {
  it('所有页面共用账号菜单，演示模式隐藏模型入口，菜单不重复“我的资料”', async () => {
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
    const wall = seedWall(t, t.repos.users.findByEmail(demo ? DEMO_ACCOUNTS[0].email : 'header@example.com')!.id, '顶栏测试墙').wall;
    const group = await get(t, `/messages/wall/${wall.id}`, { cookie });
    const conversation = group.headers.get('location')!;
    for (const path of ['/', '/messages', '/account/data', '/walls/new', `/w/${wall.id}`, `/w/${wall.id}/me`, `/w/${wall.id}/admin`, conversation, '/missing-page', ...(demo ? ['/login'] : ['/account/ai'])]) {
      const response = await get(t, path, { cookie });
      expect(response.status).toBe(path === '/missing-page' ? 404 : 200);
      const html = await response.text();
      const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0] ?? '';
      expect(header).toContain('class="site-header"');
      expect(html).toMatch(/href="\/static\/app\.[0-9a-f]{10}\.css"/);
      expect(html).toMatch(/src="\/static\/app\.[0-9a-f]{10}\.js" defer/); // 账号菜单的 Esc / 点外面关闭在 app.js（details[data-dismissable]）
      expect(header).toContain('href="/account/data"');
      const menu = header.split('<div class="popover account-menu__panel">')[1] ?? '';
      if (demo) {
        expect(menu).not.toContain('演示模型');
        expect(menu).not.toContain('href="/account/ai"');
      } else {
        expect(menu).toContain('AI 设置');
      }
      expect(menu).toContain('action="/logout"');
      expect(menu).not.toContain('我的资料');
      expect(menu).not.toContain('href="/account/data"');
      if (demo) expect(menu).toContain('切换身份');
      if (path === '/account/ai' || path === '/login') expect(header).not.toContain('aria-current="page"');
      if (path === '/login') {
        expect(html).toContain('以成员身份体验');
        expect(html).toContain('以组织者身份体验');
      }
      headers.push(header.replaceAll(' is-active', '').replaceAll(' aria-current="page"', ''));
    }
    expect(new Set(headers).size).toBe(1);
    if (demo) {
      const failed = await postForm(t, '/login/demo', { identity: 'invalid' }, { cookie });
      expect(failed.status).toBe(400);
      const html = await failed.text();
      expect(html).toContain('class="site-header"');
      expect(html).toContain('体验登录失败');
      const anonymous = await (await get(t, '/login')).text();
      expect(anonymous).toContain('class="site-header"');
      expect(anonymous).not.toContain('class="site-nav"');
      expect(anonymous).not.toContain('class="account-menu"');
    }
  });
});
