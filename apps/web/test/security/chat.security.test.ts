import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWeb, elements, get, login, postForm, seedMember, seedWall, type TestSession, type TestWeb } from '../helpers.js';
import { openDirect, sendMessage } from '../../src/services/chat.js';

describe('聊天访问边界', () => {
  let t: TestWeb;
  let owner: TestSession;
  let a: TestSession;
  let b: TestSession;
  let outsider: TestSession;
  let wallId: string;
  let direct: string;
  let group: string;
  let membershipId: string;
  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '组织者');
    a = await login(t, 'a@example.com', '甲');
    b = await login(t, 'b@example.com', '乙');
    outsider = await login(t, 'outsider@example.com', '外人');
    const { wall } = seedWall(t, owner.userId);
    wallId = wall.id;
    membershipId = seedMember(t, wall, a.userId).membership.id;
    seedMember(t, wall, b.userId);
    direct = openDirect(t.web.deps, a.userId, wallId, b.userId)!;
    group = t.repos.chat.ensureGroup(wallId, wall.createdAt);
    sendMessage(t.web.deps, b.userId, direct, randomUUID(), '只有甲乙能看到');
    sendMessage(t.web.deps, b.userId, group, randomUUID(), '墙内群消息');
  });
  afterEach(async () => { await t.close(); });
  const post = (who: TestSession, path: string, fields: Record<string, string> = {}) => postForm(t, path, { _csrf: who.csrf, ...fields }, { cookie: who.cookie, headers: { accept: 'application/json' } });

  async function denied(who: TestSession, ids: string[]) {
    for (const id of ids) {
      for (const path of [`/messages/${id}`, `/messages/${id}/items`, `/messages/${id}/items?after=0`, `/messages/${id}/items?before=999`]) {
        const response = await get(t, path, { cookie: who.cookie });
        expect(response.status, path).toBe(404);
        expect(await response.text()).not.toContain('只有甲乙能看到');
      }
      expect((await post(who, `/messages/${id}/send`, { text: '越权发送', clientId: randomUUID() })).status).toBe(404);
      expect((await post(who, `/messages/${id}/read`, { sequence: '1' })).status).toBe(404);
    }
  }

  it('非成员不能读写群或私聊，不能跨墙发起私聊或冒用会话', async () => {
    await denied(outsider, [group, direct]);
    expect((await post(outsider, '/messages/direct', { wallId, userId: a.userId })).status).toBe(404);
    expect((await post(a, '/messages/direct', { wallId, userId: outsider.userId })).status).toBe(404);
    const { wall } = seedWall(t, outsider.userId);
    expect((await post(a, '/messages/direct', { wallId: wall.id, userId: outsider.userId })).status).toBe(404);
    expect(await (await get(t, '/messages/list', { cookie: outsider.cookie })).text()).not.toContain(direct);
  });

  it('组织者可参与全员群，但不能读取、发送、标记他人私聊', async () => {
    await denied(owner, [direct]);
    expect((await get(t, `/messages/${group}/items`, { cookie: owner.cookie })).status).toBe(200);
    expect((await post(owner, `/messages/${group}/send`, { text: '组织者群消息', clientId: randomUUID() })).status).toBe(200);
    const data = await (await get(t, '/messages/list', { cookie: owner.cookie })).text();
    expect(data).not.toContain(direct);
    expect(data).not.toContain('只有甲乙能看到');
  });

  it.each(['left', 'removed', 'closed'] as const)('%s 后已有会话、历史、增量、未读与发送立即失效', async (state) => {
    if (state === 'closed') t.repos.walls.close(wallId, t.clock.now().toISOString());
    else if (state === 'left') t.repos.memberships.markLeft(membershipId, t.clock.now().toISOString());
    else t.repos.memberships.markRemoved(membershipId, t.clock.now().toISOString());
    await denied(a, [group, direct]);
    expect((await get(t, `/messages/wall/${wallId}`, { cookie: a.cookie })).status).toBe(404);
    expect(await (await get(t, '/messages/list', { cookie: a.cookie })).json()).toEqual({ conversations: [], hasMore: false });
    expect(await (await get(t, '/messages/unread', { cookie: a.cookie })).json()).toEqual({ unread: 0 });
    expect((await post(a, '/messages/direct', { wallId, userId: b.userId })).status).toBe(404);
    if (state === 'closed') await denied(owner, [group]);
  });

  it('新成员自动获得唯一群的访问权限，退出者不会留在群成员列表', async () => {
    const wall = t.repos.walls.findById(wallId)!;
    seedMember(t, wall, outsider.userId);
    expect((await get(t, `/messages/${group}/items`, { cookie: outsider.cookie })).status).toBe(200);
    expect(t.repos.chat.members(wallId).map((m) => m.userId)).toContain(outsider.userId);
    t.repos.memberships.markLeft(membershipId, t.clock.now().toISOString());
    expect(t.repos.chat.members(wallId).map((m) => m.userId)).not.toContain(a.userId);
  });

  it('没有登录时数据接口返回 401；Bearer 不能替代 cookie；所有写操作校验来源与 CSRF', async () => {
    for (const path of ['/messages/list', '/messages/unread', `/messages/${direct}/items`]) {
      expect((await get(t, path)).status).toBe(401);
      expect((await get(t, path, { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(401);
    }
    for (const [path, fields] of [
      ['/messages/direct', { wallId, userId: b.userId }],
      [`/messages/${direct}/send`, { text: '伪造', clientId: randomUUID() }],
      [`/messages/${direct}/read`, { sequence: '1' }],
    ] as [string, Record<string, string>][]) {
      expect((await postForm(t, path, { ...fields, _csrf: a.csrf })).status).toBe(401);
      for (const origin of [null, t.config.pagesOrigin, 'https://evil.example']) {
        expect((await postForm(t, path, { ...fields, _csrf: a.csrf }, { cookie: a.cookie, origin })).status).toBe(403);
      }
      expect((await postForm(t, path, { ...fields, _csrf: 'wrong' }, { cookie: a.cookie })).status).toBe(403);
    }
  });

  it('聊天页面没有内联脚本、内联样式或事件属性；所有聊天数据禁止缓存', async () => {
    for (const path of ['/messages', `/messages/${direct}`, `/messages/${group}`, `/messages/${direct}/items`, '/messages/list', '/messages/unread']) {
      const response = await get(t, path, { cookie: a.cookie });
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (response.headers.get('content-type')?.includes('text/html')) {
        for (const el of elements(await response.text())) {
          expect(el.attrs).not.toHaveProperty('style');
          expect(Object.keys(el.attrs).filter((name) => /^on/i.test(name))).toEqual([]);
          if (el.tag === 'script') expect(el.attrs.src).toMatch(/^\/static\//);
        }
      }
    }
  });
});
