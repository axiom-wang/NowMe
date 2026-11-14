/**
 * 年龄确认与协议同意（contracts 16.3）：
 * - 首次登录必须勾选“已年满 18 岁并同意协议”，记录版本与时间；
 * - 没确认当前版本的用户访问任何登录后页面都被导到 /consent，改变状态的表单也不会执行；
 * - 协议升版本后老用户重新确认；/api/（页面凭证）与公开页面不受影响；
 * - `next` 只允许站内路径。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateId, LEGAL_VERSION, SESSION_COOKIE_NAME } from '@nowme/contracts';
import { createSession } from '../../src/services/auth.js';
import { agentGet, connectAgent, createTestWeb, csrfOf, get, latestCode, login, postForm, seedWall, sessionTokenFrom, type TestWeb } from '../helpers.js';

describe('首次登录的勾选', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  async function firstLogin(email: string) {
    await postForm(t, '/login', { email });
    const verified = await postForm(t, '/login/verify', { email, code: latestCode(t, email) });
    const token = sessionTokenFrom(verified) as string;
    return { cookie: `${SESSION_COOKIE_NAME}=${token}`, csrf: csrfOf(t, token), email };
  }

  it('欢迎页有必选勾选和协议链接', async () => {
    const who = await firstLogin('new@example.com');
    const html = await (await get(t, '/welcome', { cookie: who.cookie })).text();
    expect(html).toContain('name="agree"');
    expect(html).toMatch(/<input[^>]*name="agree"[^>]*required/);
    expect(html).toContain('我已年满 18 岁，并同意');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });

  it('不勾选：400，昵称与同意记录都不写', async () => {
    const who = await firstLogin('new@example.com');
    for (const agree of [undefined, '', '0', 'on']) {
      const fields: Record<string, string> = { _csrf: who.csrf, nickname: '阿柚' };
      if (agree !== undefined) fields.agree = agree;
      const response = await postForm(t, '/welcome', fields, { cookie: who.cookie });
      expect(response.status, String(agree)).toBe(400);
      expect(await response.text()).toContain('请先勾选');
    }
    const user = t.repos.users.findByEmail('new@example.com');
    expect(user?.nickname).toBeNull();
    expect(user?.termsVersion).toBeNull();
    expect(user?.termsAcceptedAt).toBeNull();
  });

  it('勾选：记录当前版本与时间，才能进入站内', async () => {
    const who = await firstLogin('new@example.com');
    expect((await get(t, '/', { cookie: who.cookie })).status).toBe(303);
    const response = await postForm(t, '/welcome', { _csrf: who.csrf, nickname: '阿柚', agree: '1' }, { cookie: who.cookie });
    expect(response.status).toBe(303);
    const user = t.repos.users.findByEmail('new@example.com');
    expect(user?.termsVersion).toBe(LEGAL_VERSION);
    expect(user?.termsAcceptedAt).toBe(t.clock.now().toISOString());
    expect((await get(t, '/', { cookie: who.cookie })).status).toBe(200);
  });
});

describe('没确认当前版本的用户', () => {
  let t: TestWeb;
  let userId: string;
  let cookie: string;
  let csrf: string;
  beforeEach(() => {
    t = createTestWeb();
    // 老用户：有昵称，但没有确认记录（013 迁移之前注册）
    userId = generateId('usr');
    t.repos.users.create({ id: userId, email: 'old@example.com', nickname: '老用户', createdAt: t.clock.now().toISOString() });
    const session = createSession(t.web.deps, userId);
    cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
    csrf = session.csrfToken;
  });
  afterEach(async () => {
    await t.close();
  });

  it('登录后的 GET 页面都导到 /consent，并带上原来要去的地方', async () => {
    for (const path of ['/', '/messages', '/account/data', '/account/credits', '/walls/new', '/account/ai']) {
      const response = await get(t, path, { cookie });
      expect(response.status, path).toBe(303);
      expect(response.headers.get('location'), path).toBe(path === '/' ? '/consent' : `/consent?next=${encodeURIComponent(path)}`);
    }
    const json = await get(t, '/messages/list', { cookie });
    expect(json.status).toBe(403);
  });

  it('改变状态的表单不会执行', async () => {
    const response = await postForm(t, '/walls', { _csrf: csrf, name: '新墙', description: '', sceneType: 'interest', organizerNote: '' }, { cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/consent');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM walls').get()).toEqual({ n: 0 });
    const profile = await postForm(t, '/account/credits/redeem', { _csrf: csrf, code: 'whatever' }, { cookie });
    expect(profile.headers.get('location')).toBe('/consent');
  });

  it('/consent、/terms、/privacy、/logout 不受影响；公开页面不需要登录', async () => {
    expect((await get(t, '/consent', { cookie })).status).toBe(200);
    expect((await get(t, '/terms', { cookie })).status).toBe(200);
    expect((await get(t, '/privacy')).status).toBe(200);
    expect((await get(t, '/terms')).status).toBe(200);
    expect((await postForm(t, '/logout', { _csrf: csrf }, { cookie })).status).toBe(303);
  });

  it('不勾选：400；勾选后记录版本并回到 next', async () => {
    const refused = await postForm(t, '/consent', { _csrf: csrf, next: '/messages' }, { cookie });
    expect(refused.status).toBe(400);
    expect(t.repos.users.findById(userId)?.termsVersion).toBeNull();
    const accepted = await postForm(t, '/consent', { _csrf: csrf, next: '/messages', agree: '1' }, { cookie });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get('location')).toBe('/messages');
    expect(t.repos.users.findById(userId)?.termsVersion).toBe(LEGAL_VERSION);
    expect((await get(t, '/messages', { cookie })).status).toBe(200);
  });

  it('next 只允许站内路径', async () => {
    for (const next of ['https://evil.example/', '//evil.example', 'javascript:alert(1)']) {
      const accepted = await postForm(t, '/consent', { _csrf: csrf, next, agree: '1' }, { cookie });
      expect(accepted.headers.get('location'), next).toBe('/');
    }
  });

  it('CSRF 不对：不记录', async () => {
    const response = await postForm(t, '/consent', { _csrf: 'wrong', agree: '1' }, { cookie });
    expect(response.status).toBe(403);
    expect(t.repos.users.findById(userId)?.termsVersion).toBeNull();
  });

  it('重新登录后先到 /consent（带 next）', async () => {
    await postForm(t, '/login', { email: 'old@example.com', next: '/messages' });
    const verified = await postForm(t, '/login/verify', { email: 'old@example.com', code: latestCode(t, 'old@example.com'), next: '/messages' });
    expect(verified.headers.get('location')).toBe(`/consent?next=${encodeURIComponent('/messages')}`);
  });

  it('不影响 /api/：页面凭证照常使用', async () => {
    const { wall, page } = seedWall(t, userId);
    const credential = await connectAgent(t, wall, page);
    expect((await agentGet(t, '/api/agent/context', credential)).status).toBe(200);
  });
});

describe('协议升版本', () => {
  it('确认过旧版本的用户被要求重新确认；确认过当前版本的不受影响', async () => {
    const t = createTestWeb();
    try {
      const id = generateId('usr');
      t.repos.users.create({ id, email: 'v@example.com', nickname: '老用户', createdAt: t.clock.now().toISOString() });
      t.repos.users.recordConsent(id, '2020-01-01', t.clock.now().toISOString());
      const session = createSession(t.web.deps, id);
      const cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
      const old = await get(t, '/', { cookie });
      expect(old.headers.get('location')).toBe('/consent');
      expect(await (await get(t, '/consent', { cookie })).text()).toContain('我们更新了协议');
      await postForm(t, '/consent', { _csrf: session.csrfToken, agree: '1' }, { cookie });
      expect((await get(t, '/', { cookie })).status).toBe(200);
      // 已确认当前版本的人访问 /consent 直接回到 next
      expect((await get(t, '/consent?next=%2Fmessages', { cookie })).headers.get('location')).toBe('/messages');
    } finally {
      await t.close();
    }
  });

  it('登录页：已登录但没确认的人被送到 /consent', async () => {
    const t = createTestWeb();
    try {
      const who = await login(t, 'x@example.com', '某人');
      t.repos.users.recordConsent(who.userId, '2020-01-01', t.clock.now().toISOString());
      expect((await get(t, '/login', { cookie: who.cookie })).headers.get('location')).toBe('/consent');
    } finally {
      await t.close();
    }
  });
});
