/**
 * T3.2 路由的安全不变量（contracts 5）：
 * - S4：页面凭证（Bearer、无会话）调用发布、恢复、撤下、公开链接、删除、退出 → 拒绝且整个数据库无变化；
 * - S1：工作区预览与 /s/:token 中 iframe 的 sandbox 恰为 allow-scripts、src 指向页面托管源；
 * - S6：公开链接关闭 / 轮换后旧链接 404；未发布、撤下、墙关闭、成员退出或被移除、页面删除时 404；
 *   公开页不含联系方式与“想聊这个”；
 * - S5：其他用户（非成员、同墙成员、组织者、已退出、已移除）调用这些路由 → 404 且主人的数据无变化；
 *   组织者不能发布、撤下、预览别人的版本。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWebCsp, PAGE_IFRAME_SANDBOX, verifyTicket, type Card, type RevisionSummary } from '@nowme/contracts';
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
import {
  enablePublicLink,
  escapeHtml,
  exampleCard,
  pageRows,
  post,
  publish,
  publishFields,
  submitRevision,
} from '../publish-helpers.js';
import type { Page } from '../../src/db/pages.js';
import type { Wall } from '../../src/db/walls.js';

interface Scenario {
  t: TestWeb;
  organizer: TestSession;
  owner: TestSession;
  wall: Wall;
  page: Page;
  organizerPage: Page;
  credential: string;
  card: Card;
  first: RevisionSummary;
  second: RevisionSummary;
  token: string;
}

/** 组织者建墙；主人（普通成员）提交两版，发布第 2 版（公开微信），开启公开链接。 */
async function scenario(): Promise<Scenario> {
  const t = createTestWeb();
  const organizer = await login(t, 'organizer@example.com', '组织者');
  const owner = await login(t, 'owner@example.com', '林舟');
  const { wall, page: organizerPage } = seedWall(t, organizer.userId, '周末黑客松');
  const { page } = seedMember(t, wall, owner.userId);
  const credential = await connectAgent(t, wall, page);
  const card = exampleCard();
  const first = await submitRevision(t, credential);
  const second = await submitRevision(t, credential);
  expect((await publish(t, owner, wall.id, second.id, card, { contactValue: 'secret_wechat_42', tagline: '全栈偏后端，周末来组队' })).status).toBe(303);
  const token = await enablePublicLink(t, owner, wall.id, page.id);
  return { t, organizer, owner, wall, page, organizerPage, credential, card, first, second, token };
}

/** T3.2 全部改变状态的路由（字段都是“如果是主人就会成功”的合法值）。 */
function mutatingRoutes(s: Scenario): { name: string; path: string; fields: Record<string, string> }[] {
  const w = s.wall.id;
  const strip = (fields: Record<string, string>) => {
    const { _csrf: _ignored, ...rest } = fields;
    return rest;
  };
  return [
    { name: '恢复旧版本', path: `/w/${w}/me/publish`, fields: strip(publishFields('', s.first.id, s.card, { tagline: '攻击者的介绍' })) },
    { name: '发布', path: `/w/${w}/me/publish`, fields: strip(publishFields('', s.second.id, s.card, { contactValue: 'attacker' })) },
    { name: '撤下', path: `/w/${w}/me/withdraw`, fields: {} },
    { name: '关闭公开链接', path: `/w/${w}/me/public-link`, fields: { enabled: '0' } },
    { name: '轮换公开链接', path: `/w/${w}/me/public-link`, fields: { enabled: '1' } },
    { name: '删除页面', path: `/w/${w}/me/delete`, fields: { confirm: '1' } },
    { name: '退出墙', path: `/w/${w}/leave`, fields: {} },
  ];
}

function ticketRevision(src: string | undefined, t: TestWeb): string | null {
  const ticket = src?.match(/\/v\/([^/]+)\/$/)?.[1] ?? '';
  const result = verifyTicket(ticket, TEST_SECRET, t.clock.now());
  return result.ok ? result.revisionId : null;
}

function expectSandboxedFrame(html: string, t: TestWeb): Record<string, string> {
  const frames = iframesOf(html);
  expect(frames).toHaveLength(1);
  const frame = frames[0] as Record<string, string>;
  expect(frame.sandbox).toBe(PAGE_IFRAME_SANDBOX);
  expect(frame.sandbox).toBe('allow-scripts');
  for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-popups', 'allow-modals']) {
    expect(html).not.toContain(flag);
  }
  expect(new URL(frame.src ?? '').origin).toBe(t.config.pagesOrigin);
  expect(frame.src?.startsWith(`${t.config.pagesOrigin}/v/`)).toBe(true);
  expect(frame.referrerpolicy).toBe('no-referrer');
  expect(frame.srcdoc).toBeUndefined();
  expect(frame.allow).toBeUndefined();
  return frame;
}

