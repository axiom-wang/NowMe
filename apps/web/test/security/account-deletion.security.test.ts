/**
 * S11 注销账号与数据导出（contracts 14）：
 * - 注销需要一个新的、注销用途的邮箱验证码；登录验证码不能用来注销，注销确认码也不能用来登录；
 * - 还是开放墙的组织者时不能注销（不替他关别人在用的墙）；
 * - 注销后不留可访问的个人数据：会话、Agent token、页面凭证、页面、封面、头像、公开链接全部失效，
 *   其他成员看不到他的页面和资料；数据库里不再有他的邮箱与内容；
 * - 导出只给本人，不含任何凭证（明文或哈希）与别人的未公开内容。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashToken, SESSION_COOKIE_NAME } from '@nowme/contracts';
import { agentGet, dumpDb, exchange, get, latestCode, login, postForm, seedWall, sessionTokenFrom } from '../helpers.js';
import type { HostedTestWeb } from '../hosted-helpers.js';
import { memberPath } from '../icebreaker-helpers.js';
import { post, revisionDirExists } from '../publish-helpers.js';
import {
  accountWorld,
  API_KEY,
  confirmDeletion,
  downloadExport,
  OWNER_DIRECT,
  OWNER_MATERIAL,
  OWNER_MESSAGE,
  OWNER_PROFILE_TEXT,
  PEER_DIRECT_TO_OTHER,
  PEER_GROUP,
  requestDeletionCode,
  THIRD_MATERIAL,
  type AccountWorld,
} from '../account-helpers.js';
import { DELETED_MESSAGE_TEXT, DELETED_USER_NICKNAME } from '../../src/services/account-deletion.js';

let t: HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function world(): Promise<AccountWorld> {
  const w = await accountWorld();
  t = w.t;
  return w;
}

function ownerRow(w: AccountWorld) {
  return w.t.db.prepare('SELECT * FROM users WHERE id = ?').get(w.owner.session.userId) as Record<string, unknown>;
}

describe('S11 注销需要新的验证码', () => {
  it('没有确认码、确认码不对、用登录验证码都不能注销；不对时什么都不删', async () => {
    const w = await world();
    const before = JSON.stringify(dumpDb(w.t.db));
    // 没发过确认码
    expect((await confirmDeletion(w.t, w.owner.session, '123456')).status).toBe(400);
    // 一个还没用过的登录验证码（同一邮箱）
    expect((await postForm(w.t, '/login', { email: w.owner.session.email })).status).toBe(200);
    const loginCode = latestCode(w.t, w.owner.session.email);
    expect((await confirmDeletion(w.t, w.owner.session, loginCode)).status).toBe(400);
    expect(ownerRow(w).deleted_at).toBeNull();
    // 发了确认码，但输错；没勾选确认
    const { code } = await requestDeletionCode(w.t, w.owner.session);
    expect(code).toMatch(/^\d{6}$/);
    expect((await confirmDeletion(w.t, w.owner.session, code === '000000' ? '111111' : '000000')).status).toBe(400);
    expect((await post(w.t, w.owner.session, '/account/delete', { code: code! })).status).toBe(400);
    expect(ownerRow(w).deleted_at).toBeNull();
    // 除了验证码记录与尝试次数，其他表一行没变
    const strip = (dump: string) => JSON.parse(dump, (key, value) => (key === 'login_codes' || key === 'sessions' ? undefined : value)) as unknown;
    expect(strip(JSON.stringify(dumpDb(w.t.db)))).toEqual(strip(before));
  });

  it('输错 5 次确认码作废；注销确认码不能用来登录', async () => {
    const w = await world();
    const { code } = await requestDeletionCode(w.t, w.owner.session);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await confirmDeletion(w.t, w.owner.session, wrong);
    expect((await confirmDeletion(w.t, w.owner.session, code!)).status).toBe(400);
    expect(ownerRow(w).deleted_at).toBeNull();

    const fresh = await requestDeletionCode(w.t, w.owner.session);
    const verify = await postForm(w.t, '/login/verify', { email: w.owner.session.email, code: fresh.code! });
    expect(verify.status).toBe(400);
    expect(sessionTokenFrom(verify)).toBeNull();
  });

  it('缺 CSRF、错误来源、只带页面凭证：都不能发码也不能注销', async () => {
    const w = await world();
    const { code } = await requestDeletionCode(w.t, w.owner.session);
    const mails = w.t.outbox.messages.length;
    const noCsrf = await postForm(w.t, '/account/delete', { code: code!, confirm: '1' }, { cookie: w.owner.session.cookie });
    expect([200, 303]).not.toContain(noCsrf.status);
    const crossSite = await postForm(w.t, '/account/delete', { _csrf: w.owner.session.csrf, code: code!, confirm: '1' }, { cookie: w.owner.session.cookie, origin: 'https://evil.example' });
    expect([200, 303]).not.toContain(crossSite.status);
    const bearer = await postForm(w.t, '/account/delete', { code: code!, confirm: '1' }, { headers: { authorization: `Bearer ${w.credential}` } });
    expect([200, 303]).not.toContain(bearer.status);
    const bearerCode = await postForm(w.t, '/account/delete/code', {}, { headers: { authorization: `Bearer ${w.credential}` } });
    expect([200, 303]).not.toContain(bearerCode.status);
    expect(w.t.outbox.messages.length).toBe(mails);
    expect(ownerRow(w).deleted_at).toBeNull();
    // 确认码仍然可用：正常注销成功
    expect((await confirmDeletion(w.t, w.owner.session, code!)).status).toBe(200);
  });
});

describe('S11 组织者有开放的墙时不能注销', () => {
  it('不发码、不注销、不关墙；关闭墙之后可以注销', async () => {
    const w = await world();
    const page = await get(w.t, '/account/delete', { cookie: w.organizer.cookie });
    const html = await page.text();
    expect(html).toContain('先关闭你组织的墙');
    expect(html).toContain(`/w/${w.wall.id}/admin`);
    expect(html).not.toContain('/account/delete/code');
    const mails = w.t.outbox.messages.length;
    expect((await requestDeletionCode(w.t, w.organizer)).status).toBe(409);
    expect(w.t.outbox.messages.length).toBe(mails);

    // 先拿到确认码再建墙：注销时仍会被拦下
    const w2 = seedWall(w.t, w.owner.session.userId, '阿柚的读书会');
    expect((await requestDeletionCode(w.t, w.owner.session)).status).toBe(409);
    w.t.repos.walls.close(w2.wall.id, w.t.clock.now().toISOString());
    const { code } = await requestDeletionCode(w.t, w.owner.session);
    const reopened = seedWall(w.t, w.owner.session.userId, '又一面墙');
    expect((await confirmDeletion(w.t, w.owner.session, code!)).status).toBe(409);
    expect(ownerRow(w).deleted_at).toBeNull();
    expect(w.t.repos.walls.findById(reopened.wall.id)?.status).toBe('open');
    expect(w.t.repos.walls.findById(w.wall.id)?.status).toBe('open');

    w.t.repos.walls.close(reopened.wall.id, w.t.clock.now().toISOString());
    expect((await confirmDeletion(w.t, w.owner.session, code!)).status).toBe(200);
    expect(ownerRow(w).deleted_at).not.toBeNull();
  });
});

describe('S11 注销后不留可访问的个人数据', () => {
  it('会话、token、凭证、页面、封面、头像、公开链接全部失效；别人看不到他的页面和资料', async () => {
    const w = await world();
    const { t: web, wall, owner, peer } = w;
    const userId = owner.session.userId;
    const pageId = owner.member.page.id;
    const published = web.repos.publications.findActiveForPage(pageId)!;
    const revisionId = published.revisionId;
    const coverPath = `/w/${wall.id}/covers/${pageId}.png`;
    const avatarPath = `/w/${wall.id}/members/${userId}/avatar`;
    // 注销前：都能访问
    expect((await get(web, memberPath(wall, owner), { cookie: peer.session.cookie })).status).toBe(200);
    expect((await get(web, `/s/${w.publicToken}`)).status).toBe(200);
    expect((await get(web, avatarPath, { cookie: peer.session.cookie })).status).toBe(200);
    expect((await agentGet(web, '/api/agent/context', w.credential)).status).toBe(200);
    expect(revisionDirExists(web, revisionId)).toBe(true);
    expect(await (await get(web, `/w/${wall.id}`, { cookie: peer.session.cookie })).text()).toContain('在天台种番茄');
    expect(await (await get(web, `/w/${wall.id}/admin`, { cookie: w.organizer.cookie })).text()).toContain('阿柚');
    expect((await get(web, coverPath, { cookie: peer.session.cookie })).status).toBe(200);
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM icebreakers WHERE viewer_id = ?').get(userId)).toEqual({ n: 1 });
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM icebreakers WHERE page_id = ?').get(pageId)).toEqual({ n: 1 });
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM brief_assets WHERE owner_id = ?').get(userId)).toEqual({ n: 1 });
    expect(web.repos.profileEntries.listForUser(userId).length).toBeGreaterThan(0);
    expect(JSON.stringify(dumpDb(web.db))).toContain(OWNER_DIRECT);
    expect(existsSync(join(web.dataDir, 'hosted', pageId))).toBe(true);
    // 另开一个设备的会话
    const otherDevice = await login(web, owner.session.email);

    const { code } = await requestDeletionCode(web, owner.session);
    const done = await confirmDeletion(web, owner.session, code!);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('账号已注销');
    expect(done.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=;`) || /Max-Age=0/.test(cookie))).toBe(true);

    // 会话：两台设备都失效
    for (const session of [owner.session, otherDevice]) {
      const home = await get(web, '/messages', { cookie: session.cookie });
      expect(home.status).toBe(303);
      expect(home.headers.get('location')).toContain('/login');
      expect((await get(web, '/account/export', { cookie: session.cookie })).status).toBe(303);
      expect((await get(web, `/w/${wall.id}/me`, { cookie: session.cookie })).status).toBe(303);
    }
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId)).toEqual({ n: 0 });
    // Agent：凭证与未使用的指令
    expect((await agentGet(web, '/api/agent/context', w.credential)).status).toBe(401);
    expect((await exchange(web, wall.id, w.pendingToken)).status).toBe(401);
    // 页面、封面、公开链接、头像：别的成员与路人都 404
    expect((await get(web, memberPath(wall, owner), { cookie: peer.session.cookie })).status).toBe(404);
    expect((await get(web, coverPath, { cookie: peer.session.cookie })).status).toBe(404);
    expect((await get(web, `/s/${w.publicToken}`)).status).toBe(404);
    expect((await get(web, avatarPath, { cookie: peer.session.cookie })).status).toBe(404);
    const wallHtml = await (await get(web, `/w/${wall.id}`, { cookie: peer.session.cookie })).text();
    expect(wallHtml).not.toContain(pageId);
    expect(wallHtml).not.toContain('在天台种番茄');
    // 文件已删除
    expect(revisionDirExists(web, revisionId)).toBe(false);
    expect(existsSync(join(web.dataDir, 'hosted', pageId))).toBe(false);

    // 聊天：他的消息被替换，名字是“已注销用户”；私聊对方看不到了
    const history = web.repos.chat.history(w.groupId).messages;
    const his = history.filter((message) => message.senderId === userId);
    expect(his.length).toBeGreaterThan(0);
    expect(his.every((message) => message.text === DELETED_MESSAGE_TEXT && message.senderName === DELETED_USER_NICKNAME && !message.senderAvatarUrl)).toBe(true);
    expect(history.some((message) => message.text === PEER_GROUP)).toBe(true);
    expect(web.repos.chat.findVisible(w.directId, peer.session.userId)).toBeNull();
    expect((await get(web, `/messages/${w.directId}`, { cookie: peer.session.cookie })).status).toBe(404);

    // 数据库里不再有他的邮箱与内容
    const dump = JSON.stringify(dumpDb(web.db));
    for (const secret of [owner.session.email, OWNER_MATERIAL.slice(0, 12), OWNER_PROFILE_TEXT, OWNER_MESSAGE, OWNER_DIRECT, '在天台种番茄', API_KEY]) {
      expect(dump).not.toContain(secret);
    }
    const row = ownerRow(w);
    expect(row.email).toBe(`deleted:${userId}`);
    expect(row.nickname).toBe(DELETED_USER_NICKNAME);
    expect(row.avatar_webp).toBeNull();
    for (const [table, column] of [
      ['profile_entries', 'user_id'],
      ['briefs', 'owner_id'],
      ['brief_assets', 'owner_id'],
      ['icebreakers', 'viewer_id'],
      ['user_model_settings', 'user_id'],
      ['chat_reads', 'user_id'],
    ] as const) {
      expect(web.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(userId)).toEqual({ n: 0 });
    }
    expect(web.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND status = 'active'").get(userId)).toEqual({ n: 0 });
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM page_credentials WHERE page_id = ? AND revoked_at IS NULL').get(pageId)).toEqual({ n: 0 });
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM agent_tokens WHERE page_id = ? AND used_at IS NULL').get(pageId)).toEqual({ n: 0 });
    // 对方针对他的页面拿到的“和 TA 聊什么”也清掉了
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM icebreakers WHERE page_id = ?').get(pageId)).toEqual({ n: 0 });
    // 余额作废，流水只追加
    const entries = web.repos.credits.listEntries({ kind: 'user', id: userId }, 10);
    expect(entries[0]).toMatchObject({ reason: 'account_deleted', delta: -30, balanceAfter: 0 });
    expect(entries.some((entry) => entry.reason === 'grant')).toBe(true);

    // 组织者后台只看到“已注销用户”，看不到他的页面内容
    const admin = await (await get(web, `/w/${wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(admin).not.toContain('阿柚');
    expect(admin).not.toContain(owner.session.email);

    // 同一个邮箱之后注册成全新的账号，拿不回原来的东西
    const again = await login(web, owner.session.email, '新的阿柚');
    expect(again.userId).not.toBe(userId);
    expect((await get(web, `/w/${wall.id}`, { cookie: again.cookie })).status).toBe(404);
    expect((await get(web, `/w/${wall.id}/me`, { cookie: again.cookie })).status).toBe(404);
    const data = await (await get(web, '/account/data', { cookie: again.cookie })).text();
    expect(data).not.toContain(OWNER_PROFILE_TEXT);
    expect(data).not.toContain(wall.name);
  });

  it('伪造墓碑账号的“邮箱”既不能登录，也不能恢复会话', async () => {
    const w = await world();
    const userId = w.owner.session.userId;
    const { code } = await requestDeletionCode(w.t, w.owner.session);
    expect((await confirmDeletion(w.t, w.owner.session, code!)).status).toBe(200);
    expect(w.t.repos.users.findByEmail(`deleted:${userId}`)).toBeNull();
    // 墓碑邮箱不是合法邮箱：登录表单直接拒绝
    expect((await postForm(w.t, '/login', { email: `deleted:${userId}` })).status).toBe(400);
    // 即使会话行被人为塞回去，也不能当会话用
    w.t.db.prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      hashToken(w.owner.session.token),
      userId,
      'csrf',
      w.t.clock.now().toISOString(),
      new Date(w.t.clock.now().getTime() + 3600_000).toISOString(),
    );
    expect((await get(w.t, '/messages', { cookie: w.owner.session.cookie })).status).toBe(303);
  });
});

describe('S11 举报、拉黑与同意记录', () => {
  it('拉黑关系删除；他提交的举报留给平台但删去他写的说明；针对他的举报保留；协议同意记录清空', async () => {
    const w = await world();
    const { t: web, wall, owner, peer, third } = w;
    const userId = owner.session.userId;
    const OWNER_NOTE = '阿柚写的举报说明：他在页面上冒用我的作品';
    const PEER_NOTE = '林舟写的举报说明：阿柚私信骚扰';
    expect((await post(web, owner.session, `${memberPath(wall, peer)}/report`, { reason: 'impersonation', note: OWNER_NOTE })).status).toBe(303);
    expect((await post(web, peer.session, `${memberPath(wall, owner)}/report`, { reason: 'harassment', note: PEER_NOTE })).status).toBe(303);
    const withThird = web.repos.chat.ensureDirect(wall.id, userId, third.session.userId, web.clock.now().toISOString());
    expect((await post(web, owner.session, `/messages/${withThird}/block`)).status).toBe(303);
    expect((await post(web, peer.session, `/messages/${w.directId}/block`)).status).toBe(303);
    const blocks = () => web.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ? OR blocked_id = ?').get(userId, userId);
    expect(blocks()).toEqual({ n: 2 });
    expect(ownerRow(w).terms_version).not.toBeNull();

    const { code } = await requestDeletionCode(web, owner.session);
    expect((await confirmDeletion(web, owner.session, code!)).status).toBe(200);

    expect(blocks()).toEqual({ n: 0 });
    const filed = web.db.prepare('SELECT * FROM reports WHERE reporter_id = ?').all(userId) as Record<string, unknown>[];
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ note: null, reason: 'impersonation', status: 'open' });
    const against = web.db.prepare('SELECT * FROM reports WHERE reported_user_id = ?').all(userId) as Record<string, unknown>[];
    expect(against).toHaveLength(1);
    expect(against[0]).toMatchObject({ note: PEER_NOTE, reporter_id: peer.session.userId });
    const row = ownerRow(w);
    expect(row.terms_version).toBeNull();
    expect(row.terms_accepted_at).toBeNull();
    expect(JSON.stringify(dumpDb(web.db))).not.toContain(OWNER_NOTE);
  });
});

describe('S11 导出只给本人且不含凭证', () => {
  it('未登录不能导出；页面凭证当不了会话', async () => {
    const w = await world();
    const anonymous = await get(w.t, '/account/export');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/login');
    const bearer = await get(w.t, '/account/export', { headers: { authorization: `Bearer ${w.credential}` } });
    expect(bearer.status).toBe(303);
    expect(bearer.headers.get('content-type') ?? '').not.toContain('zip');
  });

  it('不含任何令牌、凭证、哈希、Key 与别人的未公开内容', async () => {
    const w = await world();
    const { t: web } = w;
    const { response, files } = await downloadExport(web, w.owner.session);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="nowme-export-\d{8}\.zip"$/);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const all = [...files.values()].map((buffer) => buffer.toString('latin1')).join('\n') + [...files.values()].map((buffer) => buffer.toString('utf8')).join('\n');

    const secrets: string[] = [w.owner.session.token, w.credential, w.pendingToken, w.publicToken, API_KEY, w.wall.inviteCode, w.owner.session.csrf];
    for (const table of ['sessions', 'page_credentials', 'agent_tokens', 'login_codes', 'redeem_codes']) {
      for (const row of web.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
        for (const value of Object.values(row)) if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) secrets.push(value);
      }
    }
    for (const row of web.db.prepare('SELECT encrypted_key FROM user_model_settings').all() as { encrypted_key: string | null }[]) if (row.encrypted_key) secrets.push(row.encrypted_key);
    expect(secrets.length).toBeGreaterThan(8);
    for (const secret of secrets) expect(all).not.toContain(secret);

    // 别人的未公开内容：别人之间的私聊、别人的采访、别人的邮箱
    expect(all).not.toContain(PEER_DIRECT_TO_OTHER);
    expect(all).not.toContain(THIRD_MATERIAL);
    expect(all).not.toContain(w.peer.session.email);
    expect(all).not.toContain('third@example.com');
  });

  it('按用户限流', async () => {
    const w = await world();
    for (let i = 0; i < 5; i += 1) expect((await get(w.t, '/account/export', { cookie: w.owner.session.cookie })).status).toBe(200);
    const limited = await get(w.t, '/account/export', { cookie: w.owner.session.cookie });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    // 别人不受影响
    expect((await get(w.t, '/account/export', { cookie: w.peer.session.cookie })).status).toBe(200);
  });
});
