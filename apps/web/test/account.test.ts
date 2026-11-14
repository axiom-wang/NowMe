/**
 * 导出我的数据与注销账号（contracts 14）的功能测试；安全不变量 S11 见 security/account-deletion.security.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { generateId } from '@nowme/contracts';
import { createTestWeb, get, type TestWeb } from './helpers.js';
import type { HostedTestWeb } from './hosted-helpers.js';
import { post } from './publish-helpers.js';
import { accountWorld, confirmDeletion, downloadExport, OWNER_DIRECT, OWNER_MATERIAL, OWNER_MESSAGE, OWNER_PROFILE_TEXT, PEER_GROUP, readZip, requestDeletionCode, type AccountWorld } from './account-helpers.js';
import { chargeJob, userAccount } from '../src/services/billing.js';
import { buildZip, isSafeZipPath } from '../src/services/zip.js';

let t: HostedTestWeb | TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function world(): Promise<AccountWorld> {
  const w = await accountWorld();
  t = w.t;
  return w;
}

interface ExportData {
  format: string;
  account: { email: string; nickname: string; avatar: string | null };
  walls: { wall: { id: string; name: string }; membership: { status: string }; page: null | {
    publicLinkOn: boolean;
    contact: { value: string } | null;
    revisions: { number: number; status: string; files: string | null; card: unknown }[];
    publications: { revisionNumber: number; card: { tagline: string } | null; endedAt: string | null }[];
    interview: null | { status: string; answers: { material: string }; briefMarkdown: string; images: { file: string }[] };
  } }[];
  profile: { text: string }[];
  icebreakers: { wallName: string; about: string; result: { openers: unknown[] } }[];
  conversations: { kind: string; with: string | null; stillVisible: boolean; messages: { from: string; mine: boolean; text: string }[] }[];
  credits: { balance: number; entries: { reason: string; delta: number }[] };
  aiSettings: { role: string; provider: string; hasKey: boolean }[];
}

describe('导出我的数据', () => {
  it('zip 里有自己的账号、页面文件、采访、画像、破冰结果、聊天、点数与 AI 设置', async () => {
    const w = await world();
    const withThird = w.t.repos.chat.ensureDirect(w.wall.id, w.owner.session.userId, w.third.session.userId, w.t.clock.now().toISOString());
    expect((await post(w.t, w.owner.session, `/messages/${withThird}/block`)).status).toBe(303);
    const { files, data: raw } = await downloadExport(w.t, w.owner.session);
    expect(raw.blocked).toEqual([expect.objectContaining({ nickname: '小白' })]);
    expect(JSON.stringify(raw.blocked)).not.toContain(w.third.session.userId);
    const data = raw as unknown as ExportData;
    expect(data.format).toBe('nowme-export');
    expect(files.get('README.txt')?.toString('utf8')).toContain('NOWMe 数据导出');
    expect(data.account).toMatchObject({ email: w.owner.session.email, nickname: '阿柚', avatar: 'avatar.webp' });
    expect(files.get('avatar.webp')).toEqual(Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]));

    const mine = data.walls.find((item) => item.wall.id === w.wall.id)!;
    expect(mine.membership.status).toBe('active');
    const page = mine.page!;
    expect(page.publicLinkOn).toBe(true);
    const accepted = page.revisions.find((revision) => revision.status === 'accepted')!;
    expect(accepted.files).toBe(`pages/${w.wall.id}/v${accepted.number}/`);
    expect(files.get(`pages/${w.wall.id}/v${accepted.number}/index.html`)?.toString('utf8')).toContain('<html');
    expect(files.has(`pages/${w.wall.id}/v${accepted.number}/card.json`)).toBe(true);
    expect(page.publications[0]).toMatchObject({ revisionNumber: accepted.number, endedAt: null });
    expect(page.publications[0]?.card?.tagline).toContain('在天台种番茄');
    expect(page.interview?.status).toBe('confirmed');
    expect(page.interview?.answers.material).toBe(OWNER_MATERIAL);
    expect(page.interview?.briefMarkdown.length).toBeGreaterThan(0);
    const image = page.interview!.images[0]!.file;
    expect(image).toMatch(new RegExp(`^interviews/${w.wall.id}/photo-`));
    expect(files.has(image)).toBe(true);

    expect(data.profile.map((entry) => entry.text)).toContain(OWNER_PROFILE_TEXT);
    expect(data.icebreakers).toHaveLength(1);
    expect(data.icebreakers[0]?.wallName).toBe('周末黑客松');
    expect(data.icebreakers[0]?.result.openers.length).toBeGreaterThan(0);

    const group = data.conversations.find((conversation) => conversation.kind === 'group')!;
    expect(group.stillVisible).toBe(true);
    expect(group.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ mine: true, from: '我', text: OWNER_MESSAGE }),
      expect.objectContaining({ mine: false, from: '林舟', text: PEER_GROUP }),
    ]));
    const direct = data.conversations.find((conversation) => conversation.kind === 'direct' && conversation.with === '林舟')!;
    expect(direct).toMatchObject({ with: '林舟', stillVisible: true });
    expect(direct.messages.map((message) => message.text)).toEqual([OWNER_DIRECT]);

    expect(data.credits.balance).toBe(30);
    expect(data.credits.entries).toEqual([expect.objectContaining({ reason: 'grant', delta: 30 })]);
    expect(data.aiSettings.map((setting) => setting.role).sort()).toEqual(['generate', 'interview']);
    expect(data.aiSettings.every((setting) => setting.provider === 'anthropic' && setting.hasKey)).toBe(true);
  });

  it('退出墙之后：看不到的会话只剩自己发的消息，破冰结果不再导出，页面版本仍在', async () => {
    const w = await world();
    expect((await post(w.t, w.owner.session, `/w/${w.wall.id}/leave`)).status).toBe(200);
    const data = (await downloadExport(w.t, w.owner.session)).data as unknown as ExportData;
    const mine = data.walls.find((item) => item.wall.id === w.wall.id)!;
    expect(mine.membership.status).toBe('left');
    expect(mine.page?.revisions.some((revision) => revision.files)).toBe(true);
    const group = data.conversations.find((conversation) => conversation.kind === 'group')!;
    expect(group.stillVisible).toBe(false);
    expect(group.messages.map((message) => message.text)).toEqual([OWNER_MESSAGE]);
    const direct = data.conversations.find((conversation) => conversation.kind === 'direct')!;
    expect(direct.with).toBeNull();
    expect(data.icebreakers).toHaveLength(0);
  });

  it('删除页面之后只剩版本编号与发布记录的墓碑', async () => {
    const w = await world();
    expect((await post(w.t, w.owner.session, `/w/${w.wall.id}/me/delete`, { confirm: '1' })).status).toBe(303);
    const { files, data } = await downloadExport(w.t, w.owner.session);
    const page = (data as unknown as ExportData).walls.find((item) => item.wall.id === w.wall.id)!.page!;
    expect(page.revisions.every((revision) => revision.files === null && revision.card === null)).toBe(true);
    expect(page.publications.every((publication) => publication.card === null)).toBe(true);
    expect(page.interview).toBeNull();
    expect([...files.keys()].some((path) => path.startsWith('pages/'))).toBe(false);
  });

  it('“我的资料”里有导出与注销入口', async () => {
    const w = await world();
    const html = await (await get(w.t, '/account/data', { cookie: w.owner.session.cookie })).text();
    expect(html).toContain('href="/account/export"');
    expect(html).toContain('href="/account/delete"');
  });
});

describe('注销账号', () => {
  it('确认页说明后果；发码后显示输入框；注销后的结果页没有登录态', async () => {
    const w = await world();
    const intro = await (await get(w.t, '/account/delete', { cookie: w.owner.session.cookie })).text();
    expect(intro).toContain('注销后会发生什么');
    expect(intro).toContain('没用完的点数作废');
    expect(intro).toContain('action="/account/delete/code"');
    const sent = await post(w.t, w.owner.session, '/account/delete/code');
    expect(sent.status).toBe(200);
    const codeHtml = await sent.text();
    expect(codeHtml).toContain('name="code"');
    expect(codeHtml).toContain('name="confirm"');
    const mail = w.t.outbox.messages.at(-1)!;
    expect(mail.to).toBe(w.owner.session.email);
    expect(mail.subject).toMatch(/^\d{6} 是你注销 NOWMe 账号的确认码$/);
    const code = mail.subject.slice(0, 6);
    const done = await confirmDeletion(w.t, w.owner.session, code);
    const html = await done.text();
    expect(html).toContain('账号已注销');
    expect(html).not.toContain('阿柚');
  });

  it('进行中的付费任务：先全额退回再随余额一起作废，任务以失败结束', async () => {
    const w = await world();
    const { t: web, owner } = w;
    const jobId = generateId('gen');
    const nowIso = web.clock.now().toISOString();
    web.repos.jobs.create({ id: jobId, pageId: owner.member.page.id, ownerId: owner.session.userId, kind: 'generate', baseRevisionId: null, targetBlock: null, requestText: '把标题改大', createdAt: nowIso });
    web.repos.jobs.markRunning(jobId, nowIso);
    chargeJob(web.web.deps, jobId, { ok: true, source: 'platform', price: 10, payer: userAccount(owner.session.userId) }, owner.session.userId);
    expect(web.repos.credits.balanceOf(userAccount(owner.session.userId))).toBe(20);

    const { code } = await requestDeletionCode(web, owner.session);
    expect((await confirmDeletion(web, owner.session, code!)).status).toBe(200);
    const job = web.repos.jobs.findById(jobId)!;
    expect(job.status).toBe('failed');
    expect(job.requestText).toBeNull();
    expect(web.repos.credits.findJobEntry('job_refund', jobId)?.delta).toBe(10);
    const entries = web.repos.credits.listEntries(userAccount(owner.session.userId), 10);
    expect(entries[0]).toMatchObject({ reason: 'account_deleted', delta: -30, balanceAfter: 0 });
    // 任务执行器之后再来结束这个任务：不会再改状态，也不会再退一次
    expect(web.repos.jobs.finish(jobId, { status: 'succeeded', revisionId: null, errorCode: null, resultMessage: 'x', charged: true, usage: {}, finishedAt: nowIso })).toBe(false);
  });

  it('演示模式没有导出与注销', async () => {
    const web = createTestWeb({ demo: true });
    t = web;
    expect((await get(web, '/account/export')).status).toBe(404);
    expect((await get(web, '/account/delete')).status).toBe(404);
  });
});

describe('zip 写入', () => {
  it('能被标准方式读回（store 与 deflate），拒绝不安全与重复的路径', () => {
    const text = new TextEncoder().encode('你好 NOWMe '.repeat(50));
    const binary = new Uint8Array([0, 1, 2, 3, 255]);
    const zip = buildZip([{ path: 'a/说明.txt', data: text }, { path: 'b.bin', data: binary }], new Date('2026-11-15T10:20:30Z'));
    const files = readZip(zip);
    expect(files.get('a/说明.txt')).toEqual(Buffer.from(text));
    expect(files.get('b.bin')).toEqual(Buffer.from(binary));
    for (const path of ['../x', '/etc/passwd', 'a//b', 'a\\b', '', 'a/./b']) expect(isSafeZipPath(path)).toBe(false);
    expect(() => buildZip([{ path: '../x', data: binary }], new Date())).toThrow();
    expect(() => buildZip([{ path: 'x', data: binary }, { path: 'x', data: binary }], new Date())).toThrow();
  });
});
