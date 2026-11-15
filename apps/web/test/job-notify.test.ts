/**
 * 生成 / 修改结束后的提醒邮件（contracts 18.3）：主人离开页面才发、每个任务最多一封、可以关掉、失败也提醒。
 * 安全要求（不含内容、开关的 CSRF）见 security/progress.security.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { jobNoticeMail } from '../src/services/job-notify.js';
import { get, login, MINUTE, seedWall } from './helpers.js';
import { completeInterview, createHostedTestWeb, generate, joinAs, type HostedTestWeb } from './hosted-helpers.js';
import { post } from './publish-helpers.js';
import { finishJob, progressWorld, type ProgressWorld } from './progress-helpers.js';

let t: HostedTestWeb | null = null;
let world: ProgressWorld | null = null;
afterEach(async () => {
  await t?.close();
  await world?.t.close();
  t = null;
  world = null;
});

const notices = (web: HostedTestWeb, email: string) => web.outbox.messages.filter((message) => message.to === email && !/验证码/.test(message.subject));

async function setup() {
  const web = (t = createHostedTestWeb());
  const organizer = await login(web, 'org@example.com', '组织者');
  const { wall } = seedWall(web, organizer.userId, '周末黑客松');
  const owner = await joinAs(web, wall, 'owner@example.com', '阿柚');
  await completeInterview(web, wall, owner);
  return { web, wall, owner };
}

describe('完成提醒', () => {
  it('主人离开了页面：做好后发一封“你的页面做好了”+ 预览链接；同一个任务只发一次', async () => {
    const { web, wall, owner } = await setup();
    const generated = await generate(web, wall, owner);
    expect(generated.job?.status).toBe('succeeded');
    expect(await web.web.notifier.tick()).toBe(1);
    const [mail] = notices(web, 'owner@example.com');
    expect(mail?.subject).toBe('你的页面做好了，去看看');
    expect(mail?.body).toContain('你在「周末黑客松」的页面已经做好了');
    expect(mail?.body).toContain(`${web.config.webOrigin}/w/${wall.id}/me?rev=${generated.job?.revisionId}#preview-heading`);
    expect(mail?.body).toContain(`${web.config.webOrigin}/account/data#notifications`);
    expect(web.repos.notify.outcomeOf(generated.job?.id ?? '')).toBe('sent');
    expect(await web.web.notifier.tick()).toBe(0);
    expect(notices(web, 'owner@example.com')).toHaveLength(1);
  });

  it('主人还在看（进度连接或最近轮询过）：不发', async () => {
    world = await progressWorld();
    const { t: web, wall, owner } = world;
    const jobId = world.queueJob();
    expect((await get(web, `/w/${wall.id}/me/jobs/${jobId}/status`, { cookie: owner.cookie })).status).toBe(200);
    finishJob(web, jobId, 'failed');
    expect(await web.web.notifier.tick()).toBe(0);
    expect(web.repos.notify.outcomeOf(jobId)).toBe('present');
    expect(notices(web, 'owner@example.com')).toEqual([]);

    // 最近一次看是很久以前：发（失败也提醒，告诉他点数已退回）
    const second = world.queueJob();
    expect((await get(web, `/w/${wall.id}/me/jobs/${second}/status`, { cookie: owner.cookie })).status).toBe(200);
    web.clock.advance(5 * MINUTE);
    finishJob(web, second, 'failed');
    expect(await web.web.notifier.tick()).toBe(1);
    const [mail] = notices(web, 'owner@example.com');
    expect(mail?.subject).toBe('这次页面没有做成');
    expect(mail?.body).toContain('如果用了点数，已经全额退回');
    expect(mail?.body).toContain(`/w/${wall.id}/me/jobs/${second}`);
  });

  it('在“我的资料”里关掉后不发；需要补充说明、被平台中止的任务各自处理', async () => {
    const { web, wall, owner } = await setup();
    expect((await post(web, owner.session, '/account/notifications', { jobEmail: '' })).status).toBe(303);
    const generated = await generate(web, wall, owner);
    expect(await web.web.notifier.tick()).toBe(0);
    expect(web.repos.notify.outcomeOf(generated.job?.id ?? '')).toBe('off');

    expect((await post(web, owner.session, '/account/notifications', { jobEmail: '1' })).status).toBe(303);
    expect(web.repos.notify.jobEmailEnabled(owner.session.userId)).toBe(true);
    // 停用账号中止的任务：不发
    const id = 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    web.repos.jobs.create({ id, pageId: owner.member.page.id, ownerId: owner.session.userId, kind: 'generate', baseRevisionId: null, targetBlock: null, requestText: null, createdAt: web.clock.now().toISOString() });
    web.repos.jobs.cancel(id, 'SUSPENDED', web.clock.now().toISOString());
    expect(await web.web.notifier.tick()).toBe(0);
    expect(web.repos.notify.outcomeOf(id)).toBe('skipped');
  });

  it('很久以前结束的任务不补发；发信失败只记一次，不重试', async () => {
    const { web, wall, owner } = await setup();
    const generated = await generate(web, wall, owner);
    web.clock.advance(31 * MINUTE);
    expect(await web.web.notifier.tick()).toBe(0);
    expect(web.repos.notify.outcomeOf(generated.job?.id ?? '')).toBeNull();
  });

  it('邮件文案：生成 / 修改 / 需要补充说明 / 没做成', () => {
    const base = { nickname: '阿柚', wallName: '周末黑客松', link: 'https://nowme.example/x', settingsLink: 'https://nowme.example/account/data#notify' };
    expect(jobNoticeMail({ ...base, job: { kind: 'generate', status: 'succeeded' } }).subject).toBe('你的页面做好了，去看看');
    expect(jobNoticeMail({ ...base, job: { kind: 'edit', status: 'succeeded' } }).subject).toBe('你的页面改好了，去看看');
    expect(jobNoticeMail({ ...base, job: { kind: 'edit', status: 'needs_input' } }).subject).toBe('改页面之前，AI 想先问你一句');
    expect(jobNoticeMail({ ...base, job: { kind: 'edit', status: 'failed' } }).subject).toBe('这次页面修改没有做成');
    expect(jobNoticeMail({ ...base, nickname: null, job: { kind: 'generate', status: 'failed' } }).body.startsWith('你好：')).toBe(true);
  });
});
