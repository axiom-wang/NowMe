/**
 * 我的页面按阶段只突出一件事、步骤条与真实状态一致、默认创作方式（contracts 18.1）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { grantCredits, sponsorWall, type AiStatus } from '../src/services/billing.js';
import { creationRoute, workspaceStage, workspaceSteps, type StageInput } from '../src/services/workspace-stage.js';
import { createTestWeb, createUser, seedWall, type TestWeb } from './helpers.js';
import { createPlatformTestWeb, topUp } from './billing-helpers.js';
import { completeInterview, createHostedTestWeb, generate, joinAs, MATERIAL, postMultipart, interviewFields, type HostedTestWeb } from './hosted-helpers.js';
import { post, publish, workspaceHtml } from './publish-helpers.js';
import { cardSchema } from '@nowme/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let t: TestWeb | HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const EMPTY: StageInput = { briefStatus: null, activeJob: false, hasLive: false, hasUsable: false, published: false };

describe('阶段判定（纯函数）', () => {
  it('按真实状态只给一个阶段：正在做 > 已发布 > 有做好的一版 > 资料状态', () => {
    expect(workspaceStage(EMPTY)).toBe('start');
    expect(workspaceStage({ ...EMPTY, briefStatus: 'collecting' })).toBe('interview');
    expect(workspaceStage({ ...EMPTY, briefStatus: 'followups' })).toBe('interview');
    expect(workspaceStage({ ...EMPTY, briefStatus: 'review' })).toBe('review');
    expect(workspaceStage({ ...EMPTY, briefStatus: 'confirmed' })).toBe('ready');
    expect(workspaceStage({ ...EMPTY, briefStatus: 'confirmed', activeJob: true })).toBe('generating');
    expect(workspaceStage({ ...EMPTY, briefStatus: 'confirmed', hasLive: true, hasUsable: true })).toBe('preview');
    // 只有没做成的版本：仍按资料状态
    expect(workspaceStage({ ...EMPTY, briefStatus: 'confirmed', hasLive: true })).toBe('ready');
    expect(workspaceStage({ ...EMPTY, hasLive: true, hasUsable: true, published: true })).toBe('published');
    // 已发布后再修改：显示进度
    expect(workspaceStage({ ...EMPTY, hasLive: true, hasUsable: true, published: true, activeJob: true })).toBe('generating');
  });

  it('步骤条与真实状态一致：还没采访时“采访”是当前步骤，不会显示“已完成”', () => {
    const states = (input: StageInput) => workspaceSteps(input, true).map((step) => step.state);
    expect(workspaceSteps(EMPTY, true).map((step) => step.label)).toEqual(['采访', '确认资料', '生成页面', '发布到墙上']);
    expect(workspaceStage({ ...EMPTY, hasLive: true })).toBe('start');
    expect(states({ ...EMPTY, hasLive: true })).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(states(EMPTY)).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(states({ ...EMPTY, briefStatus: 'followups' })).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(states({ ...EMPTY, briefStatus: 'review' })).toEqual(['done', 'current', 'todo', 'todo']);
    expect(states({ ...EMPTY, briefStatus: 'confirmed', activeJob: true })).toEqual(['done', 'done', 'current', 'todo']);
    expect(states({ ...EMPTY, briefStatus: 'confirmed', hasLive: true })).toEqual(['done', 'done', 'current', 'todo']);
    expect(states({ ...EMPTY, briefStatus: 'confirmed', hasLive: true, hasUsable: true })).toEqual(['done', 'done', 'done', 'current']);
    expect(states({ ...EMPTY, hasLive: true, hasUsable: true, published: true })).toEqual(['done', 'done', 'done', 'done']);
    // 只有本地 AI 助手一条路时：三步
    expect(workspaceSteps(EMPTY, false).map((step) => [step.label, step.state])).toEqual([
      ['交给 AI 助手', 'current'],
      ['做好一版页面', 'todo'],
      ['发布到墙上', 'todo'],
    ]);
  });

  it('默认创作方式：自己的 Key 优先；平台 AI 可用且点数够 → 平台；不够 → 点数提示；都没有 → 设置', () => {
    const status = (patch: Partial<AiStatus>): AiStatus => ({ mode: 'platform', prices: { generate: 10, edit: 4 }, balance: 0, wallAllowance: 0, ...patch });
    expect(creationRoute(status({ mode: 'own' }))).toBe('own');
    expect(creationRoute(status({ mode: 'none' }))).toBe('setup');
    expect(creationRoute(status({ balance: 10 }))).toBe('platform');
    expect(creationRoute(status({ wallAllowance: 12 }))).toBe('platform');
    expect(creationRoute(status({ balance: 9, wallAllowance: 9 }))).toBe('credits');
    expect(creationRoute(status({ balance: 5 }), 'edit')).toBe('platform');
    expect(creationRoute(status({ prices: { generate: 0, edit: 0 } }))).toBe('platform');
  });
});

describe('我的页面：每个阶段一个主要按钮', () => {
  /** 页面上“现在该做的事”那张卡片。 */
  const nextStep = (html: string) => {
    const start = html.indexOf('id="next-step"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</section>', start));
  };
  const primaries = (fragment: string) => fragment.match(/btn--primary/g)?.length ?? 0;

  it('平台 AI 可用且墙额度够：不出现“选路线”，主要按钮是“开始采访”，其他方式收起', async () => {
    const web = (t = createPlatformTestWeb());
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId, '周末黑客松');
    grantCredits(web.web.deps, organizerId, 100);
    expect(sponsorWall(web.web.deps, wall, organizerId, { credits: 100, memberCap: 0 }).ok).toBe(true);
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');
    const html = await workspaceHtml(web, owner.session, wall.id);
    const card = nextStep(html);
    expect(card).toContain('先聊几句，让 AI 认识你');
    expect(card).toContain('开始采访');
    expect(primaries(card)).toBe(1);
    expect(card).toContain('用的是 NOWMe 的 AI');
    expect(card).toContain('这面墙还能为你出 100 点');
    expect(html).toMatch(/<details class="card more-ways" id="more-ways">/);
    expect(html).not.toContain('选路线');
    // 步骤条：采访是当前步骤
    expect(html).toMatch(/progress__step--current" aria-current="step"><span class="progress__num" aria-hidden="true">1<\/span><span class="progress__label">采访/);
    // 还没有页面：没有“墙上的页面 / 公开链接”抢在前面
    expect(html).not.toContain('id="wall-status"');
    expect(html).not.toContain('id="public-link"');
  });

  it('点数不够：说清楚要多少、有多少，主要按钮是“去兑换点数”，仍可先采访，其他方式展开；不出现错误码', async () => {
    const web = (t = createPlatformTestWeb());
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId, '周末黑客松');
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');
    const html = await workspaceHtml(web, owner.session, wall.id);
    const card = nextStep(html);
    expect(card).toContain('点数不够');
    expect(card).toContain('要 10 点，你现在能用 0 点');
    expect(card).toContain('请组织者给这面墙充一点额度');
    expect(card).toMatch(/<a class="btn btn--primary btn--lg" href="\/account\/credits">去兑换点数<\/a>/);
    expect(card).toContain('先开始采访（不收点数）');
    expect(primaries(card)).toBe(1);
    expect(html).toMatch(/<details class="card more-ways" id="more-ways" open/);
    expect(card).not.toMatch(/\bMODEL_[A-Z]+\b|InsufficientCredits|error=/);

    // 采访页同样提前说明（采访不收点数）
    const create = await (await web.request(`/w/${wall.id}/me/create`, { headers: { cookie: owner.session.cookie } })).text();
    expect(create).toContain('采访不收点数；用 NOWMe 的 AI 生成一版页面要 10 点，你现在能用 0 点');

    // 充值后恢复默认路线
    await topUp(web, owner.session, 20);
    const after = nextStep(await workspaceHtml(web, owner.session, wall.id));
    expect(after).toContain('开始采访');
    expect(after).not.toContain('点数不够');
  });

  it('阶段推进：采访中 → 确认资料 → 生成 → 预览（发布到墙上）→ 已发布（看墙上的样子）', async () => {
    const web = (t = createHostedTestWeb());
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId, '周末黑客松');
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');

    // 填了第一页，还有追问 → 继续采访
    const started = await postMultipart(web, `/w/${wall.id}/me/create/start`, interviewFields(owner.session, MATERIAL), [], { cookie: owner.session.cookie });
    expect(started.status).toBe(303);
    const brief = web.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
    if (brief?.status === 'followups') expect(nextStep(await workspaceHtml(web, owner.session, wall.id))).toContain('继续采访');
    expect((await post(web, owner.session, `/w/${wall.id}/me/create/restart`)).status).toBe(303);

    await completeInterview(web, wall, owner);
    const ready = nextStep(await workspaceHtml(web, owner.session, wall.id));
    expect(ready).toContain('可以做页面了');
    expect(ready).toContain(`action="/w/${wall.id}/me/generate"`);
    expect(primaries(ready)).toBe(1);

    const generated = await generate(web, wall, owner);
    expect(generated.job?.status).toBe('succeeded');
    const previewHtml = await workspaceHtml(web, owner.session, wall.id);
    const preview = nextStep(previewHtml);
    expect(preview).toContain('第 1 版做好了');
    expect(preview).toContain('href="#publish"');
    expect(primaries(preview)).toBe(1);
    expect(previewHtml).toContain('data-nm-page-frame');
    expect(previewHtml).toMatch(/progress__step--current" aria-current="step"><span class="progress__num" aria-hidden="true">4<\/span><span class="progress__label">发布到墙上/);

    const revisionId = generated.job?.revisionId ?? '';
    const card = cardSchema.parse(JSON.parse(readFileSync(join(web.dataDir, 'revisions', revisionId, 'original', 'card.json'), 'utf8')));
    expect((await publish(web, owner.session, wall.id, revisionId, card)).status).toBe(303);
    const publishedHtml = await workspaceHtml(web, owner.session, wall.id);
    const published = nextStep(publishedHtml);
    expect(published).toContain('你的页面已经在墙上了');
    expect(published).toContain(`href="/w/${wall.id}/p/${owner.member.page.id}"`);
    expect(primaries(published)).toBe(1);
    // 公开链接、撤下在下方
    expect(publishedHtml.indexOf('id="wall-status"')).toBeGreaterThan(publishedHtml.indexOf('id="next-step"'));
    expect(publishedHtml.indexOf('id="public-link"')).toBeGreaterThan(publishedHtml.indexOf('id="next-step"'));
    expect(publishedHtml).not.toContain('progress__step--current');
  });

  it('没有工程用语：不出现 brief、缩略卡、“通过校验的版本”、Agent 指令', async () => {
    const web = (t = createHostedTestWeb());
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId, '周末黑客松');
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');
    await completeInterview(web, wall, owner);
    await generate(web, wall, owner);
    const pages = [
      await workspaceHtml(web, owner.session, wall.id),
      await (await web.request(`/w/${wall.id}/me/create`, { headers: { cookie: owner.session.cookie } })).text(),
      await (await web.request(`/w/${wall.id}/me/brief`, { headers: { cookie: owner.session.cookie } })).text(),
    ];
    for (const html of pages) {
      const visible = html.replace(/<[^>]+>/g, ' ');
      expect(visible).not.toMatch(/\bbrief\b/i);
      expect(visible).not.toContain('缩略卡');
      expect(visible).not.toContain('通过校验的版本');
      expect(visible).not.toContain('Agent 指令');
      expect(visible).not.toContain('本地 Agent');
    }
  });
});

