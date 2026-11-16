/**
 * 内容安全的安全约束（contracts 16.1）：
 * - 日志只记检查点类型与命中规则编号，不记原文；
 * - 外部审核接口只走公网 HTTPS（逐次解析 DNS，内网 / 回环地址一律当作“接口不可用”，不发请求），密钥不外泄；
 * - 在路由边界检查：被拦下的内容没有写库、没有交给模型、没有建任务；
 * - 无权访问的人不会触发审核接口调用。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createContentSafety } from '../../src/services/content-safety.js';
import { createHostedTestWeb, interviewFields, joinAs, postMultipart } from '../hosted-helpers.js';
import { createTestWeb, createUser, login, postForm, seedMember, seedWall, type TestWeb } from '../helpers.js';
import { post } from '../publish-helpers.js';
import { openDirect } from '../../src/services/chat.js';

let t: TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const SECRET_TEXT = '兼职刷单日结，加我领取内部暗号ZZZ-7788';

describe('日志不含原文', () => {
  it('内置规则命中：日志有类型和规则编号，没有原文', async () => {
    const logs: string[] = [];
    t = createTestWeb({ log: (line) => logs.push(line) });
    const a = await login(t, 'a@example.com', '甲');
    const b = await login(t, 'b@example.com', '乙');
    const { wall } = seedWall(t, a.userId);
    seedMember(t, wall, b.userId);
    const direct = openDirect(t.web.deps, a.userId, wall.id, b.userId)!;
    const response = await postForm(t, `/messages/${direct}/send`, { _csrf: a.csrf, text: SECRET_TEXT, clientId: 'client-id-0000000001' }, { cookie: a.cookie, headers: { accept: 'application/json' } });
    expect(response.status).toBe(400);
    const text = logs.join('\n');
    expect(text).toContain('[safety] 拦截 kind=message rule=B01');
    expect(text).not.toContain('ZZZ-7788');
    expect(text).not.toContain('刷单');
    expect(text).not.toContain('暗号');
  });

  it('外部词表与审核接口命中、审核接口失败：日志同样不含原文', async () => {
    const logs: string[] = [];
    const secret = 'ZZZ-secret-phrase';
    let mode: 'deny' | 'fail' = 'deny';
    const safety = createContentSafety({
      moderation: { blocklistFile: null, url: 'https://mod.example.com/check', onFailure: 'allow' },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: (async () => (mode === 'deny' ? new Response(JSON.stringify({ allowed: false, rule: 'x1' })) : new Response('oops', { status: 500 }))) as unknown as typeof fetch,
      log: (line) => logs.push(line),
    });
    await safety.checkText('page', secret);
    mode = 'fail';
    await safety.checkText('wall', secret);
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs[0]).toContain('kind=page rule=M:x1');
    expect(logs[1]).toContain('kind=wall');
  });
});

describe('外部审核接口只走公网 HTTPS', () => {
  const lookupPrivate = async () => [{ address: '10.0.0.5', family: 4 }];
  const lookupMixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];

  for (const [name, lookup] of [['内网地址', lookupPrivate], ['公网与回环混合', lookupMixed]] as const) {
    it(`解析到${name}：不发请求，按失败策略处理（默认放行，block 时拦截）`, async () => {
      let sent = 0;
      const transport = (async () => {
        sent += 1;
        return new Response(JSON.stringify({ allowed: true }));
      }) as unknown as typeof fetch;
      const logs: string[] = [];
      const allow = createContentSafety({ moderation: { blocklistFile: null, url: 'https://mod.example.com/c', onFailure: 'allow' }, lookup, transport, log: (line) => logs.push(line) });
      expect((await allow.checkText('message', '你好')).ok).toBe(true);
      const block = createContentSafety({ moderation: { blocklistFile: null, url: 'https://mod.example.com/c', onFailure: 'block' }, lookup, transport, log: () => {} });
      expect((await block.checkText('message', '你好')).ok).toBe(false);
      expect(sent).toBe(0);
      expect(logs.join('\n')).toContain('审核接口不可用');
    });
  }

  it('审核接口返回重定向：当作失败，不跟随', async () => {
    const transport = (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch;
    const safety = createContentSafety({
      moderation: { blocklistFile: null, url: 'https://mod.example.com/c', onFailure: 'block' },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
      log: () => {},
    });
    expect(await safety.checkText('message', '你好')).toMatchObject({ ok: false, rule: 'M00' });
  });

  it('http 地址（非本机开发）不会被调用', async () => {
    let sent = 0;
    const safety = createContentSafety({
      moderation: { blocklistFile: null, url: 'http://mod.example.com/c', onFailure: 'block' },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: (async () => {
        sent += 1;
        return new Response('{}');
      }) as unknown as typeof fetch,
      log: () => {},
    });
    expect((await safety.checkText('message', '你好')).ok).toBe(false);
    expect(sent).toBe(0);
  });

  it('审核接口的密钥只放在 Authorization 头里：不进请求体、日志与页面', async () => {
    const key = 'mod-key-SECRET-123456';
    const logs: string[] = [];
    const bodies: string[] = [];
    t = createTestWeb({
      log: (line) => logs.push(line),
      env: { NOWME_MODERATION_URL: 'https://mod.example.com/check' },
      secretEnv: { NOWME_MODERATION_API_KEY: key },
      modelLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      moderationFetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`);
        if (!body.includes('你好')) return new Response(JSON.stringify({ allowed: true }));
        bodies.push(body);
        return new Response(JSON.stringify({ allowed: false, rule: 'r9' }));
      }) as unknown as typeof fetch,
    });
    const a = await login(t, 'a@example.com', '甲');
    const b = await login(t, 'b@example.com', '乙');
    const { wall } = seedWall(t, a.userId);
    seedMember(t, wall, b.userId);
    const direct = openDirect(t.web.deps, a.userId, wall.id, b.userId)!;
    const sent = await postForm(t, `/messages/${direct}/send`, { _csrf: a.csrf, text: '你好', clientId: 'client-id-0000000001' }, { cookie: a.cookie });
    expect(sent.status).toBe(400);
    expect(await sent.text()).not.toContain(key);
    expect(bodies).toHaveLength(1);
    const html = await (await t.request('/privacy')).text();
    expect(html).toContain('内容审核服务');
    expect(html).not.toContain(key);
    expect(bodies.join('')).not.toContain(key);
    expect(logs.join('\n')).not.toContain(key);
  });
});

describe('路由边界：被拦下的内容不写库、不交给模型', () => {
  it('采访素材命中：422，不建 brief，不请求模型', async () => {
    const web = createHostedTestWeb();
    t = web;
    const { wall } = seedWall(web, createUser(web, 'org@example.com', '组织者'), '周末黑客松');
    const owner = await joinAs(web, wall, 'm@example.com', '阿柚');
    const response = await postMultipart(web, `/w/${wall.id}/me/create/start`, interviewFields(owner.session, `我叫阿柚。${SECRET_TEXT}`), [], { cookie: owner.session.cookie });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('你写的内容里');
    expect(web.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)).toBeNull();
    expect(web.fake.calls).toHaveLength(0);
  });

  it('修改要求命中：不建任务，不请求模型', async () => {
    const web = createHostedTestWeb();
    t = web;
    const { wall } = seedWall(web, createUser(web, 'org@example.com', '组织者'), '周末黑客松');
    const owner = await joinAs(web, wall, 'm@example.com', '阿柚');
    const response = await post(web, owner.session, `/w/${wall.id}/me/edit`, { revisionId: '', block: '', request: '把标题换成：稳赚不赔的项目，来就送' });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('把标题换成：稳赚不赔的项目，来就送');
    expect(web.db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    expect(web.fake.calls).toHaveLength(0);
  });

  it('无权访问的人不会触发审核接口调用', async () => {
    let calls = 0;
    t = createTestWeb({
      env: { NOWME_MODERATION_URL: 'https://mod.example.com/check' },
      modelLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      moderationFetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ allowed: true }));
      }) as unknown as typeof fetch,
    });
    const a = await login(t, 'a@example.com', '甲');
    const b = await login(t, 'b@example.com', '乙');
    const stranger = await login(t, 'c@example.com', '丙');
    calls = 0; // 登录时昵称检查也会调用审核接口
    const { wall } = seedWall(t, a.userId);
    seedMember(t, wall, b.userId);
    const direct = openDirect(t.web.deps, a.userId, wall.id, b.userId)!;
    const denied = await postForm(t, `/messages/${direct}/send`, { _csrf: stranger.csrf, text: '你好', clientId: 'client-id-0000000009' }, { cookie: stranger.cookie, headers: { accept: 'application/json' } });
    expect(denied.status).toBe(404);
    expect(calls).toBe(0);
    const allowed = await postForm(t, `/messages/${direct}/send`, { _csrf: a.csrf, text: '你好', clientId: 'client-id-0000000010' }, { cookie: a.cookie, headers: { accept: 'application/json' } });
    expect(allowed.status).toBe(200);
    expect(calls).toBe(1);
  });
});
