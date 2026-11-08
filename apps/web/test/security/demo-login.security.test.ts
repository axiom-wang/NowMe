import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, SESSION_COOKIE_NAME } from '@nowme/contracts';
import { createWebApp } from '../../src/app.js';
import { DEMO_ACCOUNTS, DEMO_WALL_NAME } from '../../src/demo-access.js';
import { createSession, requestLoginCode } from '../../src/services/auth.js';
import { createTestWeb, createUser, dumpDb, postForm, sessionTokenFrom, seedWall, seedMember, csrfOf, latestCode, login, type TestWeb } from '../helpers.js';

describe('评审演示登录隔离', () => {
  let t: TestWeb;
  let wallId: string;
  beforeEach(() => {
    t = createTestWeb({ demo: true });
    const organizerId = createUser(t, DEMO_ACCOUNTS[1].email, '体验组织者');
    const memberId = createUser(t, DEMO_ACCOUNTS[0].email, '体验成员');
    const { wall } = seedWall(t, organizerId, DEMO_WALL_NAME);
    seedMember(t, wall, memberId);
    wallId = wall.id;
  });
  afterEach(async () => { await t.close(); });

  it('普通开发不开放快捷登录；生产、目录不一致及假模型均拒绝演示模式', async () => {
    const normal = createTestWeb();
    try {
      expect(await (await normal.request('/login')).text()).not.toContain('以成员身份体验');
      expect((await postForm(normal, '/login/demo', { identity: 'member' })).status).toBe(404);
      expect(() => createWebApp({ config: { ...normal.config, isProduction: true }, db: normal.db, demo: { dataDir: normal.dataDir } })).toThrow('演示登录必须绑定');
      expect(() => createWebApp({ config: normal.config, db: normal.db, demo: { dataDir: '/different' } })).toThrow('演示登录必须绑定');
      expect(() => createWebApp({ config: { ...normal.config, hosted: { ...normal.config.hosted, fake: true } }, db: normal.db, demo: { dataDir: normal.dataDir } })).toThrow('不能使用假模型');
      const background = await login(normal, 'background@demo.nowme.test');
      expect(background.userId).toBeTruthy();
    } finally { await normal.close(); }
  });

  it('首页和登录页只显示两个固定身份，不公开背景账号或邮箱', async () => {
    for (const path of ['/', '/login']) {
      const html = await (await t.request(path)).text();
      expect(html).toContain('以成员身份体验');
      expect(html).toContain('以组织者身份体验');
      expect(html.match(/action="\/login\/demo"/g)).toHaveLength(2);
      expect(html).not.toContain('name="email"');
      expect(html).not.toContain('@demo.nowme.test');
    }
    expect((await t.request('/dev/outbox')).status).toBe(404);
  });

  it('禁止任意身份、邮箱、用户ID、权限和跳转参数；不创建会话', async () => {
    const before = dumpDb(t.db);
    for (const fields of ([{ identity: 'background' }, { email: DEMO_ACCOUNTS[0].email }, { identity: 'member', userId: 'x' }, { identity: 'member', role: 'organizer' }, { identity: 'member', next: '//evil.example' }] as Record<string, string>[])) {
      const response = await postForm(t, '/login/demo', fields);
      expect(response.status).toBe(400);
      expect(sessionTokenFrom(response)).toBeNull();
    }
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('拒绝跨站、空来源、错误内容类型；GET不登录', async () => {
    const before = dumpDb(t.db);
    for (const origin of [null, 'null', 'https://other.example']) expect((await postForm(t, '/login/demo', { identity: 'member' }, { origin })).status).toBe(403);
    expect((await t.request('/login/demo')).status).toBe(404);
    expect((await t.request('/login/demo', { method: 'POST', headers: { origin: t.config.webOrigin, 'content-type': 'application/json' }, body: '{"identity":"member"}' })).status).toBe(400);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('真实哈希会话与安全cookie；切换销毁旧会话；退出失效；保留角色权限', async () => {
    const first = await postForm(t, '/login/demo', { identity: 'member' });
    const token = sessionTokenFrom(first)!;
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    expect(first.headers.get('location')).toBe('/');
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(first.headers.get('set-cookie')).toMatch(/SameSite=Lax/);
    expect(t.db.prepare('SELECT id FROM sessions').get()).toEqual({ id: hashToken(token) });
    const memberHome = await (await t.request('/', { headers: { cookie } })).text();
    expect(memberHome).toContain('我加入的墙');
    expect(memberHome).not.toContain('切换体验身份');
    expect(memberHome).not.toContain('action="/login/demo"');
    expect((await t.request(`/w/${wallId}/admin`, { headers: { cookie } })).status).toBe(404);
    expect((await t.request(`/w/${wallId}/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(303);
    const second = await postForm(t, '/login/demo', { identity: 'organizer' }, { cookie });
    const nextToken = sessionTokenFrom(second)!;
    expect(second.headers.get('location')).toBe('/');
    expect(nextToken).not.toBe(token);
    expect(t.repos.sessions.findValid(hashToken(token), t.clock.now().toISOString())).toBeNull();
    const nextCookie = `${SESSION_COOKIE_NAME}=${nextToken}`;
    const organizerHome = await (await t.request('/', { headers: { cookie: nextCookie } })).text();
    expect(organizerHome).toContain('我加入的墙');
    expect(organizerHome).toContain(DEMO_WALL_NAME);
    expect(organizerHome).not.toContain('切换体验身份');
    expect(organizerHome).not.toContain('action="/login/demo"');
    expect(organizerHome).toContain('切换身份');
    expect((await t.request(`/w/${wallId}/admin`, { headers: { cookie: nextCookie } })).status).toBe(200);
    expect((await postForm(t, '/logout', { _csrf: csrfOf(t, nextToken) }, { cookie: nextCookie })).status).toBe(303);
    expect(t.repos.sessions.findValid(hashToken(nextToken), t.clock.now().toISOString())).toBeNull();
    expect(t.outbox.messages).toEqual([]);
  });

  it('演示验证码仅允许两个指定账号，仍创建正常会话', async () => {
    for (const account of DEMO_ACCOUNTS) {
      expect((await postForm(t, '/login', { email: account.email })).status).toBe(200);
      const response = await postForm(t, '/login/verify', { email: account.email, code: latestCode(t, account.email), next: `/w/${wallId}/me` });
      const token = sessionTokenFrom(response)!;
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/');
      expect(t.repos.sessions.findValid(hashToken(token), t.clock.now().toISOString())?.userId).toBe(t.repos.users.findByEmail(account.email)?.id);
    }
  });

  it('验证码发放与验证都拒绝背景人物和新注册，已有背景会话也失效', async () => {
    const email = 'background@demo.nowme.test';
    const id = createUser(t, email, '背景人物');
    requestLoginCode(t.web.deps, email);
    const code = latestCode(t, email);
    const before = dumpDb(t.db);
    for (const target of [email, 'new@example.com']) {
      expect((await postForm(t, '/login', { email: target })).status).toBe(404);
      expect((await postForm(t, '/login/verify', { email: target, code })).status).toBe(404);
    }
    expect(dumpDb(t.db)).toEqual(before);
    const session = createSession(t.web.deps, id);
    expect((await t.request(`/w/${wallId}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${session.token}` } })).status).toBe(303);
  });
});
