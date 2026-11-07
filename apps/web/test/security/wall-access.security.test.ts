/**
 * S6（非成员看不到墙）与 S1（成员页的沙箱 iframe），以及 T3.1 新增 POST 路由的 S4 补充断言。
 *
 * S6：身份（未登录、非成员、已退出、已移除、其他墙的成员）× 路由（墙、成员页、封面、chat、后台与后台操作）一律拿不到内容：
 *     未登录 GET → /login?next=，POST → 401；其他身份 → 404（与不存在的墙完全一样），数据库无变化。
 *     被移除后立即失去访问且卡片立即从墙上消失；关闭的墙对所有人（含组织者、原成员）不可见；
 *     邀请码无效 / 墙关闭不能加入；被移除不能用邀请重新加入。
 * S1：成员页 iframe 的 sandbox 恰为 allow-scripts、src 指向页面托管源；票据只为当前发布版本签发（未发布 / 撤下不签发）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, PAGE_IFRAME_SANDBOX, SESSION_COOKIE_NAME, verifyTicket } from '@nowme/contracts';
import type { Wall } from '../../src/db/walls.js';
import {
  connectAgent,
  createTestWeb,
  dumpDb,
  elements,
  get,
  iframesOf,
  login,
  postForm,
  seedMember,
  seedWall,
  TEST_SECRET,
  type TestSession,
  type TestWeb,
} from '../helpers.js';
import { publishedMember, publishPage, seedPublication, seedRevision, makeCard, withdraw, type PublishedMember } from '../wall-helpers.js';

const CONTACT = { channel: 'wechat', value: 'ayou_wechat_2026' };
const MISSING_WALL = 'wal_aaaaaaaaaaaaaaaaaaaaaaaaaa';

/** 主站 HTML 不含内联脚本、内联样式、事件属性、javascript: 链接（主站 CSP 不允许）。 */
function expectNoInlineCode(html: string): void {
  for (const element of elements(html)) {
    if (element.tag === 'script') expect(element.attrs.src, '<script> 必须是外部文件').toMatch(/^\/static\//);
    expect(element.tag, '不能有 <style>').not.toBe('style');
    expect(Object.keys(element.attrs).filter((name) => name === 'style' || name.startsWith('on')), element.tag).toEqual([]);
    for (const name of ['href', 'src', 'action']) {
      expect(element.attrs[name] ?? '', `${element.tag} ${name}`).not.toMatch(/^\s*javascript:/i);
    }
  }
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
}

interface Route {
  method: 'GET' | 'POST';
  path: string;
  fields?: Record<string, string>;
}

function wallRoutes(wall: Wall, target: PublishedMember): Route[] {
  const w = wall.id;
  const p = target.page.id;
  return [
    { method: 'GET', path: `/w/${w}` },
    { method: 'GET', path: `/w/${w}/p/${p}` },
    { method: 'GET', path: `/w/${w}/covers/${p}.png` },
    { method: 'GET', path: `/w/${w}/admin` },
    { method: 'POST', path: `/w/${w}/p/${p}/chat`, fields: { hookId: 'can-help' } },
    { method: 'POST', path: `/w/${w}/admin/remove`, fields: { membershipId: target.membership.id } },
    { method: 'POST', path: `/w/${w}/admin/close`, fields: { confirm: '1' } },
  ];
}

async function call(t: TestWeb, route: Route, session: TestSession | null): Promise<Response> {
  if (route.method === 'GET') return get(t, route.path, { cookie: session?.cookie });
  return postForm(t, route.path, { _csrf: session?.csrf ?? 'guess', ...route.fields }, { cookie: session?.cookie });
}

/** 响应里不能出现的内容：墙名、卡片文字、联系方式、页面票据。 */
function secretsOf(wall: Wall, target: PublishedMember): string[] {
  return [wall.name, target.card.tagline, target.card.hooks[0]?.text ?? '', CONTACT.value, '/v/', target.revisionId];
}

describe('S6 身份 × 路由：拿不到任何墙内内容', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let wall: Wall;
  let target: PublishedMember;
  let identities: Record<string, TestSession>;

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者');
    ({ wall } = seedWall(t, organizer.userId, '秘密黑客松'));
    const targetSession = await login(t, 'target@example.com', '阿柚');
    target = publishedMember(t, wall, { userId: targetSession.userId, name: '阿柚', contact: CONTACT });

    const outsider = await login(t, 'outsider@example.com', '路人');
    const left = await login(t, 'left@example.com', '已退出');
    t.repos.memberships.markLeft(seedMember(t, wall, left.userId).membership.id, t.clock.now().toISOString());
    const removed = await login(t, 'removed@example.com', '已移除');
    const removedMember = seedMember(t, wall, removed.userId);
    expect(
      (await postForm(t, `/w/${wall.id}/admin/remove`, { _csrf: organizer.csrf, membershipId: removedMember.membership.id }, { cookie: organizer.cookie }))
        .status,
    ).toBe(303);
    const elsewhere = await login(t, 'elsewhere@example.com', '别的墙');
    const { wall: otherWall } = seedWall(t, outsider.userId, '另一面墙');
    seedMember(t, otherWall, elsewhere.userId);
    identities = { outsider, left, removed, elsewhere };
  });
  afterEach(async () => {
    await t.close();
  });

  it('未登录：GET 重定向到 /login?next=，POST 返回 401，数据库无变化', async () => {
    for (const route of wallRoutes(wall, target)) {
      const before = dumpDb(t.db);
      const response = await call(t, route, null);
      if (route.method === 'GET') {
        expect(response.status, route.path).toBe(303);
        expect(response.headers.get('location'), route.path).toBe(`/login?next=${encodeURIComponent(route.path)}`);
      } else {
        expect(response.status, route.path).toBe(401);
      }
      const body = await response.text();
      for (const secret of secretsOf(wall, target)) expect(body, `${route.path} 泄露 ${secret}`).not.toContain(secret);
      expect(dumpDb(t.db), route.path).toEqual(before);
    }
  });

  it('非成员、已退出、已移除、其他墙的成员：全部 404，与不存在的墙一样，数据库无变化（不记事件）', async () => {
    for (const [name, session] of Object.entries(identities)) {
      const missing = await (await get(t, `/w/${MISSING_WALL}`, { cookie: session.cookie })).text();
      for (const route of wallRoutes(wall, target)) {
        const before = dumpDb(t.db);
        const response = await call(t, route, session);
        expect(response.status, `${name} ${route.method} ${route.path}`).toBe(404);
        const body = await response.text();
        if (route.method === 'GET' && !route.path.endsWith('.png')) expect(body, `${name} ${route.path}`).toBe(missing);
        for (const secret of secretsOf(wall, target)) expect(body, `${name} ${route.path} 泄露 ${secret}`).not.toContain(secret);
        expect(dumpDb(t.db), `${name} ${route.path}`).toEqual(before);
      }
    }
  });

  it('普通成员不是组织者：后台与后台操作 404，数据库无变化', async () => {
    const member = await login(t, 'member@example.com', '小白');
    seedMember(t, wall, member.userId);
    for (const route of wallRoutes(wall, target).filter((item) => item.path.includes('/admin'))) {
      const before = dumpDb(t.db);
      const response = await call(t, route, member);
      expect(response.status, route.path).toBe(404);
      expect(dumpDb(t.db), route.path).toEqual(before);
    }
  });

  it('凭证放进 cookie、ID 格式不对、页面不属于这面墙：一律当作不存在', async () => {
    const member = await login(t, 'member@example.com', '小白');
    seedMember(t, wall, member.userId);
    const { wall: otherWall } = seedWall(t, organizer.userId, '另一面');
    const foreign = publishedMember(t, otherWall, { name: '外墙的人', contact: CONTACT });
    for (const path of [
      `/w/not-a-wall`,
      `/w/${wall.id}/p/not-a-page`,
      `/w/${wall.id}/p/${foreign.page.id}`,
      `/w/${wall.id}/covers/${foreign.page.id}.png`,
      `/w/${wall.id}/covers/${target.page.id}.jpg`,
      `/w/${wall.id}/covers/..%2F${target.page.id}.png`,
    ]) {
      const response = await get(t, path, { cookie: member.cookie });
      expect(response.status, path).toBe(404);
    }
    const chat = await postForm(t, `/w/${wall.id}/p/${foreign.page.id}/chat`, { _csrf: member.csrf, hookId: 'can-help' }, { cookie: member.cookie });
    expect(chat.status).toBe(404);
    const credential = await connectAgent(t, wall, target.page);
    const asCookie = await get(t, `/w/${wall.id}`, { cookie: `${SESSION_COOKIE_NAME}=${credential}`, headers: { authorization: `Bearer ${credential}` } });
    expect(asCookie.status).toBe(303);
    expect(asCookie.headers.get('location')).toMatch(/^\/login/);
  });

  it('被移除的成员立即失去访问，其卡片立即从墙上消失（墙、成员页、封面、chat）', async () => {
    const viewer = await login(t, 'viewer@example.com', '旁观者');
    seedMember(t, wall, viewer.userId);
    const victim = await login(t, 'victim@example.com', '将被移除');
    const victimPage = publishedMember(t, wall, { userId: victim.userId, name: '将被移除', contact: CONTACT });
    const wallBefore = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(wallBefore).toContain(victimPage.page.id);
    expect((await get(t, `/w/${wall.id}/covers/${victimPage.page.id}.png`, { cookie: viewer.cookie })).status).toBe(200);
    expect((await get(t, `/w/${wall.id}`, { cookie: victim.cookie })).status).toBe(200);

    const removed = await postForm(t, `/w/${wall.id}/admin/remove`, { _csrf: organizer.csrf, membershipId: victimPage.membership.id }, { cookie: organizer.cookie });
    expect(removed.status).toBe(303);

    const wallAfter = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(wallAfter).not.toContain(victimPage.page.id);
    expect(wallAfter).not.toContain('将被移除的一行介绍');
    expect((await get(t, `/w/${wall.id}/p/${victimPage.page.id}`, { cookie: viewer.cookie })).status).toBe(404);
    expect((await get(t, `/w/${wall.id}/covers/${victimPage.page.id}.png`, { cookie: viewer.cookie })).status).toBe(404);
    expect(
      (await postForm(t, `/w/${wall.id}/p/${victimPage.page.id}/chat`, { _csrf: viewer.csrf, hookId: 'can-help' }, { cookie: viewer.cookie })).status,
    ).toBe(404);
    for (const path of [`/w/${wall.id}`, `/w/${wall.id}/p/${target.page.id}`, `/w/${wall.id}/covers/${target.page.id}.png`, `/w/${wall.id}/me`]) {
      expect((await get(t, path, { cookie: victim.cookie })).status, path).toBe(404);
    }
  });

  it('被移除的成员不能用邀请重新加入（GET 友好提示 403、POST 403，数据库无变化）', async () => {
    const removed = identities.removed as TestSession;
    const page = await get(t, `/join/${wall.inviteCode}`, { cookie: removed.cookie });
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain(`action="/join/${wall.inviteCode}"`);
    const before = dumpDb(t.db);
    const post = await postForm(t, `/join/${wall.inviteCode}`, { _csrf: removed.csrf }, { cookie: removed.cookie });
    expect(post.status).toBe(403);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('邀请码无效（格式不对、不存在）：GET / POST 都 404，不创建成员关系', async () => {
    const outsider = identities.outsider as TestSession;
    for (const code of ['inv_x', 'nope', generateToken('invite'), wall.inviteCode.toUpperCase()]) {
      const before = dumpDb(t.db);
      expect((await get(t, `/join/${code}`, { cookie: outsider.cookie })).status, code).toBe(404);
      expect((await postForm(t, `/join/${code}`, { _csrf: outsider.csrf }, { cookie: outsider.cookie })).status, code).toBe(404);
      expect(dumpDb(t.db), code).toEqual(before);
    }
  });

  it('关闭的墙对所有人不可见（含组织者、原成员）；邀请链接失效；“我的”里没有链接', async () => {
    const member = await login(t, 'member@example.com', '小白');
    seedMember(t, wall, member.userId);
    const targetSession = await login(t, 'target@example.com', '阿柚');
    const closed = await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: organizer.csrf, confirm: '1' }, { cookie: organizer.cookie });
    expect(closed.status).toBe(303);

    for (const [name, session] of Object.entries({ organizer, member, target: targetSession, ...identities })) {
      for (const route of [...wallRoutes(wall, target), { method: 'GET' as const, path: `/w/${wall.id}/me` }]) {
        const before = dumpDb(t.db);
        const response = await call(t, route, session);
        expect(response.status, `${name} ${route.method} ${route.path}`).toBe(404);
        const body = await response.text();
        for (const secret of secretsOf(wall, target)) expect(body, `${name} ${route.path}`).not.toContain(secret);
        expect(dumpDb(t.db), `${name} ${route.path}`).toEqual(before);
      }
      const before = dumpDb(t.db);
      expect((await get(t, `/join/${wall.inviteCode}`, { cookie: session.cookie })).status, name).toBe(404);
      expect((await postForm(t, `/join/${wall.inviteCode}`, { _csrf: session.csrf }, { cookie: session.cookie })).status, name).toBe(404);
      expect(dumpDb(t.db), name).toEqual(before);
      const home = await (await get(t, '/', { cookie: session.cookie })).text();
      expect(home, name).not.toContain(`href="/w/${wall.id}`);
    }
  });
});

