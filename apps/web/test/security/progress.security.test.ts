/**
 * 实时进度与完成通知的安全要求（contracts 18.4）：
 * - 进度（SSE 与轮询）只对任务主人开放：其他成员、组织者、非成员、未登录、别人的任务 ID、格式不对 → 一律 404；
 * - 被移除 / 删除页面后正在推送的连接立即停止；任务结束后连接关闭；
 * - 推送内容只有阶段名与数字（不含修改要求、资料、模型输出）；
 * - 主站 CSP 不放开任何外部源，页面 CSP（buildPageCsp）不变（connect-src 'none'）；
 * - 邮件开关只改会话用户自己的设置，需要会话 + CSRF + Origin，忽略 Authorization；提醒邮件不含页面内容。
 */
import { buildPageCsp, buildWebCsp, parseCsp } from '@nowme/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { get, login, postForm, seedMember } from '../helpers.js';
import { completeInterview, createHostedTestWeb, edit, generate, joinAs, MATERIAL, type HostedTestWeb } from '../hosted-helpers.js';
import { finishJob, progressWorld, readSse, type ProgressWorld } from '../progress-helpers.js';
import { seedWall } from '../helpers.js';

let world: ProgressWorld | null = null;
let hosted: HostedTestWeb | null = null;
afterEach(async () => {
  await world?.t.close();
  await hosted?.close();
  world = null;
  hosted = null;
});

const ALLOWED_STAGE_KEYS = ['seq', 'stage', 'step', 'label', 'turn', 'maxTurns'].sort();
const ALLOWED_DONE_KEYS = [...ALLOWED_STAGE_KEYS, 'done', 'status', 'next'].sort();

describe('进度只给任务主人', () => {
  it('其他成员、组织者、非成员、未登录、格式不对、别人的任务：SSE 与轮询一律 404，不占连接名额', async () => {
    world = await progressWorld();
    const { t, wall, owner, organizer } = world;
    const jobId = world.queueJob();
    const other = await login(t, 'other@example.com', '小白');
    seedMember(t, wall, other.userId);
    const outsider = await login(t, 'outsider@example.com', '路人');
    // 路人自己的墙和任务：拿自己的墙路径去读别人的任务
    const { wall: ownWall } = seedWall(t, outsider.userId, '路人的墙');
    for (const suffix of ['progress', 'status']) {
      const path = `/w/${wall.id}/me/jobs/${jobId}/${suffix}`;
      expect((await get(t, path, { cookie: other.cookie })).status, `其他成员 ${suffix}`).toBe(404);
      expect((await get(t, path, { cookie: organizer.cookie })).status, `组织者 ${suffix}`).toBe(404);
      expect((await get(t, path, { cookie: outsider.cookie })).status, `非成员 ${suffix}`).toBe(404);
      expect((await get(t, path)).status, `未登录 ${suffix}`).toBe(404);
      expect((await get(t, `/w/${ownWall.id}/me/jobs/${jobId}/${suffix}`, { cookie: outsider.cookie })).status, `换墙 ${suffix}`).toBe(404);
      expect((await get(t, `/w/${wall.id}/me/jobs/gen_bad/${suffix}`, { cookie: owner.cookie })).status).toBe(404);
      expect((await get(t, `/w/${wall.id}/me/jobs/../../${suffix}`, { cookie: owner.cookie })).status).toBe(404);
      // 页面凭证 / Authorization 头不能代替会话
      expect((await get(t, path, { headers: { authorization: `Bearer ${owner.cookie}` } })).status).toBe(404);
    }
    expect(t.web.deps.progress.connections()).toBe(0);
    expect(t.web.deps.progress.present(jobId)).toBe(false);
  });

  it('被移除后：正在推送的连接立即停止（gone），之后 404', async () => {
    world = await progressWorld();
    const { t, wall, owner, member } = world;
    const jobId = world.queueJob();
    const response = await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const reading = readSse(response);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.repos.memberships.markRemoved(member.membership.id, t.clock.now().toISOString())).toBe(true);
    const { events, ended } = await reading;
    expect(ended).toBe(true);
    expect(events.at(-1)?.event).toBe('gone');
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect((await get(t, `/w/${wall.id}/me/jobs/${jobId}/status`, { cookie: owner.cookie })).status).toBe(404);
  });

  it('任务结束后连接关闭；推送内容只有阶段名与数字，不含修改要求', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const secret = '把名字改成凌晨四点的菜市场';
    const jobId = world.queueJob({ kind: 'edit', requestText: secret });
    t.repos.jobEvents.append(jobId, 'generating', t.clock.now().toISOString(), { turn: 1, maxTurns: 30 });
    finishJob(t, jobId, 'needs_input');
    const { events, raw, ended } = await readSse(await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie }));
    expect(ended).toBe(true);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('想改哪一块'); // 任务结果的文字（模型输出）也不推送
    for (const event of events.filter((item) => item.event === 'stage')) expect(Object.keys(JSON.parse(event.data)).sort()).toEqual(ALLOWED_STAGE_KEYS);
    const done = events.find((item) => item.event === 'done');
    expect(Object.keys(JSON.parse(done?.data ?? '{}')).sort()).toEqual(ALLOWED_DONE_KEYS);
    const status = await (await get(t, `/w/${wall.id}/me/jobs/${jobId}/status`, { cookie: owner.cookie })).text();
    expect(status).not.toContain(secret);
    expect(Object.keys(JSON.parse(status)).sort()).toEqual(ALLOWED_DONE_KEYS);
  });

  it('CSP：进度响应用主站 CSP（只允许同源），页面 CSP 仍是 connect-src none', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    finishJob(t, jobId, 'failed');
    const response = await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie });
    const csp = response.headers.get('content-security-policy') ?? '';
    await response.body?.cancel();
    expect(csp).toBe(buildWebCsp({ pagesOrigin: t.config.pagesOrigin }));
    const web = parseCsp(csp);
    expect(web.get('default-src')).toEqual(["'self'"]);
    expect(web.has('connect-src')).toBe(false); // 由 default-src 'self' 覆盖，不放开任何外部源
    const page = parseCsp(buildPageCsp({ pagesOrigin: t.config.pagesOrigin, ticket: 'tkt', frameAncestors: t.config.webOrigin }));
    expect(page.get('connect-src')).toEqual(["'none'"]);
  });
});

