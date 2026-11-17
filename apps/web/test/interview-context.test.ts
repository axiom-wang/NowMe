import { afterEach, describe, expect, it } from 'vitest';
import { generateId } from '@nowme/contracts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createUser, seedWall } from './helpers.js';
import { completeInterview, createHostedTestWeb, generate, get, interviewFields, joinAs, post, postMultipart, TINY_JPEG, type HostedTestWeb } from './hosted-helpers.js';
import { migrate } from '../src/db/database.js';
import { publish } from './publish-helpers.js';
import { findOwnPage } from '../src/services/access.js';
import { relevantProfile } from '../src/hosted/known-context.js';
import { normalizedProfileText, similarEntries } from '../src/hosted/profile.js';

let t: HostedTestWeb;
afterEach(async () => { await t?.close(); });
async function setup() {
  t = createHostedTestWeb();
  const { wall } = seedWall(t, createUser(t, 'org@context.test'), '采访上下文');
  const owner = await joinAs(t, wall, 'owner@context.test', '阿柚');
  return { wall, owner, own: findOwnPage(t.repos, owner.session.userId, wall.id)! };
}
function profile(userId: string, text: string, scope = 'all', questionKey: string | null = null) {
  const entry = { id: generateId('pfe'), userId, text, scope, questionKey, category: 'fact' as const, source: 'interview' as const, confirmation: 'owner-confirmed' as const, createdAt: t.clock.now().toISOString(), updatedAt: t.clock.now().toISOString() };
  t.repos.profileEntries.insert(entry);
  return entry;
}

