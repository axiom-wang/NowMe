/**
 * 登录安全：验证码错误次数、过期、重放、旧码作废、发码限流；next 开放重定向防护；Host 头校验；
 * 登录表单的来源检查（防登录 CSRF）；登录时更换会话（防会话固定）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, SESSION_COOKIE_NAME } from '@nowme/contracts';
import { safeNextPath } from '../../src/security/redirect.js';
import {
  createTestWeb,
  elements,
  get,
  latestCode,
  login,
  MINUTE,
  postForm,
  sessionTokenFrom,
  type TestWeb,
} from '../helpers.js';

const EMAIL = 'owner@example.com';

describe('验证码', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  const verify = (code: string, email = EMAIL) => postForm(t, '/login/verify', { email, code });

  it('错误 5 次后验证码作废：之后输入正确的验证码也不能登录', async () => {
    await postForm(t, '/login', { email: EMAIL });
    const code = latestCode(t, EMAIL);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let remaining = 4; remaining >= 1; remaining--) {
      const response = await verify(wrong);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`还可以再试 ${remaining} 次`);
      expect(sessionTokenFrom(response)).toBeNull();
    }
    const fifth = await verify(wrong);
    expect(fifth.status).toBe(400);
    expect(await fifth.text()).toContain('错误次数太多');
    const correct = await verify(code);
    expect(correct.status).toBe(400);
    expect(sessionTokenFrom(correct)).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });

    // 重新获取的验证码可以用
    await postForm(t, '/login', { email: EMAIL });
    expect((await verify(latestCode(t, EMAIL))).status).toBe(303);
  });

  it('格式不对的输入也计入尝试次数', async () => {
    await postForm(t, '/login', { email: EMAIL });
    for (const input of ['', 'abcdef', '12345', '1234567']) await verify(input);
    const row = t.db.prepare('SELECT attempts FROM login_codes WHERE email = ?').get(EMAIL) as { attempts: number };
    expect(row.attempts).toBe(4);
  });

  it('10 分钟后过期', async () => {
    await postForm(t, '/login', { email: EMAIL });
    const code = latestCode(t, EMAIL);
    t.clock.advance(10 * MINUTE);
    const response = await verify(code);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('已过期');
    expect(sessionTokenFrom(response)).toBeNull();
  });

  it('用过的验证码不能再用；新验证码签发后旧验证码作废；验证码只对它的邮箱有效', async () => {
    await postForm(t, '/login', { email: EMAIL });
    const first = latestCode(t, EMAIL);
    await postForm(t, '/login', { email: EMAIL });
    const second = latestCode(t, EMAIL);
    if (first !== second) expect((await verify(first)).status).toBe(400);
    expect((await verify(second, 'other@example.com')).status).toBe(400);
    expect((await verify(second)).status).toBe(303);
    expect((await verify(second)).status).toBe(400);
  });

  it('同一邮箱 10 分钟内最多发 5 次验证码，超出 429；过了窗口恢复；不影响别的邮箱', async () => {
    for (let i = 0; i < 5; i++) expect((await postForm(t, '/login', { email: EMAIL })).status).toBe(200);
    const limited = await postForm(t, '/login', { email: EMAIL });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('太频繁');
    expect(t.outbox.messages.filter((message) => message.to === EMAIL)).toHaveLength(5);
    expect((await postForm(t, '/login', { email: 'other@example.com' })).status).toBe(200);
    t.clock.advance(10 * MINUTE + 1000);
    expect((await postForm(t, '/login', { email: EMAIL })).status).toBe(200);
  });

  it('登录表单需要同源 Origin / Referer（防登录 CSRF）', async () => {
    for (const origin of ['http://evil.example', 'null', null]) {
      const response = await postForm(t, '/login', { email: EMAIL }, { origin });
      expect(response.status, String(origin)).toBe(403);
    }
    expect(t.outbox.messages).toEqual([]);
    await postForm(t, '/login', { email: EMAIL });
    const forged = await postForm(t, '/login/verify', { email: EMAIL, code: latestCode(t, EMAIL) }, { origin: 'http://evil.example' });
    expect(forged.status).toBe(403);
    expect(sessionTokenFrom(forged)).toBeNull();
  });

  it('登录时总是换新会话：带着旧会话 cookie 登录，旧会话被删除', async () => {
    const first = await login(t, EMAIL);
    await postForm(t, '/login', { email: EMAIL });
    const response = await postForm(t, '/login/verify', { email: EMAIL, code: latestCode(t, EMAIL) }, { cookie: first.cookie });
    const token = sessionTokenFrom(response) as string;
    expect(token).not.toBe(first.token);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(hashToken(first.token))).toEqual({ n: 0 });
    // 攻击者预先放进 cookie 的任意值不会成为会话
    const planted = `${SESSION_COOKIE_NAME}=nms_${'A'.repeat(43)}`;
    expect((await get(t, '/', { cookie: planted })).status).toBe(303);
  });
});

describe('next 开放重定向防护', () => {
  const origin = 'http://localhost:3000';

  it.each([
    ['//evil.example', '/'],
    ['///evil.example', '/'],
    ['/\\evil.example', '/'],
    ['\\\\evil.example', '/'],
    ['https://evil.example/', '/'],
    ['http://localhost:3000.evil.example/', '/'],
    ['javascript:alert(1)', '/'],
    ['data:text/html,x', '/'],
    ['/%0d%0aSet-Cookie:x', '/%0d%0aSet-Cookie:x'],
    ['/\nfoo', '/'],
    ['/\tfoo', '/'],
    ['w/abc/me', '/'],
    ['', '/'],
    ['/login?next=/x', '/'],
    ['/logout', '/'],
    [`/${'a'.repeat(600)}`, '/'],
    ['/w/abc/me', '/w/abc/me'],
    ['/w/abc/me?rev=rev_x#preview', '/w/abc/me?rev=rev_x#preview'],
    ['/', '/'],
  ])('%s → %s', (next, expected) => {
    expect(safeNextPath(next, origin)).toBe(expected);
  });

  it('登录流程里恶意 next 被替换为 /（表单隐藏字段与重定向都是站内路径）', async () => {
    const t = createTestWeb();
    try {
      const page = await (await get(t, `/login?next=${encodeURIComponent('//evil.example/x')}`)).text();
      const hidden = elements(page).find((element) => element.tag === 'input' && element.attrs.name === 'next');
      expect(hidden?.attrs.value).toBe('/');

      await login(t, EMAIL);
      for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
        await postForm(t, '/login', { email: EMAIL, next });
        const response = await postForm(t, '/login/verify', { email: EMAIL, code: latestCode(t, EMAIL), next });
        expect(response.status).toBe(303);
        expect(response.headers.get('location'), next).toBe('/');
      }
    } finally {
      await t.close();
    }
  });
});

describe('Host 头校验', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it.each(['127.0.0.1:3000', '127.0.0.1:4000', 'localhost:3001', 'evil.example', 'localhost'])('Host: %s → 421，不设 cookie', async (host) => {
    for (const path of ['/login', '/api/agent/context', '/static/app.css']) {
      const response = await t.request(path, { headers: { host } });
      expect(response.status, path).toBe(421);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.text()).toContain(t.config.webOrigin);
    }
    const post = await t.web.request(`http://${host}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.config.webOrigin },
      body: 'email=owner%40example.com',
    });
    expect(post.status).toBe(421);
    expect(t.outbox.messages).toEqual([]);
  });

  it('URL 中的主机不对（例如 127.0.0.1 访问）也 421', async () => {
    const response = await t.web.request('http://127.0.0.1:3000/login');
    expect(response.status).toBe(421);
  });

  it('正确的 Host：正常响应', async () => {
    const response = await t.request('/login', { headers: { host: 'localhost:3000' } });
    expect(response.status).toBe(200);
  });
});