describe('S1 成员页的沙箱 iframe 与票据', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let viewer: TestSession;
  let wall: Wall;

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者');
    viewer = await login(t, 'viewer@example.com', '小白');
    ({ wall } = seedWall(t, organizer.userId, '黑客松'));
    seedMember(t, wall, viewer.userId);
  });
  afterEach(async () => {
    await t.close();
  });

  it('iframe 的 sandbox 恰为 allow-scripts，src 指向页面托管源，referrerpolicy=no-referrer', async () => {
    const target = publishedMember(t, wall, { name: '阿柚', contact: CONTACT });
    const html = await (await get(t, `/w/${wall.id}/p/${target.page.id}`, { cookie: viewer.cookie })).text();
    const frames = iframesOf(html);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as Record<string, string>;
    expect(frame.sandbox).toBe(PAGE_IFRAME_SANDBOX);
    expect(frame.sandbox).toBe('allow-scripts');
    for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-popups', 'allow-modals']) {
      expect(html).not.toContain(flag);
    }
    expect(new URL(frame.src ?? '').origin).toBe(t.config.pagesOrigin);
    expect(frame.src).toMatch(new RegExp(`^${t.config.pagesOrigin}/v/[^/]+/$`));
    expect(frame.referrerpolicy).toBe('no-referrer');
    expect(frame['data-nm-page-frame']).toBe('');
    expect(frame.allow).toBeUndefined();
    expect(frame.srcdoc).toBeUndefined();
  });

  it('票据只为当前发布版本签发：重新发布后换成新版本；更早的 accepted 版本、未发布 / 撤下的页面都拿不到票据', async () => {
    const target = publishedMember(t, wall, { name: '阿柚' });
    const draftOnly = seedRevision(t, target.page, makeCard('阿柚'));
    const ticketOf = async () => {
      const response = await get(t, `/w/${wall.id}/p/${target.page.id}`, { cookie: viewer.cookie });
      const html = await response.text();
      return { status: response.status, html, ticket: iframesOf(html)[0]?.src?.match(/\/v\/([^/]+)\/$/)?.[1] ?? '' };
    };
    const first = await ticketOf();
    expect(verifyTicket(first.ticket, TEST_SECRET, t.clock.now())).toMatchObject({ ok: true, revisionId: target.revisionId });
    expect(first.html).not.toContain(draftOnly);

    const newer = seedRevision(t, target.page, makeCard('阿柚'));
    seedPublication(t, target.page, newer, { card: makeCard('阿柚') });
    const second = await ticketOf();
    expect(verifyTicket(second.ticket, TEST_SECRET, t.clock.now())).toMatchObject({ ok: true, revisionId: newer });

    withdraw(t, target.page);
    const withdrawn = await ticketOf();
    expect(withdrawn.status).toBe(404);
    expect(withdrawn.html).not.toContain('/v/');
    expect(iframesOf(withdrawn.html)).toEqual([]);

    const unpublished = seedMember(t, wall, (await login(t, 'u@example.com', '未发布')).userId);
    seedRevision(t, unpublished.page, makeCard('未发布'));
    const response = await get(t, `/w/${wall.id}/p/${unpublished.page.id}`, { cookie: viewer.cookie });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('/v/');
  });

  it('T3.1 的所有页面都没有内联脚本、内联样式与事件属性；响应带 no-store', async () => {
    const target = publishedMember(t, wall, { name: '阿柚', contact: CONTACT });
    const removedUser = await login(t, 'removed@example.com', '已移除');
    const removed = seedMember(t, wall, removedUser.userId);
    t.repos.memberships.markRemoved(removed.membership.id, t.clock.now().toISOString());
    const outsider = await login(t, 'outsider@example.com', '路人');
    const responses = [
      await get(t, '/', { cookie: viewer.cookie }),
      await get(t, '/walls/new', { cookie: viewer.cookie }),
      await postForm(t, '/walls', { _csrf: viewer.csrf, name: '', sceneType: 'x' }, { cookie: viewer.cookie }),
      await get(t, `/join/${wall.inviteCode}`, { cookie: outsider.cookie }),
      await get(t, `/join/${wall.inviteCode}`, { cookie: removedUser.cookie }),
      await get(t, `/w/${wall.id}?notice=joined`, { cookie: viewer.cookie }),
      await get(t, `/w/${wall.id}/p/${target.page.id}`, { cookie: viewer.cookie }),
      await postForm(t, `/w/${wall.id}/p/${target.page.id}/chat`, { _csrf: viewer.csrf, hookId: 'can-help' }, { cookie: viewer.cookie }),
      await get(t, `/w/${wall.id}/admin?notice=created`, { cookie: organizer.cookie }),
      await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: organizer.csrf }, { cookie: organizer.cookie }),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expectNoInlineCode(await response.text());
    }
  });
});