describe('轻量采访与上下文', () => {
  it('旧数据库画像迁移保留内容，缺少范围和来源的旧条目仍可复用', async () => {
    const { owner } = await setup();
    const saved = profile(owner.session.userId, '我做过三个校园小程序');
    // 回到 022 的表形状，再运行正式迁移，验证已有行不丢失。
    t.db.exec('ALTER TABLE profile_entries DROP COLUMN scope');
    t.db.exec('ALTER TABLE profile_entries DROP COLUMN source_wall_id');
    t.db.exec('ALTER TABLE profile_entries DROP COLUMN question_key');
    t.db.exec('ALTER TABLE generation_jobs DROP COLUMN remember_facts');
    t.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run('023_interview_context.sql');
    expect(migrate(t.db)).toEqual(['023_interview_context.sql']);
    expect(t.repos.profileEntries.listForUser(owner.session.userId)[0]).toMatchObject({ id: saved.id, text: saved.text, scope: 'all', sourceWallId: null, questionKey: null });
    expect(migrate(t.db)).toEqual([]);
  });

  it('一次调用直接给草稿；不答追问即可确认，并明确确认显示名和边界', async () => {
    const { wall, owner } = await setup();
    await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [], { cookie: owner.session.cookie });
    expect(t.fake.calls).toHaveLength(1);
    const html = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(html).toContain('先确认名字与展示边界');
    expect(html).toContain('补一个例子（可选）');
    expect(html).not.toMatch(/name="f_f1"[^>]*checked/);
    expect((await post(t, owner.session, `/w/${wall.id}/me/create/confirm`, { displayName: '小柚', showSchool: '1', hidden: '成绩；真名' })).status).toBe(303);
    expect(t.fake.calls).toHaveLength(1);
    const brief = JSON.parse(t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)!.briefJson!);
    expect(brief.displayName).toBe('小柚');
    expect(brief.boundaries).toMatchObject({ school: '显示', photo: '不可以', hidden: ['成绩', '真名'] });
  });

  it('直接确认时补充不会丢；失败后重试保留补充和同时改过的边界', async () => {
    const { wall, owner } = await setup();
    await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [], { cookie: owner.session.cookie });
    const create = t.fake.createMessage.bind(t.fake);
    t.fake.createMessage = async () => { throw new Error('offline'); };
    const failed = await post(t, owner.session, `/w/${wall.id}/me/create/confirm`, { f_f1_text: '我焊过一把键盘', displayName: '小柚', showSchool: '1', ai_0: '我自己焊键盘' });
    expect(failed.status).toBe(422);
    const failedHtml = await failed.text();
    expect(failedHtml).toContain('value="小柚"');
    expect(failedHtml).toContain('value="我焊过一把键盘"');
    expect(failedHtml).toMatch(/name="showSchool"[^>]*checked/);
    expect(failedHtml).not.toMatch(/name="profile_0"[^>]*checked/);
    expect(JSON.parse(t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)!.followupsJson!).pending).toBe(true);
    t.fake.createMessage = create;
    const retried = await post(t, owner.session, `/w/${wall.id}/me/create/followups`, {});
    expect(retried.status).toBe(303);
    const record = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)!;
    expect(record.status).toBe('review');
    expect(JSON.parse(record.briefJson!).boundaries).toMatchObject({ school: '显示', photo: '不可以' });
    expect(JSON.parse(record.briefJson!).aiView[0]).toBe('我自己焊键盘');
    expect(JSON.parse(record.briefJson!).profileSelection).toEqual([]);
    expect(JSON.stringify(t.fake.calls.at(-1))).toContain('我焊过一把键盘');
    expect(JSON.parse(record.followupsJson!).pending).toBe(false);
  });

  it('只复用本人有效必答题与相关画像；题目对应时预填；足够素材只需本页意图', async () => {
    const { wall, owner, own } = await setup();
    const scene = t.web.deps.hosted!.scene(own);
    const question = scene.choiceQuestions.find((q) => q.id === 'role')!;
    const id = generateId('wqn');
    const now = t.clock.now().toISOString();
    t.repos.questions.insert({ id, wallId: wall.id, position: 0, prompt: question.question, kind: 'single', options: ['开发', '设计'], createdAt: now, updatedAt: now });
    t.repos.questions.saveAnswer(wall.id, id, owner.session.userId, ['开发', '已删除的选项'], now);
    const otherId = createUser(t, 'other@context.test');
    t.repos.questions.saveAnswer(wall.id, id, otherId, ['设计'], now);
    profile(owner.session.userId, '我做过一套校园二手书交换的小程序，写了完整的前端');
    profile(owner.session.userId, '我每周都会拍街头的招牌，已经拍了一整年');
    profile(owner.session.userId, '我能连讲十分钟手冲咖啡的萃取方法');
    profile(owner.session.userId, '仅兴趣墙的私有条目', 'interest');
    profile(otherId, '别人的私有画像');
    const known = t.web.deps.hosted!.known(own, owner.session.userId);
    expect(known.fast).toBe(true);
    expect(known.choices.role?.selected).toEqual(['开发']);
    const html = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(html).toContain('这次只说你想突出的那一面');
    expect(html).toContain('name="reuse_role"');
    expect(html).not.toContain('别人的私有画像');
    await postMultipart(t, `/w/${wall.id}/me/create/start`, { _csrf: owner.session.csrf, intent: '想找人一起做游戏', reuse_role: '1' }, [], { cookie: owner.session.cookie });
    const request = JSON.stringify(t.fake.calls[0]);
    expect(request).toContain('owner_wall_answers');
    expect(request).toContain('校园二手书');
    expect(request).not.toContain('已删除的选项');
    expect(request).not.toContain('仅兴趣墙的私有条目');
    expect(request).not.toContain('别人的私有画像');
  });

  it('旧画像与不同措辞的必答题也会减少表单题，保留原文而不猜选项', async () => {
    const { wall, owner, own } = await setup();
    profile(owner.session.userId, '做过 React 前端项目，还不会后端');
    const now = t.clock.now().toISOString();
    const id = generateId('wqn');
    t.repos.questions.insert({ id, wallId: wall.id, position: 0, prompt: '想找什么队友一起做？', kind: 'single', options: ['会画画的朋友'], createdAt: now, updatedAt: now });
    t.repos.questions.saveAnswer(wall.id, id, owner.session.userId, ['会画画的朋友'], now);
    const known = t.web.deps.hosted!.known(own, owner.session.userId);
    expect(known.choices.skills).toEqual({ selected: [], text: '做过 React 前端项目，还不会后端' });
    expect(known.choices.teammate?.text).toBe('想找什么队友一起做？：会画画的朋友');
    expect(known.choices.role).toBeUndefined();
    const html = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(html).toContain('name="reuse_skills"');
    expect(html).not.toContain('name="q_skills_0"');
  });

  it('快问快答只接受配置内原话，填空与选中话题进入采访', async () => {
    const { wall, owner } = await setup();
    await postMultipart(t, `/w/${wall.id}/me/create/start`, { ...interviewFields(owner.session), quick_snapshot: '0', starter_0: '做交互原型', starter_1: '我收藏的老相机', topic_0: '1' }, [], { cookie: owner.session.cookie });
    const request = JSON.stringify(t.fake.calls[0]);
    expect(request).toContain('凌晨三点，我还在改 bug');
    expect(request).toContain('朋友最常找我帮忙的是做交互原型');
    expect(request).not.toContain('主人明确选中想聊的话题'); // 无有效群像不能伪造选项
  });

  it('重开保留文字、点选、原图、追问回答与更正', async () => {
    const { wall, owner } = await setup();
    await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [{ name: 'photos', bytes: TINY_JPEG }], { cookie: owner.session.cookie });
    await post(t, owner.session, `/w/${wall.id}/me/create/followups`, { f_f1_text: '我自己焊了一把键盘' });
    await post(t, owner.session, `/w/${wall.id}/me/create/revise`, { note: '我已经玩了三年' });
    const before = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)!;
    await post(t, owner.session, `/w/${wall.id}/me/create/restart`);
    const after = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)!;
    expect(after.id).toBe(before.id);
    expect(after.status).toBe('collecting');
    expect(after.answersJson).toContain('我自己焊了一把键盘');
    expect(after.answersJson).toContain('我已经玩了三年');
    expect(existsSync(join(t.dataDir, 'hosted', owner.member.page.id, 'assets/photo-1.jpg'))).toBe(true);
    const html = await (await get(t, `/w/${wall.id}/me/create`, { cookie: owner.session.cookie })).text();
    expect(html).toContain('做过 3 个校园小程序');
    expect(html).toContain('已保存 1 张图片');
    await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [], { cookie: owner.session.cookie });
    expect(JSON.stringify(t.fake.calls.at(-1))).toContain('我自己焊了一把键盘');
  });

  it('生成首条消息含原图；成功修改写回 brief，默认不记画像，勾选才记住', async () => {
    const { wall, owner } = await setup();
    await completeInterview(t, wall, owner);
    const first = await generate(t, wall, owner);
    const generation = t.fake.calls.find((c) => c.tool_choice?.type === 'auto');
    expect(JSON.stringify(generation?.messages[0])).toContain(Buffer.from(TINY_JPEG).toString('base64'));
    const before = t.repos.profileEntries.listForUser(owner.session.userId).length;
    let revisionId = first.job!.revisionId!;
    for (const [request, rememberFacts] of [['再加一句我拿过校赛二等奖', '0'], ['再加一句我自己焊过键盘', '1']]) {
      const response = await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId, request: request!, rememberFacts: rememberFacts! });
      expect(response.status).toBe(303);
      await t.web.deps.hosted!.idle();
      const id = response.headers.get('location')!.split('/').at(-1)!;
      const job = t.repos.jobs.findById(id)!;
      expect(job.status).toBe('succeeded');
      revisionId = job.revisionId!;
    }
    const brief = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)!;
    expect(brief.briefMd).toContain('我拿过校赛二等奖');
    expect(brief.answersJson).toContain('我拿过校赛二等奖');
    const entries = t.repos.profileEntries.listForUser(owner.session.userId);
    expect(entries).toHaveLength(before + 1);
    expect(entries.find((e) => e.text === '我自己焊过键盘')).toMatchObject({ text: '我自己焊过键盘', scope: wall.sceneType, sourceWallId: wall.id });
    await generate(t, wall, owner);
    expect(JSON.stringify(t.fake.calls.at(-1))).toContain('我拿过校赛二等奖');
  });

  it('风格快捷指令保留同时写的新事实，修改失败时保留记忆选择', async () => {
    const { wall, owner } = await setup();
    await completeInterview(t, wall, owner);
    const generated = await generate(t, wall, owner);
    const response = await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId: generated.job!.revisionId!, request: '再加一句我拿过校赛二等奖', shortcut: '更大胆', rememberFacts: '1' });
    await t.web.deps.hosted!.idle();
    const job = t.repos.jobs.findById(response.headers.get('location')!.split('/').at(-1)!)!;
    expect(job.requestText).toBe('再加一句我拿过校赛二等奖；更大胆');
    expect(job.rememberFacts).toBe(true);
    const rejected = await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId: generated.job!.revisionId!, request: 'x'.repeat(500), shortcut: '更大胆', rememberFacts: '1' });
    expect(rejected.status).toBe(422);
    expect(await rejected.text()).toMatch(/name="rememberFacts"[^>]*checked/);
  });

  it('仅当前可展示的公开群像给话题选项，撤下来源后不再提供', async () => {
    const { wall, owner, own } = await setup();
    await completeInterview(t, wall, owner);
    const generated = await generate(t, wall, owner);
    const revision = t.repos.revisions.findById(generated.job!.revisionId!)!;
    await publish(t, owner.session, wall.id, revision.id, JSON.parse(revision.cardJson!));
    const publication = t.repos.publications.findActiveForPage(owner.member.page.id)!;
    t.repos.portraits.replace({ wallId: wall.id, resultJson: JSON.stringify({ summary: '有人喜欢做独立游戏', themes: [{ title: '独立游戏', detail: '动手做游戏', count: 1 }], stats: [] }), sources: [publication.id], pageCount: 1, createdBy: owner.session.userId, createdAt: t.clock.now().toISOString() });
    expect(t.web.deps.hosted!.known(own, owner.session.userId).topics).toEqual(['独立游戏']);
    await post(t, owner.session, `/w/${wall.id}/me/create/restart`);
    await postMultipart(t, `/w/${wall.id}/me/create/start`, { ...interviewFields(owner.session), topic_0: '1' }, [], { cookie: owner.session.cookie });
    expect(JSON.stringify(t.fake.calls.at(-1))).toContain('主人明确选中想聊的话题 → 独立游戏');
    t.db.prepare("UPDATE publications SET ended_at = ?, end_reason = 'withdrawn' WHERE id = ?").run(t.clock.now().toISOString(), publication.id);
    expect(t.web.deps.hosted!.known(own, owner.session.userId).topics).toEqual([]);
  });

  it('画像可手动新增、编辑、人工合并；范围限制选择，近似不自动删除', async () => {
    expect(normalizedProfileText('C#')).not.toBe(normalizedProfileText('C'));
    expect(normalizedProfileText('.NET')).not.toBe(normalizedProfileText('NET'));
    expect(normalizedProfileText('我喜欢做游戏。')).toBe(normalizedProfileText('我喜欢做游戏')); 
    const { owner, wall } = await setup();
    for (const text of ['我喜欢做独立游戏', '我喜欢做独立小游戏']) expect((await post(t, owner.session, '/account/profile/entry', { text, category: 'fact', scope: 'hackathon' })).status).toBe(303);
    const entries = t.repos.profileEntries.listForUser(owner.session.userId);
    expect(similarEntries(entries[0]!, entries)).toHaveLength(1);
    expect(relevantProfile(entries, 'interest', wall.id)).toHaveLength(0);
    expect((await post(t, owner.session, '/account/profile/entry', { entryId: entries[0]!.id, mergeId: entries[1]!.id, text: '我喜欢做独立小游戏，负责美术', category: 'fact', scope: 'all' })).status).toBe(303);
    expect(t.repos.profileEntries.listForUser(owner.session.userId)).toHaveLength(1);
    expect((await post(t, owner.session, '/account/profile/entry', { text: 'x'.repeat(201), category: 'fact', scope: 'all' })).status).toBe(400);
  });
});
