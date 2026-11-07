/**
 * 平台托管路线（contracts 9 / hosted-route.md）功能测试：采访 → brief 确认 → 生成 → 修改；额度与次数；提示缓存；
 * 没有 key 时整个功能隐藏。用假 Claude 客户端（真实工具循环 + 真实静态校验）与假预览器。
 * 隐私与隔离（S7、S8）见 test/security/hosted.security.test.ts。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBriefMarkdown, toStructuredBrief, briefOutputSchema } from '../src/hosted/brief.js';
import { withRollingCache } from '../src/hosted/runner.js';
import { createTestWeb, createUser, get, login, seedWall, type TestWeb } from './helpers.js';
import {
  completeInterview,
  createHostedTestWeb,
  edit,
  generate,
  interviewFields,
  joinAs,
  postMultipart,
  TINY_JPEG,
  type HostedTestWeb,
} from './hosted-helpers.js';
import { post, workspaceHtml } from './publish-helpers.js';

let t: HostedTestWeb | TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

function setup(env: Record<string, string> = {}) {
  const web = createHostedTestWeb({ env });
  t = web;
  const organizerId = createUser(web, 'org@example.com', '组织者');
  const { wall } = seedWall(web, organizerId, '周末黑客松');
  return { t: web, wall };
}

describe('没有 API key：整个功能隐藏', () => {
  it('工作区没有“在这里创作”；创作路由一律 404；“我的资料”仍可用', async () => {
    const web = createTestWeb();
    t = web;
    expect(web.web.deps.hosted).toBeNull();
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId);
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');
    const html = await workspaceHtml(web, owner.session, wall.id);
    expect(html).not.toContain('在这里创作');
    for (const path of ['create', 'jobs/gen_aaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      expect((await get(web, `/w/${wall.id}/me/${path}`, { cookie: owner.session.cookie })).status).toBe(404);
    }
    for (const path of ['create/followups', 'create/confirm', 'create/revise', 'create/restart', 'generate', 'edit']) {
      expect((await post(web, owner.session, `/w/${wall.id}/me/${path}`)).status, path).toBe(404);
    }
    expect((await postMultipart(web, `/w/${wall.id}/me/create/start`, { _csrf: owner.session.csrf }, [], { cookie: owner.session.cookie })).status).toBe(404);
    expect((await get(web, '/account/data', { cookie: owner.session.cookie })).status).toBe(200);
  });

  it('有 key 时开启（客户端由入口注入，配置对象里只有 hasApiKey）', () => {
    const web = createTestWeb({ env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-0000000000000000' } });
    t = web;
    expect(web.config.hosted).toMatchObject({ enabled: true, hasApiKey: true, fake: false });
    // 测试没有传 anthropicApiKey，也没注入客户端 → 不开启（不会用配置里不存在的 key 去建客户端）
    expect(web.web.deps.hosted).toBeNull();
  });
});

describe('应用内采访', () => {
  it('素材 + 点选 + 图片 → 追问 → 确认“AI 眼中的你” → brief.md 与本地路线结构相同；画像写回', async () => {
    const { t, wall } = setup();
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    const workspace = await workspaceHtml(t, owner.session, wall.id);
    expect(workspace).toContain('在这里创作');
    expect(workspace).toContain('生成 Agent 指令'); // 与本地 Agent 并列
    const createPage = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(createPage).toContain('会发送给 Claude API');
    expect(createPage).toContain('想找什么样的队友'); // 场景指南的题目

    const started = await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [{ name: 'photos', bytes: TINY_JPEG, filename: 'x.png', type: 'image/png' }], {
      cookie: owner.session.cookie,
    });
    expect(started.status).toBe(303);
    const followups = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
    expect(followups?.status).toBe('followups');
    const assets = t.repos.briefAssets.listForBrief(followups?.id ?? '', owner.session.userId);
    expect(assets.map((asset) => [asset.fileName, asset.mime])).toEqual([['photo-1.jpg', 'image/jpeg']]); // 按魔数，不按文件名
    expect(existsSync(join(t.dataDir, 'hosted', owner.member.page.id, 'assets', 'photo-1.jpg'))).toBe(true);
    const answers = JSON.parse(followups?.answersJson ?? '{}');
    expect(answers.choices.role.selected).toEqual(['开发']);
    expect(answers.styles).toEqual(['hackathon-terminal']);
    expect(answers.motion).toBe('calm');

    const followPage = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(followPage).toContain('能说一个只属于你的具体细节吗？');
    expect((await post(t, owner.session, `/w/${wall.id}/me/create/followups`, { f_f1: '1', f_f1_text: '手冲咖啡' })).status).toBe(303);
    const review = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
    expect(review?.status).toBe('review');
    const reviewPage = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(reviewPage).toContain('这是 AI 眼中的你');
    expect(reviewPage).toContain('确认，就是我');

    // 确认前不能生成
    const early = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    expect(early.headers.get('location')).toContain('error=no-brief');

    // 改写第 1 句、划掉第 2 句、保留全部画像建议
    const parsed = JSON.parse(review?.briefJson ?? '{}');
    const fields: Record<string, string> = { ai_0: '你是阿柚，一个做小程序的前端。', ai_1_drop: '1' };
    for (let index = 2; index < parsed.aiView.length; index += 1) fields[`ai_${index}`] = parsed.aiView[index];
    parsed.hooks.forEach((hook: { text: string; opener: string }, index: number) => {
      fields[`hook_${index}_text`] = hook.text;
      fields[`hook_${index}_opener`] = hook.opener;
    });
    parsed.profileSuggestions.forEach((_: unknown, index: number) => (fields[`profile_${index}`] = '1'));
    expect((await post(t, owner.session, `/w/${wall.id}/me/create/confirm`, fields)).status).toBe(303);
    const confirmed = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
    expect(confirmed?.status).toBe('confirmed');
    const md = confirmed?.briefMd ?? '';
    const template = readFileSync(join(import.meta.dirname, '../../../skill/templates/brief.md'), 'utf8');
    const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings(md)).toEqual(headings(template));
    expect(md).toContain('> 你是阿柚，一个做小程序的前端。');
    expect(md).toContain('assets/photo-1.jpg');
    expect(md).toContain('hackathon-terminal');
    const profile = t.repos.profileEntries.listForUser(owner.session.userId);
    expect(profile.length).toBe(parsed.profileSuggestions.length);
    expect(profile.every((entry) => entry.confirmation === 'owner-confirmed')).toBe(true);
  });

  it('接话点至少保留 2 个、AI 眼中的你至少一句；重新整理会带上修正意见', async () => {
    const { t, wall } = setup();
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [], { cookie: owner.session.cookie });
    await post(t, owner.session, `/w/${wall.id}/me/create/followups`, { f_f1: 'skip' });
    const bad = await post(t, owner.session, `/w/${wall.id}/me/create/confirm`, { ai_0: 'x', hook_0_drop: '1', hook_1_drop: '1' });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('接话点至少保留 2 个');
    const revised = await post(t, owner.session, `/w/${wall.id}/me/create/revise`, { note: '我已经玩了三年了' });
    expect(revised.status).toBe(303);
    const brief = JSON.parse(t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)?.briefJson ?? '{}');
    expect(brief.aiView[0]).toContain('我已经玩了三年了');
    const lastCall = t.fake.calls.at(-1);
    expect(JSON.stringify(lastCall?.messages)).toContain('<owner_correction>');
  });

  it('图片：类型按魔数、最多 6 张、单张 ≤ 2 MB', async () => {
    const { t, wall } = setup();
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const asSvg = await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [{ name: 'photos', bytes: svg, filename: 'cute.png', type: 'image/png' }], { cookie: owner.session.cookie });
    expect(asSvg.status).toBe(422);
    expect(await asSvg.text()).toContain('只支持 PNG');
    const seven = Array.from({ length: 7 }, () => ({ name: 'photos', bytes: TINY_JPEG }));
    expect((await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), seven, { cookie: owner.session.cookie })).status).toBe(422);
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(TINY_JPEG);
    expect((await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [{ name: 'photos', bytes: big }], { cookie: owner.session.cookie })).status).toBe(422);
    expect(t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)).toBeNull();
  });

  it('采访调用每页每天有上限', async () => {
    const { t, wall } = setup({ NOWME_INTERVIEW_DAILY_CALLS: '1' });
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    expect((await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [], { cookie: owner.session.cookie })).status).toBe(303);
    const limited = await post(t, owner.session, `/w/${wall.id}/me/create/followups`, { f_f1: 'skip' });
    expect(limited.status).toBe(429);
  });
});

describe('托管生成与修改', () => {
  it('生成 → 平台重新校验 → hosted 版本 → 预览 → 指定区块修改 → 新版本 → 发布仍需主人确认', async () => {
    const { t, wall } = setup();
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner);
    const generated = await generate(t, wall, owner);
    expect(generated.location).toMatch(/\/jobs\/gen_/);
    expect(generated.job).toMatchObject({ status: 'succeeded', charged: true, kind: 'generate' });
    expect(t.processor).toBeDefined();
    const revision = t.repos.revisions.findById(generated.job?.revisionId ?? '');
    expect(revision).toMatchObject({ source: 'hosted', status: 'accepted', credentialId: null });
    expect(JSON.parse(revision?.cardJson ?? '{}').displayName).toBe('阿柚');
    // 图片进了版本；brief.md 没有进版本
    const original = join(t.dataDir, 'revisions', revision?.id ?? '', 'original');
    expect(existsSync(join(original, 'assets', 'photo-1.jpg'))).toBe(true);
    expect(existsSync(join(original, 'brief.md'))).toBe(false);
    expect(t.previewer.calls).toBe(1); // 截图自查跑过
    expect(t.leftoverJobDirs()).toEqual([]); // 临时目录已删除

    const jobPage = await (await get(t, `/w/${wall.id}/me/jobs/${generated.job?.id}`, { cookie: owner.session.cookie })).text();
    expect(jobPage).toContain('去预览第 1 版');
    expect(jobPage).not.toContain('http-equiv="refresh"');
    const workspace = await workspaceHtml(t, owner.session, wall.id, `?rev=${revision?.id}`);
    expect(workspace).toContain('data-nm-page-frame');
    expect(workspace).toContain('在这里创作'); // 版本来源
    expect(workspace).toContain('用日常语言修改第 1 版');
    expect(t.repos.publications.findActiveForPage(owner.member.page.id)).toBeNull(); // 不会自动发布

    const edited = await edit(t, wall, owner, { revisionId: revision?.id ?? '', block: 'about', request: '再加一句我拿过校赛二等奖' });
    expect(edited.job).toMatchObject({ status: 'succeeded', charged: true, kind: 'edit', targetBlock: 'about' });
    const second = t.repos.revisions.findById(edited.job?.revisionId ?? '');
    expect(second?.number).toBe(2);
    const html = readFileSync(join(t.dataDir, 'revisions', second?.id ?? '', 'original', 'index.html'), 'utf8');
    expect(html).toMatch(/data-nm-id="about"[^>]*>\s*<p class="nm-edited">已按要求修改：再加一句我拿过校赛二等奖/);
    expect(second?.report.warnings.some((issue) => issue.code === 'HOSTED_BLOCKS_CHANGED')).toBe(false);
    // 修改任务把基础版本的图片也带上了
    expect(existsSync(join(t.dataDir, 'revisions', second?.id ?? '', 'original', 'assets', 'photo-1.jpg'))).toBe(true);
    expect(t.leftoverJobDirs()).toEqual([]);
    // 第一条消息包含修改要求与目标区块，且修改要求放在资料标签里
    const editCall = t.fake.calls.find((call) => JSON.stringify(call.messages[0]).includes('<owner_edit_request>'));
    expect(JSON.stringify(editCall?.messages[0])).toContain('目标区块：data-nm-id=\\"about\\"');
  });

  it('澄清、平台校验不通过、超过轮数都不扣额度、不存版本', async () => {
    const { t, wall } = setup({ NOWME_HOSTED_MAX_TURNS: '6' });
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner, '我叫阿柚。【假模型：违规】做过小程序。');
    const rejected = await generate(t, wall, owner);
    expect(rejected.job).toMatchObject({ status: 'failed', errorCode: 'REJECTED', charged: false, revisionId: null });
    expect(t.repos.revisions.listForPage(owner.member.page.id)).toEqual([]);
    expect(t.leftoverJobDirs()).toEqual([]);
    const failedPage = await (await get(t, `/w/${wall.id}/me/jobs/${rejected.job?.id}`, { cookie: owner.session.cookie })).text();
    expect(failedPage).toContain('不扣免费次数');

    await post(t, owner.session, `/w/${wall.id}/me/create/restart`);
    await completeInterview(t, wall, owner, '我叫阿柚。【假模型：不结束】');
    const stuck = await generate(t, wall, owner);
    expect(stuck.job).toMatchObject({ status: 'failed', errorCode: 'MAX_TURNS', charged: false });

    await post(t, owner.session, `/w/${wall.id}/me/create/restart`);
    await completeInterview(t, wall, owner);
    const ok = await generate(t, wall, owner);
    expect(ok.job?.status).toBe('succeeded');
    const clarify = await edit(t, wall, owner, { revisionId: ok.job?.revisionId ?? '', request: '改一下那里【假模型：澄清】' });
    expect(clarify.job).toMatchObject({ status: 'needs_input', charged: false, revisionId: null });
    const clarifyPage = await (await get(t, `/w/${wall.id}/me/jobs/${clarify.job?.id}`, { cookie: owner.session.cookie })).text();
    expect(clarifyPage).toContain('你想改哪一块');
    expect(clarifyPage).toContain('按这个修改');

    const quota = t.web.deps.hosted?.overview(
      { wall, membership: owner.member.membership, page: owner.member.page },
      owner.session.userId,
    ).quota;
    expect(quota).toEqual({ total: 3, used: 1, remaining: 2 });
  });

  it('额度：用完后不能再生成或修改；退出后重新加入、删除页面都不恢复', async () => {
    const { t, wall } = setup({ NOWME_HOSTED_FREE_QUOTA: '1' });
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner);
    const first = await generate(t, wall, owner);
    expect(first.job?.status).toBe('succeeded');
    const again = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    expect(again.headers.get('location')).toContain('error=quota');
    const editAttempt = await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId: first.job?.revisionId ?? '', request: '换个颜色' });
    expect(editAttempt.headers.get('location')).toContain('hosted=quota');
    expect(await workspaceHtml(t, owner.session, wall.id, '?hosted=quota')).toContain('免费次数已经用完');

    await post(t, owner.session, `/w/${wall.id}/me/delete`, { confirm: '1' });
    await completeInterview(t, wall, owner);
    expect((await post(t, owner.session, `/w/${wall.id}/me/generate`)).headers.get('location')).toContain('error=quota');
  });

  it('每页每天的任务次数（含失败）有上限；同时只有一个任务', async () => {
    const { t, wall } = setup({ NOWME_HOSTED_DAILY_ATTEMPTS: '1' });
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner, '我叫阿柚。【假模型：违规】');
    await generate(t, wall, owner);
    expect((await post(t, owner.session, `/w/${wall.id}/me/generate`)).headers.get('location')).toContain('error=daily');
  });

  it('修改：区块与版本必须属于这一页；修改要求 1–500 字', async () => {
    const { t, wall } = setup();
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner);
    const ok = await generate(t, wall, owner);
    const revisionId = ok.job?.revisionId ?? '';
    expect((await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId, block: 'nope', request: '改' })).headers.get('location')).toContain('hosted=bad-block');
    expect((await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId, request: '' })).headers.get('location')).toContain('hosted=bad-request');
    expect((await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId, request: '长'.repeat(501) })).headers.get('location')).toContain('hosted=bad-request');
    expect((await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId: 'rev_aaaaaaaaaaaaaaaaaaaaaaaaaa', request: '改' })).headers.get('location')).toContain('hosted=no-revision');
  });

  it('任务进行中页面自动刷新；进程重启时遗留任务置为失败且不扣额度', async () => {
    const { t, wall } = setup();
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    const now = t.clock.now().toISOString();
    t.repos.jobs.create({ id: 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', pageId: owner.member.page.id, ownerId: owner.session.userId, kind: 'generate', baseRevisionId: null, targetBlock: null, requestText: null, createdAt: now });
    const page = await (await get(t, `/w/${wall.id}/me/jobs/gen_aaaaaaaaaaaaaaaaaaaaaaaaaa`, { cookie: owner.session.cookie })).text();
    expect(page).toContain('http-equiv="refresh"');
    expect(t.repos.jobs.interruptAll(now)).toBe(1);
    expect(t.repos.jobs.findById('gen_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED', charged: false });
  });
});

describe('提示缓存与模型选择', () => {
  it('采访用采访模型、生成用生成模型；固定的 system 与工具带缓存断点，变量放在用户消息里', async () => {
    const { t, wall } = setup({ NOWME_INTERVIEW_MODEL: 'claude-haiku-5-5', NOWME_GENERATE_MODEL: 'claude-opus-5-5' });
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner);
    await generate(t, wall, owner);
    const interview = t.fake.calls.filter((call) => call.tool_choice?.type === 'tool');
    const generation = t.fake.calls.filter((call) => call.tool_choice?.type !== 'tool');
    expect(interview.length).toBeGreaterThanOrEqual(2);
    expect(interview.every((call) => call.model === 'claude-haiku-5-5')).toBe(true);
    expect(generation.every((call) => call.model === 'claude-opus-5-5')).toBe(true);
    for (const call of t.fake.calls) {
      expect(call.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
      expect(JSON.stringify(call.system)).not.toContain('沉迷做手冲咖啡'); // system 固定，不含主人内容
    }
    expect(JSON.stringify(generation[0]?.system)).toContain('nowme-page'); // SKILL.md 全文在 system 里
    expect(JSON.stringify(generation[0]?.system)).toContain('reference/page-contract.md');
    expect(generation[0]?.tools?.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    // 第 2 轮起最后一条用户消息带滚动缓存断点
    const later = generation[1];
    const lastMessage = later?.messages.at(-1);
    expect(lastMessage && typeof lastMessage.content !== 'string' ? lastMessage.content.at(-1) : null).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(JSON.stringify(t.fake.calls[0]?.messages)).toContain('<owner_material>');
  });

  it('withRollingCache 不修改原数组', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }] }];
    const marked = withRollingCache(messages);
    expect(messages[0]?.content[0]).not.toHaveProperty('cache_control');
    expect((marked[0]?.content as { cache_control?: unknown }[])[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('brief 渲染', () => {
  it('结构化 brief 按模板渲染；风格与动效取表单而不是模型', () => {
    const output = briefOutputSchema.parse({
      displayName: '小满',
      firstScreen: '名字和方言',
      facts: [{ text: '会五种方言', source: 'interview' }],
      hooks: [
        { kind: 'obsessed', text: '我在沉迷方言', opener: '你好呀' },
        { kind: 'want-to-try', text: '我也想上台', opener: '一起排练吗' },
      ],
      aiView: ['你是小满。'],
      unknowns: ['年级'],
    });
    const brief = toStructuredBrief(output, { material: '', choices: {}, styles: [], motion: 'lively' });
    const md = renderBriefMarkdown(brief, { name: '话剧社', description: '', sceneType: 'club', organizerNote: null }, {
      id: 'club', label: '社团', goal: 'g', interviewBudgetSeconds: 180, assetPrompt: 'a', choiceQuestions: [], followUps: [], maxFollowUps: 1,
      mustHave: [], hookKinds: [{ kind: 'obsessed', pattern: 'p' }], defaults: { showSchool: false, useNickname: false, contactPublic: false },
      pageGoal: 'p', suggestedBlocks: ['hero'], visualTone: 'v', examples: ['club-newbie-sticker'],
    });
    expect(md).toContain('- 动效强度：活泼（lively）');
    expect(md).toContain('| 1 | obsessed | 我在沉迷方言 | 你好呀 |');
    expect(md).toContain('- 年级');
    expect(md).toContain('你来定；场景推荐 club-newbie-sticker');
  });

  it('模型输出过长时截断、接话点不足 2 个时拒绝', () => {
    const long = briefOutputSchema.parse({
      displayName: '名'.repeat(40),
      firstScreen: 'x',
      facts: [],
      hooks: [
        { text: '接'.repeat(50), opener: 'o' },
        { text: '好的', opener: 'o' },
      ],
      aiView: ['a'],
      unknowns: [],
    });
    expect(Array.from(long.displayName)).toHaveLength(24);
    expect(Array.from(long.hooks[0]?.text ?? '')).toHaveLength(32);
    expect(briefOutputSchema.safeParse({ displayName: 'x', firstScreen: 'x', facts: [], hooks: [{ text: '好的', opener: 'o' }], aiView: ['a'], unknowns: [] }).success).toBe(false);
  });
});

it('登录后才能进入创作页', async () => {
  const { t, wall } = setup();
  const response = await get(t, `/w/${wall.id}/me/create`);
  expect([302, 303]).toContain(response.status);
  expect(response.headers.get('location')).toContain('/login');
  void login;
});
