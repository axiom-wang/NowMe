/**
 * S3：一次性 token 只能换取一次；过期无效；只对签发它的那一页、那一面墙有效；
 * 换取后该页旧凭证全部失效；数据库只存哈希。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken, type AgentContext, type ExchangeResponse } from '@nowme/contracts';
import {
  agentGet,
  connectAgent,
  createUser,
  dumpDb,
  exchange,
  exampleFiles,
  HOUR,
  issueInstruction,
  login,
  postForm,
  postJson,
  seedMember,
  seedWall,
  type TestWeb,
  createTestWeb,
} from '../helpers.js';

async function expectTokenInvalid(response: Response): Promise<string> {
  expect(response.status).toBe(401);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('TOKEN_INVALID');
  expect(body.error.message).toMatch(/[一-鿿]/);
  return body.error.message;
}

describe('S3 一次性 token', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('换取成功：返回凭证、页面 ID 与 AgentContext；token 只能换一次', async () => {
    const owner = createUser(t, 'owner@example.com', '林舟');
    const { wall, page } = seedWall(t, owner);
    const { token } = issueInstruction(t, wall, page);

    const first = await exchange(t, wall.id, token);
    expect(first.status).toBe(200);
    const body = (await first.json()) as ExchangeResponse;
    expect(body.credential).toMatch(/^nmc_[A-Za-z0-9_-]{43}$/);
    expect(body.page).toEqual({ id: page.id });
    const context: AgentContext = body.context;
    expect(context.wall).toEqual({ id: wall.id, name: wall.name, description: wall.description, sceneType: 'hackathon', organizerNote: null });
    expect(context.page).toEqual({ id: page.id, revisionCount: 0, lastSubmittedAt: null, workspaceUrl: `${t.config.webOrigin}/w/${wall.id}/me` });
    expect(context.kit.version).toBe('1');
    expect(context.kit.basePath).toBe('/_nowme/kit/v1/');
    expect(context.kit.fonts.length).toBeGreaterThan(0);
    expect(context.limits.htmlMaxBytes).toBe(300 * 1024);

    const message = await expectTokenInvalid(await exchange(t, wall.id, token));
    expect(message).toContain('已经用过');
    // 第二次失败没有签发新凭证
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM page_credentials').get()).toEqual({ n: 1 });
  });

  it('过期的 token 无效（按 NOWME_AGENT_TOKEN_TTL_HOURS）', async () => {
    const owner = createUser(t, 'owner@example.com');
    const { wall, page } = seedWall(t, owner);
    const { token, expiresAt } = issueInstruction(t, wall, page);
    expect(expiresAt.getTime() - t.clock.now().getTime()).toBe(72 * HOUR);
    t.clock.advance(72 * HOUR);
    expect(await expectTokenInvalid(await exchange(t, wall.id, token))).toContain('过期');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM page_credentials').get()).toEqual({ n: 0 });
  });

  it('有效期可调：NOWME_AGENT_TOKEN_TTL_HOURS=1', async () => {
    const short = createTestWeb({ env: { NOWME_AGENT_TOKEN_TTL_HOURS: '1' } });
    try {
      const owner = createUser(short, 'owner@example.com');
      const { wall, page } = seedWall(short, owner);
      const { token } = issueInstruction(short, wall, page);
      short.clock.advance(HOUR - 1000);
      const ok = await exchange(short, wall.id, token);
      expect(ok.status).toBe(200);
      const second = issueInstruction(short, wall, page);
      short.clock.advance(HOUR);
      await expectTokenInvalid(await exchange(short, wall.id, second.token));
    } finally {
      await short.close();
    }
  });

  it('别的墙 ID：拒绝，且不消耗 token', async () => {
    const owner = createUser(t, 'owner@example.com');
    const { wall, page } = seedWall(t, owner, '墙 A');
    const { wall: otherWall } = seedWall(t, owner, '墙 B');
    const { token } = issueInstruction(t, wall, page);

    expect(await expectTokenInvalid(await exchange(t, otherWall.id, token))).toContain('不匹配');
    expect(await expectTokenInvalid(await exchange(t, 'wal_aaaaaaaaaaaaaaaaaaaaaaaaaa', token))).toContain('不匹配');
    expect((await exchange(t, wall.id, token)).status).toBe(200);
  });

  it('只对签发它的那一页有效：凭证只能访问与提交这一页', async () => {
    const owner = createUser(t, 'owner@example.com');
    const other = createUser(t, 'other@example.com');
    const { wall, page } = seedWall(t, owner);
    const { page: otherPage } = seedMember(t, wall, other);

    const credential = await connectAgent(t, wall, page);
    const context = (await (await agentGet(t, '/api/agent/context', credential)).json()) as AgentContext;
    expect(context.page.id).toBe(page.id);

    const submitted = await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    expect(submitted.status).toBe(201);
    expect(t.repos.revisions.listForPage(page.id)).toHaveLength(1);
    expect(t.repos.revisions.listForPage(otherPage.id)).toHaveLength(0);

    // 另一位成员的 token 换到的是另一位成员的页面
    const otherCredential = await connectAgent(t, wall, otherPage);
    const otherContext = (await (await agentGet(t, '/api/agent/context', otherCredential)).json()) as AgentContext;
    expect(otherContext.page.id).toBe(otherPage.id);
    // 两个凭证互不影响
    expect((await agentGet(t, '/api/agent/context', credential)).status).toBe(200);
  });

  it('换取后该页旧凭证全部失效；重新生成指令会作废未使用的旧 token', async () => {
    const owner = createUser(t, 'owner@example.com');
    const { wall, page } = seedWall(t, owner);
    const oldCredential = await connectAgent(t, wall, page);
    expect((await agentGet(t, '/api/agent/context', oldCredential)).status).toBe(200);

    const unused = issueInstruction(t, wall, page);
    const fresh = issueInstruction(t, wall, page);
    // 生成新指令时旧的未使用 token 作废
    await expectTokenInvalid(await exchange(t, wall.id, unused.token));
    // 只生成、未换取时旧凭证仍然有效（contracts 4.1：重新生成指令并被换取时才吊销）
    expect((await agentGet(t, '/api/agent/context', oldCredential)).status).toBe(200);

    const response = await exchange(t, wall.id, fresh.token);
    const newCredential = ((await response.json()) as ExchangeResponse).credential;
    const stale = await agentGet(t, '/api/agent/context', oldCredential);
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('CREDENTIAL_INVALID');
    expect((await agentGet(t, '/api/agent/context', newCredential)).status).toBe(200);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM page_credentials WHERE page_id = ? AND revoked_at IS NULL').get(page.id)).toEqual({ n: 1 });
  });

  it('格式不对、不存在、伪造的 token 一律 401 TOKEN_INVALID（不是 400）', async () => {
    const owner = createUser(t, 'owner@example.com');
    const { wall } = seedWall(t, owner);
    const bodies: unknown[] = [
      { wallId: wall.id, token: generateToken('agentToken') },
      { wallId: wall.id, token: 'nmt_short' },
      { wallId: wall.id, token: generateToken('pageCredential') },
      { wallId: 'not-a-wall', token: generateToken('agentToken') },
      { wallId: wall.id },
      { wallId: wall.id, token: generateToken('agentToken'), extra: 1 },
    ];
    for (const body of bodies) await expectTokenInvalid(await postJson(t, '/api/agent/exchange', body));
    const bad = await postJson(t, '/api/agent/exchange', '{not json');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('墙关闭或成员关系无效时 token 无效，已有凭证也失效', async () => {
    const owner = createUser(t, 'owner@example.com');
    const member = createUser(t, 'member@example.com');
    const { wall, page } = seedWall(t, owner);
    const { page: memberPage, membership } = seedMember(t, wall, member);
    const credential = await connectAgent(t, wall, memberPage);
    const { token } = issueInstruction(t, wall, memberPage);

    t.db.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?").run(t.clock.now().toISOString(), membership.id);
    await expectTokenInvalid(await exchange(t, wall.id, token));
    expect((await agentGet(t, '/api/agent/context', credential)).status).toBe(401);

    const ownerCredential = await connectAgent(t, wall, page);
    const ownerToken = issueInstruction(t, wall, page).token;
    t.db.prepare("UPDATE walls SET status = 'closed', closed_at = ? WHERE id = ?").run(t.clock.now().toISOString(), wall.id);
    await expectTokenInvalid(await exchange(t, wall.id, ownerToken));
    for (const request of [
      agentGet(t, '/api/agent/context', ownerCredential),
      postJson(t, '/api/agent/events', { type: 'fetch' }, ownerCredential),
      postJson(t, '/api/agent/revisions', { files: exampleFiles() }, ownerCredential),
    ]) {
      const response = await request;
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('CREDENTIAL_INVALID');
    }
  });

  it('数据库只存哈希：token、凭证、会话令牌、验证码的明文都不在库里', async () => {
    const session = await login(t, 'owner@example.com', '林舟');
    const { wall, page } = seedWall(t, session.userId);
    // 通过工作区生成指令（与用户实际操作一致）
    const response = await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: session.csrf }, { cookie: session.cookie });
    expect(response.status).toBe(200);
    const token = (await response.text()).match(/nmt_[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeDefined();
    const unusedToken = issueInstruction(t, wall, page).token; // 再生成一条，保持未使用
    const credential = (await (await exchange(t, wall.id, unusedToken)).json()) as ExchangeResponse;

    const code = t.outbox.messages.at(-1)?.body.match(/\d{6}/)?.[0] as string;
    const dump = JSON.stringify(dumpDb(t.db));
    for (const secret of [token as string, unusedToken, credential.credential, session.token]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(secret.slice(4)); // 去掉前缀也不在
    }
    expect(dump).toContain(hashToken(unusedToken));
    expect(dump).toContain(hashToken(credential.credential));
    expect(dump).toContain(hashToken(session.token));
    // 验证码：login_codes 只有 64 位 hex 哈希
    const codes = t.db.prepare('SELECT code_hash FROM login_codes').all() as { code_hash: string }[];
    expect(codes.length).toBeGreaterThan(0);
    for (const row of codes) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.code_hash).not.toContain(code);
    }
  });
});
