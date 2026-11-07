/**
 * 工作区的访问控制与 S1 展示要求：
 * - 只有页面主人能看到自己的工作区；未登录 → /login?next=；别人、非成员、已移除、墙关闭 → 404；
 * - iframe 的 sandbox 恰为 allow-scripts，src 指向 NOWME_PAGES_ORIGIN/v/<票据>/，referrerpolicy=no-referrer；
 * - 票据只为主人自己的 accepted 版本签发（S5、S6）；
 * - 响应带主站 CSP；主站 HTML 没有内联脚本 / 样式 / 事件属性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWebCsp, parseCsp, PAGE_IFRAME_SANDBOX, TICKET_TTL_SECONDS, verifyTicket, type RevisionResponse } from '@nowme/contracts';
import {
  connectAgent,
  createTestWeb,
  dumpDb,
  elements,
  exampleFiles,
  get,
  iframesOf,
  login,
  postForm,
  postJson,
  seedMember,
  seedWall,
  TEST_SECRET,
  type TestSession,
  type TestWeb,
} from '../helpers.js';
import type { Page } from '../../src/db/pages.js';
import type { Wall } from '../../src/db/walls.js';

/** 主站 HTML 不含内联脚本、内联样式、事件处理属性、javascript: 链接（主站 CSP 不允许）。 */
export function expectNoInlineCode(html: string): void {
  for (const element of elements(html)) {
    if (element.tag === 'script') {
      expect(element.attrs.src, '<script> 必须是外部文件').toMatch(/^\/static\//);
    }
    expect(element.tag, '不能有 <style>').not.toBe('style');
    expect(Object.keys(element.attrs).filter((name) => name === 'style' || name.startsWith('on')), element.tag).toEqual([]);
    for (const name of ['href', 'src', 'action']) {
      expect(element.attrs[name] ?? '', `${element.tag} ${name}`).not.toMatch(/^\s*javascript:/i);
    }
  }
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
}

function ticketOf(src: string | undefined): string {
  return src?.match(/\/v\/([^/]+)\/$/)?.[1] ?? '';
}

describe('工作区访问控制与沙箱 iframe', () => {
  let t: TestWeb;
  let owner: TestSession;
  let other: TestSession;
  let wall: Wall;
  let page: Page;
  let revisionId: string;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    other = await login(t, 'other@example.com', '小白');
    ({ wall, page } = seedWall(t, owner.userId));
    const credential = await connectAgent(t, wall, page);
    const response = await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    revisionId = ((await response.json()) as RevisionResponse).revision.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('未登录：重定向到 /login?next=（next 为当前路径）', async () => {
    const response = await get(t, `/w/${wall.id}/me?rev=${revisionId}`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/w/${wall.id}/me?rev=${revisionId}`)}`);
    expect(await response.text()).not.toContain('/v/');
  });

  it('非成员的已登录用户：404，不暴露墙是否存在；指令与断开也是 404 且数据库无变化', async () => {
    const response = await get(t, `/w/${wall.id}/me`, { cookie: other.cookie });
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).not.toContain(wall.name);
    expect(html).not.toContain('/v/');
    const missing = await get(t, '/w/wal_aaaaaaaaaaaaaaaaaaaaaaaaaa/me', { cookie: other.cookie });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(html); // 与不存在的墙完全一样

    for (const action of ['instruction', 'disconnect']) {
      const before = dumpDb(t.db);
      const post = await postForm(t, `/w/${wall.id}/me/${action}`, { _csrf: other.csrf }, { cookie: other.cookie });
      expect(post.status, action).toBe(404);
      expect(dumpDb(t.db), action).toEqual(before);
    }
  });

  it('同一面墙的其他成员：/w/:wallId/me 是他自己的页面，看不到主人的版本，也拿不到主人版本的票据', async () => {
    seedMember(t, wall, other.userId);
    const response = await get(t, `/w/${wall.id}/me`, { cookie: other.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(revisionId);
    expect(iframesOf(html)).toEqual([]);
    expect(html).toContain('还没有版本');

    const sneaky = await get(t, `/w/${wall.id}/me?rev=${revisionId}`, { cookie: other.cookie });
    expect(sneaky.status).toBe(404);
    expect(await sneaky.text()).not.toContain('/v/');
  });

  it('墙关闭、主人被移除或退出、ID 格式不对：404', async () => {
    const malformed = await get(t, '/w/not-a-wall/me', { cookie: owner.cookie });
    expect(malformed.status).toBe(404);

    const membership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    t.db.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE id = ?").run(t.clock.now().toISOString(), membership?.id ?? '');
    expect((await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).status).toBe(404);
    t.db.prepare("UPDATE memberships SET status = 'active', ended_at = NULL WHERE id = ?").run(membership?.id ?? '');
    expect((await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).status).toBe(200);

    t.db.prepare("UPDATE walls SET status = 'closed', closed_at = ? WHERE id = ?").run(t.clock.now().toISOString(), wall.id);
    const closed = await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie });
    expect(closed.status).toBe(404);
    expect(await closed.text()).not.toContain('/v/');
  });

  it('S1：iframe 的 sandbox 恰为 allow-scripts，src 指向页面托管源，referrerpolicy=no-referrer，宽 375', async () => {
    const response = await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie });
    const html = await response.text();
    const frames = iframesOf(html);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as Record<string, string>;
    expect(frame.sandbox).toBe(PAGE_IFRAME_SANDBOX);
    expect(frame.sandbox).toBe('allow-scripts');
    for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-popups', 'allow-modals']) {
      expect(html).not.toContain(flag);
    }
    expect(frame.src?.startsWith(`${t.config.pagesOrigin}/v/`)).toBe(true);
    expect(new URL(frame.src ?? '').origin).toBe(t.config.pagesOrigin);
    expect(frame.referrerpolicy).toBe('no-referrer');
    expect(frame.width).toBe('375');
    expect(frame['data-nm-page-frame']).toBe('');
    expect(frame.allow).toBeUndefined();
    expect(frame.srcdoc).toBeUndefined();
  });

  it('票据只为主人自己的 accepted 版本签发，30 分钟有效，签名可被页面托管校验', async () => {
    const html = await (await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).text();
    const ticket = ticketOf(iframesOf(html)[0]?.src);
    const verified = verifyTicket(ticket, TEST_SECRET, t.clock.now());
    expect(verified).toEqual({ ok: true, revisionId, expiresAt: new Date(t.clock.now().getTime() + TICKET_TTL_SECONDS * 1000) });
    expect(verifyTicket(ticket, 'another-secret-0123456789abcdefghijklmnop', t.clock.now()).ok).toBe(false);
    expect(verifyTicket(ticket, TEST_SECRET, new Date(t.clock.now().getTime() + TICKET_TTL_SECONDS * 1000)).ok).toBe(false);
  });

  it('响应带主站 CSP（frame-src 只允许页面托管源）与 nosniff、DENY、no-store', async () => {
    const response = await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie });
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toBe(buildWebCsp({ pagesOrigin: t.config.pagesOrigin }));
    expect(parseCsp(csp).get('frame-src')).toEqual([t.config.pagesOrigin]);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('主站页面没有内联脚本、内联样式与事件属性（主站 CSP 不放开 unsafe-inline）', async () => {
    const instruction = await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    const pages = [
      await (await get(t, '/login')).text(),
      await (await postForm(t, '/login', { email: 'x@example.com' })).text(),
      await (await get(t, '/', { cookie: owner.cookie })).text(),
      await (await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).text(),
      await instruction.text(),
      await (await get(t, '/missing', { cookie: owner.cookie })).text(),
      await (await get(t, '/dev/outbox')).text(),
    ];
    for (const html of pages) expectNoInlineCode(html);
  });

  it('安装说明（T3.6）不含 token：#skill-install 里没有 nmt_ 与这次的 token；整页里 token 只出现在指令与纯文本说明各一次', async () => {
    const response = await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    const html = await response.text();
    const token = /nmt_[A-Za-z0-9_-]{43}/.exec(html)?.[0] as string;
    expect(token).toBeDefined();
    const guide = /<details class="skill-install" id="skill-install"[^>]*>[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
    expect(guide.length).toBeGreaterThan(0);
    expect(guide).not.toContain(token);
    expect(guide).not.toMatch(/nm[ct]_/);
    expect(html.split(token)).toHaveLength(3);
  });

  it('公开的 Skill 分发路由（T3.6）不含任何 token 或凭证，也不需要登录', async () => {
    await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    for (const path of ['/skill', '/skill/install.md', '/skill/manifest.json']) {
      const response = await get(t, path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).not.toMatch(/nm[ct]_[A-Za-z0-9_-]{16,}/);
    }
  });
});