describe('S4：页面凭证不能发布、恢复、撤下、改公开链接、删除、退出', () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await scenario();
  });
  afterEach(async () => {
    await s.t.close();
  });

  it('Authorization: Bearer <凭证>（无会话）：表单与 JSON 请求一律拒绝，整个数据库无变化，文件仍在', async () => {
    const { t } = s;
    for (const { name, path, fields } of mutatingRoutes(s)) {
      for (const origin of [t.config.webOrigin, null]) {
        const before = dumpDb(t.db);
        const response = await postForm(t, path, { _csrf: 'guess', ...fields }, { origin, headers: { authorization: `Bearer ${s.credential}` } });
        expect([401, 403, 404], `${name} → ${response.status}`).toContain(response.status);
        expect(dumpDb(t.db), name).toEqual(before);
      }
      const before = dumpDb(t.db);
      const json = await t.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json', origin: t.config.webOrigin },
        body: JSON.stringify(fields),
      });
      expect([401, 403, 404], `${name}（JSON）→ ${json.status}`).toContain(json.status);
      expect(dumpDb(t.db), name).toEqual(before);
    }
    expect(t.repos.publications.findActiveForPage(s.page.id)?.revisionId).toBe(s.second.id);
    expect(t.repos.pages.findById(s.page.id)?.publicToken).toBe(s.token);
    expect((await get(t, `/s/${s.token}`)).status).toBe(200);
  });

  it('主人的会话 + 凭证头但没有 CSRF：403，数据库无变化（Authorization 头不能替代 CSRF）', async () => {
    const { t } = s;
    for (const { name, path, fields } of mutatingRoutes(s)) {
      const before = dumpDb(t.db);
      const response = await postForm(t, path, fields, { cookie: s.owner.cookie, headers: { authorization: `Bearer ${s.credential}` } });
      expect(response.status, name).toBe(403);
      expect(dumpDb(t.db), name).toEqual(before);
    }
  });

  it('Agent API 没有发布类接口：凭证 POST 到 /api/agent/publish 等路径 → 404，数据库无变化', async () => {
    const { t } = s;
    for (const path of ['/api/agent/publish', '/api/agent/withdraw', '/api/agent/public-link', '/api/agent/delete']) {
      const before = dumpDb(t.db);
      const response = await t.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId: s.first.id }),
      });
      expect(response.status, path).toBe(404);
      expect(dumpDb(t.db), path).toEqual(before);
    }
  });
});

describe('S1：工作区预览与公开链接的 iframe', () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await scenario();
  });
  afterEach(async () => {
    await s.t.close();
  });

  it('工作区（默认与 ?rev= 恢复旧版本）：sandbox 恰为 allow-scripts，src 指向页面托管源，票据为所选版本', async () => {
    const { t, wall, owner } = s;
    const current = await (await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).text();
    expect(ticketRevision(expectSandboxedFrame(current, t).src, t)).toBe(s.second.id);
    const restore = await (await get(t, `/w/${wall.id}/me?rev=${s.first.id}`, { cookie: owner.cookie })).text();
    expect(ticketRevision(expectSandboxedFrame(restore, t).src, t)).toBe(s.first.id);
  });

  it('/s/:token：sandbox 恰为 allow-scripts，src 指向页面托管源，票据为当前发布版本；带主站 CSP；无内联代码', async () => {
    const { t } = s;
    const response = await get(t, `/s/${s.token}`);
    expect(response.headers.get('content-security-policy')).toBe(buildWebCsp({ pagesOrigin: t.config.pagesOrigin }));
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const html = await response.text();
    expect(ticketRevision(expectSandboxedFrame(html, t).src, t)).toBe(s.second.id);
    for (const element of elements(html)) {
      if (element.tag === 'script') expect(element.attrs.src).toMatch(/^\/static\//);
      expect(element.tag).not.toBe('style');
      expect(Object.keys(element.attrs).filter((name) => name === 'style' || name.startsWith('on'))).toEqual([]);
    }
    // 恢复旧版本后公开链接展示被恢复的版本，链接不变
    await publish(t, s.owner, s.wall.id, s.first.id, s.card);
    const restored = await (await get(t, `/s/${s.token}`)).text();
    expect(ticketRevision(expectSandboxedFrame(restored, t).src, t)).toBe(s.first.id);
  });
});

