import { expect, it } from 'vitest';
import { sessionCookieName } from '@nowme/contracts';
import { createTestWeb, csrfOf, latestCode, postForm, type TestWeb } from '../helpers.js';

it('同一 IP 的正式站与演示端口登录互不覆盖，退出只清除本站会话', async () => {
  const env = { NOWME_ALLOW_SAME_IP_ORIGINS: '1', NOWME_PAGES_ORIGIN: 'https://203.0.113.10:8443' };
  const prod = createTestWeb({ env: { ...env, NOWME_WEB_ORIGIN: 'https://203.0.113.10' } });
  const demo = createTestWeb({ env: { ...env, NOWME_WEB_ORIGIN: 'https://203.0.113.10:8444' } });
  async function signIn(t: TestWeb, email: string) {
    await postForm(t, '/login', { email });
    const response = await postForm(t, '/login/verify', { email, code: latestCode(t, email) });
    expect(response.status).toBe(303);
    const header = response.headers.getSetCookie()[0]!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    const cookie = header.split(';')[0]!;
    const token = cookie.slice(cookie.indexOf('=') + 1);
    return { cookie, csrf: csrfOf(t, token) };
  }
  try {
    const a = await signIn(prod, 'prod@example.com');
    const b = await signIn(demo, 'demo@example.com');
    expect(a.cookie).toMatch(/^nowme_session=/);
    expect(b.cookie).toMatch(/^nowme_session_8444=/);
    const combined = `${a.cookie}; ${b.cookie}`;
    for (const t of [prod, demo]) {
      expect((await t.request('/welcome', { headers: { cookie: combined } })).status).toBe(200);
    }
    expect((await demo.request('/welcome', { headers: { cookie: a.cookie } })).status).toBe(303);
    expect((await prod.request('/welcome', { headers: { cookie: b.cookie } })).status).toBe(303);
    const logout = await postForm(demo, '/logout', { _csrf: b.csrf }, { cookie: combined });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toMatch(/^nowme_session_8444=/);
    expect((await prod.request('/welcome', { headers: { cookie: combined } })).status).toBe(200);
    expect((await demo.request('/welcome', { headers: { cookie: combined } })).status).toBe(303);
  } finally { await prod.close(); await demo.close(); }
});

it('域名沿用原会话名，IPv6 的不同端口也分开', () => {
  expect(sessionCookieName('https://nowme.example:8444')).toBe('nowme_session');
  expect(sessionCookieName('https://[2001:db8::1]:8444')).toBe('nowme_session_8444');
});
