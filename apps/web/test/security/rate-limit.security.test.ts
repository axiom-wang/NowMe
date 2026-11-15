/**
 * 短时限流与来源地址（contracts 10.3）：
 * - 没有登录态的入口按来源地址限流（发验证码、提交验证码、换取页面凭证），登录后的高频操作按用户限流（发消息）；
 * - 来源地址只在声明了可信代理层数时才看 `X-Forwarded-For`，并且只取代理追加的那一段，客户端伪造的部分不算数。
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { RATE_RULES } from '../../src/constants.js';
import { clientAddress, UNKNOWN_CLIENT } from '../../src/security/client.js';
import { createRateLimiter } from '../../src/security/rate-limit.js';
import { createClock, createTestWeb, get, login, MINUTE, postForm, postJson, seedMember, seedWall, type TestWeb } from '../helpers.js';

describe('createRateLimiter', () => {
  it('窗口内最多 max 次；被拒绝时给出还要等多久；窗口过后恢复', () => {
    const clock = createClock();
    const limiter = createRateLimiter(clock.now);
    const rule = { max: 3, windowMs: 60_000 };
    expect([1, 2, 3].map(() => limiter.hit('s', 'k', rule).ok)).toEqual([true, true, true]);
    clock.advance(20_000);
    expect(limiter.hit('s', 'k', rule)).toEqual({ ok: false, retryAfterSeconds: 40 });
    // 持续重试不会把窗口越拖越长
    clock.advance(39_500);
    expect(limiter.hit('s', 'k', rule)).toEqual({ ok: false, retryAfterSeconds: 1 });
    clock.advance(500);
    expect(limiter.hit('s', 'k', rule).ok).toBe(true);
  });

  it('不同范围、不同键互不影响', () => {
    const limiter = createRateLimiter(createClock().now);
    const rule = { max: 1, windowMs: 1000 };
    expect(limiter.hit('a', 'k', rule).ok).toBe(true);
    expect(limiter.hit('a', 'k', rule).ok).toBe(false);
    expect(limiter.hit('b', 'k', rule).ok).toBe(true);
    expect(limiter.hit('a', 'other', rule).ok).toBe(true);
  });

  it('键很多时清理过期记录，内存不会一直涨', () => {
    const clock = createClock();
    const limiter = createRateLimiter(clock.now);
    const rule = { max: 1, windowMs: 1000 };
    for (let i = 0; i < 6000; i += 1) limiter.hit('s', `k${i}`, rule);
    expect(limiter.size).toBe(6000);
    clock.advance(2000);
    limiter.hit('s', 'fresh', rule);
    expect(limiter.size).toBe(1);
  });
});

describe('clientAddress', () => {
  async function addressOf(hops: number, forwarded: string | undefined): Promise<string> {
    const app = new Hono();
    app.get('/', (c) => c.text(clientAddress(c, hops)));
    const response = await app.request('/', forwarded === undefined ? {} : { headers: { 'x-forwarded-for': forwarded } });
    return response.text();
  }

  it('没有声明可信代理时忽略 X-Forwarded-For', async () => {
    expect(await addressOf(0, '1.2.3.4')).toBe(UNKNOWN_CLIENT);
  });

  it('一层代理：取最右边一个；客户端自己加在左边的不算', async () => {
    expect(await addressOf(1, '203.0.113.7')).toBe('203.0.113.7');
    expect(await addressOf(1, '1.1.1.1, 9.9.9.9, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('两层代理：取右数第二个', async () => {
    expect(await addressOf(2, '1.1.1.1, 203.0.113.7, 10.0.0.2')).toBe('203.0.113.7');
  });

  it('头缺失、层数不够、不是 IP：退回连接地址', async () => {
    expect(await addressOf(1, undefined)).toBe(UNKNOWN_CLIENT);
    expect(await addressOf(2, '203.0.113.7')).toBe(UNKNOWN_CLIENT);
    expect(await addressOf(1, 'not-an-ip')).toBe(UNKNOWN_CLIENT);
  });

  it('IPv4 映射的 IPv6 按 IPv4 记；IPv6 统一成小写', async () => {
    expect(await addressOf(1, '::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(await addressOf(1, '2001:DB8::1')).toBe('2001:db8::1');
  });
});

describe('入口限流', () => {
  let t: TestWeb | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  const from = (address: string, extra = '') => ({ headers: { 'x-forwarded-for': `${extra}${address}` } });

  it('同一地址请求验证码太多次 → 429 + Retry-After；别的地址不受影响；伪造的转发头前缀绕不过去', async () => {
    t = createTestWeb({ env: { NOWME_TRUST_PROXY: '1' } });
    for (let i = 0; i < RATE_RULES.loginRequest.max; i += 1) {
      const response = await postForm(t, '/login', { email: `user${i}@example.com` }, from('203.0.113.7'));
      expect(response.status).toBe(200);
    }
    const blocked = await postForm(t, '/login', { email: 'one-more@example.com' }, from('203.0.113.7'));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.text()).toContain('这个网络发验证码发得太频繁了');
    expect(t.outbox.messages.some((message) => message.to === 'one-more@example.com')).toBe(false);

    const spoofed = await postForm(t, '/login', { email: 'spoof@example.com' }, from('203.0.113.7', '8.8.8.8, '));
    expect(spoofed.status).toBe(429);
    const elsewhere = await postForm(t, '/login', { email: 'elsewhere@example.com' }, from('198.51.100.9'));
    expect(elsewhere.status).toBe(200);

    t.clock.advance(RATE_RULES.loginRequest.windowMs + 1000);
    expect((await postForm(t, '/login', { email: 'later@example.com' }, from('203.0.113.7'))).status).toBe(200);
  });

  it('没有声明可信代理时，转发头不能用来换身份', async () => {
    t = createTestWeb();
    for (let i = 0; i < RATE_RULES.loginRequest.max; i += 1) await postForm(t, '/login', { email: `user${i}@example.com` }, from(`10.0.0.${i % 250}`));
    expect((await postForm(t, '/login', { email: 'x@example.com' }, from('172.16.0.1'))).status).toBe(429);
  });

  it('同一地址提交验证码太多次 → 429', async () => {
    t = createTestWeb({ env: { NOWME_TRUST_PROXY: '1' } });
    for (let i = 0; i < RATE_RULES.loginVerify.max; i += 1) {
      const response = await postForm(t, '/login/verify', { email: `guess${i}@example.com`, code: '000000' }, from('203.0.113.7'));
      expect(response.status).toBe(400);
    }
    const blocked = await postForm(t, '/login/verify', { email: 'guess@example.com', code: '000000' }, from('203.0.113.7'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('同一地址换取页面凭证太多次 → RATE_LIMITED', async () => {
    t = createTestWeb();
    const body = { wallId: 'wal_aaaaaaaaaaaaaaaaaaaaaaaaaa', token: 'nmt_' + 'A'.repeat(43) };
    for (let i = 0; i < RATE_RULES.agentExchange.max; i += 1) expect((await postJson(t, '/api/agent/exchange', body)).status).toBe(401);
    const blocked = await postJson(t, '/api/agent/exchange', body);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('同一用户发消息太快 → 429，草稿不丢；过一分钟恢复；别的用户不受影响', async () => {
    t = createTestWeb();
    const a = await login(t, 'a@example.com', '阿柚');
    const b = await login(t, 'b@example.com', '小白');
    const { wall } = seedWall(t, a.userId);
    seedMember(t, wall, b.userId);
    const group = (await get(t, `/messages/wall/${wall.id}`, { cookie: a.cookie })).headers.get('location') ?? '';
    const send = (session: typeof a, index: number) =>
      postForm(t!, `${group}/send`, { _csrf: session.csrf, clientId: `client-${session.userId.slice(4, 12)}-${String(index).padStart(6, '0')}`, text: `第 ${index} 条` }, { cookie: session.cookie, headers: { accept: 'application/json' } });
    for (let i = 0; i < RATE_RULES.chatSend.max; i += 1) expect((await send(a, i)).status).toBe(200);
    const blocked = await send(a, 999);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.json()).toEqual({ error: '发得有点快，大约 1 分钟后再发。' });
    expect((await send(b, 0)).status).toBe(200);
    t.clock.advance(MINUTE + 1000);
    expect((await send(a, 1000)).status).toBe(200);
  });

  it('限流不暴露会话是否存在：没有权限的会话仍然是 404', async () => {
    t = createTestWeb();
    const a = await login(t, 'a@example.com', '阿柚');
    for (let i = 0; i < RATE_RULES.chatSend.max + 2; i += 1) {
      const response = await postForm(t, '/messages/cnv_aaaaaaaaaaaaaaaaaaaaaaaaaa/send', { _csrf: a.csrf, clientId: `client-id-${String(i).padStart(8, '0')}`, text: 'x' }, { cookie: a.cookie, headers: { accept: 'application/json' } });
      expect(response.status).toBe(404);
    }
  });
});
