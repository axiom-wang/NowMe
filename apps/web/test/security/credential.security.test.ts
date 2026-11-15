/**
 * S4：页面凭证不能发布。凭证调用发布、恢复、撤下、公开链接、删除、组织者操作等任何主站路由都无效且不改变状态；
 * 凭证不能当会话用；主站表单路由忽略 Authorization 头；会话 + 正确 CSRF 但 Origin 错误时拒绝。
 *
 * 路由清单覆盖 contracts 4.2 中全部改变状态的 POST，包括 M3 才实现的路由（现在应为 404；实现之后仍必须拒绝）。
 * 每个用例都在请求前后对整个数据库做快照比较。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME, type RevisionResponse } from '@nowme/contracts';
import {
  agentGet,
  connectAgent,
  createTestWeb,
  dumpDb,
  exampleFiles,
  get,
  login,
  postForm,
  postJson,
  seedMember,
  seedWall,
  type TestSession,
  type TestWeb,
} from '../helpers.js';
import type { Wall } from '../../src/db/walls.js';
import type { Page } from '../../src/db/pages.js';

interface Scenario {
  owner: TestSession;
  member: TestSession;
  wall: Wall;
  page: Page;
  memberPage: Page;
  credential: string;
  revisionId: string;
}

/** contracts 4.2 中全部改变状态的主站路由（含 M3 的路由）及合理的表单字段。 */
function stateChangingRoutes(s: Scenario): { path: string; fields: Record<string, string> }[] {
  const w = s.wall.id;
  return [
    { path: '/logout', fields: {} },
    { path: '/welcome', fields: { nickname: '攻击者' } },
    { path: `/w/${w}/me/instruction`, fields: {} },
    { path: `/w/${w}/me/disconnect`, fields: {} },
    // M3（T3.1 / T3.2）
    { path: '/walls', fields: { name: '凭证建的墙', description: '', sceneType: 'hackathon' } },
    { path: `/join/${s.wall.inviteCode}`, fields: {} },
    { path: `/w/${w}/p/${s.memberPage.id}/chat`, fields: { hookId: 'find-designer' } },
    {
      path: `/w/${w}/me/publish`,
      fields: {
        revisionId: s.revisionId,
        tagline: '凭证发布的介绍',
        'hooks[0][text]': '接话点一',
        'hooks[0][opener]': '你好',
        'hooks[1][text]': '接话点二',
        'hooks[1][opener]': '你好',
        contactChannel: 'wechat',
        contactValue: 'attacker',
        contactPublic: '1',
        confirm: '1',
      },
    },
    { path: `/w/${w}/me/withdraw`, fields: {} },
    { path: `/w/${w}/me/public-link`, fields: { enabled: '1' } },
    { path: `/w/${w}/me/delete`, fields: { confirm: '1' } },
    { path: `/w/${w}/leave`, fields: {} },
    { path: `/w/${w}/admin/remove`, fields: { membershipId: 'x', userId: s.member.userId } },
    { path: `/w/${w}/admin/close`, fields: { confirm: '1' } },
  ];
}

const REJECTED = [401, 403, 404];
/** stateChangingRoutes 中 T2.1 已实现的路由个数（排在最前面）。 */
const IMPLEMENTED_ROUTE_COUNT = 4;

