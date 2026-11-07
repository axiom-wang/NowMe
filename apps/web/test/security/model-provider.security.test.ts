import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultModelEndpoint, loadConfig } from '@nowme/contracts';
import { createModelClient } from '../../src/hosted/model-client.js';
import { createFakeModel } from '../../src/hosted/fake-model.js';
import { createModelFetch, isPublicModelAddress, validateModelUrl } from '../../src/security/model-network.js';
import { createUserModels, type UserModelInput } from '../../src/hosted/user-models.js';
import { createTestWeb, createUser, dumpDb, get, login, postForm, seedWall, type TestWeb } from '../helpers.js';
import { completeInterview, generate, joinAs } from '../hosted-helpers.js';
import { post } from '../publish-helpers.js';

const KEY = 'sk-USER-SECRET-0123456789';
const MASTER = 'ab'.repeat(32);
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const params = { model: 'test-model', max_tokens: 100, system: [{ type: 'text' as const, text: 's' }], messages: [{ role: 'user' as const, content: 'hi' }] };
const input = (apiKey = KEY): UserModelInput => ({ provider: 'openai', baseUrl: '', model: 'test-model', apiKey, vision: false });
let t: TestWeb | undefined;
afterEach(async () => { await t?.close(); t = undefined; });
function setup(transport?: typeof fetch) {
  t = createTestWeb({ secretEnv: { NOWME_AI_ENCRYPTION_KEY: MASTER, NOWME_MODEL_API_KEY: 'platform-must-not-be-used' }, modelFetch: transport, modelLookup: lookup });
  return t;
}
function save(web: TestWeb, userId: string, apiKey = KEY) { web.web.deps.userModels.save(userId, { interview: input(apiKey), generate: input(apiKey) }); }

function fields(csrf: string) {
  return { _csrf: csrf, shared: '1', interview_provider: 'openai', interview_baseUrl: '', interview_model: 'test-small', interview_apiKey: KEY, generate_model: 'test-large' };
}

