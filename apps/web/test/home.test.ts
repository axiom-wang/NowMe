import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWeb, elements, get, login, seedMember, seedWall, type TestWeb } from './helpers.js';
import { publishedMember, publishPage, withdraw } from './wall-helpers.js';

function group(html: string, status: 'pending' | 'published'): string {
  return html.split(`class="home-group home-group--${status}"`)[1]?.split('</section>')[0] ?? '';
}

describe('首页创作工作台', () => {
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