describe('邀请加入后直接进入引导', () => {
  it('新成员 → 采访页（欢迎语 + 先去墙上看看）；重新加入的成员仍回到墙', async () => {
    const web = (t = createTestWeb());
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId, '周末黑客松');
    const { login, postForm } = await import('./helpers.js');
    const member = await login(web, 'm@example.com', '小白');
    const joined = await postForm(web, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    expect(joined.headers.get('location')).toBe(`/w/${wall.id}/me/create?welcome=1`);
    // 已经是成员：直接进墙
    const again = await postForm(web, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    expect(again.headers.get('location')).toBe(`/w/${wall.id}`);
  });

  it('墙有必答题：引导先去回答，答完回到引导', async () => {
    const web = (t = createHostedTestWeb());
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId, '周末黑客松');
    const { saveQuestions } = await import('../src/services/wall-questions.js');
    saveQuestions(web.web.deps, wall.id, [{ id: null, index: 1, prompt: '现在的组队情况', kind: 'single', options: ['已有队伍', '在找队伍'] }]);
    const { login, postForm, get } = await import('./helpers.js');
    const member = await login(web, 'm@example.com', '小白');
    const joined = await postForm(web, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    const guide = await get(web, joined.headers.get('location') ?? '', { cookie: member.cookie });
    expect(guide.status).toBe(303);
    expect(guide.headers.get('location')).toBe(`/w/${wall.id}/questions?next=${encodeURIComponent(`/w/${wall.id}/me/create?welcome=1`)}`);
  });
});
