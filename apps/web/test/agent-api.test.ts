/** Agent API（contracts 4.1）：context、events、认证错误体。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext } from '@nowme/contracts';
import { agentGet, connectAgent, createTestWeb, createUser, postJson, seedWall, type TestWeb } from './helpers.js';
import type { Page } from '../src/db/pages.js';
import type { Wall } from '../src/db/walls.js';

describe('Agent API', () => {
  let t: TestWeb;
  let wall: Wall;
  let page: Page;
  let credential: string;
  let ownerId: string;

  beforeEach(async () => {
    t = createTestWeb();
    ownerId = createUser(t, 'owner@example.com', '林舟');
    ({ wall, page } = seedWall(t, ownerId));
    credential = await connectAgent(t, wall, page);
  });
  afterEach(async () => {
    await t.close();
  });

  it('GET /api/agent/context：200 AgentContext，并记录凭证最近使用时间', async () => {
    t.clock.advance(5000);
    const response = await agentGet(t, '/api/agent/context', credential);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const context = (await response.json()) as AgentContext;
    expect(context.wall.id).toBe(wall.id);
    expect(context.page.id).toBe(page.id);
    expect(Object.keys(context).sort()).toEqual(['kit', 'limits', 'page', 'wall']);
    expect(t.repos.credentials.findActiveForPage(page.id)?.lastUsedAt).toBe(t.clock.now().toISOString());
  });

  it('缺少或格式错误的 Authorization：401 CREDENTIAL_INVALID（中文说明）', async () => {
    for (const header of [undefined, '', 'Bearer', 'Basic abc', `Bearer ${credential}x`, `Token ${credential}`, `Bearer nmc_${'a'.repeat(43)}`]) {
      const headers: Record<string, string> = header === undefined ? {} : { authorization: header };
      const response = await t.request('/api/agent/context', { headers });
      expect(response.status, String(header)).toBe(401);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CREDENTIAL_INVALID');
      expect(body.error.message).toContain('工作区');
    }
    // 大小写不敏感的 scheme 可以
    expect((await t.request('/api/agent/context', { headers: { authorization: `bearer ${credential}` } })).status).toBe(200);
  });

  it('POST /api/agent/events：204，存为 agent_<type>，只存数字与布尔属性', async () => {
    t.clock.advance(1000);
    expect((await postJson(t, '/api/agent/events', { type: 'fetch' }, credential)).status).toBe(204);
    expect((await postJson(t, '/api/agent/events', { type: 'submit', props: { ok: true, durationMs: 1234, errorCount: 0 } }, credential)).status).toBe(
      204,
    );
    const events = t.repos.events.listForPage(page.id);
    expect(events.map((event) => [event.type, event.props, event.wallId, event.actorId])).toEqual([
      ['agent_fetch', {}, wall.id, ownerId],
      ['agent_submit', { ok: true, durationMs: 1234, errorCount: 0 }, wall.id, ownerId],
    ]);
  });

  it('events：非法类型、字符串 / 对象属性、超过 16 个属性、未知字段 → 400，不存储', async () => {
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
    const bodies: unknown[] = [
      { type: 'publish' },
      { type: 'agent_fetch' },
      { type: 'submit', props: { note: '页面内容' } },
      { type: 'submit', props: { nested: { a: 1 } } },
      { type: 'submit', props: { list: [1] } },
      { type: 'submit', props: tooMany },
      { type: 'submit', props: { 'bad key': 1 } },
      { type: 'submit', content: '<html>' },
      '{bad json',
    ];
    for (const body of bodies) {
      const response = await postJson(t, '/api/agent/events', body, credential);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    }
    expect(t.repos.events.listForPage(page.id)).toEqual([]);
  });

  it('events 请求体上限 64 KB：413', async () => {
    const response = await postJson(t, '/api/agent/events', { type: 'submit', padding: 'x'.repeat(70 * 1024) }, credential);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('Agent API 不加载会话、也不受 CSRF 影响；非 GET/POST 方法 404', async () => {
    expect((await t.request('/api/agent/context', { method: 'POST', headers: { authorization: `Bearer ${credential}` } })).status).toBe(404);
    expect((await t.request('/api/agent/revisions', { headers: { authorization: `Bearer ${credential}` } })).status).toBe(404);
  });
});