describe('S4 页面凭证不能当会话、不能发布', () => {
  let t: TestWeb;
  let s: Scenario;

  beforeEach(async () => {
    t = createTestWeb();
    const owner = await login(t, 'owner@example.com', '林舟');
    const member = await login(t, 'member@example.com', '小白');
    const { wall, page } = seedWall(t, owner.userId);
    const { page: memberPage } = seedMember(t, wall, member.userId);
    const credential = await connectAgent(t, wall, page);
    const submitted = await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    expect(submitted.status).toBe(201);
    const { revision } = (await submitted.json()) as RevisionResponse;
    s = { owner, member, wall, page, memberPage, credential, revisionId: revision.id };
  });
  afterEach(async () => {
    await t.close();
  });

  it('用 Authorization: Bearer <凭证>（无会话）逐个调用所有改变状态的主站路由：全部拒绝，数据库无变化', async () => {
    for (const { path, fields } of stateChangingRoutes(s)) {
      for (const origin of [t.config.webOrigin, null]) {
        const before = dumpDb(t.db);
        const response = await postForm(t, path, { _csrf: 'guess', ...fields }, { origin, headers: { authorization: `Bearer ${s.credential}` } });
        expect(REJECTED, `${path}（Origin ${origin ?? '无'}）→ ${response.status}`).toContain(response.status);
        expect(dumpDb(t.db), path).toEqual(before);
      }
      // JSON 请求体同样无效
      const before = dumpDb(t.db);
      const json = await t.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json', origin: t.config.webOrigin },
        body: JSON.stringify(fields),
      });
      expect(REJECTED, `${path}（JSON）→ ${json.status}`).toContain(json.status);
      expect(dumpDb(t.db), path).toEqual(before);
    }
    // 凭证本身仍然只是凭证：Agent API 照常可用
    expect((await agentGet(t, '/api/agent/context', s.credential)).status).toBe(200);
  });

  it('凭证放进会话 cookie 也无效：页面要求登录，表单返回 401，数据库无变化', async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${s.credential}`;
    const workspace = await get(t, `/w/${s.wall.id}/me`, { cookie, headers: { authorization: `Bearer ${s.credential}` } });
    expect(workspace.status).toBe(303);
    expect(workspace.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/w/${s.wall.id}/me`)}`);
    const home = await get(t, '/messages', { cookie });
    expect(home.status).toBe(303);

    for (const { path, fields } of stateChangingRoutes(s)) {
      const before = dumpDb(t.db);
      const response = await postForm(t, path, { _csrf: 'guess', ...fields }, { cookie, headers: { authorization: `Bearer ${s.credential}` } });
      expect(REJECTED, `${path} → ${response.status}`).toContain(response.status);
      expect(dumpDb(t.db), path).toEqual(before);
    }
  });

  it('GET 页面只看会话：带凭证的 Authorization 头不会被当成登录', async () => {
    for (const path of ['/messages', `/w/${s.wall.id}/me`, `/w/${s.wall.id}/me?rev=${s.revisionId}`]) {
      const response = await get(t, path, { headers: { authorization: `Bearer ${s.credential}` } });
      expect(response.status, path).toBe(303);
      expect(response.headers.get('location'), path).toMatch(/^\/login/);
      expect(await response.text()).not.toContain('/v/');
    }
  });

  it('主站会话不能当 Agent 凭证用：Agent API 不读 cookie', async () => {
    const before = dumpDb(t.db);
    const context = await t.request('/api/agent/context', { headers: { cookie: s.owner.cookie } });
    expect(context.status).toBe(401);
    const revision = await t.request('/api/agent/revisions', {
      method: 'POST',
      headers: { cookie: s.owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ files: exampleFiles() }),
    });
    expect(revision.status).toBe(401);
    const sessionAsBearer = await agentGet(t, '/api/agent/context', s.owner.token);
    expect(sessionAsBearer.status).toBe(401);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('会话 + 正确 CSRF，但 Origin 错误、为 null、缺失（且无 Referer）、Referer 跨站：一律 403，数据库无变化', async () => {
    const bad: { origin: string | null; referer?: string }[] = [
      { origin: 'http://evil.example' },
      { origin: 'null' },
      { origin: t.config.pagesOrigin },
      { origin: 'http://localhost:3001' },
      { origin: null },
      { origin: null, referer: 'http://evil.example/w/x' },
      { origin: null, referer: `${t.config.pagesOrigin}/v/ticket/` },
    ];
    for (const [index, { path, fields }] of stateChangingRoutes(s).entries()) {
      // 已实现的路由（前 4 个）在来源检查处 403；M3 尚未实现的路由现在是 404，实现后必须是 403
      const expected = index < IMPLEMENTED_ROUTE_COUNT ? [403] : [403, 404];
      for (const variant of bad) {
        const before = dumpDb(t.db);
        const response = await postForm(t, path, { _csrf: s.owner.csrf, ...fields }, { cookie: s.owner.cookie, ...variant });
        expect(expected, `${path} ${JSON.stringify(variant)} → ${response.status}`).toContain(response.status);
        expect(dumpDb(t.db), path).toEqual(before);
      }
    }
  });

  it('会话 + 正确 Origin，但 CSRF 缺失或错误：403，数据库无变化', async () => {
    for (const { path, fields } of stateChangingRoutes(s).slice(0, IMPLEMENTED_ROUTE_COUNT)) {
      for (const csrf of [undefined, '', 'wrong', s.member.csrf]) {
        const before = dumpDb(t.db);
        const body = csrf === undefined ? fields : { _csrf: csrf, ...fields };
        const response = await postForm(t, path, body, { cookie: s.owner.cookie });
        expect(response.status, `${path} csrf=${String(csrf)}`).toBe(403);
        expect(dumpDb(t.db), path).toEqual(before);
      }
    }
  });

  it('正向对照：会话 + CSRF + 正确 Origin（或只有同源 Referer）时操作成功', async () => {
    const withOrigin = await postForm(t, `/w/${s.wall.id}/me/instruction`, { _csrf: s.owner.csrf }, { cookie: s.owner.cookie });
    expect(withOrigin.status).toBe(200);
    const withReferer = await postForm(
      t,
      `/w/${s.wall.id}/me/instruction`,
      { _csrf: s.owner.csrf },
      { cookie: s.owner.cookie, origin: null, referer: `${t.config.webOrigin}/w/${s.wall.id}/me` },
    );
    expect(withReferer.status).toBe(200);
  });

  it('凭证被断开后立即失效；断开只能由主人在应用内操作', async () => {
    const disconnected = await postForm(t, `/w/${s.wall.id}/me/disconnect`, { _csrf: s.owner.csrf }, { cookie: s.owner.cookie });
    expect(disconnected.status).toBe(303);
    expect(disconnected.headers.get('location')).toBe(`/w/${s.wall.id}/me?notice=disconnected`);
    const response = await agentGet(t, '/api/agent/context', s.credential);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('提交里夹带凭证：校验器拦截（CREDENTIAL_LEAK），不落盘，库里只有遮住的片段', async () => {
    const files = exampleFiles();
    const html = Buffer.from(files['index.html'] as string, 'base64').toString('utf8');
    files['index.html'] = Buffer.from(html.replace('</body>', `<!-- ${s.credential} --></body>`)).toString('base64');
    files[`notes-${s.credential}.txt`] = Buffer.from('x').toString('base64');
    const response = await postJson(t, '/api/agent/revisions', { files }, s.credential);
    expect(response.status).toBe(422);
    const { revision } = (await response.json()) as RevisionResponse;
    expect(revision.status).toBe('rejected');
    expect(revision.report.errors.map((issue) => issue.code)).toContain('CREDENTIAL_LEAK');
    expect(JSON.stringify(dumpDb(t.db))).not.toContain(s.credential);
    expect(JSON.stringify(revision)).not.toContain(s.credential);
  });
});
