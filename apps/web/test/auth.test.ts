/** 登录与会话（W01、contracts 4.2）：完整流程、cookie 属性、昵称、退出、发件箱。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, SESSION_COOKIE_NAME } from '@nowme/contracts';
import {
  createTestWeb,
  csrfOf,
  get,
  HOUR,
  latestCode,
  login,
  postForm,
  sessionTokenFrom,
  type TestWeb,
} from './helpers.js';

describe('登录与会话', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('首次登录：发码 → 输入验证码 → 设置会话 cookie → 填昵称 → 回到 next', async () => {
    const next = '/w/wal_aaaaaaaaaaaaaaaaaaaaaaaaaa/me';
    const sent = await postForm(t, '/login', { email: ' Ayou@Example.com ', next });
    expect(sent.status).toBe(200);
    const sentHtml = await sent.text();
    expect(sentHtml).toContain('输入验证码');
    expect(sentHtml).toContain('ayou@example.com');
    expect(sentHtml).toContain('href="/dev/outbox"');
    const message = t.outbox.messages.at(-1);
    expect(message?.to).toBe('ayou@example.com');
    expect(message?.body).toMatch(/验证码是 \d{6}，10 分钟内有效/);

    const verified = await postForm(t, '/login/verify', { email: 'ayou@example.com', code: latestCode(t, 'ayou@example.com'), next });
    expect(verified.status).toBe(303);
    expect(verified.headers.get('location')).toBe(`/welcome?next=${encodeURIComponent(next)}`);
    const [cookie] = verified.headers.getSetCookie();
    const token = sessionTokenFrom(verified) as string;
    expect(token).toMatch(/^nms_[A-Za-z0-9_-]{43}$/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/Secure/i);

    const sessionCookie = `${SESSION_COOKIE_NAME}=${token}`;
    // 没填昵称之前，其他页面都先去 /welcome
    const home = await get(t, '/', { cookie: sessionCookie });
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toBe('/welcome');
    const welcome = await get(t, `/welcome?next=${encodeURIComponent(next)}`, { cookie: sessionCookie });
    expect(welcome.status).toBe(200);

    const csrf = csrfOf(t, token);
    const named = await postForm(t, '/welcome', { _csrf: csrf, nickname: '  阿柚  ', agree: '1', next }, { cookie: sessionCookie });
    expect(named.status).toBe(303);
    expect(named.headers.get('location')).toBe(next);
    expect(t.repos.users.findByEmail('ayou@example.com')?.nickname).toBe('阿柚');
    const homeAfter = await get(t, '/', { cookie: sessionCookie });
    expect(homeAfter.status).toBe(200);
    expect(await homeAfter.text()).toContain('阿柚');
  });

  it('再次登录同一邮箱（大小写不同）：同一个用户，直接回到 next', async () => {
    const first = await login(t, 'owner@example.com', '林舟');
    await postForm(t, '/login', { email: 'OWNER@example.com' });
    const verified = await postForm(t, '/login/verify', { email: 'owner@EXAMPLE.com', code: latestCode(t, 'owner@example.com'), next: '/' });
    expect(verified.status).toBe(303);
    expect(verified.headers.get('location')).toBe('/');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(sessionTokenFrom(verified)).not.toBe(first.token);
  });

  it('昵称校验：空、超过 24 个字、含控制字符 → 400', async () => {
    await postForm(t, '/login', { email: 'new@example.com' });
    const verified = await postForm(t, '/login/verify', { email: 'new@example.com', code: latestCode(t, 'new@example.com') });
    const token = sessionTokenFrom(verified) as string;
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const csrf = csrfOf(t, token);
    for (const nickname of ['', '   ', '字'.repeat(25), '换\n行']) {
      const response = await postForm(t, '/welcome', { _csrf: csrf, nickname, agree: '1' }, { cookie });
      expect(response.status, JSON.stringify(nickname)).toBe(400);
    }
    expect((await postForm(t, '/welcome', { _csrf: csrf, nickname: '字'.repeat(24), agree: '1' }, { cookie })).status).toBe(303);
  });

  it('邮箱格式不对：400 并保留输入', async () => {
    for (const email of ['', 'not-an-email', 'a@b', '<script>@x.com', `${'a'.repeat(250)}@example.com`]) {
      const response = await postForm(t, '/login', { email });
      expect(response.status, email).toBe(400);
      expect(await response.text()).toContain('邮箱格式不对');
    }
    expect(t.outbox.messages).toEqual([]);
  });

  it('已登录访问 /login 直接跳到 next', async () => {
    const session = await login(t, 'owner@example.com');
    const response = await get(t, '/login?next=%2Fw%2Fabc%2Fme', { cookie: session.cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/w/abc/me');
  });

  it('退出登录：删除会话、清除 cookie，旧 cookie 失效', async () => {
    const session = await login(t, 'owner@example.com');
    const response = await postForm(t, '/logout', { _csrf: session.csrf }, { cookie: session.cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
    expect(response.headers.getSetCookie().join()).toMatch(new RegExp(`${SESSION_COOKIE_NAME}=;.*Max-Age=0`));
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(hashToken(session.token))).toEqual({ n: 0 });
    expect((await get(t, '/messages', { cookie: session.cookie })).status).toBe(303);
  });

  it('会话 30 天后过期', async () => {
    const session = await login(t, 'owner@example.com');
    t.clock.advance(30 * 24 * HOUR - 1000);
    expect((await get(t, '/', { cookie: session.cookie })).status).toBe(200);
    t.clock.advance(2000);
    const expired = await get(t, '/messages', { cookie: session.cookie });
    expect(expired.status).toBe(303);
    expect(expired.headers.get('location')).toBe('/login?next=%2Fmessages');
  });

  it('/dev/outbox 在非生产环境列出发出的验证码', async () => {
    await postForm(t, '/login', { email: 'owner@example.com' });
    const response = await get(t, '/dev/outbox');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('owner@example.com');
    expect(html).toContain(latestCode(t, 'owner@example.com'));
  });

  it('生产环境没有 /dev/outbox，验证码页面也不提示它；主站为 https 时 cookie 带 Secure', async () => {
    const prod = createTestWeb({
      env: { NODE_ENV: 'production', NOWME_WEB_ORIGIN: 'https://nowme.example', NOWME_PAGES_ORIGIN: 'https://pages.nowme.example' },
    });
    try {
      expect((await get(prod, '/dev/outbox')).status).toBe(404);
      const sent = await postForm(prod, '/login', { email: 'owner@example.com' });
      expect(sent.status).toBe(200);
      expect(await sent.text()).not.toContain('/dev/outbox');
      const verified = await postForm(prod, '/login/verify', { email: 'owner@example.com', code: latestCode(prod, 'owner@example.com') });
      expect(verified.headers.getSetCookie()[0]).toContain('Secure');
    } finally {
      await prod.close();
    }
  });
});
