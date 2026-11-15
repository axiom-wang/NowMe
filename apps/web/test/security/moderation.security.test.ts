/**
 * S12：举报、拉黑与停用（contracts 15）。
 *
 * - 举报人身份不暴露给组织者和被举报人：组织者后台只有页面、原因类别与次数；没有举报人昵称 / ID / 邮箱、补充说明；
 *   被举报人在自己的页面、工作区、消息里看不到任何举报痕迹；
 * - 私信举报只到平台运营：组织者后台不出现私信举报、私信内容、举报人；
 * - 只有这面墙的组织者能处理页面举报；看不到、处理不了针对自己页面的举报；
 * - 拉黑后双向不可见、不可联系：墙上卡片、成员页、封面、“和 TA 聊什么”、想聊这个、发起私信、已有私信里发消息都不行；
 *   被拉黑的人看不到是谁拉黑了自己；
 * - 停用账号立即失效：已有会话失效、不能再登录、页面下墙、本地 Agent 凭证吊销。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wall } from '../../src/db/walls.js';
import { openDirect, sendMessage } from '../../src/services/chat.js';
import { suspendUser } from '../../src/services/moderation.js';
import { agentGet, connectAgent, createTestWeb, get, latestCode, login, postForm, seedWall, type TestSession, type TestWeb } from '../helpers.js';
import { publishPage, publishedMember, type PublishedMember } from '../wall-helpers.js';

const NOTE = '补充说明里的私密细节_只给平台看';
const DM_TEXT = '私信里的原话_组织者不该看到';

describe('S12 举报、拉黑与停用', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let reporter: TestSession;
  let target: TestSession;
  let other: TestSession;
  let wall: Wall;
  let targetPage: PublishedMember;
  let reporterPage: PublishedMember;
  let organizerPage: PublishedMember;

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者林舟');
    reporter = await login(t, 'reporter@example.com', '举报人小周');
    target = await login(t, 'target@example.com', '被举报阿柚');
    other = await login(t, 'other@example.com', '路人丙');
    const seeded = seedWall(t, organizer.userId, '周末黑客松');
    wall = seeded.wall;
    // 组织者自己也发布一页（用来验证组织者看不到针对自己页面的举报）
    organizerPage = publishPage(t, seeded, '林舟', { userId: organizer.userId });
    reporterPage = publishedMember(t, wall, { userId: reporter.userId, name: '小周' });
    targetPage = publishedMember(t, wall, { userId: target.userId, name: '阿柚' });
    publishedMember(t, wall, { userId: other.userId, name: '丙' });
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (who: TestSession, path: string, fields: Record<string, string> = {}) => postForm(t, path, { _csrf: who.csrf, ...fields }, { cookie: who.cookie });
  const pagePath = (page: PublishedMember) => `/w/${wall.id}/p/${page.page.id}`;
  const adminHtml = async () => {
    const response = await get(t, `/w/${wall.id}/admin`, { cookie: organizer.cookie });
    expect(response.status).toBe(200);
    return response.text();
  };

  it('组织者后台只有被举报页面、原因与次数；没有举报人、补充说明、私信举报', async () => {
    expect((await post(reporter, `${pagePath(targetPage)}/report`, { reason: 'harassment', note: NOTE })).status).toBe(303);
    expect((await post(other, `${pagePath(targetPage)}/report`, { reason: 'spam' })).status).toBe(303);
    const direct = openDirect(t.web.deps, reporter.userId, wall.id, target.userId)!;
    sendMessage(t.web.deps, target.userId, direct, randomUUID(), DM_TEXT);
    expect((await post(reporter, `/messages/${direct}/report`, { reason: 'harassment', note: `${NOTE}_私信` })).status).toBe(303);

    const html = await adminHtml();
    expect(html).toContain('待处理举报');
    expect(html).toContain('骚扰 1 次');
    expect(html).toContain('垃圾广告 1 次');
    // 整个后台：没有补充说明、私信内容、私信会话、举报人的 ID 与邮箱
    for (const secret of [NOTE, DM_TEXT, direct, reporter.userId, reporter.email, other.userId, other.email]) {
      expect(html, secret).not.toContain(secret);
    }
    // 举报区块：连举报人的昵称都没有（成员列表里本来就有所有成员的昵称）
    const section = html.slice(html.indexOf('id="reports"'), html.indexOf('</section>', html.indexOf('id="reports"')));
    expect(section).toContain('阿柚');
    for (const secret of ['举报人小周', '小周', '路人丙', '丙']) expect(section, secret).not.toContain(secret);
    // 私信举报不会以任何形式出现在组织者后台
    expect(html).not.toContain('私信 1');
  });

  it('被举报人看不到任何举报痕迹', async () => {
    await post(reporter, `${pagePath(targetPage)}/report`, { reason: 'impersonation', note: NOTE });
    for (const path of [pagePath(targetPage), `/w/${wall.id}/me`, `/w/${wall.id}`, '/messages', '/account/data']) {
      const html = await (await get(t, path, { cookie: target.cookie })).text();
      expect(html, path).not.toContain(NOTE);
      expect(html, path).not.toContain('举报人小周');
      expect(html, path).not.toContain('冒充他人');
    }
  });

  it('组织者看不到、也处理不了针对自己页面的举报', async () => {
    expect((await post(reporter, `${pagePath(organizerPage)}/report`, { reason: 'other', note: NOTE })).status).toBe(303);
    const html = await adminHtml();
    expect(html).toContain('现在没有待处理的举报');
    expect((await post(organizer, `/w/${wall.id}/admin/reports/dismiss`, { pageId: organizerPage.page.id })).status).toBe(404);
    expect(t.repos.moderation.findPageReport(reporter.userId, organizerPage.page.id)?.status).toBe('open');
  });

  it('只有这面墙的组织者能处理举报；凭证、非组织者、没有举报的页面都 404 且不改变状态', async () => {
    await post(reporter, `${pagePath(targetPage)}/report`, { reason: 'harassment' });
    for (const who of [reporter, target, other]) {
      expect((await post(who, `/w/${wall.id}/admin/reports/takedown`, { pageId: targetPage.page.id })).status).toBe(404);
      expect((await post(who, `/w/${wall.id}/admin/reports/dismiss`, { pageId: targetPage.page.id })).status).toBe(404);
    }
    const credential = await connectAgent(t, wall, targetPage.page);
    const withCredential = await postForm(t, `/w/${wall.id}/admin/reports/takedown`, { pageId: targetPage.page.id }, { headers: { authorization: `Bearer ${credential}` } });
    expect(withCredential.status).not.toBe(303);
    // 没有待处理举报的页面不能被“请下墙”
    expect((await post(organizer, `/w/${wall.id}/admin/reports/takedown`, { pageId: reporterPage.page.id })).status).toBe(404);
    expect(t.repos.publications.findActiveForPage(targetPage.page.id)).not.toBeNull();
    expect(t.repos.publications.findActiveForPage(reporterPage.page.id)).not.toBeNull();
  });

  it('只能举报别人的、墙上可见的页面；非成员 404', async () => {
    expect((await post(target, `${pagePath(targetPage)}/report`, { reason: 'spam' })).status).toBe(404);
    const outsider = await login(t, 'outsider@example.com', '外人');
    expect((await post(outsider, `${pagePath(targetPage)}/report`, { reason: 'spam' })).status).toBe(404);
    expect((await post(outsider, `${pagePath(targetPage)}/block`)).status).toBe(404);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM reports').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM blocks').get()).toEqual({ n: 0 });
  });

  it('私信举报只能由参与者发起；组织者不能举报 / 读取别人的私信', async () => {
    const direct = openDirect(t.web.deps, reporter.userId, wall.id, target.userId)!;
    expect((await post(organizer, `/messages/${direct}/report`, { reason: 'spam' })).status).toBe(404);
    expect((await post(other, `/messages/${direct}/block`)).status).toBe(404);
    const group = t.repos.chat.ensureGroup(wall.id, wall.createdAt);
    expect((await post(reporter, `/messages/${group}/report`, { reason: 'spam' })).status).toBe(404);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM reports').get()).toEqual({ n: 0 });
  });

  it('拉黑后双向不可见、不可联系，对方不会知道是谁拉黑了自己', async () => {
    const direct = openDirect(t.web.deps, reporter.userId, wall.id, target.userId)!;
    sendMessage(t.web.deps, target.userId, direct, randomUUID(), '拉黑前的消息');
    expect((await post(reporter, `${pagePath(targetPage)}/block`)).status).toBe(303);

    for (const [viewer, page] of [
      [reporter, targetPage],
      [target, reporterPage],
    ] as const) {
      const wallHtml = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
      expect(wallHtml).not.toContain(page.page.id);
      for (const path of [pagePath(page), `/w/${wall.id}/covers/${page.page.id}.png`]) {
        expect((await get(t, path, { cookie: viewer.cookie })).status, path).toBe(404);
      }
      for (const action of ['icebreaker', 'icebreaker/clear', 'direct', 'chat', 'contact', 'report', 'block']) {
        expect((await post(viewer, `${pagePath(page)}/${action}`, { hookId: 'can-help', reason: 'spam' })).status, action).toBe(404);
      }
      expect((await post(viewer, '/messages/direct', { wallId: wall.id, userId: page.userId })).status).toBe(404);
      const sent = await postForm(t, `/messages/${direct}/send`, { _csrf: viewer.csrf, clientId: randomUUID(), text: '还能发吗' }, { cookie: viewer.cookie, headers: { accept: 'application/json' } });
      expect(sent.status).toBe(403);
      expect(await sent.json()).toEqual({ error: '现在没法在这段对话里发消息了。' });
    }
    // 第三人不受影响
    expect((await get(t, pagePath(targetPage), { cookie: other.cookie })).status).toBe(200);
    // 被拉黑的人：资料页里没有拉黑者，私聊里只看到中性的说明
    const targetData = await (await get(t, '/account/data', { cookie: target.cookie })).text();
    expect(targetData).not.toContain('举报人小周');
    const targetChat = await (await get(t, `/messages/${direct}`, { cookie: target.cookie })).text();
    expect(targetChat).toContain('现在没法在这段对话里发消息了');
    expect(targetChat).not.toContain('你已拉黑');
    expect(targetChat).not.toContain('拉黑了你');
    expect(t.repos.chat.history(direct).messages.map((m) => m.text)).toEqual(['拉黑前的消息']);
    // 拉黑的人自己能在“我的资料”里看到并解除
    const reporterData = await (await get(t, '/account/data', { cookie: reporter.cookie })).text();
    expect(reporterData).toContain('被举报阿柚');
    expect((await post(target, '/account/blocks/remove', { userId: reporter.userId })).status).toBe(404);
    expect((await post(reporter, '/account/blocks/remove', { userId: target.userId })).status).toBe(303);
    expect((await get(t, pagePath(targetPage), { cookie: reporter.cookie })).status).toBe(200);
    expect((await get(t, pagePath(reporterPage), { cookie: target.cookie })).status).toBe(200);
  });

  it('停用账号：已有会话立即失效、不能再登录、页面下墙、凭证吊销', async () => {
    const credential = await connectAgent(t, wall, targetPage.page);
    expect((await get(t, '/', { cookie: target.cookie })).status).toBe(200);
    suspendUser(t.web.deps, target.userId, '测试');

    const home = await get(t, '/messages', { cookie: target.cookie });
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toContain('/login');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(target.userId)).toEqual({ n: 0 });
    expect(t.repos.publications.findActiveForPage(targetPage.page.id)).toBeNull();
    expect((await get(t, pagePath(targetPage), { cookie: reporter.cookie })).status).toBe(404);
    const agent = await agentGet(t, '/api/agent/context', credential);
    expect(agent.status).toBe(401);

    // 不能再登录：验证码正确也不发会话
    expect((await postForm(t, '/login', { email: target.email })).status).toBe(200);
    const verified = await postForm(t, '/login/verify', { email: target.email, code: latestCode(t, target.email) });
    expect(verified.status).toBe(400);
    expect(verified.headers.get('set-cookie') ?? '').not.toContain('nms_');
    expect(await verified.text()).toContain('停用');
    // 别人也不能再给 TA 发起私信
    expect((await post(reporter, '/messages/direct', { wallId: wall.id, userId: target.userId })).status).toBe(404);
  });
});