describe('完成提醒邮件的开关与内容', () => {
  it('开关：需要会话 + CSRF + Origin，只改自己的设置；Authorization 头无效', async () => {
    hosted = createHostedTestWeb();
    const t = hosted;
    const a = await login(t, 'a@example.com', '阿柚');
    const b = await login(t, 'b@example.com', '小白');
    expect(t.repos.notify.jobEmailEnabled(a.userId)).toBe(true);
    expect((await postForm(t, '/account/notifications', { jobEmail: '' }, { cookie: a.cookie })).status).toBe(403);
    expect((await postForm(t, '/account/notifications', { _csrf: a.csrf, jobEmail: '' }, { cookie: a.cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await postForm(t, '/account/notifications', { _csrf: a.csrf, jobEmail: '' }, { headers: { authorization: `Bearer ${a.cookie}` } })).status).toBe(401);
    expect(t.repos.notify.jobEmailEnabled(a.userId)).toBe(true);
    const saved = await postForm(t, '/account/notifications', { _csrf: a.csrf, jobEmail: '', userId: b.userId }, { cookie: a.cookie });
    expect(saved.status).toBe(303);
    expect(t.repos.notify.jobEmailEnabled(a.userId)).toBe(false);
    expect(t.repos.notify.jobEmailEnabled(b.userId)).toBe(true);
    const page = await (await get(t, '/account/data', { cookie: a.cookie })).text();
    expect(page).toContain('id="notifications"');
    expect(page).toMatch(/name="jobEmail" value="1"\/>/); // 未勾选
    // 只提交 jobEmail 不会动组织者提醒的开关
    expect(t.repos.reminders.acceptsReminders(a.userId)).toBe(true);
  });

  it('提醒邮件不含页面内容、资料与修改要求，只有一句话和链接', async () => {
    hosted = createHostedTestWeb();
    const t = hosted;
    const organizer = await login(t, 'org@example.com', '组织者');
    const { wall } = seedWall(t, organizer.userId, '周末黑客松');
    const owner = await joinAs(t, wall, 'owner@example.com', '阿柚');
    await completeInterview(t, wall, owner);
    const generated = await generate(t, wall, owner);
    const request = '再加一句我拿过校赛二等奖';
    const edited = await edit(t, wall, owner, { revisionId: generated.job?.revisionId ?? '', block: 'about', request });
    expect(edited.job?.status).toBe('succeeded');
    expect(await t.web.notifier.tick()).toBe(2);
    const mails = t.outbox.messages.filter((message) => message.to === 'owner@example.com' && !/验证码/.test(message.subject));
    expect(mails).toHaveLength(2);
    const brief = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
    const parsed = JSON.parse(brief?.briefJson ?? '{}') as { aiView: string[]; hooks: { text: string; opener: string }[] };
    for (const mail of mails) {
      const text = `${mail.subject}\n${mail.body}\n${mail.html ?? ''}`;
      expect(text).not.toContain(MATERIAL.slice(0, 8));
      expect(text).not.toContain(request);
      for (const sentence of parsed.aiView) expect(text).not.toContain(sentence);
      for (const hook of parsed.hooks) expect(text).not.toContain(hook.text);
      expect(text).not.toContain(edited.job?.resultMessage ?? '不会出现的文字');
      expect(text).not.toMatch(/nmt_|nmc_|_csrf/);
      expect(text).toContain(`${t.config.webOrigin}/w/${wall.id}/me`);
    }
  });
});