describe('S6：公开链接', () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await scenario();
  });
  afterEach(async () => {
    await s.t.close();
  });

  async function expectGone(token: string, label: string): Promise<void> {
    const response = await get(s.t, `/s/${token}`);
    expect(response.status, label).toBe(404);
    const html = await response.text();
    expect(html, label).not.toContain('/v/');
    expect(html, label).not.toContain(s.card.displayName);
  }

  it('公开页不含联系方式、接话点、开场白与“想聊这个”，也不含墙名与版本 ID', async () => {
    const html = await (await get(s.t, `/s/${s.token}`)).text();
    expect(html).not.toContain('secret_wechat_42');
    expect(html).not.toContain('微信');
    expect(html).not.toContain('想聊这个');
    for (const hook of s.card.hooks) {
      expect(html).not.toContain(escapeHtml(hook.text));
      expect(html).not.toContain(escapeHtml(hook.opener));
    }
    expect(html).not.toContain('周末黑客松');
    // 版本 ID 只出现在票据里（contracts 4.4 票据格式本身含版本 ID），页面其他地方没有
    const withoutFrameSrc = html.replace(/ src="http[^"]*"/g, '');
    expect(withoutFrameSrc).not.toContain(s.second.id);
    expect(html).not.toContain(s.page.id);
    expect(html).not.toContain(s.wall.id);
  });

  it('关闭后旧链接 404；重新开启令牌不同，旧令牌仍 404；轮换后旧令牌 404', async () => {
    const { t, owner, wall, page } = s;
    await post(t, owner, `/w/${wall.id}/me/public-link`, { enabled: '0' });
    await expectGone(s.token, '关闭');
    const reopened = await enablePublicLink(t, owner, wall.id, page.id);
    expect(reopened).not.toBe(s.token);
    await expectGone(s.token, '重新开启后的旧令牌');
    expect((await get(t, `/s/${reopened}`)).status).toBe(200);
    const rotated = await enablePublicLink(t, owner, wall.id, page.id);
    expect(rotated).not.toBe(reopened);
    await expectGone(reopened, '轮换');
    expect((await get(t, `/s/${rotated}`)).status).toBe(200);
  });

  it('未发布（链接开着但从没发布）：404', async () => {
    const { t, wall } = s;
    const other = await login(t, 'other@example.com', '小白');
    const { page } = seedMember(t, wall, other.userId);
    const token = await enablePublicLink(t, other, wall.id, page.id);
    await expectGone(token, '未发布');
  });

  it('撤下：404；墙关闭：404（重新打开也不受影响的只是数据，展示一律拒绝）', async () => {
    const { t, owner, wall } = s;
    await post(t, owner, `/w/${wall.id}/me/withdraw`);
    await expectGone(s.token, '撤下');
    await publish(t, owner, wall.id, s.second.id, s.card);
    expect((await get(t, `/s/${s.token}`)).status).toBe(200);
    t.db.prepare("UPDATE walls SET status = 'closed', closed_at = ? WHERE id = ?").run(t.clock.now().toISOString(), wall.id);
    await expectGone(s.token, '墙关闭');
  });

  it('成员关系无效（被移除，令牌仍在库里）：404', async () => {
    const { t, wall, owner } = s;
    const membership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    t.db.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?").run(t.clock.now().toISOString(), membership?.id ?? '');
    expect(t.repos.pages.findById(s.page.id)?.publicToken).toBe(s.token);
    await expectGone(s.token, '被移除');
  });

  it('成员退出：404；删除页面：404', async () => {
    const { t, wall, owner } = s;
    await post(t, owner, `/w/${wall.id}/me/delete`, { confirm: '1' });
    await expectGone(s.token, '删除');
    await post(t, owner, `/w/${wall.id}/leave`);
    await expectGone(s.token, '退出');
  });

  it('格式不对、不存在、拿 publication ID 或 page ID 当令牌：404，与其他“找不到”完全相同', async () => {
    const { t } = s;
    const reference = await (await get(t, '/missing')).text();
    const publication = t.repos.publications.findActiveForPage(s.page.id);
    for (const token of ['x', 'pub_', `${s.token}x`, s.token.toUpperCase(), publication?.id ?? '', s.page.id, encodeURIComponent('../w')]) {
      const response = await get(t, `/s/${token}`);
      expect(response.status, token).toBe(404);
      expect(await response.text(), token).toBe(reference);
    }
  });
});

