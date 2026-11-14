/**
 * 点数（contracts 12）：兑换码、扣点与退点、墙的额度、界面上的说明。安全不变量见 security/billing.security.test.ts。
 */
import { REDEEM_CODE_PATTERN } from '@nowme/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { chargeJob, generateRedeemCode, normalizeRedeemCode, planJob, redeemCode, refundUnsettledJobs, settleJob, sponsorWall, userAccount, wallAccount, wallAllowance } from '../src/services/billing.js';
import { closeWall } from '../src/services/walls.js';
import { InsufficientCredits } from '../src/db/credits.js';
import { createTestWeb, createUser, dumpDb, get, HOUR, login, seedMember, seedWall, type TestWeb } from './helpers.js';
import { balanceOf, createPlatformTestWeb, newCode, topUp, wallBalanceOf } from './billing-helpers.js';
import { completeInterview, createHostedTestWeb, edit, generate, joinAs, type HostedTestWeb } from './hosted-helpers.js';
import { post, workspaceHtml } from './publish-helpers.js';

let t: TestWeb | HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const ACCESS = { ownReady: false, platformAvailable: true };

describe('兑换码', () => {
  it('格式：NM- 加四组 Crockford Base32；每次都不一样', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRedeemCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(REDEEM_CODE_PATTERN);
  });

  it('输入时不区分大小写、可省略连字符与前缀，易混字符自动归一', () => {
    expect(normalizeRedeemCode('nm-abcd-efgh-jkmn-pqrs')).toBe('NM-ABCD-EFGH-JKMN-PQRS');
    expect(normalizeRedeemCode('  ABCD EFGH JKMN PQRS ')).toBe('NM-ABCD-EFGH-JKMN-PQRS');
    expect(normalizeRedeemCode('NMABCDEFGHJKMNPQRS')).toBe('NM-ABCD-EFGH-JKMN-PQRS');
    expect(normalizeRedeemCode('nm-o0il-0000-0000-0000')).toBe('NM-0011-0000-0000-0000');
    for (const bad of ['', 'NM-ABCD', 'NM-ABCD-EFGH-JKMN-PQRSX', 'NM-UUUU-UUUU-UUUU-UUUU', '<script>']) expect(normalizeRedeemCode(bad)).toBeNull();
  });

  it('兑换一次到账并记流水；再用、过期、不存在都失败且不动余额', () => {
    const web = (t = createTestWeb());
    const a = createUser(web, 'a@example.com');
    const b = createUser(web, 'b@example.com');
    const code = newCode(web, 100);
    expect(redeemCode(web.web.deps, a, code.toLowerCase().replace(/-/g, ' '))).toEqual({ ok: true, credits: 100, balance: 100 });
    expect(redeemCode(web.web.deps, a, code)).toEqual({ ok: false, error: 'used' });
    expect(redeemCode(web.web.deps, b, code)).toEqual({ ok: false, error: 'used' });
    expect(redeemCode(web.web.deps, b, generateRedeemCode())).toEqual({ ok: false, error: 'invalid' });
    expect(redeemCode(web.web.deps, b, 'not a code')).toEqual({ ok: false, error: 'invalid' });
    const expired = newCode(web, 50, { expiresAt: new Date(web.clock.now().getTime() + HOUR).toISOString() });
    web.clock.advance(2 * HOUR);
    expect(redeemCode(web.web.deps, b, expired)).toEqual({ ok: false, error: 'expired' });
    expect(balanceOf(web, a)).toBe(100);
    expect(balanceOf(web, b)).toBe(0);
    expect(web.repos.credits.listEntries(userAccount(a), 10)).toEqual([expect.objectContaining({ delta: 100, balanceAfter: 100, reason: 'redeem', actorId: a })]);
  });
});

