import { seedDemoAvatars } from '../scripts/demo-avatars.js';
import sharp from 'sharp';
/** 真实校验 / 提交 / 发布 / 聊天服务；渲染器用假实现，真实渲染由 pnpm demo 验收。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDemoClubPages, seedDemo, type DemoSeed } from '../scripts/demo-seed.js';
import { DEMO_TEST_NAME } from '../scripts/demo-content.js';
import { DEMO_TEST_PROFILE } from '../scripts/demo-persona.js';
import { DEMO_ANSWERS, DEMO_QUESTIONS } from '../scripts/demo-organizer.js';
import { loadPortrait } from '../src/services/portrait.js';
import { DEMO_ACCOUNTS } from '../src/demo-access.js';
import { createTestWeb, csrfOf, postForm, sessionTokenFrom, type TestWeb } from './helpers.js';

let t: TestWeb;
let seed: DemoSeed;
beforeAll(async () => {
  t = createTestWeb({ demo: true });
  seed = await seedDemo(t.web);
});
afterAll(async () => { await t.close(); });

describe('demo 种子', () => {
  it('全部演示用户有不同的本地头像；重复补齐不覆盖用户头像', async () => {
    const users = t.db.prepare('SELECT id, avatar_version AS version FROM users').all() as { id: string; version: string }[];
    expect(users).toHaveLength(30);
    expect(new Set(users.map((user) => user.version)).size).toBe(users.length);
    for (const user of users) {
      const image = t.repos.users.avatarForUser(user.id);
      expect(image).toBeTruthy();
      const metadata = await sharp(image!).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.width).toBe(256);
      expect(metadata.height).toBe(256);
    }
    expect(seedDemoAvatars(t.web.deps)).toBe(0);
    expect(t.db.prepare('SELECT id, avatar_version AS version FROM users').all()).toEqual(users);
  });

  it('组织者 + 6 名成员 + 体验成员；5 人已发布，1 人只提交；联系方式有公开有不公开', async () => {
    expect(seed.members).toHaveLength(6);
    expect(seed.members.filter((m) => m.published)).toHaveLength(5);
    expect(seed.members.some((m) => m.published && !m.contactPublic)).toBe(true);
    expect(seed.members.some((m) => m.published && m.contactPublic)).toBe(true);
    const active = t.db.prepare('SELECT COUNT(*) AS n FROM publications WHERE ended_at IS NULL').get() as { n: number };
    expect(active.n).toBe(5 + 5 + 12);
    const revisions = t.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE status = 'accepted'").get() as { n: number };
    expect(revisions.n).toBe(6 + 5 + 12);
    expect(seed.newcomer.instruction.command).toContain('/nowme-page');
    expect(seed.inviteUrl).toContain('/join/');
  });

  it('黑客松墙和摄影社墙上的人物都贴合各自的墙', () => {
    expect(seed.members.map((m) => m.nickname)).toEqual(['林舟', '苏晴', '程野', '方棠', '祝一一', '周一鸣']);
    expect(seed.members.filter((m) => m.published).map((m) => m.exampleDir)).toEqual(['hackathon-terminal', 'hackathon-poster', 'hack-chengye', 'hack-fangtang', 'hack-zhuyiyi']);
    expect(seed.club.members.map((m) => m.nickname)).toEqual(['栗子', '贺川', '麦冬', DEMO_TEST_NAME, '温溪']);
    for (const member of seed.members.filter((m) => m.published)) {
      const html = readFileSync(join(t.dataDir, 'revisions', member.revisionId, 'original', 'index.html'), 'utf8');
      expect(html).not.toMatch(/黑胶|话剧|菜市场/);
    }
  });

  it('组织者工具有预置数据：两道必答题、回答、完成度里有人没答、墙上能筛选并看到群像', async () => {
    const questions = t.repos.questions.listForWall(seed.wall.id);
    expect(questions.map((question) => [question.prompt, question.kind])).toEqual(DEMO_QUESTIONS.map((question) => [question.prompt, question.kind]));
    const answered = t.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM wall_answers WHERE wall_id = ?').get(seed.wall.id) as { n: number };
    expect(answered.n).toBe(Object.keys(DEMO_ANSWERS).length);
    const unpublished = seed.members.find((member) => !member.published)!;
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM wall_answers WHERE user_id = ?').get(unpublished.userId)).toEqual({ n: 0 });
    const portrait = loadPortrait(t.web.deps, seed.wall.id);
    expect(portrait.kind).toBe('ready');
    if (portrait.kind !== 'ready') return;
    expect(portrait.view.pageCount).toBe(5);
    expect(portrait.view.stats.map((stat) => stat.answered)).toEqual([5, 5]);
    // S13：群像里不出现名字、链接和数字人数
    const text = [portrait.view.summary, ...portrait.view.themes.flatMap((theme) => [theme.title, theme.detail])].join('\n');
    for (const member of seed.members) expect(text).not.toContain(member.nickname);
    expect(text).not.toMatch(/https?:|www\.|\d+\s*(人|位|个人)/);

    // 体验成员已经答过题，进墙不会被拦去答题；墙上有群像和按回答筛选
    const member = await postForm(t, '/login/demo', { identity: 'member' });
    const wall = await t.request(`/w/${seed.wall.id}`, { headers: { cookie: `nowme_session=${sessionTokenFrom(member)}` } });
    expect(wall.status).toBe(200);
    const html = await wall.text();
    expect(html).toContain(portrait.view.summary);
    expect(html).toContain(DEMO_QUESTIONS[0].prompt);
    const organizer = await postForm(t, '/login/demo', { identity: 'organizer' });
    const admin = await (await t.request(`/w/${seed.wall.id}/admin`, { headers: { cookie: `nowme_session=${sessionTokenFrom(organizer)}` } })).text();
    expect(admin).toContain(portrait.view.summary);
    expect(admin).toContain(unpublished.nickname);
    // 其他墙没有题目
    expect(t.repos.questions.listForWall(seed.club.wall.id)).toEqual([]);
  });

  it('社团墙三位拍照的人，再增补江予安与温溪；使用原测试账号且重复启动不会新增版本', async () => {
    expect(seed.club.wall.sceneType).toBe('club');
    expect(seed.club.wall.organizerId).toBe(seed.organizer.userId);
    expect(seed.club.members.map((m) => m.exampleDir)).toEqual(['interest-film-zine', 'club-hechuan', 'club-maidong', 'club-light-notes', 'club-tide-atlas']);
    expect(seed.club.members.every((m) => m.published)).toBe(true);
    for (const member of seed.club.members.slice(0, 3)) expect(seed.members.some((m) => m.userId === member.userId)).toBe(false);
    expect(seed.club.members[3]!.userId).toBe(seed.tester.userId);
    expect(seed.club.members[3]!.nickname).toBe(DEMO_TEST_NAME);
    expect(seed.club.members[4]!.nickname).toBe('温溪');
    expect(seed.club.members.slice(3).every((member) => !member.contactPublic)).toBe(true);
    const before = t.db.prepare('SELECT count(*) AS n FROM revisions').get();
    expect(await ensureDemoClubPages(t.web)).toEqual([]);
    expect(t.db.prepare('SELECT count(*) AS n FROM revisions').get()).toEqual(before);
    const clubActive = t.db
      .prepare('SELECT COUNT(*) AS n FROM publications pb JOIN pages p ON p.id = pb.page_id WHERE p.wall_id = ? AND pb.ended_at IS NULL')
      .get(seed.club.wall.id) as { n: number };
    expect(clubActive.n).toBe(5);
    expect(t.repos.memberships.findByWallAndUser(seed.club.wall.id, seed.newcomer.userId)?.status).toBe('active');
    expect(seed.club.inviteUrl).toContain('/join/');
  });

  it('仅保留 AI 与山野两面新墙，各 10 位成员、6 页，未创建者没有版本和发布', () => {
    expect(seed.extraWalls).toHaveLength(2);
    expect(t.db.prepare("SELECT count(*) AS n FROM walls").get()).toEqual({ n: 4 });
    expect(t.db.prepare("SELECT count(*) AS n FROM walls WHERE name LIKE '%城市漫游%' OR name LIKE '%独立创作者%'").get()).toEqual({ n: 0 });
    const pages = new Set<string>();
    const contents = new Set<string>();
    for (const entry of seed.extraWalls) {
      const publishedCount = 6;
      expect(t.repos.memberships.countActiveForWall(entry.wall.id)).toBe(10);
      expect(entry.members).toHaveLength(10);
      expect(new Set(entry.members.map((member) => member.userId)).size).toBe(10);
      expect(t.db.prepare('SELECT count(*) AS n FROM pages WHERE wall_id = ?').get(entry.wall.id)).toEqual({ n: 10 });
      expect(t.db.prepare(`SELECT count(*) AS n FROM publications pb JOIN pages p ON p.id = pb.page_id
        WHERE p.wall_id = ? AND pb.ended_at IS NULL`).get(entry.wall.id)).toEqual({ n: publishedCount });
      expect(entry.members.filter((member) => member.published)).toHaveLength(publishedCount);
      expect(entry.members[9]?.userId).toBe(entry.wall.organizerId);
      expect(t.repos.memberships.findByWallAndUser(entry.wall.id, seed.tester.userId)?.role).toBe('member');
      for (const member of entry.members) {
        pages.add(member.pageId);
        if (member.revisionId === null) {
          expect(member.published).toBe(false);
          expect(t.repos.revisions.listForPage(member.pageId)).toEqual([]);
          expect(t.repos.publications.findActiveForPage(member.pageId)).toBeNull();
          continue;
        }
        const revision = t.repos.revisions.findById(member.revisionId)!;
        expect(revision.status).toBe('accepted');
        expect(revision.report.errors).toEqual([]);
        expect(JSON.parse(revision.cardJson!).displayName).toBe(member.nickname);
        const html = readFileSync(join(t.dataDir, 'revisions', member.revisionId, 'original', 'index.html'), 'utf8');
        expect(html).toContain(`<h1>${member.nickname}</h1>`);
        contents.add(html);
      }
    }
    expect(pages.size).toBe(20);
    expect(contents.size).toBe(12);
    expect(seed.extraWalls[0]!.members.filter((member) => member.published).map((member) => member.nickname))
      .toEqual(['许知远', '唐可', '周野', '顾言', '宋雨', '陈默']);
    expect(seed.extraWalls[1]!.members.filter((member) => member.published).map((member) => member.nickname))
      .toEqual(['江川', '周晴', '高远', '安宁', '麦子', '赵森']);
  });

  it('接入现有体验成员：登录后可以访问四面墙、全部成员页与已有聊天', async () => {
    expect(seed.tester.email).toBe(DEMO_ACCOUNTS.find((account) => account.identity === 'member')!.email);
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    expect(response.status).toBe(303);
    const cookie = `nowme_session=${sessionTokenFrom(response)}`;
    const home = await (await t.request('/', { headers: { cookie } })).text();
    for (const wall of [seed.wall, seed.club.wall, ...seed.extraWalls.map((entry) => entry.wall)]) {
      expect(home).toContain(wall.name);
      expect((await t.request(`/w/${wall.id}`, { headers: { cookie } })).status).toBe(200);
    }
    for (const entry of seed.extraWalls) {
      for (const member of entry.members) expect((await t.request(`/w/${entry.wall.id}/p/${member.pageId}`, { headers: { cookie } })).status).toBe(member.published ? 200 : 404);
    }
    const inbox = await (await t.request('/messages', { headers: { cookie } })).text();
    expect(inbox).toContain('许知远');
    expect(inbox).toContain('全员群');
    for (const account of DEMO_ACCOUNTS) expect(t.repos.users.findByEmail(account.email)).not.toBeNull();
    // 保留原有“从空白开始”体验，新增页面不会占用原黑客松墙的创作工作区。
    expect(t.db.prepare(`SELECT count(*) AS n FROM publications pb JOIN pages p ON p.id = pb.page_id
      WHERE p.owner_id = ? AND p.wall_id = ? AND pb.ended_at IS NULL`).get(seed.tester.userId, seed.wall.id)).toEqual({ n: 0 });
    for (const member of seed.club.members) {
      expect((await t.request(`/w/${seed.club.wall.id}/p/${member.pageId}`, { headers: { cookie } })).status).toBe(200);
    }
  });

  it('AI 介绍（contracts 20）：体验成员在有自己页面的摄影社墙上看到区块；没有页面的墙引导先做页面', async () => {
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    const cookie = `nowme_session=${sessionTokenFrom(response)}`;
    const club = await (await t.request(`/w/${seed.club.wall.id}`, { headers: { cookie } })).text();
    expect(club).toContain('id="intros"');
    expect(club).toContain('墙上 4 位成员');
    // 这个测试没有配置演示模型：区块如实说明，不显示 AI 设置入口
    expect(club).toContain('体验账号暂时用不了这个功能');
    const ai = await (await t.request(`/w/${seed.extraWalls[0]!.wall.id}`, { headers: { cookie } })).text();
    expect(ai).toContain('AI 还不认识这面墙上的你');
  });

  it('问墙（contracts 21）：体验成员在人够多的墙上看到区块（不需要先有自己的页面）；没有演示模型时如实说明', async () => {
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    const cookie = `nowme_session=${sessionTokenFrom(response)}`;
    for (const wallId of [seed.club.wall.id, seed.extraWalls[0]!.wall.id]) {
      const html = await (await t.request(`/w/${wallId}`, { headers: { cookie } })).text();
      expect(html).toContain('id="ask"');
      expect(html).toContain('要问墙，需要先有一个能用的 AI');
      expect(html).not.toContain('href="/account/ai"');
    }
  });

  it('模拟聊天有双向消息、正确归属和已读/未读；未参与的私聊不出现在主测试账号中', () => {
    expect(seed.chat).toEqual({ groups: 4, directs: 15, messages: 79 });
    const list = t.repos.chat.list(seed.tester.userId).conversations;
    expect(list).toHaveLength(16); // 四个群 + 每墙三个私聊。
    expect(list.filter((entry) => entry.kind === 'direct')).toHaveLength(12);
    // 12 段私聊各写各的：没有任何一句话重复出现，消息列表里看不出模板
    const directTexts = (t.db.prepare(`SELECT msg.body AS body FROM chat_messages msg JOIN conversations c ON c.id = msg.conversation_id
      WHERE c.kind = 'direct' AND (c.user_a = ? OR c.user_b = ?)`).all(seed.tester.userId, seed.tester.userId) as { body: string }[]).map((row) => row.body);
    expect(directTexts).toHaveLength(46);
    expect(new Set(directTexts).size).toBe(directTexts.length);
    expect(list.some((entry) => entry.unread > 0)).toBe(true);
    expect(list.some((entry) => entry.unread === 0)).toBe(true);
    expect(t.db.prepare(`SELECT count(*) AS n FROM chat_messages msg JOIN conversations c ON c.id = msg.conversation_id
      LEFT JOIN memberships m ON m.wall_id = c.wall_id AND m.user_id = msg.sender_id AND m.status = 'active' WHERE m.id IS NULL`).get()).toEqual({ n: 0 });
    const privateChat = t.db.prepare("SELECT id FROM conversations WHERE kind = 'direct' AND user_a <> ? AND user_b <> ? LIMIT 1").get(seed.tester.userId, seed.tester.userId) as { id: string };
    expect(t.repos.chat.findVisible(privateChat.id, seed.tester.userId)).toBeNull();
    const history = t.repos.chat.history(list.find((entry) => entry.kind === 'direct')!.id).messages;
    expect(new Set(history.map((message) => message.senderId)).size).toBe(2);
    expect(history.map((message) => message.createdAt)).toEqual(history.map((message) => message.createdAt).sort());
  });

  it('身份、聊天和私有画像保持一致；AI、山野墙工作区留空', async () => {
    expect(t.repos.users.findById(seed.tester.userId)?.nickname).toBe(DEMO_TEST_NAME);
    expect(seed.newcomer.nickname).toBe(DEMO_TEST_NAME);
    expect(t.repos.profileEntries.listForUser(seed.tester.userId).map(({ category, text }) => ({ category, text }))).toEqual(expect.arrayContaining([...DEMO_TEST_PROFILE]));
    expect(t.repos.briefs.listForOwner(seed.tester.userId)).toHaveLength(0);
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    const cookie = `nowme_session=${sessionTokenFrom(response)}`;
    const data = await (await t.request('/account/data', { headers: { cookie } })).text();
    for (const entry of DEMO_TEST_PROFILE) expect(data).toContain(entry.text);
    for (const entry of seed.extraWalls) {
      const member = entry.members[0]!;
      expect(member.userId).toBe(seed.tester.userId);
      expect(member.nickname).toBe(DEMO_TEST_NAME);
      expect(member.revisionId).toBeNull();
      expect(t.repos.briefs.findForPage(member.pageId, seed.tester.userId)).toBeNull();
      expect(t.repos.revisions.listForPage(member.pageId)).toEqual([]);
      expect((await t.request(`/w/${entry.wall.id}/me/brief`, { headers: { cookie } })).status).toBe(404);
      const workspace = await t.request(`/w/${entry.wall.id}/me`, { headers: { cookie } });
      expect(workspace.status).toBe(200);
      expect(await workspace.text()).toContain('开始采访');
    }
    const conversation = t.repos.chat.list(seed.members[0]!.userId).conversations.find((item) => item.kind === 'direct');
    expect(JSON.stringify(conversation)).toContain(DEMO_TEST_NAME);
    for (const wall of [seed.wall, seed.club.wall]) {
      expect((await t.request(`/w/${wall.id}/me/brief`, { headers: { cookie } })).status).toBe(404);
    }
  });

  it('虚拟画像可以真实删除，重新登录不补回，空白工作区没有预置 brief', async () => {
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    const token = sessionTokenFrom(response)!;
    const cookie = `nowme_session=${token}`;
    const _csrf = csrfOf(t, token);
    const first = t.repos.profileEntries.listForUser(seed.tester.userId)[0]!;
    expect((await postForm(t, '/account/profile/delete', { _csrf, entryId: first.id }, { cookie })).status).toBe(303);
    expect(t.repos.profileEntries.listForUser(seed.tester.userId).some((entry) => entry.id === first.id)).toBe(false);
    expect((await postForm(t, '/account/profile/delete', { _csrf, all: '1' }, { cookie })).status).toBe(303);
    const relogin = await postForm(t, '/login/demo', { identity: 'member' });
    const nextCookie = `nowme_session=${sessionTokenFrom(relogin)}`;
    const data = await (await t.request('/account/data', { headers: { cookie: nextCookie } })).text();
    expect(data).toContain('长期画像（0 条）');
    expect(t.repos.profileEntries.listForUser(seed.tester.userId)).toEqual([]);
    expect(t.repos.briefs.listForOwner(seed.tester.userId)).toHaveLength(0);
  });
});