describe('S5：其他用户调用主人的路由', () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await scenario();
  });
  afterEach(async () => {
    await s.t.close();
  });

  it('非成员：工作区、确认页与全部改变状态的路由 → 404，整个数据库无变化', async () => {
    const { t, wall } = s;
    const stranger = await login(t, 'stranger@example.com', '路人');
    for (const path of [`/w/${wall.id}/me`, `/w/${wall.id}/me?rev=${s.first.id}`, `/w/${wall.id}/me/delete`, `/w/${wall.id}/leave`]) {
      const response = await get(t, path, { cookie: stranger.cookie });
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain('/v/');
    }
    for (const { name, path, fields } of mutatingRoutes(s)) {
      const before = dumpDb(t.db);
      const response = await postForm(t, path, { _csrf: stranger.csrf, ...fields }, { cookie: stranger.cookie });
      expect(response.status, name).toBe(404);
      expect(dumpDb(t.db), name).toEqual(before);
    }
  });

  it('组织者与同墙成员：不能发布或恢复主人的版本（404，数据库无变化），不能预览主人的版本', async () => {
    const { t, wall, organizer } = s;
    const member = await login(t, 'member@example.com', '小白');
    seedMember(t, wall, member.userId);
    for (const actor of [organizer, member]) {
      for (const revision of [s.first, s.second]) {
        const before = dumpDb(t.db);
        const response = await publish(t, actor, wall.id, revision.id, s.card);
        expect(response.status).toBe(404);
        expect(dumpDb(t.db)).toEqual(before);
        const preview = await get(t, `/w/${wall.id}/me?rev=${revision.id}`, { cookie: actor.cookie });
        expect(preview.status).toBe(404);
        expect(await preview.text()).not.toContain('/v/');
      }
    }
  });

  it('组织者与同墙成员：撤下、公开链接、删除、退出只作用于他们自己的页面，主人的数据不变', async () => {
    const { t, wall, organizer } = s;
    const member = await login(t, 'member@example.com', '小白');
    seedMember(t, wall, member.userId);
    for (const actor of [organizer, member]) {
      for (const { name, path, fields } of mutatingRoutes(s).filter((route) => !route.path.endsWith('/publish'))) {
        const before = pageRows(t, s.page.id);
        await postForm(t, path, { _csrf: actor.csrf, ...fields }, { cookie: actor.cookie });
        expect(pageRows(t, s.page.id), `${name}`).toEqual(before);
      }
    }
    expect(t.repos.publications.findActiveForPage(s.page.id)?.revisionId).toBe(s.second.id);
    expect((await get(t, `/s/${s.token}`)).status).toBe(200);
    // 组织者的工作区里没有主人的版本与联系方式
    const html = await (await get(t, `/w/${wall.id}/me`, { cookie: organizer.cookie })).text();
    expect(html).not.toContain(s.first.id);
    expect(html).not.toContain('secret_wechat_42');
  });

  it('已退出、已移除的主人：工作区与全部路由 → 404，数据库无变化', async () => {
    const { t, wall, owner } = s;
    const membership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    for (const status of ['left', 'removed']) {
      t.db.prepare('UPDATE memberships SET status = ?, ended_at = ? WHERE id = ?').run(status, t.clock.now().toISOString(), membership?.id ?? '');
      expect((await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).status, status).toBe(404);
      expect((await get(t, `/w/${wall.id}/me/delete`, { cookie: owner.cookie })).status, status).toBe(404);
      for (const { name, path, fields } of mutatingRoutes(s)) {
        const before = dumpDb(t.db);
        const response = await post(t, owner, path, fields);
        expect(response.status, `${status} ${name}`).toBe(404);
        expect(dumpDb(t.db), `${status} ${name}`).toEqual(before);
      }
    }
  });

  it('墙关闭后主人的全部路由 → 404，数据库无变化', async () => {
    const { t, wall, owner } = s;
    t.db.prepare("UPDATE walls SET status = 'closed', closed_at = ? WHERE id = ?").run(t.clock.now().toISOString(), wall.id);
    for (const { name, path, fields } of mutatingRoutes(s)) {
      const before = dumpDb(t.db);
      const response = await post(t, owner, path, fields);
      expect(response.status, name).toBe(404);
      expect(dumpDb(t.db), name).toEqual(before);
    }
  });

  it('未登录的表单 POST：401，数据库无变化', async () => {
    const { t } = s;
    for (const { name, path, fields } of mutatingRoutes(s)) {
      const before = dumpDb(t.db);
      const response = await postForm(t, path, fields);
      expect(response.status, name).toBe(401);
      expect(dumpDb(t.db), name).toEqual(before);
    }
  });
});
