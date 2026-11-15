/**
 * 组织者工具（contracts 19）：必答题与按回答筛选、完成度与一键提醒、墙的群像。
 * 权限与隐私见 security/organizer-tools.security.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { groundPortrait, portraitOutputSchema, type PortraitInput } from '../src/hosted/portrait.js';
import { remindersIdle } from '../src/services/reminders.js';
import { closeWall } from '../src/services/walls.js';
import { effectiveChoices, parseQuestionForm, questionsVersion, saveQuestions, type QuestionDraft } from '../src/services/wall-questions.js';
import type { WallQuestion } from '../src/db/organizer-tools.js';
import { get, HOUR, login, seedWall, type TestSession } from './helpers.js';
import { createHostedTestWeb, joinAs, type HostedOwner, type HostedTestWeb } from './hosted-helpers.js';
import { post } from './publish-helpers.js';
import { confirmDeletion, downloadExport, requestDeletionCode } from './account-helpers.js';
import { publishPage, withdraw } from './wall-helpers.js';

let t: HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const SKILLS: QuestionDraft = { id: null, index: 0, prompt: '你最擅长哪几样？', kind: 'multi', options: ['设计', '前端', '后端'] };
const TEAM: QuestionDraft = { id: null, index: 1, prompt: '现在的组队情况', kind: 'single', options: ['已有队伍', '在找队伍'] };

interface World {
  t: HostedTestWeb;
  wall: ReturnType<typeof seedWall>['wall'];
  organizer: TestSession;
  members: HostedOwner[];
}

async function world(options: { questions?: QuestionDraft[]; members?: number } = {}): Promise<World> {
  const web = createHostedTestWeb();
  t = web;
  const organizer = await login(web, 'org@example.com', '组织者');
  const { wall } = seedWall(web, organizer.userId, '周末黑客松');
  if (options.questions) saveQuestions(web.web.deps, wall.id, options.questions);
  const members: HostedOwner[] = [];
  const names = ['阿柚', '林舟', '苏晴', '小白', '大熊'];
  for (let i = 0; i < (options.members ?? 3); i += 1) members.push(await joinAs(web, wall, `m${i}@example.com`, names[i] ?? `成员${i}`));
  return { t: web, wall, organizer, members };
}

function questionsOf(w: World): WallQuestion[] {
  return w.t.repos.questions.listForWall(w.wall.id);
}

/** 按选项文字回答（单选取第一个）。 */
async function answer(w: World, session: TestSession, choices: string[][], next?: string): Promise<Response> {
  const questions = questionsOf(w);
  const fields: Record<string, string> = { qv: questionsVersion(questions) };
  if (next) fields.next = next;
  questions.forEach((question, position) => {
    const chosen = choices[position] ?? [];
    if (question.kind === 'single') {
      if (chosen[0]) fields[`a${position}`] = String(question.options.indexOf(chosen[0]));
    } else {
      for (const label of chosen) fields[`a${position}_${question.options.indexOf(label)}`] = '1';
    }
  });
  return post(w.t, session, `/w/${w.wall.id}/questions`, fields);
}

async function html(w: World, session: TestSession, path: string): Promise<string> {
  const response = await get(w.t, path, { cookie: session.cookie });
  expect(response.status, path).toBe(200);
  return response.text();
}