describe('S4 补充：T3.1 的 POST 路由不认页面凭证，必须有会话 + CSRF + 同源', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let member: TestSession;
  let wall: Wall;
  let target: PublishedMember;
  let credential: string;
  let routes: { path: string; fields: Record<string, string> }[];

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者');
    member = await login(t, 'member@example.com', '小白');
    ({ wall } = seedWall(t, organizer.userId, '黑客松'));
    target = publishedMember(t, wall, { userId: member.userId, name: '小白', contact: CONTACT });
    const ownerMembership = t.repos.memberships.findByWallAndUser(wall.id, organizer.userId);
    const ownerPage = t.repos.pages.findByMembership(ownerMembership?.id ?? '');
    if (!ownerMembership || !ownerPage) throw new Error('缺少组织者页面');
    publishPage(t, { membership: ownerMembership, page: ownerPage }, '组织者', { contact: CONTACT });
    credential = await connectAgent(t, wall, ownerPage);
    const outsiderWall = seedWall(t, member.userId, '小白的墙').wall;
    routes = [
      { path: '/walls', fields: { name: '凭证建的墙', description: '', sceneType: 'hackathon' } },
      { path: `/join/${outsiderWall.inviteCode}`, fields: {} },
      { path: `/w/${wall.id}/p/${target.page.id}/chat`, fields: { hookId: 'can-help' } },
      { path: `/w/${wall.id}/admin/remove`, fields: { membershipId: target.membership.id } },
      { path: `/w/${wall.id}/admin/close`, fields: { confirm: '1' } },
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  it('只带 Authorization: Bearer <凭证>（无会话）：全部拒绝，数据库无变化', async () => {
    for (const { path, fields } of routes) {
      for (const origin of [t.config.webOrigin, null]) {
        const before = dumpDb(t.db);
        const response = await postForm(t, path, { _csrf: 'guess', ...fields }, { origin, headers: { authorization: `Bearer ${credential}` } });
        expect([401, 403], `${path} → ${response.status}`).toContain(response.status);
        expect(dumpDb(t.db), path).toEqual(before);
      }
    }
  });

  it('组织者会话 + 凭证，但 CSRF 缺失 / 错误 / 是别人的：403，数据库无变化', async () => {
    for (const { path, fields } of routes) {
      for (const csrf of [undefined, '', 'wrong', member.csrf]) {
        const before = dumpDb(t.db);
        const body = csrf === undefined ? fields : { _csrf: csrf, ...fields };
        const response = await postForm(t, path, body, { cookie: organizer.cookie, headers: { authorization: `Bearer ${credential}` } });
        expect(response.status, `${path} csrf=${String(csrf)}`).toBe(403);
        expect(dumpDb(t.db), path).toEqual(before);
      }
    }
  });

  it('组织者会话 + 正确 CSRF，但 Origin 跨站 / 缺失：403，数据库无变化', async () => {
    for (const { path, fields } of routes) {
      for (const variant of [{ origin: 'http://evil.example' }, { origin: t.config.pagesOrigin }, { origin: null }, { origin: 'null' }]) {
        const before = dumpDb(t.db);
        const response = await postForm(t, path, { _csrf: organizer.csrf, ...fields }, { cookie: organizer.cookie, ...variant });
        expect(response.status, `${path} ${JSON.stringify(variant)}`).toBe(403);
        expect(dumpDb(t.db), path).toEqual(before);
      }
    }
  });

  it('正向对照：会话 + CSRF + 同源时成功（凭证在 Authorization 里也不影响）', async () => {
    const chat = await postForm(t, routes[2]?.path ?? '', { _csrf: organizer.csrf, hookId: 'can-help' }, { cookie: organizer.cookie, headers: { authorization: `Bearer ${credential}` } });
    expect(chat.status).toBe(303);
    const removed = await postForm(t, routes[3]?.path ?? '', { _csrf: organizer.csrf, membershipId: target.membership.id }, { cookie: organizer.cookie });
    expect(removed.status).toBe(303);
  });
});
