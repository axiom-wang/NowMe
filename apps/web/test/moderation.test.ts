/** 举报、拉黑与处理（contracts 15）：流转、重复举报、组织者处理、运营命令。安全边界见 security/moderation.security.test.ts。 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wall } from '../src/db/walls.js';
import { openDirect, sendMessage } from '../src/services/chat.js';
import { ModerationCliError, runModerationCommand } from '../src/services/moderation-cli.js';
import { parseReportForm } from '../src/services/moderation.js';
import { createTestWeb, get, latestCode, login, postForm, seedWall, type TestSession, type TestWeb } from './helpers.js';
import { publishPage, publishedMember, type PublishedMember } from './wall-helpers.js';

describe('举报与处理', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let reporter: TestSession;
  let target: TestSession;
  let wall: Wall;
  let targetPage: PublishedMember;

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者');
    reporter = await login(t, 'reporter@example.com', '小周');
    target = await login(t, 'target@example.com', '阿柚');
    ({ wall } = seedWall(t, organizer.userId, '周末黑客松'));
    publishedMember(t, wall, { userId: reporter.userId, name: '小周' });
    targetPage = publishedMember(t, wall, { userId: target.userId, name: '阿柚' });
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (who: TestSession, path: string, fields: Record<string, string> = {}) => postForm(t, path, { _csrf: who.csrf, ...fields }, { cookie: who.cookie });
  const targetPath = () => `/w/${wall.id}/p/${targetPage.page.id}`;
  const cli = (...argv: string[]) => runModerationCommand(t.web.deps, argv);
  const reportCount = () => (t.db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n;

  it('校验举报表单：原因必选，补充说明限长、去空白', () => {
    expect(parseReportForm({ reason: 'nope' }).ok).toBe(false);
    expect(parseReportForm({ reason: 'spam', note: 'x'.repeat(501) }).ok).toBe(false);
    expect(parseReportForm({ reason: 'spam', note: 'a\u0007b' }).ok).toBe(false);
    expect(parseReportForm({ reason: 'spam', note: '  \r\n ' })).toEqual({ ok: true, input: { reason: 'spam', note: null } });
    expect(parseReportForm({ reason: 'other', note: ' 第一行\r\n第二行 ' })).toEqual({ ok: true, input: { reason: 'other', note: '第一行\n第二行' } });
  });

  it('成员页有举报入口（自己的页面没有）；表单不完整时提示', async () => {
    const html = await (await get(t, targetPath(), { cookie: reporter.cookie })).text();
    expect(html).toContain(`${targetPath()}/report`);
    expect(html).toContain(`${targetPath()}/block`);
    const own = await (await get(t, targetPath(), { cookie: target.cookie })).text();
    expect(own).not.toContain(`${targetPath()}/report`);
    const bad = await post(reporter, `${targetPath()}/report`, { reason: '' });
    expect(bad.headers.get('location')).toBe(`${targetPath()}?safety=invalid#safety`);
    expect(await (await get(t, `${targetPath()}?safety=invalid`, { cookie: reporter.cookie })).text()).toContain('先选一个原因');
    expect(reportCount()).toBe(0);
  });

  it('同一人重复举报同一页只更新；处理后同一版不再重新打开，换了发布再举报才重新打开', async () => {
    expect((await post(reporter, `${targetPath()}/report`, { reason: 'spam' })).headers.get('location')).toContain('safety=reported');
    expect((await post(reporter, `${targetPath()}/report`, { reason: 'harassment', note: '更新' })).headers.get('location')).toContain('safety=report-updated');
    expect(reportCount()).toBe(1);
    const report = t.repos.moderation.findPageReport(reporter.userId, targetPage.page.id)!;
    expect(report).toMatchObject({ reason: 'harassment', note: '更新', status: 'open' });
    expect(await (await get(t, targetPath(), { cookie: reporter.cookie })).text()).toContain('你已经举报过这一页');

    expect((await post(organizer, `/w/${wall.id}/admin/reports/dismiss`, { pageId: targetPage.page.id })).status).toBe(303);
    expect(t.repos.moderation.findReport(report.id)).toMatchObject({ status: 'dismissed', resolvedBy: 'organizer' });
    expect(t.repos.publications.findActiveForPage(targetPage.page.id)).not.toBeNull();
    await post(reporter, `${targetPath()}/report`, { reason: 'spam' });
    expect(t.repos.moderation.findReport(report.id)?.status).toBe('dismissed');
    expect(await (await get(t, `/w/${wall.id}/admin`, { cookie: organizer.cookie })).text()).toContain('现在没有待处理的举报');

    publishPage(t, targetPage, '阿柚', { userId: target.userId });
    await post(reporter, `${targetPath()}/report`, { reason: 'spam' });
    expect(t.repos.moderation.findReport(report.id)?.status).toBe('open');
    expect(reportCount()).toBe(1);
  });

  it('组织者请这一页下墙：页面撤下、举报已处理、主人看到原因并可重新发布', async () => {
    await post(reporter, `${targetPath()}/report`, { reason: 'inappropriate' });
    const admin = await (await get(t, `/w/${wall.id}/admin`, { cookie: organizer.cookie })).text();
    expect(admin).toContain('不当内容 1 次');
    const response = await post(organizer, `/w/${wall.id}/admin/reports/takedown`, { pageId: targetPage.page.id });
    expect(response.headers.get('location')).toBe(`/w/${wall.id}/admin?notice=report-takedown#reports`);
    expect(t.repos.publications.findActiveForPage(targetPage.page.id)).toBeNull();
    expect(t.repos.publications.findLatestEndedForPage(targetPage.page.id)?.endReason).toBe('withdrawn');
    expect(t.repos.moderation.findPageReport(reporter.userId, targetPage.page.id)).toMatchObject({ status: 'actioned', resolvedBy: 'organizer' });
    expect((await get(t, targetPath(), { cookie: reporter.cookie })).status).toBe(404);
    const workspace = await (await get(t, `/w/${wall.id}/me`, { cookie: target.cookie })).text();
    expect(workspace).toContain('组织者请它先下墙');
    expect(workspace).not.toContain('不当内容');
    // 再次处理同一页：已经没有待处理举报 → 404
    expect((await post(organizer, `/w/${wall.id}/admin/reports/takedown`, { pageId: targetPage.page.id })).status).toBe(404);
  });

  it('私信举报只进运营：运营命令能看到举报时为止的消息', async () => {
    const direct = openDirect(t.web.deps, reporter.userId, wall.id, target.userId)!;
    sendMessage(t.web.deps, target.userId, direct, randomUUID(), '第一条骚扰');
    expect((await post(reporter, `/messages/${direct}/report`, { reason: 'harassment', note: '一直发' })).headers.get('location')).toBe(`/messages/${direct}?safety=reported#safety`);
    sendMessage(t.web.deps, target.userId, direct, randomUUID(), '举报之后的消息');
    const report = t.repos.moderation.findConversationReport(reporter.userId, direct)!;
    expect(report.reportedUserId).toBe(target.userId);

    const list = cli('list', '--kind', 'conversation');
    expect(list).toHaveLength(1);
    expect(list[0]).toContain(report.id);
    const shown = cli('show', '--id', report.id).join('\n');
    expect(shown).toContain('第一条骚扰');
    expect(shown).not.toContain('举报之后的消息');
    expect(shown).toContain('一直发');
    expect(shown).toContain('reporter@example.com');
    expect(cli('resolve', '--id', report.id, '--as', 'actioned', '--note', '已警告')).toEqual([`已把 ${report.id} 标记为已处理`]);
    expect(() => cli('resolve', '--id', report.id, '--as', 'actioned')).toThrow(ModerationCliError);
    expect(cli('list')).toEqual(['（没有举报）']);
    expect(cli('list', '--status', 'all')).toHaveLength(1);
  });

  it('运营命令：hide-page、suspend、unsuspend、参数错误', async () => {
    await post(reporter, `${targetPath()}/report`, { reason: 'spam' });
    expect(cli('hide-page', '--page', targetPage.page.id)).toEqual(['页面已下墙；结束了 1 条待处理举报']);
    expect(t.repos.publications.findActiveForPage(targetPage.page.id)).toBeNull();
    expect(await (await get(t, `/w/${wall.id}/me`, { cookie: target.cookie })).text()).toContain('被平台处理下墙');

    expect(cli('suspend', '--email', 'TARGET@example.com', '--note', '多次骚扰')[0]).toContain('账号已停用');
    expect(t.repos.moderation.isSuspended(target.userId)).toBe(true);
    expect(cli('unsuspend', '--email', 'target@example.com')).toEqual(['已解除停用（页面不会自动回到墙上）']);
    await postForm(t, '/login', { email: target.email });
    expect((await postForm(t, '/login/verify', { email: target.email, code: latestCode(t, target.email) })).status).toBe(303);
    expect(t.db.prepare("SELECT action FROM moderation_actions ORDER BY rowid").all()).toEqual([{ action: 'takedown' }, { action: 'suspend' }, { action: 'unsuspend' }]);

    expect(() => cli('nope')).toThrow(/用法/);
    expect(() => cli('show', '--id', 'rpt_x')).toThrow('没有这条举报');
    expect(() => cli('suspend', '--email', 'nobody@example.com')).toThrow('没有这个邮箱的账号');
    expect(() => cli('list', '--status', 'weird')).toThrow(ModerationCliError);
  });

  it('私聊里拉黑：拉黑的人看到“你已拉黑”，输入框隐藏；资料页可以解除', async () => {
    const direct = openDirect(t.web.deps, reporter.userId, wall.id, target.userId)!;
    expect((await post(reporter, `/messages/${direct}/block`)).headers.get('location')).toBe(`/messages/${direct}?safety=blocked#safety`);
    const html = await (await get(t, `/messages/${direct}?safety=blocked`, { cookie: reporter.cookie })).text();
    expect(html).toContain('你已拉黑阿柚');
    expect(html).toMatch(/<form[^>]*data-chat-form[^>]*hidden/);
    const data = await (await get(t, '/account/data', { cookie: reporter.cookie })).text();
    expect(data).toContain('拉黑名单（1 人）');
    expect((await post(reporter, '/account/blocks/remove', { userId: target.userId })).headers.get('location')).toBe('/account/data?notice=unblocked#blocks');
    const sent = await postForm(t, `/messages/${direct}/send`, { _csrf: reporter.csrf, clientId: randomUUID(), text: '又能聊了' }, { cookie: reporter.cookie, headers: { accept: 'application/json' } });
    expect(sent.status).toBe(200);
  });

  it('在成员页拉黑后回到墙上，卡片消失', async () => {
    const response = await post(reporter, `${targetPath()}/block`);
    expect(response.headers.get('location')).toBe(`/w/${wall.id}?notice=blocked`);
    const html = await (await get(t, `/w/${wall.id}?notice=blocked`, { cookie: reporter.cookie })).text();
    expect(html).toContain('已拉黑');
    expect(html).not.toContain(targetPage.page.id);
  });
});
