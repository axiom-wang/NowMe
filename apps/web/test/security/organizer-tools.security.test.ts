/**
 * S13 组织者工具的安全不变量（contracts 19.4）：
 * - 只有这面墙的组织者能改必答题、一键提醒、生成群像、下载成员名单；其他人（成员、墙外的人、被移出的人、页面凭证）一律 404 / 无效；
 * - 回答只在墙内可见：组织者看得到全部有效成员的回答；墙上只出现已上墙成员的回答；墙外与被移出的人看不到；
 * - 提醒邮件是固定模板：组织者看不到任何人的邮箱、不能写正文；不发给关闭提醒、拉黑了组织者、停用的账号；
 * - 群像只读墙上可见的发布快照：不含名字、草稿、渲染文字、联系方式与没上墙的人；输出里没有链接、名字与数字人数。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { remindersIdle } from '../../src/services/reminders.js';
import { removeMember } from '../../src/services/walls.js';
import { questionsVersion, saveQuestions } from '../../src/services/wall-questions.js';
import { connectAgent, get, login, postForm, seedWall, type TestSession } from '../helpers.js';
import { createHostedTestWeb, joinAs, type HostedOwner, type HostedTestWeb } from '../hosted-helpers.js';
import { post } from '../publish-helpers.js';
import { publishPage } from '../wall-helpers.js';

let t: HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const SECRET_ANSWER = '秘密部门';

async function world() {
  const web = createHostedTestWeb();
  t = web;
  const organizer = await login(web, 'org@example.com', '组织者');
  const { wall } = seedWall(web, organizer.userId, '周末黑客松');
  saveQuestions(web.web.deps, wall.id, [{ id: null, index: 0, prompt: '想去哪个部门？', kind: 'single', options: ['宣传部', SECRET_ANSWER] }]);
  const members: HostedOwner[] = [];
  for (const [i, name] of ['阿柚', '林舟', '苏晴', '小白'].entries()) members.push(await joinAs(web, wall, `m${i}@example.com`, name));
  const outsider = await login(web, 'outsider@example.com', '路人');
  const answer = (session: TestSession, option: number) => post(web, session, `/w/${wall.id}/questions`, { qv: questionsVersion(web.repos.questions.listForWall(wall.id)), a0: String(option) });
  return { t: web, wall, organizer, members, outsider, answer };
}

const ADMIN_POSTS = ['/admin/questions', '/admin/remind', '/admin/portrait'];

describe('S13 只有组织者能用组织者工具', () => {
  it('成员、墙外的人：后台的工具一律 404，什么都不改、不发、不调用模型', async () => {
    const w = await world();
    const calls = w.t.fake.calls.length;
    for (const session of [w.members[0]!.session, w.outsider]) {
      for (const path of ADMIN_POSTS) {
        const response = await post(w.t, session, `/w/${w.wall.id}${path}`, { q0_prompt: '被改了的题', q0_options: '甲\n乙' });
        expect(response.status, path).toBe(404);
      }
      expect((await get(w.t, `/w/${w.wall.id}/admin/members.csv`, { cookie: session.cookie })).status).toBe(404);
    }
    expect(w.t.repos.questions.listForWall(w.wall.id).map((question) => question.prompt)).toEqual(['想去哪个部门？']);
    expect(w.t.db.prepare('SELECT COUNT(*) AS n FROM wall_reminders').get()).toEqual({ n: 0 });
    expect(w.t.fake.calls.length).toBe(calls);
  });

  it('需要会话、CSRF 与本站来源；Authorization 头里的页面凭证不算数', async () => {
    const w = await world();
    const credential = await connectAgent(w.t, w.wall, w.members[0]!.member.page);
    for (const path of ADMIN_POSTS) {
      const noCsrf = await postForm(w.t, `/w/${w.wall.id}${path}`, {}, { cookie: w.organizer.cookie });
      expect(noCsrf.status, path).toBe(403);
      const foreign = await postForm(w.t, `/w/${w.wall.id}${path}`, { _csrf: w.organizer.csrf }, { cookie: w.organizer.cookie, origin: 'https://evil.example.com' });
      expect(foreign.status, path).toBe(403);
      const bearer = await postForm(w.t, `/w/${w.wall.id}${path}`, {}, { headers: { authorization: `Bearer ${credential}` } });
      expect([303, 401, 403, 404]).toContain(bearer.status);
      if (bearer.status === 303) expect(bearer.headers.get('location') ?? '').toMatch(/^\/login/);
    }
    const csv = await get(w.t, `/w/${w.wall.id}/admin/members.csv`, { headers: { authorization: `Bearer ${credential}` } });
    expect(csv.status).not.toBe(200);
    expect(w.t.db.prepare('SELECT COUNT(*) AS n FROM wall_reminders').get()).toEqual({ n: 0 });
  });

  it('墙外的人与被移出的人不能看也不能答必答题', async () => {
    const w = await world();
    const removed = w.members[3]!;
    removeMember(w.t.web.deps, w.wall, w.organizer.userId, removed.member.membership.id);
    for (const session of [w.outsider, removed.session]) {
      expect((await get(w.t, `/w/${w.wall.id}/questions`, { cookie: session.cookie })).status).toBe(404);
      expect((await w.answer(session, 0)).status).toBe(404);
    }
    expect(w.t.repos.questions.answersForUser(w.wall.id, w.outsider.userId)).toEqual([]);
  });
});

describe('S13 回答的可见范围', () => {
  it('墙上只出现已上墙的人的回答；组织者后台看得到全部有效成员；被移出的人的回答消失', async () => {
    const w = await world();
    const [published, unpublished, , removed] = w.members as [HostedOwner, HostedOwner, HostedOwner, HostedOwner];
    await w.answer(published.session, 0);
    await w.answer(unpublished.session, 1);
    await w.answer(removed.session, 1);
    await w.answer(w.organizer, 0);
    publishPage(w.t, published.member, '阿柚');
    const wallHtml = await (await get(w.t, `/w/${w.wall.id}`, { cookie: published.session.cookie })).text();
    expect(wallHtml).toContain('宣传部');
    expect(wallHtml).not.toContain(SECRET_ANSWER);
    const admin = await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(admin).toMatch(new RegExp(`class="answer-tag"[^>]*>${SECRET_ANSWER}<`));
    expect(admin).not.toContain('@example.com');
    removeMember(w.t.web.deps, w.wall, w.organizer.userId, removed.member.membership.id);
    removeMember(w.t.web.deps, w.wall, w.organizer.userId, unpublished.member.membership.id);
    const after = await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(after).not.toMatch(new RegExp(`class="answer-tag"[^>]*>${SECRET_ANSWER}<`));
    expect(after).not.toContain('林舟');
  });
});

describe('S13 填空题的回答', () => {
  it('墙上只出现已上墙的人写的话；被移出后从后台消失；不能写联系方式；HTML 照文字转义', async () => {
    const w = await world();
    saveQuestions(w.t.web.deps, w.wall.id, [{ id: null, index: 0, prompt: '一句话说说你想做的项目', kind: 'text', options: [] }]);
    const version = questionsVersion(w.t.repos.questions.listForWall(w.wall.id));
    const say = (session: TestSession, text: string) => post(w.t, session, `/w/${w.wall.id}/questions`, { qv: version, a0: text });
    const [published, unpublished] = w.members as [HostedOwner, HostedOwner];
    expect((await say(published.session, '<img src=x onerror=f()>做小游戏')).status).toBe(303);
    expect((await say(unpublished.session, '还没上墙的秘密想法')).status).toBe(303);
    expect((await say(w.members[2]!.session, '邮箱 me@example.com')).status).toBe(400);
    expect(w.t.repos.questions.answersForUser(w.wall.id, w.members[2]!.session.userId)).toEqual([]);
    publishPage(w.t, published.member, '阿柚');
    const wallHtml = await (await get(w.t, `/w/${w.wall.id}`, { cookie: published.session.cookie })).text();
    expect(wallHtml).toContain('&lt;img src=x onerror=f()&gt;做小游戏');
    expect(wallHtml).not.toContain('<img src=x');
    expect(wallHtml).not.toContain('还没上墙的秘密想法');
    expect(await (await get(w.t, `/w/${w.wall.id}`, { cookie: w.outsider.cookie })).text()).not.toContain('做小游戏');
    const admin = await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(admin).toContain('还没上墙的秘密想法');
    removeMember(w.t.web.deps, w.wall, w.organizer.userId, unpublished.member.membership.id);
    expect(await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text()).not.toContain('还没上墙的秘密想法');
  });
});

describe('S13 提醒邮件', () => {
  it('固定模板：组织者不能写正文；不含组织者与其他成员的邮箱；拉黑了组织者、停用的账号不收', async () => {
    const w = await world();
    const [blocker, suspended, normal] = w.members as [HostedOwner, HostedOwner, HostedOwner];
    w.t.repos.moderation.block(blocker.session.userId, w.organizer.userId, new Date().toISOString());
    w.t.repos.moderation.suspend(suspended.session.userId, null, new Date().toISOString());
    const before = w.t.outbox.messages.length;
    await post(w.t, w.organizer, `/w/${w.wall.id}/admin/remind`, { subject: '中奖了', body: '点击 https://evil.example.com' });
    await remindersIdle(w.t.web.deps);
    const mails = w.t.outbox.messages.slice(before);
    expect(mails.map((mail) => mail.to).sort()).toEqual([normal.session.email, w.members[3]!.session.email].sort());
    for (const mail of mails) {
      expect(mail.subject).not.toContain('中奖');
      expect(mail.body).not.toContain('evil.example.com');
      expect(mail.body).not.toContain('org@example.com');
      expect(mail.body.match(/[a-z0-9._-]+@example\.com/g) ?? []).toEqual([]);
    }
    // 不接收的人数合在一起显示，看不出谁拉黑了谁
    const admin = await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(admin).toContain('2 人不接收提醒邮件');
    expect(admin).not.toContain('拉黑');
  });
});

describe('S13 群像只读墙上公开的内容', () => {
  it('交给模型的没有名字、草稿、渲染文字、联系方式、没上墙的人；结果里没有名字', async () => {
    const w = await world();
    for (const [index, member] of w.members.slice(0, 3).entries()) {
      publishPage(w.t, member.member, ['阿柚', '林舟', '苏晴'][index]!, { contact: { channel: 'wechat', value: `wx_secret_${index}` } });
    }
    await w.answer(w.members[3]!.session, 1); // 没上墙的人的回答
    await w.answer(w.organizer, 0);
    for (const member of w.members.slice(0, 3)) await w.answer(member.session, 0);
    const response = await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`);
    expect(response.headers.get('location')).toContain('portrait-ready');
    const call = [...w.t.fake.calls].reverse().find((item) => JSON.stringify(item.tool_choice ?? '').includes('submit_portrait'));
    const prompt = JSON.stringify(call?.messages ?? []);
    expect(prompt).toContain('page_3');
    expect(prompt).not.toContain('page_4');
    expect(prompt).not.toContain('未确认的草稿');
    expect(prompt).not.toContain('渲染后的文字');
    expect(prompt).not.toContain('wx_secret');
    expect(prompt).not.toContain('@example.com');
    expect(prompt).not.toContain(SECRET_ANSWER);
    expect(prompt).not.toContain('小白');
    const stored = w.t.repos.portraits.find(w.wall.id);
    for (const name of ['阿柚', '林舟', '苏晴', '小白']) expect(stored?.resultJson).not.toContain(name);
  });

  it('群像只给墙内有效成员看：墙外的人、被移出的人看不到墙', async () => {
    const w = await world();
    for (const [index, member] of w.members.slice(0, 3).entries()) publishPage(w.t, member.member, ['阿柚', '林舟', '苏晴'][index]!);
    await w.answer(w.organizer, 0);
    await post(w.t, w.organizer, `/w/${w.wall.id}/admin/portrait`);
    const removed = w.members[3]!;
    removeMember(w.t.web.deps, w.wall, w.organizer.userId, removed.member.membership.id);
    for (const session of [w.outsider, removed.session]) expect((await get(w.t, `/w/${w.wall.id}`, { cookie: session.cookie })).status).toBe(404);
  });
});