describe('计划、扣点与退点', () => {
  function setup() {
    const web = (t = createTestWeb());
    const organizer = createUser(web, 'org@example.com', '组织者');
    const member = createUser(web, 'member@example.com', '成员');
    const { wall } = seedWall(web, organizer);
    seedMember(web, wall, member);
    return { web, deps: web.web.deps, organizer, member, wall };
  }
  const fund = (web: TestWeb, userId: string, credits: number) => redeemCode(web.web.deps, userId, newCode(web, credits));

  it('有自己的 Key：不收点数；平台 AI 没开又没有 Key：不能用', () => {
    const { deps, member, wall } = setup();
    expect(planJob(deps, member, wall.id, 'generate', { ownReady: true, platformAvailable: true })).toEqual({ ok: true, source: 'own', price: 0, payer: null });
    expect(planJob(deps, member, wall.id, 'generate', { ownReady: false, platformAvailable: false })).toEqual({ ok: false, error: 'MODEL_CONFIG' });
  });

  it('用平台 AI：先用墙的额度，再用个人余额，都不够就不开始', () => {
    const { web, deps, organizer, member, wall } = setup();
    expect(planJob(deps, member, wall.id, 'generate', ACCESS)).toEqual({ ok: false, error: 'credits', price: 10, balance: 0, wallAllowance: 0 });
    fund(web, member, 12);
    expect(planJob(deps, member, wall.id, 'generate', ACCESS)).toMatchObject({ ok: true, source: 'platform', price: 10, payer: userAccount(member) });
    fund(web, organizer, 100);
    expect(sponsorWall(deps, wall, organizer, { credits: 30, memberCap: 0 })).toMatchObject({ ok: true, balance: 70, wall: { balance: 30, memberCap: 0, spent: 0, funded: 30 } });
    expect(planJob(deps, member, wall.id, 'generate', ACCESS)).toMatchObject({ payer: wallAccount(wall.id) });
    expect(planJob(deps, member, wall.id, 'edit', ACCESS)).toMatchObject({ price: 4, payer: wallAccount(wall.id) });
  });

  it('每位成员上限：超过上限的部分墙不出，其他成员不受影响', () => {
    const { web, deps, organizer, member, wall } = setup();
    const other = createUser(web, 'other@example.com');
    seedMember(web, wall, other);
    fund(web, organizer, 100);
    sponsorWall(deps, wall, organizer, { credits: 100, memberCap: 14 });
    expect(wallAllowance(deps, wall.id, member)).toBe(14);
    chargeJob(deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', { ok: true, source: 'platform', price: 10, payer: wallAccount(wall.id) }, member);
    expect(wallAllowance(deps, wall.id, member)).toBe(4);
    expect(planJob(deps, member, wall.id, 'edit', ACCESS)).toMatchObject({ payer: wallAccount(wall.id) });
    expect(planJob(deps, member, wall.id, 'generate', ACCESS)).toMatchObject({ ok: false, error: 'credits', wallAllowance: 4 });
    expect(wallAllowance(deps, wall.id, other)).toBe(14);
    // 计划之后额度被用掉：扣点时再检查一次
    expect(() => chargeJob(deps, 'gen_bbbbbbbbbbbbbbbbbbbbbbbbbb', { ok: true, source: 'platform', price: 10, payer: wallAccount(wall.id) }, member)).toThrow(InsufficientCredits);
    expect(wallBalanceOf(web, wall.id)).toBe(90);
  });

  it('充入墙的额度：不能超过自己的余额；只改上限不动余额', () => {
    const { web, deps, organizer, wall } = setup();
    fund(web, organizer, 20);
    expect(sponsorWall(deps, wall, organizer, { credits: 21, memberCap: 0 })).toEqual({ ok: false, error: 'insufficient' });
    expect(sponsorWall(deps, wall, organizer, { credits: -1, memberCap: 0 })).toEqual({ ok: false, error: 'bad-amount' });
    expect(sponsorWall(deps, wall, organizer, { credits: 1.5, memberCap: 0 })).toEqual({ ok: false, error: 'bad-amount' });
    expect(sponsorWall(deps, wall, organizer, { credits: 0, memberCap: 10001 })).toEqual({ ok: false, error: 'bad-cap' });
    expect(balanceOf(web, organizer)).toBe(20);
    expect(wallBalanceOf(web, wall.id)).toBe(0);
    expect(sponsorWall(deps, wall, organizer, { credits: 0, memberCap: 18 })).toMatchObject({ ok: true, balance: 20, wall: { balance: 0, memberCap: 18 } });
  });

  it('结算：成功保留扣点；没成功全额退回，只退一次', () => {
    const { web, deps, member, wall } = setup();
    fund(web, member, 30);
    const plan = { ok: true as const, source: 'platform' as const, price: 10, payer: userAccount(member) };
    chargeJob(deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', plan, member);
    chargeJob(deps, 'gen_bbbbbbbbbbbbbbbbbbbbbbbbbb', plan, member);
    expect(balanceOf(web, member)).toBe(10);
    expect(settleJob(deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', true)).toBe(true);
    expect(settleJob(deps, 'gen_bbbbbbbbbbbbbbbbbbbbbbbbbb', false)).toBe(false);
    expect(settleJob(deps, 'gen_bbbbbbbbbbbbbbbbbbbbbbbbbb', false)).toBe(false);
    expect(balanceOf(web, member)).toBe(20);
    // 没扣过点的任务：什么都不做
    expect(settleJob(deps, 'gen_cccccccccccccccccccccccccc', false)).toBe(false);
    expect(settleJob(deps, 'gen_cccccccccccccccccccccccccc', true)).toBe(false);
    // 同一个任务不能扣第二次
    expect(() => chargeJob(deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', plan, member)).toThrow();
    expect(balanceOf(web, member)).toBe(20);
    void wall;
  });

  it('关闭墙：剩余额度退回组织者；之后才失败的任务，退点也退给组织者', () => {
    const { web, deps, organizer, member, wall } = setup();
    fund(web, organizer, 100);
    sponsorWall(deps, wall, organizer, { credits: 60, memberCap: 0 });
    chargeJob(deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', { ok: true, source: 'platform', price: 10, payer: wallAccount(wall.id) }, member);
    expect(closeWall(deps, wall, organizer)).not.toBeNull();
    expect(wallBalanceOf(web, wall.id)).toBe(0);
    expect(balanceOf(web, organizer)).toBe(90);
    settleJob(deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', false);
    expect(wallBalanceOf(web, wall.id)).toBe(0);
    expect(balanceOf(web, organizer)).toBe(100);
  });

  it('流水只追加：不能改、不能删；余额与流水一致', () => {
    const { web, member } = setup();
    fund(web, member, 30);
    expect(() => web.db.prepare('UPDATE credit_entries SET delta = 9999').run()).toThrow(/只追加/);
    expect(() => web.db.prepare('DELETE FROM credit_entries').run()).toThrow(/只追加/);
    expect(() => web.repos.credits.post({ account: userAccount(member), delta: -31, reason: 'adjust', at: web.clock.now().toISOString() })).toThrow(InsufficientCredits);
    const sum = web.db.prepare("SELECT SUM(delta) AS total FROM credit_entries WHERE account_kind = 'user' AND account_id = ?").get(member) as { total: number };
    expect(sum.total).toBe(balanceOf(web, member));
  });
});

describe('用平台 AI 做页面（完整流程）', () => {
  async function world(env: Record<string, string> = {}) {
    const web = createPlatformTestWeb({ env });
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizer.userId, '周末黑客松');
    const owner = await joinAs(web, wall, 'owner@example.com', '阿柚');
    return { web, wall, organizer, owner };
  }

  it('没有自己的 Key 也能用：工作区写明用的是 NOWMe 的 AI、价目与可用点数', async () => {
    const { web, wall, owner } = await world();
    const html = await workspaceHtml(web, owner.session, wall.id);
    expect(html).toContain('NOWMe 的 AI');
    expect(html).toContain('生成一版页面 10 点，修改一次 4 点');
    expect(html).toContain('你有 0 点');
    expect(html).toContain('href="/account/credits"');
  });

  it('采访不收点数；点数不够时生成不会开始；兑换后生成扣 10 点、修改扣 4 点，任务页写明', async () => {
    const { web, wall, owner } = await world();
    await completeInterview(web, wall, owner);
    expect(balanceOf(web, owner.session.userId)).toBe(0);
    expect(dumpDb(web.db).credit_entries).toEqual([]);

    const blocked = await generate(web, wall, owner);
    expect(blocked.job).toBeNull();
    expect(blocked.location).toContain('error=credits');
    expect(await (await get(web, blocked.location, { cookie: owner.session.cookie })).text()).toContain('点数不够，这次没有开始');
    expect(web.repos.jobs.listRecent(owner.member.page.id, owner.session.userId, 5)).toEqual([]);

    await topUp(web, owner.session, 20);
    const generated = await generate(web, wall, owner);
    expect(generated.job).toMatchObject({ status: 'succeeded', charged: true });
    expect(balanceOf(web, owner.session.userId)).toBe(10);
    const jobHtml = await (await get(web, generated.location, { cookie: owner.session.cookie })).text();
    expect(jobHtml).toContain('这次用了 10 点（你的点数）');

    const edited = await edit(web, wall, owner, { revisionId: generated.job?.revisionId ?? '', block: 'hero', request: '名字再大一点' });
    expect(edited.job).toMatchObject({ status: 'succeeded', charged: true });
    expect(balanceOf(web, owner.session.userId)).toBe(6);
    expect(web.repos.credits.listEntries(userAccount(owner.session.userId), 10).map((entry) => [entry.reason, entry.delta])).toEqual([['job', -4], ['job', -10], ['redeem', 20]]);
  });

  it('没做出新版本不收：校验没通过、需要补充说明，点数都全额退回', async () => {
    const { web, wall, owner } = await world();
    await topUp(web, owner.session, 20);
    await completeInterview(web, wall, owner, '我叫阿柚。【假模型：违规】做过三个小程序。');
    const rejected = await generate(web, wall, owner);
    expect(rejected.job).toMatchObject({ status: 'failed', errorCode: 'REJECTED', charged: false });
    expect(balanceOf(web, owner.session.userId)).toBe(20);
    const jobHtml = await (await get(web, rejected.location, { cookie: owner.session.cookie })).text();
    expect(jobHtml).toContain('这次没有做出新版本，10 点已退回你的余额');
    expect(jobHtml).not.toContain('检查 AI 设置');
    expect(web.repos.credits.listEntries(userAccount(owner.session.userId), 10).map((entry) => [entry.reason, entry.delta])).toEqual([['job_refund', 10], ['job', -10], ['redeem', 20]]);
  });

  it('修改时 AI 反问（没有新版本）：退回', async () => {
    const { web, wall, owner } = await world();
    await topUp(web, owner.session, 20);
    await completeInterview(web, wall, owner);
    const generated = await generate(web, wall, owner);
    const clarify = await edit(web, wall, owner, { revisionId: generated.job?.revisionId ?? '', request: '【假模型：澄清】改一下' });
    expect(clarify.job).toMatchObject({ status: 'needs_input', charged: false });
    expect(balanceOf(web, owner.session.userId)).toBe(10);
  });

  it('组织者给墙充额度：成员做页面先用墙的，超过每人上限后才用自己的', async () => {
    const { web, wall, organizer, owner } = await world();
    await topUp(web, organizer, 100);
    const saved = await post(web, organizer, `/w/${wall.id}/admin/credits`, { credits: '50', memberCap: '14' });
    expect(saved.headers.get('location')).toBe(`/w/${wall.id}/admin?notice=credits-saved#credits`);
    expect(balanceOf(web, organizer.userId)).toBe(50);
    expect(await workspaceHtml(web, owner.session, wall.id)).toContain('这面墙还能为你出 14 点');

    await completeInterview(web, wall, owner);
    const generated = await generate(web, wall, owner);
    expect(generated.job?.status).toBe('succeeded');
    expect(wallBalanceOf(web, wall.id)).toBe(40);
    expect(balanceOf(web, owner.session.userId)).toBe(0);
    expect(await (await get(web, generated.location, { cookie: owner.session.cookie })).text()).toContain('这面墙的额度，组织者为你付');

    const first = await edit(web, wall, owner, { revisionId: generated.job?.revisionId ?? '', block: 'hero', request: '改一次' });
    expect(first.job?.status).toBe('succeeded');
    expect(wallBalanceOf(web, wall.id)).toBe(36);
    // 已经用了 14 点（上限）：墙不再出，个人没有点数 → 不开始
    const second = await edit(web, wall, owner, { revisionId: first.job?.revisionId ?? '', block: 'hero', request: '再改一次' });
    expect(second.job).toBeNull();
    expect(second.location).toContain('hosted=credits');
    expect(await workspaceHtml(web, owner.session, wall.id, '?hosted=credits')).toContain('点数不够，这次没有开始');
    await topUp(web, owner.session, 4);
    const third = await edit(web, wall, owner, { revisionId: first.job?.revisionId ?? '', block: 'hero', request: '再改一次' });
    expect(third.job?.status).toBe('succeeded');
    expect(balanceOf(web, owner.session.userId)).toBe(0);
    expect(wallBalanceOf(web, wall.id)).toBe(36);

    const admin = await (await get(web, `/w/${wall.id}/admin`, { cookie: organizer.cookie })).text();
    expect(admin).toContain('给成员的 AI 额度');
    expect(admin).toMatch(/已用掉<\/dt>\s*<dd>14<\/dd>/);
  });

  it('价目可配置；设为 0 时不收点数', async () => {
    const { web, wall, owner } = await world({ NOWME_PRICE_GENERATE: '0', NOWME_PRICE_EDIT: '0' });
    expect(await workspaceHtml(web, owner.session, wall.id)).toContain('生成与修改都不收点数');
    await completeInterview(web, wall, owner);
    expect((await generate(web, wall, owner)).job).toMatchObject({ status: 'succeeded', charged: false });
    expect(dumpDb(web.db).credit_entries).toEqual([]);
  });

  it('注册赠送：新用户到账一次；再次登录不重复', async () => {
    const web = createPlatformTestWeb({ env: { NOWME_SIGNUP_CREDITS: '10' } });
    t = web;
    const first = await login(web, 'new@example.com', '新人');
    expect(balanceOf(web, first.userId)).toBe(10);
    await login(web, 'new@example.com', '新人');
    expect(balanceOf(web, first.userId)).toBe(10);
    expect(web.repos.credits.listEntries(userAccount(first.userId), 5).map((entry) => entry.reason)).toEqual(['signup']);
  });

  it('服务重启打断的任务：启动时把扣的点退回', async () => {
    const { web, wall, owner } = await world();
    await topUp(web, owner.session, 20);
    await completeInterview(web, wall, owner);
    const done = await generate(web, wall, owner);
    expect(balanceOf(web, owner.session.userId)).toBe(10);
    // 模拟一个扣了点、被标记为 INTERRUPTED 的任务
    web.repos.jobs.create({ id: 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', pageId: owner.member.page.id, ownerId: owner.session.userId, kind: 'edit', baseRevisionId: done.job?.revisionId ?? null, targetBlock: null, requestText: 'x', createdAt: web.clock.now().toISOString() });
    chargeJob(web.web.deps, 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', { ok: true, source: 'platform', price: 4, payer: userAccount(owner.session.userId) }, owner.session.userId);
    expect(web.repos.jobs.interruptAll(web.clock.now().toISOString())).toBe(1);
    expect(balanceOf(web, owner.session.userId)).toBe(6);
    expect(refundUnsettledJobs(web.web.deps)).toBe(1);
    expect(refundUnsettledJobs(web.web.deps)).toBe(0);
    expect(balanceOf(web, owner.session.userId)).toBe(10);
  });

  it('“点数”页：余额、价目、兑换成功提示与流水', async () => {
    const { web, owner } = await world();
    const empty = await (await get(web, '/account/credits', { cookie: owner.session.cookie })).text();
    expect(empty).toContain('还没有记录');
    expect(empty).toContain('生成一版页面 10 点，修改一次 4 点');
    const response = await post(web, owner.session, '/account/credits/redeem', { code: newCode(web, 30) });
    expect(response.headers.get('location')).toBe('/account/credits?redeemed=30');
    const html = await (await get(web, '/account/credits?redeemed=30', { cookie: owner.session.cookie })).text();
    expect(html).toContain('兑换成功，30 点已到账');
    expect(html).toMatch(/<strong>30<\/strong>/);
    expect(html).toContain('+30');
    const wrong = await post(web, owner.session, '/account/credits/redeem', { code: 'NM-0000-0000-0000-0000' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('这个兑换码不对');
  });
});

describe('用自己的模型（不经过平台 AI）', () => {
  it('不产生任何点数流水，工作区也不出现点数', async () => {
    const web = createHostedTestWeb();
    t = web;
    const organizer = await login(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizer.userId);
    const owner = await joinAs(web, wall, 'owner@example.com', '阿柚');
    await completeInterview(web, wall, owner);
    expect((await generate(web, wall, owner)).job).toMatchObject({ status: 'succeeded', charged: false });
    expect(dumpDb(web.db).credit_entries).toEqual([]);
    expect(await workspaceHtml(web, owner.session, wall.id)).not.toContain('NOWMe 的 AI');
  });
});