describe('用户模型凭证与调用隔离', () => {
  it('平台 Key 完全不参与，OpenAI 凭证只出现在鉴权头；上游错误不回显凭证或响应体', async () => {
    const seen: RequestInit[] = [];
    const web = setup((async (_url, init) => { seen.push(init!); return new Response(`secret ${KEY}`, { status: 401 }); }) as typeof fetch);
    const userId = createUser(web, 'one@example.com');
    expect(web.web.deps.userModels.ready(userId)).toBe(false);
    expect(() => web.web.deps.userModels.resolve(userId, 'generate')).toThrow('MODEL_CONFIG');
    save(web, userId);
    const client = web.web.deps.userModels.resolve(userId, 'generate').client;
    await expect(client.createMessage(params)).rejects.toThrow('MODEL_AUTH');
    expect(seen).toHaveLength(1);
    expect(new Headers(seen[0]!.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(String(seen[0]!.body)).not.toContain(KEY);
    expect(seen[0]!.redirect).toBe('manual');
    expect(JSON.stringify(dumpDb(web.db))).not.toContain(KEY);
    expect(JSON.stringify(web.config)).not.toContain(KEY);
    expect(loadConfig({ ANTHROPIC_API_KEY: KEY }).hosted.generate.hasApiKey).toBe(false);
  });

  it('AES-GCM 随机加密、跨会话读取；保存页与错误页均不回显 Key', async () => {
    const web = setup();
    const a = await login(web, 'a@example.com');
    expect((await postForm(web, '/account/ai', fields(a.csrf), { cookie: a.cookie })).status).toBe(303);
    const first = JSON.stringify(dumpDb(web.db).user_model_settings);
    const anotherSession = await login(web, 'a@example.com');
    const html = await (await get(web, '/account/ai', { cookie: anotherSession.cookie })).text();
    expect(html).toContain('已加密保存');
    expect(html).not.toContain(KEY);
    expect(web.web.deps.userModels.summary(a.userId, 'generate')?.endpoint.model).toBe('test-large');
    await postForm(web, '/account/ai', fields(a.csrf), { cookie: a.cookie });
    expect(JSON.stringify(dumpDb(web.db).user_model_settings)).not.toBe(first);
    const invalid = await postForm(web, '/account/ai', { ...fields(a.csrf), interview_baseUrl: `https://${KEY}:pw@evil.example/v1` }, { cookie: a.cookie });
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).not.toContain(KEY);
    const emptyKeyFields = { ...fields(a.csrf), interview_apiKey: '' };
    expect((await postForm(web, '/account/ai', emptyKeyFields, { cookie: a.cookie })).status).toBe(303);
    expect(web.web.deps.userModels.ready(a.userId)).toBe(true);
    const restartedVault = createUserModels(web.db, { encryptionKey: MASTER, allowLocal: false, lookup, now: web.clock.now });
    expect(restartedVault.ready(a.userId)).toBe(true);
  });

  it('无主密钥不写入，错误主密钥不降级；密文被篡改或调换用户后不能使用', async () => {
    const web = setup();
    const a = createUser(web, 'a@example.com');
    const b = createUser(web, 'b@example.com');
    const noKey = createUserModels(web.db, { allowLocal: false, now: web.clock.now });
    expect(() => noKey.save(a, { interview: input(), generate: input() })).toThrow('MODEL_CONFIG');
    expect(dumpDb(web.db).user_model_settings).toHaveLength(0);
    save(web, a); save(web, b, 'sk-other-user');
    const wrongKey = createUserModels(web.db, { encryptionKey: 'cd'.repeat(32), allowLocal: false, now: web.clock.now });
    await expect(wrongKey.resolve(a, 'generate').client.createMessage(params)).rejects.toThrow('MODEL_CONFIG');
    web.db.prepare("UPDATE user_model_settings SET encrypted_key=(SELECT encrypted_key FROM user_model_settings WHERE user_id=? AND role='generate') WHERE user_id=? AND role='generate'").run(a, b);
    await expect(web.web.deps.userModels.resolve(b, 'generate').client.createMessage(params)).rejects.toThrow('MODEL_CONFIG');
    expect(() => createUserModels(web.db, { encryptionKey: 'invalid', allowLocal: false, now: web.clock.now })).toThrow('64');
  });

  it('不同用户与不同角色使用各自的 Key 和模型；更换、删除后旧客户端停止请求', async () => {
    const seen: { key: string | null; model: string }[] = [];
    const web = setup((async (_url, init) => {
      seen.push({ key: new Headers(init!.headers).get('authorization'), model: JSON.parse(String(init!.body)).model });
      return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    }) as typeof fetch);
    const a = createUser(web, 'a@example.com'); const b = createUser(web, 'b@example.com');
    save(web, a); save(web, b, 'sk-b-user');
    const aClient = web.web.deps.userModels.resolve(a, 'generate').client;
    const bClient = web.web.deps.userModels.resolve(b, 'generate').client;
    await Promise.all([aClient.createMessage(params), bClient.createMessage({ ...params, model: 'b-model' })]);
    expect(seen).toEqual(expect.arrayContaining([{ key: `Bearer ${KEY}`, model: 'test-model' }, { key: 'Bearer sk-b-user', model: 'b-model' }]));
    save(web, a, 'sk-new');
    await expect(aClient.createMessage(params)).rejects.toThrow('MODEL_CONFIG');
    const current = web.web.deps.userModels.resolve(a, 'generate').client;
    web.web.deps.userModels.delete(a);
    await expect(current.createMessage(params)).rejects.toThrow('MODEL_CONFIG');
    expect(web.web.deps.userModels.ready(b)).toBe(true);
    expect(seen).toHaveLength(2);
    expect(() => web.web.deps.userModels.save(b, { interview: { ...input(''), baseUrl: 'https://other.example/v1' }, generate: input() })).toThrow('MODEL_CONFIG');
  });

  it('账号设置受会话、Origin、CSRF 保护，提交其他 userId 也只能操作自己', async () => {
    const web = setup(); const a = await login(web, 'a@example.com'); const b = await login(web, 'b@example.com');
    save(web, a.userId);
    expect((await postForm(web, '/account/ai', fields(a.csrf))).status).toBe(401);
    expect((await postForm(web, '/account/ai', fields(a.csrf), { cookie: a.cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await postForm(web, '/account/ai/delete', { _csrf: 'wrong' }, { cookie: a.cookie })).status).toBe(403);
    const html = await (await get(web, '/account/ai', { cookie: b.cookie })).text();
    expect(html).not.toContain('已加密保存');
    await postForm(web, '/account/ai/delete', { _csrf: b.csrf, userId: a.userId }, { cookie: b.cookie });
    expect(web.web.deps.userModels.ready(a.userId)).toBe(true);
    await postForm(web, '/account/ai/delete', { _csrf: a.csrf }, { cookie: a.cookie });
    expect(web.web.deps.userModels.ready(a.userId)).toBe(false);
  });

  it('无平台模型 Key：用户配置后真实走采访、工具循环、版本存储；删除 Key 保留已有资料', async () => {
    const fake = createFakeModel();
    const seen: string[] = [];
    const web = setup((async (_url, init) => {
      seen.push(new Headers(init!.headers).get('authorization')?.replace(/^Bearer /, '') ?? new Headers(init!.headers).get('x-api-key') ?? '');
      const body = JSON.parse(String(init!.body));
      const result = await fake.createMessage(body);
      return Response.json({ ...result, id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_sequence: null });
    }) as typeof fetch);
    const organizer = createUser(web, 'org@example.com'); const { wall } = seedWall(web, organizer);
    const owner = await joinAs(web, wall, 'owner@example.com', '阿柚');
    const settings = { ...input(), provider: 'anthropic', model: '' };
    web.web.deps.userModels.save(owner.session.userId, { interview: settings, generate: settings });
    await completeInterview(web, wall, owner);
    const generated = await generate(web, wall, owner);
    expect(generated.job?.status).toBe('succeeded');
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((key) => key === KEY)).toBe(true);
    expect(JSON.stringify(fake.calls)).not.toContain(KEY);
    const brief = web.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
    await post(web, owner.session, '/account/ai/delete');
    expect(web.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)).toEqual(brief);
    const again = await post(web, owner.session, `/w/${wall.id}/me/generate`);
    expect(again.headers.get('location')).toContain('MODEL_CONFIG');
    expect(web.repos.revisions.listForPage(owner.member.page.id)).toHaveLength(1);
  });

  it('删除排队任务的 Key：旧任务失败，不再向模型发送请求；已发送任务仍可完成', async () => {
    const fake = createFakeModel();
    let block = false;
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    const web = setup((async (_url, init) => {
      const bearer = new Headers(init!.headers).get('authorization') ?? '';
      seen.push(bearer);
      if (block) { block = false; entered(); await gate; }
      const body = JSON.parse(String(init!.body));
      const response = await fake.createMessage(body);
      return Response.json({ ...response, id: 'msg_test', type: 'message', role: 'assistant', model: body.model });
    }) as typeof fetch);
    const { wall } = seedWall(web, createUser(web, 'org@example.com'));
    const a = await joinAs(web, wall, 'a@example.com', '阿柚');
    const b = await joinAs(web, wall, 'b@example.com', '小白');
    const settings = { ...input(), provider: 'anthropic', model: '' };
    for (const owner of [a, b]) {
      web.web.deps.userModels.save(owner.session.userId, { interview: settings, generate: settings });
      await completeInterview(web, wall, owner);
    }
    block = true;
    await post(web, a.session, `/w/${wall.id}/me/generate`);
    await started;
    await post(web, b.session, `/w/${wall.id}/me/generate`);
    web.web.deps.userModels.delete(b.session.userId);
    release();
    await web.web.deps.hosted!.idle();
    const jobs = web.repos.jobs.listRecent(b.member.page.id, b.session.userId);
    expect(jobs[0]).toMatchObject({ status: 'failed', errorCode: 'MODEL_CONFIG', revisionId: null });
    expect(web.repos.jobs.listRecent(a.member.page.id, a.session.userId)[0]?.status).toBe('succeeded');
    expect(web.repos.revisions.listForPage(b.member.page.id)).toHaveLength(0);
  });

});

describe('模型服务 SSRF 与重定向', () => {
  it('拒绝内网、保留地址、非 HTTPS、账号密码及查询；仅显式开发配置允许回环', () => {
    for (const ip of ['0.0.0.0', '127.1.2.3', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1']) expect(isPublicModelAddress(ip), ip).toBe(false);
    for (const raw of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?key=x', 'https://example.com/#x', 'https://127.1', 'https://[::1]', 'http://localhost:11434/v1']) expect(() => validateModelUrl(raw), raw).toThrow('MODEL_CONFIG');
    expect(validateModelUrl('http://localhost:11434/v1', true).hostname).toBe('localhost');
    expect(() => validateModelUrl('http://10.0.0.1/v1', true)).toThrow();
  });

  it('每次请求重新检查 DNS，任一内网结果都拒绝，禁止跟随重定向', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254' } }));
    const dns = vi.fn(lookup);
    const request = createModelFetch({ lookup: dns, transport: transport as typeof fetch });
    await expect(request('https://example.com/v1')).rejects.toThrow('MODEL_CONFIG');
    dns.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(request('https://example.com/v1')).rejects.toThrow('MODEL_CONFIG');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toBeDefined();
    expect(dns).toHaveBeenCalledTimes(2);
  });

  it('直接适配器不跟随 3xx；缺 Key 不创建客户端', async () => {
    const endpoint = { ...defaultModelEndpoint('openai'), ready: true };
    expect(createModelClient(endpoint, null)).toBeNull();
    const mock = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://evil.example' } }));
    await expect(createModelClient(endpoint, KEY, { fetch: mock as typeof fetch })!.createMessage(params)).rejects.toThrow('不允许跳转');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('实际 HTTP 传输连接已校验的回环 IP、传递请求体，且不跟随 302', async () => {
    const seen: { path: string; body: string; key: string | undefined }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen.push({ path: req.url!, body: Buffer.concat(chunks).toString(), key: req.headers.authorization });
      if (req.url === '/redirect') { res.writeHead(302, { location: '/leak' }).end(); return; }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const dns = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const request = createModelFetch({ allowLocal: true, lookup: dns });
    try {
      const response = await request(`http://localhost:${port}/v1`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: 'hello' });
      expect(await response.json()).toEqual({ ok: true });
      await expect(request(`http://localhost:${port}/redirect`)).rejects.toThrow('MODEL_CONFIG');
      expect(seen).toEqual([{ path: '/v1', body: 'hello', key: `Bearer ${KEY}` }, { path: '/redirect', body: '', key: undefined }]);
      expect(dns).toHaveBeenCalledTimes(2);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

});