describe('必答题的表单校验（parseQuestionForm）', () => {
  it('空白块忽略；选项按行或逗号、顿号拆开并去重', () => {
    const parsed = parseQuestionForm({ q0_prompt: '想去哪个部门？', q0_kind: 'single', q0_options: '宣传部\n技术部，外联部、宣传部', q1_prompt: '', q1_options: '' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.drafts).toEqual([{ id: null, index: 0, prompt: '想去哪个部门？', kind: 'single', options: ['宣传部', '技术部', '外联部'] }]);
  });

  it('题目太短、选项太少 / 太多 / 太长都给出提示', () => {
    const parsed = parseQuestionForm({
      q0_prompt: '问',
      q0_options: '甲\n乙',
      q1_prompt: '只有一个选项',
      q1_options: '甲',
      q2_prompt: '选项太长',
      q2_options: `甲\n${'长'.repeat(13)}`,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors)).toEqual(['0', '1', '2']);
    expect(parsed.errors[1]).toContain('至少写 2 个选项');
  });

  it('只写了选项、没写题目时提示补上题目', () => {
    const parsed = parseQuestionForm({ q0_prompt: '', q0_options: '甲\n乙' });
    expect(parsed.ok).toBe(false);
  });

  it('存下的回答只认现在还有的选项；单选必须正好一个', () => {
    const question = { id: 'wqn_x', wallId: 'w', position: 0, prompt: 'p', kind: 'single', options: ['甲', '乙'], createdAt: '', updatedAt: '' } as WallQuestion;
    expect(effectiveChoices(question, ['乙'])).toEqual(['乙']);
    expect(effectiveChoices(question, ['丙'])).toBeNull();
    expect(effectiveChoices(question, ['甲', '乙'])).toBeNull();
    expect(effectiveChoices({ ...question, kind: 'multi' }, ['乙', '丙', '甲'])).toEqual(['甲', '乙']);
  });
});

describe('建墙时设必答题', () => {
  it('POST /walls 带上题目：建好后墙上有这些题', async () => {
    const web = createHostedTestWeb();
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const page = await html({ t: web } as World, organizer, '/walls/new');
    expect(page).toContain('必答题');
    expect(page).toContain('data-question-template');
    const response = await post(web, organizer, '/walls', {
      name: '秋季招新',
      description: '社团招新',
      sceneType: 'club',
      q0_prompt: '想去哪个部门？',
      q0_kind: 'single',
      q0_options: '宣传部\n技术部\n外联部',
    });
    expect(response.status).toBe(303);
    const wallId = /\/w\/(wal_[a-z2-7]+)\/admin/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
    expect(web.repos.questions.listForWall(wallId).map((question) => question.prompt)).toEqual(['想去哪个部门？']);
  });

  it('题目不合格时不建墙，保留填过的内容', async () => {
    const web = createHostedTestWeb();
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const response = await post(web, organizer, '/walls', { name: '秋季招新', description: '', sceneType: 'club', q0_prompt: '想去哪个部门？', q0_options: '宣传部' });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('秋季招新');
    expect(body).toContain('至少写 2 个选项');
    expect(Number((web.db.prepare('SELECT COUNT(*) AS n FROM walls').get() as { n: number }).n)).toBe(0);
  });
});

describe('成员回答', () => {
  it('没答完先被带去回答页；答完回到原来要去的地方', async () => {
    const w = await world({ questions: [SKILLS, TEAM] });
    const member = w.members[0]!;
    for (const path of [`/w/${w.wall.id}`, `/w/${w.wall.id}/me`]) {
      const response = await get(w.t, path, { cookie: member.session.cookie });
      expect(response.status, path).toBe(303);
      expect(response.headers.get('location')).toBe(`/w/${w.wall.id}/questions?next=${encodeURIComponent(path)}`);
    }
    const form = await html(w, member.session, `/w/${w.wall.id}/questions`);
    expect(form).toContain('你最擅长哪几样？');
    expect(form).toContain('组织者能看到你的回答');
    const saved = await answer(w, member.session, [['设计', '后端'], ['在找队伍']], `/w/${w.wall.id}/me`);
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/w/${w.wall.id}/me`);
    expect((await get(w.t, `/w/${w.wall.id}`, { cookie: member.session.cookie })).status).toBe(200);
  });

  it('漏答一题：400，保留已选的，不保存', async () => {
    const w = await world({ questions: [SKILLS, TEAM] });
    const member = w.members[0]!;
    const response = await answer(w, member.session, [['设计'], []]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('请选一项');
    expect(w.t.repos.questions.answersForUser(w.wall.id, member.session.userId)).toEqual([]);
  });

  it('题目在作答期间被改了：提示再看一眼，不保存', async () => {
    const w = await world({ questions: [SKILLS] });
    const member = w.members[0]!;
    const response = await post(w.t, member.session, `/w/${w.wall.id}/questions`, { qv: 'old-version', a0_0: '1' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('组织者刚刚改了题目');
    expect(w.t.repos.questions.answersForUser(w.wall.id, member.session.userId)).toEqual([]);
  });

  it('next 只能是这面墙里的路径', async () => {
    const w = await world({ questions: [TEAM] });
    const member = w.members[0]!;
    for (const next of ['https://evil.example.com/', '//evil.example.com', '/w/wal_aaaaaaaaaaaaaaaaaaaaaaaaaa', '/account/data']) {
      const response = await answer(w, member.session, [['已有队伍']], next);
      expect(response.headers.get('location'), next).toBe(`/w/${w.wall.id}`);
    }
  });

  it('组织者加了新题：已经在墙里的人下次进墙也要先答', async () => {
    const w = await world({ members: 1 });
    const member = w.members[0]!;
    expect((await get(w.t, `/w/${w.wall.id}`, { cookie: member.session.cookie })).status).toBe(200);
    saveQuestions(w.t.web.deps, w.wall.id, [TEAM]);
    expect((await get(w.t, `/w/${w.wall.id}`, { cookie: member.session.cookie })).status).toBe(303);
  });
});

describe('墙上按回答筛选', () => {
  it('卡片带回答标签与筛选编号；筛选按钮只算墙上的卡片', async () => {
    const w = await world({ questions: [SKILLS, TEAM] });
    const [a, b, c] = w.members as [HostedOwner, HostedOwner, HostedOwner];
    await answer(w, a.session, [['设计'], ['在找队伍']]);
    await answer(w, b.session, [['设计', '前端'], ['已有队伍']]);
    await answer(w, c.session, [['后端'], ['在找队伍']]); // 没发布
    await answer(w, w.organizer, [['前端'], ['已有队伍']]);
    publishPage(w.t, a.member, '阿柚');
    publishPage(w.t, b.member, '林舟');
    const page = await html(w, a.session, `/w/${w.wall.id}`);
    expect(page).toContain('data-wall-filters');
    expect(page).toMatch(/data-filter="0:0"[^>]*>\s*设计 <span class="filter-chip__count">2<\/span>/);
    // c 没上墙：“后端”在墙上 0 人，不出现按钮
    expect(page).not.toContain('data-filter="0:2"');
    expect(page).toContain('data-answers="0:0 1:1"');
    expect(page).toContain('data-answers="0:0 0:1 1:0"');
    expect(page).toContain('class="answer-tag"');
    expect(page).toContain('我的回答');
  });

  it('只改选项保留回答（删掉的选项不再算）；改题目文字清空回答；删掉的题连回答一起删', async () => {
    const w = await world({ questions: [SKILLS, TEAM] });
    const member = w.members[0]!;
    await answer(w, member.session, [['设计', '后端'], ['在找队伍']]);
    const [skills, team] = questionsOf(w) as [WallQuestion, WallQuestion];
    const response = await post(w.t, w.organizer, `/w/${w.wall.id}/admin/questions`, {
      q0_id: skills.id,
      q0_prompt: skills.prompt,
      q0_kind: 'multi',
      q0_options: '设计\n前端\n产品',
      q1_id: team.id,
      q1_prompt: '组队了吗？',
      q1_kind: 'single',
      q1_options: '已有队伍\n在找队伍',
    });
    expect(response.status).toBe(303);
    const stored = w.t.repos.questions.answersForUser(w.wall.id, member.session.userId);
    expect(stored.map((row) => row.questionId)).toEqual([skills.id]);
    expect((await html(w, w.organizer, `/w/${w.wall.id}/admin`))).toContain('设计');
    // 再删掉第二题
    await post(w.t, w.organizer, `/w/${w.wall.id}/admin/questions`, { q0_id: skills.id, q0_prompt: skills.prompt, q0_kind: 'multi', q0_options: '设计\n前端\n产品' });
    expect(questionsOf(w).map((question) => question.id)).toEqual([skills.id]);
    expect(Number((w.t.db.prepare('SELECT COUNT(*) AS n FROM wall_answers WHERE question_id = ?').get(team.id) as { n: number }).n)).toBe(0);
  });
});

describe('完成度与一键提醒', () => {
  it('后台显示谁还没发布、谁没答完；一键提醒只发给需要的人', async () => {
    const w = await world({ questions: [TEAM], members: 4 });
    const [done, noPage, noAnswer, quiet] = w.members as [HostedOwner, HostedOwner, HostedOwner, HostedOwner];
    await answer(w, done.session, [['已有队伍']]);
    await answer(w, noPage.session, [['在找队伍']]);
    await answer(w, quiet.session, [['在找队伍']]);
    publishPage(w.t, done.member, '阿柚');
    publishPage(w.t, noAnswer.member, '苏晴');
    // quiet 关闭了提醒邮件
    expect((await post(w.t, quiet.session, '/account/notifications', { reminders: '0' })).status).toBe(303);

    const admin = await html(w, w.organizer, `/w/${w.wall.id}/admin`);
    expect(admin).toContain('完成度与提醒');
    expect(admin).toMatch(/还没发布（\d）/);
    expect(admin).toContain('还没答完必答题');
    expect(admin).toContain('一键提醒 2 人');
    expect(admin).toContain('1 人不接收提醒邮件');
    expect(admin).toContain('id="nm-remind-text"');

    const sentBefore = w.t.outbox.messages.length;
    const response = await post(w.t, w.organizer, `/w/${w.wall.id}/admin/remind`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/w/${w.wall.id}/admin?reminded=2#progress`);
    await remindersIdle(w.t.web.deps);
    const mails = w.t.outbox.messages.slice(sentBefore);
    expect(mails.map((mail) => mail.to).sort()).toEqual(['m1@example.com', 'm2@example.com']);
    const toNoPage = mails.find((mail) => mail.to === 'm1@example.com')!;
    expect(toNoPage.subject).toBe('「周末黑客松」还差你的一页');
    expect(toNoPage.body).toContain('组织者组织者提醒你');
    expect(toNoPage.body).toContain(`/w/${w.wall.id}`);
    expect(toNoPage.body).toContain('/account/data#notifications');
    expect(mails.find((mail) => mail.to === 'm2@example.com')!.subject).toBe('「周末黑客松」还差你的回答');
    expect(w.t.db.prepare("SELECT status FROM wall_reminders").all()).toEqual([{ status: 'sent' }, { status: 'sent' }]);
    expect(await html(w, w.organizer, `/w/${w.wall.id}/admin?reminded=2`)).toContain('已经给 2 位成员发了提醒邮件');
  });

  it('同一个人 48 小时内只提醒一次，同一面墙最多三次', async () => {
    const w = await world({ members: 1 });
    const remind = async () => {
      await post(w.t, w.organizer, `/w/${w.wall.id}/admin/remind`);
      await remindersIdle(w.t.web.deps);
      return w.t.outbox.messages.filter((mail) => mail.subject.includes('还差你')).length;
    };
    expect(await remind()).toBe(1);
    expect(await remind()).toBe(1);
    w.t.clock.advance(47 * HOUR);
    expect(await remind()).toBe(1);
    w.t.clock.advance(2 * HOUR);
    expect(await remind()).toBe(2);
    w.t.clock.advance(49 * HOUR);
    expect(await remind()).toBe(3);
    w.t.clock.advance(49 * HOUR);
    expect(await remind()).toBe(3);
    expect(await html(w, w.organizer, `/w/${w.wall.id}/admin`)).toContain('1 人最近已经提醒过');
  });

  it('撤下页面的人、组织者自己不被提醒；发不出去的记为 failed', async () => {
    const w = await world({ members: 2 });
    const [withdrawn, normal] = w.members as [HostedOwner, HostedOwner];
    publishPage(w.t, withdrawn.member, '阿柚');
    withdraw(w.t, withdrawn.member.page);
    const outbox = w.t.web.deps.outbox;
    const original = outbox.send.bind(outbox);
    outbox.send = () => {
      throw new Error('smtp down');
    };
    expect((await post(w.t, w.organizer, `/w/${w.wall.id}/admin/remind`)).headers.get('location')).toContain('reminded=1');
    await remindersIdle(w.t.web.deps);
    outbox.send = original;
    expect(w.t.db.prepare('SELECT user_id, status FROM wall_reminders').all()).toEqual([{ user_id: normal.session.userId, status: 'failed' }]);
  });

  it('提醒邮件开关在“我的资料”里', async () => {
    const w = await world({ members: 1 });
    const member = w.members[0]!;
    expect(await html(w, member.session, '/account/data')).toContain('接收组织者的提醒邮件');
    await post(w.t, member.session, '/account/notifications', { reminders: '0' });
    expect(w.t.repos.reminders.acceptsReminders(member.session.userId)).toBe(false);
    await post(w.t, member.session, '/account/notifications', { reminders: '1' });
    expect(w.t.repos.reminders.acceptsReminders(member.session.userId)).toBe(true);
  });

  it('成员名单 CSV：昵称、状态与回答；公式开头的内容被转义', async () => {
    const w = await world({ questions: [TEAM], members: 1 });
    const member = w.members[0]!;
    w.t.repos.users.setNickname(member.session.userId, '=HYPERLINK("x")');
    await answer(w, member.session, [['在找队伍']]);
    const response = await get(w.t, `/w/${w.wall.id}/admin/members.csv`, { cookie: w.organizer.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('"昵称","角色","加入时间","发布状态","现在的组队情况"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")","成员"`);
    expect(csv).toContain('"在找队伍"');
    expect(csv).not.toContain('@example.com');
  });
});

describe('墙的群像（groundPortrait）', () => {
  const INPUT: PortraitInput = {
    wall: { name: '周末黑客松', description: '', sceneLabel: '黑客松' },
    pages: [
      { tagline: '设计', hooks: [], answers: [] },
      { tagline: '前端', hooks: [], answers: [] },
      { tagline: '后端', hooks: [], answers: [] },
    ],
    names: ['阿柚', '林舟同学'],
  };
  const ground = (raw: unknown) => groundPortrait(portraitOutputSchema.parse(raw), INPUT);

  it('人数由平台按编号去重后自己数；不足 2 人、编号越界的不算；按人数排序', () => {
    const result = ground({
      summary: '一群想把点子做出来的人',
      themes: [
        { title: '找后端', detail: '', members: [1, 2] },
        { title: '独立游戏', detail: '晚上一起打游戏', members: [1, 2, 3, 3, '#2'] },
        { title: '一个人的话题', detail: '', members: [1, 99, 0] },
      ],
    });
    expect(result?.themes).toEqual([
      { title: '独立游戏', detail: '晚上一起打游戏', count: 3 },
      { title: '找后端', detail: '', count: 2 },
    ]);
  });

  it('名字、链接、数字人数：主题丢弃，一句话群像清空', () => {
    const result = ground({
      summary: '这里有 12 个人会设计',
      themes: [
        { title: '阿柚的粉丝', detail: '', members: [1, 2] },
        { title: '加群 evil.example.com', detail: '', members: [1, 2] },
        { title: '设计', detail: '林舟同学也是', members: [1, 2] },
      ],
    });
    expect(result).toEqual({ summary: '', themes: [{ title: '设计', detail: '', count: 2 }] });
  });

  it('什么都不剩时为 null', () => {
    expect(ground({ summary: 'https://evil.example.com', themes: [{ title: '只有我', members: [1] }] })).toBeNull();
  });
});

describe('墙的群像（生成与展示）', () => {
  async function wallWithPages(count = 3) {
    const w = await world({ questions: [TEAM], members: count });
    const names = ['阿柚', '林舟', '苏晴', '小白', '大熊'];
    for (const [index, member] of w.members.entries()) {
      await answer(w, member.session, [[index % 2 === 0 ? '在找队伍' : '已有队伍']]);
      publishPage(w.t, member.member, names[index]!);
    }
    await answer(w, w.organizer, [['已有队伍']]);
    return w;
  }

  it('组织者生成：主题人数、按回答的统计、可复制的文字；全墙成员都能看到', async () => {
    const w = await wallWithPages(3);
    const response = await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`);
    expect(response.headers.get('location')).toBe(`/w/${w.wall.id}/admin?notice=portrait-ready#portrait`);
    const page = await html(w, w.members[1]!.session, `/w/${w.wall.id}`);
    expect(page).toContain('墙的群像');
    expect(page).toContain('一群想把点子做出来的人');
    expect(page).toMatch(/大家都在找队友<\/span><span class="portrait-theme__count">3 人/);
    expect(page).not.toContain('只有一个人的话题');
    expect(page).toContain('id="nm-portrait-text"');
    expect(page).toContain('现在的组队情况：在找队伍 2 · 已有队伍 1');
    expect(page).toContain('大家最想聊：大家都在找队友（3 人）');
    // 普通成员没有生成按钮
    expect(page).not.toContain(`/w/${w.wall.id}/admin/portrait`);
  });

  it('人数不够时不调用模型', async () => {
    const w = await wallWithPages(2);
    const calls = w.t.fake.calls.length;
    const response = await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`);
    expect(response.headers.get('location')).toContain('portrait=too-few');
    expect(w.t.fake.calls.length).toBe(calls);
    expect(await html(w, w.organizer, `/w/${w.wall.id}/admin?portrait=too-few`)).toContain('至少 3 个人上墙');
  });

  it('有人撤下页面后不再展示；只是更新了页面的继续展示并说明', async () => {
    const w = await wallWithPages(3);
    await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`);
    publishPage(w.t, w.members[0]!.member, '阿柚');
    const updated = await html(w, w.members[1]!.session, `/w/${w.wall.id}`);
    expect(updated).toContain('生成后有 1 位成员更新了页面');
    withdraw(w.t, w.members[2]!.member.page);
    expect(await html(w, w.members[1]!.session, `/w/${w.wall.id}`)).not.toContain('墙的群像');
    expect(await html(w, w.organizer, `/w/${w.wall.id}/admin`)).toContain('原来的群像已停止展示');
  });

  it('每面墙每 24 小时最多 6 次；关闭墙时删除', async () => {
    const w = await wallWithPages(3);
    for (let i = 0; i < 6; i += 1) expect((await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`)).headers.get('location')).toContain('portrait-ready');
    expect((await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`)).headers.get('location')).toContain('portrait=daily');
    closeWall(w.t.web.deps, w.wall, w.organizer.userId);
    expect(w.t.repos.portraits.find(w.wall.id)).toBeNull();
  });

  it('注入的链接与编造的人数进不了群像', async () => {
    const w = await world({ members: 3 });
    for (const [index, member] of w.members.entries()) {
      const published = publishPage(w.t, member.member, `成员${index}`);
      if (index === 0) {
        const card = { ...published.card, tagline: '【假模型：注入】【假模型：人数】' };
        w.t.db.prepare('UPDATE publications SET card_json = ? WHERE id = ?').run(JSON.stringify(card), published.publicationId);
      }
    }
    await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`);
    const page = await html(w, w.members[1]!.session, `/w/${w.wall.id}`);
    expect(page).toContain('大家都在找队友');
    expect(page).not.toContain('evil.example.com');
    expect(page).not.toContain('12 个人');
  });
});

describe('注销与导出', () => {
  it('导出里有自己的回答；注销后回答与提醒记录删除', async () => {
    const w = await world({ questions: [TEAM], members: 1 });
    const member = w.members[0]!;
    await answer(w, member.session, [['在找队伍']]);
    await post(w.t, w.organizer, `/w/${w.wall.id}/admin/remind`);
    await remindersIdle(w.t.web.deps);
    const { data } = await downloadExport(w.t, member.session);
    expect(data.wallAnswers).toEqual([{ wallId: w.wall.id, wallName: '周末黑客松', prompt: '现在的组队情况', choices: ['在找队伍'], updatedAt: expect.any(String) }]);
    expect(data.receivesReminderEmails).toBe(true);
    const sent = await requestDeletionCode(w.t, member.session);
    expect((await confirmDeletion(w.t, member.session, sent.code ?? '')).status).toBe(200);
    expect(w.t.db.prepare('SELECT COUNT(*) AS n FROM wall_answers WHERE user_id = ?').get(member.session.userId)).toEqual({ n: 0 });
    expect(w.t.db.prepare('SELECT COUNT(*) AS n FROM wall_reminders WHERE user_id = ?').get(member.session.userId)).toEqual({ n: 0 });
  });
});
