import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo, type DemoSeed } from '../../scripts/demo-seed.js';
import { seedDemoPersonalData } from '../../scripts/demo-persona.js';
import { DEMO_EXTRA_WALLS } from '../../scripts/demo-content.js';
import { createSession } from '../../src/services/auth.js';
import { agentGet, connectAgent, createTestWeb, createUser, postForm, type TestWeb } from '../helpers.js';

describe('演示人设的私有资料隔离', () => {
  let t: TestWeb;
  let seed: DemoSeed;
  beforeAll(async () => {
    // 使用普通会话，让背景成员也能登录，实际检验资料权限而非演示登录白名单。
    t = createTestWeb();
    seed = await seedDemo(t.web);
    // 测试专用的已确认采访资料；正式 Demo 的体验成员工作区仍保持空白。
    t.repos.profileEntries.deleteAllForUser(seed.tester.userId);
    seedDemoPersonalData(t.web.deps, seed.tester.userId, [{ wall: seed.extraWalls[0]!.wall,
      pageId: seed.extraWalls[0]!.members[0]!.pageId, profile: DEMO_EXTRA_WALLS[0]!.profiles[0]! }]);
  });
  afterAll(async () => { await t.close(); });

  it('组织者、其他成员、非成员不能读取或删除体验成员的画像和 brief', async () => {
    const entries = t.repos.profileEntries.listForUser(seed.tester.userId);
    const briefs = t.repos.briefs.listForOwner(seed.tester.userId);
    const privateText = entries.find((entry) => entry.category === 'boundary')!.text;
    const wall = seed.extraWalls[0]!;
    for (const userId of [seed.organizer.userId, wall.members[1]!.userId, createUser(t, 'outsider@example.com')]) {
      const { token, csrfToken } = createSession(t.web.deps, userId);
      const cookie = `nowme_session=${token}`;
      const dataResponse = await t.request('/account/data', { headers: { cookie } });
      expect(dataResponse.status).toBe(200);
      const data = await dataResponse.text();
      expect(data).not.toContain(privateText);
      for (const brief of briefs) expect(data).not.toContain(brief.id);
      const detail = await t.request(`/w/${wall.wall.id}/me/brief`, { headers: { cookie } });
      expect(detail.status).toBe(404);
      const fields = { _csrf: csrfToken };
      expect((await postForm(t, '/account/profile/delete', { ...fields, entryId: entries[0]!.id }, { cookie })).status).toBe(404);
      expect((await postForm(t, '/account/briefs/delete', { ...fields, briefId: briefs[0]!.id }, { cookie })).status).toBe(404);
      const publicPage = await (await t.request(`/w/${wall.wall.id}/p/${wall.members[0]!.pageId}`, { headers: { cookie } })).text();
      expect(publicPage).not.toContain(privateText);
      for (const brief of briefs) expect(publicPage).not.toContain(brief.id);
    }
    expect(t.repos.profileEntries.listForUser(seed.tester.userId)).toEqual(entries);
    expect(t.repos.briefs.listForOwner(seed.tester.userId)).toEqual(briefs);
  });

  it('页面凭证拉取情境不包含画像与 brief，不能删除资料', async () => {
    const wall = seed.extraWalls[0]!.wall;
    const page = t.repos.pages.findById(seed.extraWalls[0]!.members[0]!.pageId)!;
    const credential = await connectAgent(t, wall, page);
    const profile = t.repos.profileEntries.listForUser(seed.tester.userId);
    const briefs = t.repos.briefs.listForOwner(seed.tester.userId);
    const context = await (await agentGet(t, '/api/agent/context', credential)).text();
    for (const entry of profile) expect(context).not.toContain(entry.text);
    for (const brief of briefs) expect(context).not.toContain(brief.id);
    const headers = { authorization: `Bearer ${credential}` };
    expect((await postForm(t, '/account/profile/delete', { all: '1' }, { headers })).status).toBe(401);
    expect((await postForm(t, '/account/briefs/delete', { briefId: briefs[0]!.id }, { headers })).status).toBe(401);
  });

  it('普通用户不会在访问我的资料时自动获得演示画像和 brief', async () => {
    const normal = createTestWeb();
    try {
      const userId = createUser(normal, 'normal@example.com');
      const { token } = createSession(normal.web.deps, userId);
      const response = await normal.request('/account/data', { headers: { cookie: `nowme_session=${token}` } });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('江予安');
      expect(normal.repos.profileEntries.listForUser(userId)).toEqual([]);
      expect(normal.repos.briefs.listForOwner(userId)).toEqual([]);
    } finally { await normal.close(); }
  });
});
