/**
 * S10 点数与平台 AI 的安全不变量（contracts 12）：
 * - 平台模型的 API key 只来自环境变量：只出现在发给模型服务的鉴权头里，不入库、不进配置对象、不写日志、不在任何页面出现；
 *   模型服务出错时用户只看到“暂时用不了”，看不到服务商的原始回复；
 * - 每个人只能看到自己的余额与流水；组织者只看到墙额度的聚合数字；
 * - 兑换码只存哈希、只能用一次、按用户限流；兑换、给墙充额度都要会话 + CSRF + 本站来源；
 * - 只有组织者能给墙充额度，且不能超过自己的余额；墙的额度只给这面墙的有效成员用；
 * - 余额不为负，流水只追加，同一任务不会重复扣点或重复退点。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RATE_RULES } from '../../src/constants.js';
import { planJob, sponsorWall, userAccount, wallAllowance } from '../../src/services/billing.js';
import { removeMember } from '../../src/services/walls.js';
import { createTestWeb, dumpDb, get, login, postForm, seedMember, seedWall, type TestWeb } from '../helpers.js';
import { balanceOf, createPlatformTestWeb, newCode, topUp, wallBalanceOf } from '../billing-helpers.js';
import { completeInterview, generate, interviewFields, joinAs, postMultipart, type HostedTestWeb } from '../hosted-helpers.js';
import { post, workspaceHtml } from '../publish-helpers.js';

let t: TestWeb | HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const PLATFORM_KEY = 'sk-PLATFORM-SECRET-0123456789';
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('S10 平台模型的 key', () => {
  it('只出现在发给模型服务的鉴权头里；不入库、不进配置、不写日志、不在页面上；出错时不回显服务商的回复', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const logs: string[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return new Response(`upstream says: invalid key ${PLATFORM_KEY}`, { status: 401 });
    }) as typeof fetch;
    const web = createTestWeb({
      env: { NOWME_PLATFORM_PROVIDER: 'openai', NOWME_PLATFORM_MODEL: 'test-large', NOWME_PLATFORM_INTERVIEW_MODEL: 'test-small' },
      secretEnv: { NOWME_PLATFORM_API_KEY: PLATFORM_KEY },
      modelFetch: transport,
      modelLookup: lookup,
      log: (line) => logs.push(line),
    });
    t = web;
    expect(web.web.deps.platformModel.available).toBe(true);
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizer.userId);
    const owner = await joinAs(web, wall, 'owner@example.com', '阿柚');

    // 采访会调用平台模型（这里服务商返回 401）
    const started = await postMultipart(web, `/w/${wall.id}/me/create/start`, interviewFields(owner.session), [], { cookie: owner.session.cookie });
    const startedHtml = started.status === 303 ? await (await get(web, started.headers.get('location') ?? '/', { cookie: owner.session.cookie })).text() : await started.text();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(new URL(seen[0]!.url).host).toBe('api.openai.com');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(String(seen[0]!.init.body)).not.toContain(PLATFORM_KEY);
    expect(seen[0]!.init.redirect).toBe('manual');

    const pages = [startedHtml];
    for (const path of [`/w/${wall.id}/me`, `/w/${wall.id}/me/create`, '/account/credits', '/account/ai', `/w/${wall.id}`]) {
      pages.push(await (await get(web, path, { cookie: owner.session.cookie })).text());
    }
    pages.push(await (await get(web, `/w/${wall.id}/admin`, { cookie: organizer.cookie })).text());
    const html = pages.join('\n');
    expect(html).not.toContain(PLATFORM_KEY);
    expect(html).not.toContain('upstream says');
    // 用户看到的是“暂时用不了”，而不是让他去检查一个他看不到的配置
    expect(html).not.toContain('模型服务拒绝了凭证');
    expect(JSON.stringify(dumpDb(web.db))).not.toContain(PLATFORM_KEY);
    expect(JSON.stringify(web.config)).not.toContain(PLATFORM_KEY);
    expect(logs.join('\n')).not.toContain(PLATFORM_KEY);
    expect(logs.join('\n')).not.toContain('upstream says');
    // 真实的错误类别留在服务端日志里，给运营看
    expect(logs.some((line) => line.includes('平台 AI 调用失败') && line.includes('MODEL_AUTH'))).toBe(true);
  });

  it('配置了平台 AI 但没有 key：不可用，行为与没有平台 AI 时相同', async () => {
    const web = createTestWeb({ env: { NOWME_PLATFORM_PROVIDER: 'openai', NOWME_PLATFORM_MODEL: 'test-large' } });
    t = web;
    expect(web.web.deps.platformModel.available).toBe(false);
    const owner = await login(web, 'owner@example.com', '阿柚');
    const { wall } = seedWall(web, owner.userId);
    const html = await workspaceHtml(web, owner, wall.id);
    expect(html).toContain('尚未配置');
    expect(html).not.toContain('NOWMe 的 AI');
    expect(planJob(web.web.deps, owner.userId, wall.id, 'generate', { ownReady: false, platformAvailable: false })).toEqual({ ok: false, error: 'MODEL_CONFIG' });
  });

  it('平台 AI 的服务地址必须是公网 HTTPS：内网地址在启动时就被拒绝', () => {
    for (const baseUrl of ['http://api.example.com/v1', 'https://127.0.0.1/v1', 'https://10.0.0.8/v1', 'https://169.254.169.254/latest']) {
      expect(() =>
        createTestWeb({ env: { NOWME_PLATFORM_PROVIDER: 'openai-compatible', NOWME_PLATFORM_BASE_URL: baseUrl, NOWME_PLATFORM_MODEL: 'm' }, secretEnv: { NOWME_PLATFORM_API_KEY: PLATFORM_KEY } }),
      ).toThrow(/平台 AI 的服务地址不可用/);
    }
  });

  it('全站每日免费调用上限：用完后采访暂时用不了，不会无限消耗平台的模型', async () => {
    const web = createPlatformTestWeb({ env: { NOWME_PLATFORM_FREE_DAILY_CALLS: '1' } });
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizer.userId);
    const a = await joinAs(web, wall, 'a@example.com', '阿柚');
    const b = await joinAs(web, wall, 'b@example.com', '小白');
    const first = await postMultipart(web, `/w/${wall.id}/me/create/start`, interviewFields(a.session), [], { cookie: a.session.cookie });
    expect(first.status).toBe(303);
    const calls = web.fake.calls.length;
    const second = await postMultipart(web, `/w/${wall.id}/me/create/start`, interviewFields(b.session), [], { cookie: b.session.cookie });
    expect(web.fake.calls.length).toBe(calls);
    const html = second.status === 303 ? await (await get(web, second.headers.get('location') ?? '/', { cookie: b.session.cookie })).text() : await second.text();
    expect(html).toContain('暂时连不上 AI 模型服务');
  });
});

describe('S10 余额与流水只给本人', () => {
  it('“点数”页只有自己的；别人的余额、流水、兑换记录都不出现', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const a = await login(web, 'a@example.com', '阿柚');
    const b = await login(web, 'b@example.com', '小白');
    await topUp(web, a, 137);
    const mine = await (await get(web, '/account/credits', { cookie: a.cookie })).text();
    expect(mine).toMatch(/<strong>137<\/strong>/);
    const theirs = await (await get(web, '/account/credits', { cookie: b.cookie })).text();
    expect(theirs).toMatch(/<strong>0<\/strong>/);
    expect(theirs).not.toContain('137');
    expect((await get(web, '/account/credits')).status).toBe(303);
  });

  it('组织者后台只有墙额度的总数：没有成员各自用了多少，也没有成员的余额', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizer.userId);
    const owner = await joinAs(web, wall, 'owner@example.com', '阿柚');
    await topUp(web, organizer, 100);
    await topUp(web, owner.session, 777);
    await post(web, organizer, `/w/${wall.id}/admin/credits`, { credits: '60', memberCap: '0' });
    await completeInterview(web, wall, owner);
    expect((await generate(web, wall, owner)).job?.status).toBe('succeeded');
    const admin = await (await get(web, `/w/${wall.id}/admin`, { cookie: organizer.cookie })).text();
    expect(admin).toMatch(/墙的额度<\/dt>\s*<dd>50<\/dd>/);
    expect(admin).toMatch(/已用掉<\/dt>\s*<dd>10<\/dd>/);
    expect(admin).not.toContain('777');
    // 成员列表那一行里没有点数
    const row = /<li class="member-row">[\s\S]*?阿柚[\s\S]*?<\/li>/.exec(admin)?.[0] ?? '';
    expect(row).not.toMatch(/点/);
  });
});

describe('S10 兑换码', () => {
  it('库里只有哈希；事件里只有点数；页面与错误提示不回显别人的码', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const a = await login(web, 'a@example.com', '阿柚');
    const code = newCode(web, 50);
    const body = code.slice(3);
    const before = JSON.stringify(dumpDb(web.db));
    expect(before).not.toContain(code);
    expect(before).not.toContain(body.replace(/-/g, ''));
    await post(web, a, '/account/credits/redeem', { code });
    const after = JSON.stringify(dumpDb(web.db));
    expect(after).not.toContain(code);
    const events = (dumpDb(web.db).events as { type: string; props_json: string }[]).filter((event) => event.type === 'credits_redeem');
    expect(events.map((event) => JSON.parse(event.props_json))).toEqual([{ credits: 50 }]);
  });

  it('一个码只能用一次：两个人先后兑换，只有第一个到账', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const a = await login(web, 'a@example.com', '阿柚');
    const b = await login(web, 'b@example.com', '小白');
    const code = newCode(web, 50);
    expect((await post(web, a, '/account/credits/redeem', { code })).status).toBe(303);
    const second = await post(web, b, '/account/credits/redeem', { code });
    expect(second.status).toBe(400);
    expect(await second.text()).toContain('已经被用过了');
    expect([balanceOf(web, a.userId), balanceOf(web, b.userId)]).toEqual([50, 0]);
  });

  it('需要会话、CSRF 与本站来源；试太多次被限流（之后连正确的码也要等）', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const a = await login(web, 'a@example.com', '阿柚');
    const code = newCode(web, 50);
    expect((await postForm(web, '/account/credits/redeem', { code })).status).toBe(401);
    expect((await postForm(web, '/account/credits/redeem', { code }, { cookie: a.cookie })).status).toBe(403);
    expect((await postForm(web, '/account/credits/redeem', { _csrf: a.csrf, code }, { cookie: a.cookie, origin: 'https://evil.example' })).status).toBe(403);
    for (let i = 0; i < RATE_RULES.redeem.max; i += 1) expect((await post(web, a, '/account/credits/redeem', { code: 'NM-0000-0000-0000-0000' })).status).toBe(400);
    const limited = await post(web, a, '/account/credits/redeem', { code });
    expect(limited.status).toBe(429);
    expect(balanceOf(web, a.userId)).toBe(0);
    web.clock.advance(RATE_RULES.redeem.windowMs + 1000);
    expect((await post(web, a, '/account/credits/redeem', { code })).status).toBe(303);
    expect(balanceOf(web, a.userId)).toBe(50);
  });
});

describe('S10 墙的额度', () => {
  async function world() {
    const web = createPlatformTestWeb();
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizer.userId, '周末黑客松');
    const member = await joinAs(web, wall, 'member@example.com', '阿柚');
    await topUp(web, organizer, 100);
    return { web, wall, organizer, member };
  }

  it('只有组织者能充：成员、墙外的人提交都是 404，墙的额度不变', async () => {
    const { web, wall, member } = await world();
    const outsider = await login(web, 'out@example.com', '路人');
    await topUp(web, member.session, 50);
    await topUp(web, outsider, 50);
    for (const session of [member.session, outsider]) {
      expect((await post(web, session, `/w/${wall.id}/admin/credits`, { credits: '10', memberCap: '0' })).status).toBe(404);
    }
    expect(wallBalanceOf(web, wall.id)).toBe(0);
    expect([balanceOf(web, member.session.userId), balanceOf(web, outsider.userId)]).toEqual([50, 50]);
    expect((await postForm(web, `/w/${wall.id}/admin/credits`, { credits: '10' })).status).toBe(401);
  });

  it('不能充超过自己余额的点数，也不能用负数、小数、超大数把点数转出来', async () => {
    const { web, wall, organizer } = await world();
    for (const credits of ['101', '-50', '1.5', '1e3', '9999999', 'abc']) {
      const response = await post(web, organizer, `/w/${wall.id}/admin/credits`, { credits, memberCap: '0' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toMatch(/credits=(insufficient|bad-amount)#credits$/);
    }
    expect(balanceOf(web, organizer.userId)).toBe(100);
    expect(wallBalanceOf(web, wall.id)).toBe(0);
    const html = await (await get(web, `/w/${wall.id}/admin?credits=insufficient`, { cookie: organizer.cookie })).text();
    expect(html).toContain('你的点数不够这次充入');
    // 不在名单里的错误码不回显
    expect(await (await get(web, `/w/${wall.id}/admin?credits=%3Cb%3E`, { cookie: organizer.cookie })).text()).not.toContain('<b>');
  });

  it('墙的额度只给这面墙的有效成员：别的墙的成员用不到；被移出后立即用不到', async () => {
    const { web, wall, organizer, member } = await world();
    sponsorWall(web.web.deps, wall, organizer.userId, { credits: 60, memberCap: 0 });
    const { wall: otherWall } = seedWall(web, organizer.userId, '另一面墙');
    const stranger = await login(web, 'stranger@example.com', '别的墙的人');
    seedMember(web, otherWall, stranger.userId);
    expect(wallAllowance(web.web.deps, otherWall.id, stranger.userId)).toBe(0);
    expect(planJob(web.web.deps, stranger.userId, otherWall.id, 'generate', { ownReady: false, platformAvailable: true })).toMatchObject({ ok: false, error: 'credits' });

    await completeInterview(web, wall, member);
    expect(removeMember(web.web.deps, wall, organizer.userId, member.member.membership.id)).not.toBeNull();
    const response = await post(web, member.session, `/w/${wall.id}/me/generate`);
    expect(response.status).toBe(404);
    expect(wallBalanceOf(web, wall.id)).toBe(60);
  });

  it('关闭墙：没用完的额度退回组织者，不会留在一面已经不存在的墙上', async () => {
    const { web, wall, organizer } = await world();
    await post(web, organizer, `/w/${wall.id}/admin/credits`, { credits: '60', memberCap: '0' });
    expect(balanceOf(web, organizer.userId)).toBe(40);
    expect((await post(web, organizer, `/w/${wall.id}/admin/close`, { confirm: '1' })).status).toBe(303);
    expect(wallBalanceOf(web, wall.id)).toBe(0);
    expect(balanceOf(web, organizer.userId)).toBe(100);
    const history = web.repos.credits.listEntries(userAccount(organizer.userId), 10).map((entry) => [entry.reason, entry.delta]);
    expect(history).toEqual([['sponsor_return', 60], ['sponsor_out', -60], ['redeem', 100]]);
  });
});

describe('S10 账目的完整性', () => {
  it('并发开始的两个任务不会透支：余额只够一次时，第二个不会开始', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall: wallA } = seedWall(web, organizer.userId, '墙 A');
    const { wall: wallB } = seedWall(web, organizer.userId, '墙 B');
    const session = await login(web, 'owner@example.com', '阿柚');
    const onA = { session, member: seedMember(web, wallA, session.userId) };
    const onB = { session, member: seedMember(web, wallB, session.userId) };
    await topUp(web, session, 10);
    await completeInterview(web, wallA, onA);
    await completeInterview(web, wallB, onB);
    // 两个请求同时发出（各自一页，互不占用“同一页只能有一个任务”的限制）
    const [first, second] = await Promise.all([post(web, session, `/w/${wallA.id}/me/generate`), post(web, session, `/w/${wallB.id}/me/generate`)]);
    await web.web.deps.hosted?.idle();
    const started = [first, second].filter((response) => /\/jobs\/gen_/.test(response.headers.get('location') ?? ''));
    expect(started).toHaveLength(1);
    expect(balanceOf(web, session.userId)).toBe(0);
    const charges = (dumpDb(web.db).credit_entries as { reason: string }[]).filter((entry) => entry.reason === 'job');
    expect(charges).toHaveLength(1);
  });

  it('余额表不允许负数；流水不允许非法的原因、零变动', async () => {
    const web = createPlatformTestWeb();
    t = web;
    const a = await login(web, 'a@example.com', '阿柚');
    const at = web.clock.now().toISOString();
    expect(() => web.db.prepare("INSERT INTO credit_balances (account_kind, account_id, balance, updated_at) VALUES ('user', ?, -1, ?)").run(a.userId, at)).toThrow();
    expect(() => web.db.prepare("INSERT INTO credit_entries (id, account_kind, account_id, delta, balance_after, reason, created_at) VALUES ('cre_x', 'user', ?, 0, 0, 'grant', ?)").run(a.userId, at)).toThrow();
    expect(() => web.db.prepare("INSERT INTO credit_entries (id, account_kind, account_id, delta, balance_after, reason, created_at) VALUES ('cre_y', 'user', ?, 5, 5, 'free-money', ?)").run(a.userId, at)).toThrow();
  });

  it('演示模式没有点数页面与兑换入口', async () => {
    const web = createTestWeb({ demo: true });
    t = web;
    expect((await get(web, '/account/credits')).status).toBe(404);
    expect((await postForm(web, '/account/credits/redeem', { code: 'x' })).status).toBe(404);
  });
});
