import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWeb, elements, get, latestCode, login, postForm, seedMember, seedWall, type TestWeb } from './helpers.js';
import { publishedMember, publishPage, withdraw } from './wall-helpers.js';

function group(html: string, status: 'pending' | 'published'): string {
  return html.split(`class="home-group home-group--${status}"`)[1]?.split('</section>')[0] ?? '';
}

describe('首页创作工作台（登录后）', () => {
  let t: TestWeb;
  beforeEach(() => { t = createTestWeb(); });
  afterEach(async () => { await t.close(); });

  it('按真实发布状态分组，撤下归入待完成，历史墙不计入统计且不提供访问入口', async () => {
    const me = await login(t, 'me@example.com', '江予安');
    const owner = await login(t, 'owner@example.com');
    const { wall: pending } = seedWall(t, me.userId, '待创作的墙');
    const { wall: live } = seedWall(t, owner.userId, '已经发布的墙');
    const published = publishedMember(t, live, { userId: me.userId, name: '江予安' });
    const { wall: withdrawn } = seedWall(t, owner.userId, '已经撤下的墙');
    withdraw(t, publishedMember(t, withdrawn, { userId: me.userId, name: '江予安' }).page);
    const { wall: closed } = seedWall(t, owner.userId, '已经关闭的墙');
    seedMember(t, closed, me.userId);
    t.repos.walls.close(closed.id, t.clock.now().toISOString());
    const html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(html).toContain('你好，江予安！');
    expect(html).toContain('你还有 2 个页面未发布');
    expect(html).toContain('aria-label="3 面墙"');
    expect(group(html, 'pending')).toContain(pending.name);
    expect(group(html, 'pending')).toContain(withdrawn.name);
    expect(group(html, 'pending')).toContain('我的页面：已撤下');
    expect(group(html, 'pending')).not.toContain(live.name);
    expect(group(html, 'published')).toContain(live.name);
    expect(group(html, 'published')).toContain(`href="/w/${live.id}/p/${published.page.id}"`);
    expect(html).not.toContain(`href="/w/${closed.id}`);
    const links = elements(html).filter((el) => el.tag === 'a').map((el) => el.attrs.href);
    expect(links).toContain(`/w/${pending.id}/me`);
    expect(links).toContain(`/w/${pending.id}/admin`);
    expect(links).not.toContain(`/w/${live.id}/admin`);
    expect(elements(html).some((el) => 'style' in el.attrs || Object.keys(el.attrs).some((name) => name.startsWith('on')))).toBe(false);
  });

  it('筛选只改变可见分组，统计仍为所有有效墙；未知筛选回到全部', async () => {
    const me = await login(t, 'filter@example.com');
    seedWall(t, me.userId, '未完成墙');
    const live = seedWall(t, me.userId, '已发布墙');
    publishPage(t, live, '测试用户');
    for (const filter of ['pending', 'published']) {
      const html = await (await get(t, `/?filter=${filter}`, { cookie: me.cookie })).text();
      expect(group(html, filter as 'pending' | 'published')).not.toBe('');
      expect(group(html, filter === 'pending' ? 'published' : 'pending')).toBe('');
      expect(html).toContain('aria-label="2 面墙"');
      expect(elements(html).find((el) => el.attrs.class?.includes('home-filter is-active'))?.attrs.href).toBe(`/?filter=${filter}`);
    }
    const html = await (await get(t, '/?filter=unknown', { cookie: me.cookie })).text();
    expect(group(html, 'pending')).not.toBe('');
    expect(group(html, 'published')).not.toBe('');
  });

  it('零面墙、只有待完成、全部发布时都有可用入口与准确的空状态', async () => {
    const me = await login(t, 'empty@example.com');
    let html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(html).toContain('还没有加入任何墙');
    expect(html).toContain('从一面墙，开启新的相遇');
    const created = seedWall(t, me.userId);
    html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(group(html, 'published')).toContain('让你的第一张页面上墙');
    publishPage(t, created, '测试用户');
    html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(html).toContain('你的页面，都已闪亮上墙');
    expect(group(html, 'pending')).toContain('每一页，都已被看见');
    expect(html).not.toContain('你还有 0 个页面未发布');
  });
});

describe('未登录的正式首页', () => {
  let t: TestWeb;
  afterEach(async () => { await t.close(); });

  it('先讲给组织者，再告诉被邀请的成员怎么开始；有登录与建墙入口，不出现演示内容', async () => {
    t = createTestWeb();
    const response = await get(t, '/');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>给你的圈子建一面墙 · NOWMe</title>');
    expect(html).toContain('class="site page--landing"');
    expect(html).toMatch(/href="\/static\/landing\.[0-9a-f]{10}\.css"/);
    const organizer = html.indexOf('组织者只要做三件事');
    const invited = html.indexOf('收到邀请了？');
    expect(organizer).toBeGreaterThan(0);
    expect(invited).toBeGreaterThan(organizer);
    for (const promise of ['只有圈子里的人看得到', '你点发布，才会上墙', '它不会替你发消息', '组织者看不到你的草稿']) expect(html).toContain(promise);
    const links = elements(html).filter((el) => el.tag === 'a').map((el) => el.attrs.href);
    expect(links).toContain('/login?next=%2Fwalls%2Fnew');
    expect(links).toContain('/login');
    expect(links).toContain('#invited');
    expect(html).toContain('id="invited"');
    expect(html).not.toMatch(/评审|评委|演示|黑客松体验|华硕|Create Lab/);
    expect(html).not.toContain('action="/login/demo"');
    // 访客不加载登录后的脚本；主站 CSP 不允许内联样式与事件属性
    expect(html).not.toMatch(/\/static\/home\./);
    expect(html).not.toMatch(/\/static\/messages\./);
    expect(elements(html).some((el) => 'style' in el.attrs || Object.keys(el.attrs).some((name) => name.startsWith('on')))).toBe(false);
  });

  it('失效的会话 cookie 在首页只看到正式首页，不泄露任何工作台内容', async () => {
    t = createTestWeb();
    const me = await login(t, 'gone@example.com', '江予安');
    seedWall(t, me.userId, '我的秘密墙');
    await postForm(t, '/logout', { _csrf: me.csrf }, { cookie: me.cookie });
    const html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(html).toContain('收到邀请了？');
    expect(html).not.toContain('江予安');
    expect(html).not.toContain('我的秘密墙');
  });

  it('登录后还没填昵称：首页继续引导完成注册，而不是显示正式首页', async () => {
    t = createTestWeb();
    await postForm(t, '/login', { email: 'new@example.com' });
    const verified = await postForm(t, '/login/verify', { email: 'new@example.com', code: latestCode(t, 'new@example.com') });
    const cookie = verified.headers.getSetCookie()[0]!.split(';')[0]!;
    const response = await get(t, '/', { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/welcome');
  });

  it('演示模式复用正式首页，只把登录按钮换成体验入口', async () => {
    t = createTestWeb({ demo: true });
    const response = await get(t, '/');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>给你的圈子建一面墙 · NOWMe</title>');
    expect(html).toContain('class="site page--landing"');
    expect(html).toContain('组织者只要做三件事');
    expect(html).toContain('收到邀请了？');
    expect(html).toMatch(/href="\/static\/landing\.[0-9a-f]{10}\.css"/);
    expect(html).toContain('site-header__login" href="/login">体验</a>');
    expect(html.match(/>体验<\/a>/g)).toHaveLength(2);
    expect(html).not.toContain('action="/login/demo"');
    expect(html).not.toContain('以成员身份体验');
  });
});
