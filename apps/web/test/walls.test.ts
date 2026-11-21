/**
 * 墙的闭环（T3.1）：建墙（W02）、邀请与加入（W04，含退出后重新加入）、墙（W13）、成员页、想聊这个（W14）、
 * 组织者后台（W03：移除、关闭墙）、“我的”、事件。访问控制矩阵与 S1 / S5 见 test/security/wall-*.security.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_IFRAME_SANDBOX, verifyTicket } from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import { wallQueries } from '../src/db/wall-queries.js';
import type { Wall } from '../src/db/walls.js';
import { qrSvg } from '../src/services/qr.js';
import { parsePublishedCard, parsePublishedContact, shuffle, type StageModel } from '../src/services/wall-view.js';
import { parseWallForm } from '../src/services/walls.js';
import {
  agentGet,
  connectAgent,
  createTestWeb,
  elements,
  get,
  iframesOf,
  login,
  postForm,
  seedMember,
  seedWall,
  TEST_SECRET,
  TINY_PNG,
  type TestSession,
  type TestWeb,
} from './helpers.js';
import { publishedMember, publishPage, withdraw } from './wall-helpers.js';

const CONTACT = { channel: 'wechat', value: 'ayou_2026' };

function cardOrder(html: string): string[] {
  return [...html.matchAll(/class="wall-card__link" href="\/w\/[^/]+\/p\/(pg_[a-z2-7]+)"/g)].map((match) => match[1] as string);
}

describe('建墙（W02）', () => {
  let t: TestWeb;
  let owner: TestSession;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
  });
  afterEach(async () => {
    await t.close();
  });

  it('表单：名称、简介、点选场景类型（label 来自场景指南）、可选“组织者的话”', async () => {
    const response = await get(t, '/walls/new', { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const type of ['hackathon', 'interest', 'club', 'general'] as const) {
      expect(html).toContain(`value="${type}"`);
      expect(html).toContain(loadSceneGuide(type).label);
    }
    const names = elements(html)
      .filter((element) => ['input', 'textarea'].includes(element.tag))
      .map((element) => element.attrs.name);
    expect(names).toEqual(expect.arrayContaining(['_csrf', 'name', 'description', 'sceneType', 'organizerNote']));
  });

  it('提交后创建墙，创建者成为组织者成员并有自己的页面，跳到组织者后台', async () => {
    const response = await postForm(
      t,
      '/walls',
      { _csrf: owner.csrf, name: '  周末黑客松  ', description: '48 小时\r\n找到队友', sceneType: 'hackathon', organizerNote: '写清楚想找什么样的队友' },
      { cookie: owner.cookie },
    );
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    const wallId = /^\/w\/(wal_[a-z2-7]{26})\/admin\?notice=created$/.exec(location)?.[1];
    expect(wallId).toBeTruthy();
    const wall = t.repos.walls.findById(wallId ?? '') as Wall;
    expect(wall).toMatchObject({
      name: '周末黑客松',
      description: '48 小时\n找到队友',
      sceneType: 'hackathon',
      organizerNote: '写清楚想找什么样的队友',
      organizerId: owner.userId,
      status: 'open',
    });
    expect(wall.inviteCode).toMatch(/^inv_[a-z2-7]{26}$/);
    const membership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    expect(membership).toMatchObject({ role: 'organizer', status: 'active' });
    expect(t.repos.pages.findByMembership(membership?.id ?? '')?.ownerId).toBe(owner.userId);

    const admin = await get(t, location, { cookie: owner.cookie });
    expect(admin.status).toBe(200);
    const html = await admin.text();
    expect(html).toContain('墙建好了');
    expect(html).toContain(`${t.config.webOrigin}/join/${wall.inviteCode}`);
  });

  it('“组织者的话”可以不填（存为 null）', async () => {
    await postForm(t, '/walls', { _csrf: owner.csrf, name: '读书会', description: '', sceneType: 'interest', organizerNote: '  ' }, { cookie: owner.cookie });
    const wall = t.repos.walls.findOpenByOrganizerAndName(owner.userId, '读书会');
    expect(wall?.organizerNote).toBeNull();
    expect(wall?.description).toBe('');
  });

  it('不合法的表单：400，逐项提示，保留已填内容，不建墙', async () => {
    const response = await postForm(
      t,
      '/walls',
      { _csrf: owner.csrf, name: '', description: 'x'.repeat(201), sceneType: 'party', organizerNote: '一\t二' },
      { cookie: owner.cookie },
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('请填写墙的名称');
    expect(html).toContain('简介最多 200 个字');
    expect(html).toContain('请选一种场景');
    expect(html).toContain('组织者的话只能是一行文字');
    expect(html).toContain('x'.repeat(201));
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM walls').get()).toEqual({ n: 0 });
  });

  it('parseWallForm：长度按码点计算，名称不能换行', () => {
    expect(parseWallForm({ name: '😀'.repeat(40), sceneType: 'club' }).ok).toBe(true);
    expect(parseWallForm({ name: '😀'.repeat(41), sceneType: 'club' }).ok).toBe(false);
    expect(parseWallForm({ name: '第一行\n第二行', sceneType: 'club' }).ok).toBe(false);
    expect(parseWallForm({ name: '墙', sceneType: 'club', description: '第一行\n第二行' }).ok).toBe(true);
  });
});

describe('邀请与加入（W04）', () => {
  let t: TestWeb;
  let owner: TestSession;
  let member: TestSession;
  let wall: Wall;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    member = await login(t, 'member@example.com', '小白');
    ({ wall } = seedWall(t, owner.userId, '周末黑客松'));
  });
  afterEach(async () => {
    await t.close();
  });

  it('未登录打开邀请链接：先登录再回来（/login?next=/join/<邀请码>）', async () => {
    const response = await get(t, `/join/${wall.inviteCode}`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/join/${wall.inviteCode}`)}`);
  });

  it('加入页显示墙名、简介与加入按钮；加入后新建成员关系与页面，记 join 事件，进入墙', async () => {
    const page = await get(t, `/join/${wall.inviteCode}`, { cookie: member.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('周末黑客松');
    expect(html).toContain('测试用的墙');
    expect(html).toContain(`action="/join/${wall.inviteCode}"`);
    expect(html).toContain('加入这面墙');

    const joined = await postForm(t, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    expect(joined.status).toBe(303);
    // 新成员直接进入“做一页自己”的引导（contracts 18.1）
    expect(joined.headers.get('location')).toBe(`/w/${wall.id}/me/create?welcome=1`);
    const guide = await get(t, `/w/${wall.id}/me/create?welcome=1`, { cookie: member.cookie });
    expect(guide.status).toBe(200);
    const guideHtml = await guide.text();
    expect(guideHtml).toContain('欢迎加入「周末黑客松」');
    expect(guideHtml).toContain(`href="/w/${wall.id}">先去墙上看看</a>`);
    const membership = t.repos.memberships.findByWallAndUser(wall.id, member.userId);
    expect(membership).toMatchObject({ role: 'member', status: 'active' });
    const memberPage = t.repos.pages.findByMembership(membership?.id ?? '');
    expect(memberPage?.ownerId).toBe(member.userId);
    const events = t.repos.events.listForWall(wall.id).filter((event) => event.type === 'join');
    expect(events).toEqual([expect.objectContaining({ actorId: member.userId, pageId: memberPage?.id, props: { rejoin: false } })]);

    const welcome = await get(t, `/w/${wall.id}?notice=joined`, { cookie: member.cookie });
    expect(welcome.status).toBe(200);
    expect(await welcome.text()).toContain('加入成功');
  });

  it('已是成员：打开邀请直接进墙；再次提交不重复创建', async () => {
    seedMember(t, wall, member.userId);
    const page = await get(t, `/join/${wall.inviteCode}`, { cookie: member.cookie });
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe(`/w/${wall.id}`);
    const again = await postForm(t, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`/w/${wall.id}`);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE wall_id = ?').get(wall.id)).toEqual({ n: 2 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM pages WHERE wall_id = ?').get(wall.id)).toEqual({ n: 2 });
    // 组织者打开自己墙的邀请也直接进墙
    expect((await get(t, `/join/${wall.inviteCode}`, { cookie: owner.cookie })).headers.get('location')).toBe(`/w/${wall.id}`);
  });

  it('退出后重新加入：重新激活原成员关系（同一行、同一页），页面保持未发布', async () => {
    const published = publishedMember(t, wall, { userId: member.userId, name: '小白', contact: CONTACT });
    // 模拟“退出墙”（T3.2）：成员关系 left；这里故意不结束发布，验证重新加入时页面也不会回到墙上
    expect(t.repos.memberships.markLeft(published.membership.id, t.clock.now().toISOString())).toBe(true);

    const page = await get(t, `/join/${wall.inviteCode}`, { cookie: member.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('你之前退出过这面墙');
    expect(html).toContain('重新加入这面墙');

    t.clock.advance(60_000);
    const rejoined = await postForm(t, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    expect(rejoined.status).toBe(303);
    expect(rejoined.headers.get('location')).toBe(`/w/${wall.id}?notice=rejoined`);
    const membership = t.repos.memberships.findByWallAndUser(wall.id, member.userId);
    expect(membership).toMatchObject({ id: published.membership.id, status: 'active', endedAt: null, joinedAt: t.clock.now().toISOString() });
    expect(t.repos.pages.findByMembership(published.membership.id)?.id).toBe(published.page.id);
    expect(t.repos.publications.findActiveForPage(published.page.id)).toBeNull();
    expect(t.repos.publications.displayState(published.page.id)).not.toBe('published');
    const joinEvents = t.repos.events.listForWall(wall.id).filter((event) => event.type === 'join');
    expect(joinEvents.at(-1)?.props).toEqual({ rejoin: true });

    const wallHtml = await (await get(t, `/w/${wall.id}`, { cookie: owner.cookie })).text();
    expect(cardOrder(wallHtml)).toEqual([]);
  });

  it('被移除的成员：加入页给出友好提示（403），提交也不能加入', async () => {
    const { membership } = seedMember(t, wall, member.userId);
    t.repos.memberships.markRemoved(membership.id, t.clock.now().toISOString());
    const page = await get(t, `/join/${wall.inviteCode}`, { cookie: member.cookie });
    expect(page.status).toBe(403);
    const html = await page.text();
    expect(html).toContain('现在不能加入这面墙');
    expect(html).not.toContain(`action="/join/`);
    const post = await postForm(t, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie });
    expect(post.status).toBe(403);
    expect(t.repos.memberships.findById(membership.id)?.status).toBe('removed');
  });
});

describe('墙（W13）、成员页与想聊这个（W14）', () => {
  let t: TestWeb;
  let owner: TestSession;
  let viewer: TestSession;
  let wall: Wall;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    viewer = await login(t, 'viewer@example.com', '小白');
    ({ wall } = seedWall(t, owner.userId, '周末黑客松'));
    seedMember(t, wall, viewer.userId);
  });
  afterEach(async () => {
    await t.close();
  });

  it('空状态：没有人发布时显示提示与“我的页面”入口', async () => {
    const response = await get(t, `/w/${wall.id}`, { cookie: viewer.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('周末黑客松');
    expect(html).toContain('墙上还没有人');
    expect(html).toContain(`href="/w/${wall.id}/me"`);
    expect(html).toContain('未发布');
    expect(cardOrder(html)).toEqual([]);
  });

  it('只显示已发布的有效成员；卡片内容取自发布快照（不是版本原始 card）；封面 lazy、固定尺寸', async () => {
    const ayou = publishedMember(t, wall, { name: '阿柚', contact: CONTACT });
    const quiet = publishedMember(t, wall, { name: '安静的人', contact: null });
    const drafted = seedMember(t, wall, (await login(t, 'draft@example.com', '草稿君')).userId);
    const withdrawn = publishedMember(t, wall, { name: '撤下的人' });
    withdraw(t, withdrawn.page);

    const html = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(new Set(cardOrder(html))).toEqual(new Set([ayou.page.id, quiet.page.id]));
    expect(html).toContain('阿柚的一行介绍');
    expect(html).toContain('阿柚能帮你做前端');
    expect(html).not.toContain('原始介绍');
    expect(html).not.toContain('撤下的人');
    expect(html).not.toContain(drafted.page.id);
    expect(html).not.toContain(CONTACT.value);
    expect(html).not.toContain('rev_');

    const images = elements(html).filter((element) => element.tag === 'img');
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.attrs.loading).toBe('lazy');
      expect(image.attrs.width).toBe('375');
      expect(image.attrs.height).toBe('500');
      expect(image.attrs.src).toMatch(new RegExp(`^/w/${wall.id}/covers/pg_[a-z2-7]{26}\\.png$`));
    }

    const cover = await get(t, `/w/${wall.id}/covers/${ayou.page.id}.png`, { cookie: viewer.cookie });
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(cover.headers.get('cache-control')).toBe('private, no-cache');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(TINY_PNG);
    const etag = cover.headers.get('etag') ?? '';
    expect(etag).not.toContain('rev_');
    const cached = await get(t, `/w/${wall.id}/covers/${ayou.page.id}.png`, { cookie: viewer.cookie, headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
  });

  it('没有封面文件时显示占位，不链接封面', async () => {
    publishedMember(t, wall, { name: '无封面', cover: false });
    const html = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(elements(html).filter((element) => element.tag === 'img')).toEqual([]);
    expect(html).toContain('wall-card__placeholder');
  });

  it('每次请求随机排序（多次请求的顺序不全相同），不按热度', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => publishedMember(t, wall, { name: `成员${index}` }).page.id);
    const orders = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const order = cardOrder(await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text());
      expect([...order].sort()).toEqual([...ids].sort());
      orders.add(order.join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('卡片上的便签完整写出第一个接话点，其余的只写数量；全部接话点进检索文字', async () => {
    publishedMember(t, wall, { name: '阿柚' });
    const html = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    const card = elements(html).find((element) => element.attrs['data-wall-card'] !== undefined);
    const hooks = [...html.matchAll(/class="wall-card__say-text">([^<]+)</g)].map((match) => match[1]);
    expect(hooks).toHaveLength(1);
    expect(card?.attrs['data-search']).toContain('阿柚'.toLowerCase());
    expect(card?.attrs['data-search']).toContain(hooks[0]?.toLowerCase());
    const more = /还想聊 (\d+) 个话题/.exec(html);
    const search = card?.attrs['data-search'] ?? '';
    // 检索文字 = 名字 + 一行介绍 + 全部接话点；便签之外的接话点也能被搜到
    expect(search.split(' ').length).toBeGreaterThanOrEqual(2 + Number(more?.[1] ?? 0));
    expect(html).not.toContain('wall-card__hook"');
  });

  it('还没上墙时墙上给自己留一个空位（不算卡片）；发布后空位消失', async () => {
    publishedMember(t, wall, { name: '阿柚' });
    const before = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(before).toContain('这里留给你');
    expect(before).toContain(`class="wall-ghost__link" href="/w/${wall.id}/me"`);
    expect(cardOrder(before)).toHaveLength(1);
    const mine = t.repos.memberships.findByWallAndUser(wall.id, viewer.userId);
    const myPage = t.repos.pages.findByMembership(mine?.id ?? '');
    if (!mine || !myPage) throw new Error('缺少成员关系');
    publishPage(t, { membership: mine, page: myPage }, '小白');
    const after = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(after).not.toContain('wall-ghost');
    expect(cardOrder(after)).toHaveLength(2);
  });

  it('写明上墙人数与成员总数；卡片够多才出现搜索框', async () => {
    publishedMember(t, wall, { name: '成员0' });
    const few = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(few).toMatch(/data-wall-count-note[^>]*>位已上墙<\/span>/);
    expect(few).toMatch(/data-wall-summary[\s\S]*共 \d+ 位成员/);
    expect(few).not.toContain('data-wall-search');
    for (let index = 1; index < 4; index += 1) publishedMember(t, wall, { name: `成员${index}` });
    const many = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(many).toContain('data-wall-search');
    expect(many).toMatch(/src="\/static\/wall\.[0-9a-f]{10}\.js"/);
    expect(many).toContain('data-wall-none');
  });

  it('shuffle 是排列（元素不丢不重）', () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    expect([...shuffle(items)].sort((a, b) => a - b)).toEqual(items);
  });

  it('墙浏览记 wall_view 事件（props 只有卡片数）', async () => {
    publishedMember(t, wall, { name: '阿柚' });
    await get(t, `/w/${wall.id}`, { cookie: viewer.cookie });
    const events = t.repos.events.listForWall(wall.id).filter((event) => event.type === 'wall_view');
    expect(events).toEqual([expect.objectContaining({ actorId: viewer.userId, pageId: null, props: { cards: 1 } })]);
  });

  it('“我的页面”入口：显示我的发布状态；发布后可以看自己的页面', async () => {
    const mine = t.repos.memberships.findByWallAndUser(wall.id, viewer.userId);
    const myPage = t.repos.pages.findByMembership(mine?.id ?? '');
    if (!mine || !myPage) throw new Error('缺少成员关系');
    publishPage(t, { membership: mine, page: myPage }, '小白');
    const html = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(html).toContain('你的页面已经挂在墙上了');
    expect(html).toContain(`href="/w/${wall.id}/p/${myPage.id}"`);
    expect(html).toContain('wall-card__me');
  });

  it('成员页：PageFrame 展示当前发布版本，名字 / 介绍 / 接话点来自发布快照；联系方式公开时有“想聊这个”', async () => {
    const ayou = publishedMember(t, wall, { name: '阿柚', contact: CONTACT });
    const response = await get(t, `/w/${wall.id}/p/${ayou.page.id}`, { cookie: viewer.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('阿柚的一行介绍');
    expect(html).not.toContain('原始介绍');
    const frames = iframesOf(html);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.sandbox).toBe(PAGE_IFRAME_SANDBOX);
    const ticket = frames[0]?.src?.match(/\/v\/([^/]+)\/$/)?.[1] ?? '';
    expect(verifyTicket(ticket, TEST_SECRET, t.clock.now())).toMatchObject({ ok: true, revisionId: ayou.revisionId });
    // 每个接话点一个“想聊这个”表单；联系方式本身不在成员页里
    const forms = elements(html).filter((element) => element.tag === 'form' && element.attrs.action === `/w/${wall.id}/p/${ayou.page.id}/chat`);
    expect(forms).toHaveLength(2);
    const hookIds = elements(html)
      .filter((element) => element.tag === 'input' && element.attrs.name === 'hookId')
      .map((element) => element.attrs.value);
    expect(hookIds).toEqual(['can-help', 'looking-for']);
    expect(html).not.toContain(CONTACT.value);

    const events = t.repos.events.listForWall(wall.id).filter((event) => event.type === 'page_open');
    expect(events).toEqual([expect.objectContaining({ actorId: viewer.userId, pageId: ayou.page.id, props: {} })]);
  });

  it('连播接口按 listPublished 的 published_at,rowid 固定顺序、首尾循环，票据指向当前发布版本', async () => {
    const first = publishedMember(t, wall, { name: '第一位' });
    const second = publishedMember(t, wall, { name: '第二位' });
    const third = publishedMember(t, wall, { name: '第三位' });
    // 第三条发布时间最早；前两条时间相同，分别验证 published_at 与 rowid 两级排序。
    t.clock.advance(1_000);
    t.db.prepare('UPDATE publications SET published_at = ? WHERE id IN (?, ?)').run(t.clock.now().toISOString(), first.publicationId, second.publicationId);
    const members = [third, first, second];
    const published = wallQueries(t.db).listPublished(wall.id);
    expect(published.map((entry) => entry.pageId)).toEqual(members.map((member) => member.page.id));
    expect(published[0]?.publishedAt).not.toBe(published[1]?.publishedAt);
    expect(published[1]?.publishedAt).toBe(published[2]?.publishedAt);

    for (const [index, entry] of published.entries()) {
      const response = await get(t, `/w/${wall.id}/p/${entry.pageId}/stage`, { cookie: viewer.cookie });
      expect(response.status).toBe(200);
      const model = (await response.json()) as StageModel;
      const previous = published[(index - 1 + published.length) % published.length];
      const next = published[(index + 1) % published.length];
      expect(model).toEqual({
        pageId: entry.pageId,
        displayName: members[index]?.card.displayName,
        tagline: members[index]?.card.tagline,
        src: expect.any(String),
        position: index + 1,
        total: published.length,
        prevId: previous?.pageId,
        nextId: next?.pageId,
      });
      const ticket = model.src.match(/\/v\/([^/]+)\/$/)?.[1] ?? '';
      expect(verifyTicket(ticket, TEST_SECRET, t.clock.now())).toMatchObject({ ok: true, revisionId: entry.revisionId });
    }
    const events = t.repos.events.listForWall(wall.id).filter((event) => event.type === 'page_open');
    expect(events).toEqual(published.map((entry) => expect.objectContaining({ actorId: viewer.userId, pageId: entry.pageId, props: {} })));
  });

  it('单人墙：连播接口没有上一位 / 下一位，成员页也不渲染这两个按钮', async () => {
    const only = publishedMember(t, wall, { name: '唯一成员' });
    const response = await get(t, `/w/${wall.id}/p/${only.page.id}/stage`, { cookie: viewer.cookie });
    expect(response.status).toBe(200);
    expect((await response.json()) as StageModel).toMatchObject({ pageId: only.page.id, position: 1, total: 1, prevId: null, nextId: null });

    const html = await (await get(t, `/w/${wall.id}/p/${only.page.id}`, { cookie: viewer.cookie })).text();
    const nodes = elements(html);
    const frame = nodes.find((element) => element.attrs['data-nm-page-frame-root'] !== undefined);
    expect(frame?.attrs).toMatchObject({ 'data-nm-stage-wall': wall.id, 'data-nm-stage-page': only.page.id });
    expect(frame?.attrs['data-nm-stage-prev']).toBeUndefined();
    expect(frame?.attrs['data-nm-stage-next']).toBeUndefined();
    expect(nodes.filter((element) => element.attrs['data-nm-stage-prev-button'] !== undefined)).toEqual([]);
    expect(nodes.filter((element) => element.attrs['data-nm-stage-next-button'] !== undefined)).toEqual([]);
    expect(html).toContain('data-nm-stage-position="">1 / 1</span>');
  });

  it('多人成员页：PageFrame 显示连播序号与上一位 / 下一位按钮', async () => {
    const first = publishedMember(t, wall, { name: '第一位' });
    const second = publishedMember(t, wall, { name: '第二位' });
    const third = publishedMember(t, wall, { name: '第三位' });
    const html = await (await get(t, `/w/${wall.id}/p/${second.page.id}`, { cookie: viewer.cookie })).text();
    const nodes = elements(html);
    const frame = nodes.find((element) => element.attrs['data-nm-page-frame-root'] !== undefined);
    expect(frame?.attrs).toMatchObject({
      'data-nm-stage-wall': wall.id,
      'data-nm-stage-page': second.page.id,
      'data-nm-stage-prev': first.page.id,
      'data-nm-stage-next': third.page.id,
    });
    expect(html).toContain('data-nm-stage-position="">2 / 3</span>');
    expect(nodes.filter((element) => element.attrs['data-nm-stage-prev-button'] !== undefined)).toHaveLength(1);
    expect(nodes.filter((element) => element.attrs['data-nm-stage-next-button'] !== undefined)).toHaveLength(1);
    expect(html).toContain('上一位');
    expect(html).toContain('下一位');
  });

  it('主人没有公开联系方式：仍可站内聊天，但不能查看联系方式', async () => {
    const quiet = publishedMember(t, wall, { name: '安静的人', contact: null });
    const html = await (await get(t, `/w/${wall.id}/p/${quiet.page.id}`, { cookie: viewer.cookie })).text();
    expect(html).toContain('想聊这个</button>');
    expect(html).toContain('/chat"');
    expect(html).not.toContain('查看公开联系方式');
    const chat = await postForm(t, `/w/${wall.id}/p/${quiet.page.id}/chat`, { _csrf: viewer.csrf, hookId: 'can-help' }, { cookie: viewer.cookie });
    expect(chat.status).toBe(303);
    expect((await postForm(t, `/w/${wall.id}/p/${quiet.page.id}/contact`, { _csrf: viewer.csrf, hookId: 'can-help' }, { cookie: viewer.cookie })).status).toBe(404);
  });

  it('想聊这个：进入站内私聊并预填发布快照中的开场白，不自动发送或泄露联系方式', async () => {
    const ayou = publishedMember(t, wall, { name: '阿柚', contact: CONTACT });
    const response = await postForm(t, `/w/${wall.id}/p/${ayou.page.id}/chat`, { _csrf: viewer.csrf, hookId: 'looking-for' }, { cookie: viewer.cookie });
    expect(response.status).toBe(303);
    const html = await (await get(t, response.headers.get('location')!, { cookie: viewer.cookie })).text();
    expect(html).not.toContain(CONTACT.value);
    expect(html).toContain('嗨阿柚，我是做设计的～');
    expect(html).not.toContain('你好阿柚，我看到你能帮忙做前端');
    expect(t.db.prepare('SELECT * FROM chat_messages').all()).toHaveLength(0);
    const contact = await postForm(t, `/w/${wall.id}/p/${ayou.page.id}/contact`, { _csrf: viewer.csrf, hookId: 'looking-for' }, { cookie: viewer.cookie });
    expect(contact.status).toBe(200);
    const contactHtml = await contact.text();
    expect(contactHtml).toContain(CONTACT.value);
    const copyTargets = elements(contactHtml)
      .filter((element) => element.attrs['data-copy'])
      .map((element) => element.attrs['data-copy']);
    expect(copyTargets).toEqual(['nm-chat-contact', 'nm-chat-opener']);

    const events = t.repos.events.listForWall(wall.id).filter((event) => event.type === 'want_to_chat');
    expect(events).toEqual([expect.objectContaining({ actorId: viewer.userId, pageId: ayou.page.id, props: { hookIndex: 1 } }), expect.objectContaining({ props: { hookIndex: 1 } })]);
    const stored = JSON.stringify(t.db.prepare("SELECT * FROM events WHERE type = 'want_to_chat'").all());
    expect(stored).not.toContain(CONTACT.value);
    expect(stored).not.toContain('设计');
  });

  it('想聊这个：未知的接话点 → 404，不记事件；按位置编号也能找到接话点', async () => {
    const ayou = publishedMember(t, wall, { name: '阿柚', contact: CONTACT });
    for (const hookId of ['', 'nope', '9', '<script>', '-1']) {
      const response = await postForm(t, `/w/${wall.id}/p/${ayou.page.id}/chat`, { _csrf: viewer.csrf, hookId }, { cookie: viewer.cookie });
      expect(response.status, hookId).toBe(404);
    }
    expect(t.repos.events.listForWall(wall.id).filter((event) => event.type === 'want_to_chat')).toEqual([]);
    const byIndex = await postForm(t, `/w/${wall.id}/p/${ayou.page.id}/chat`, { _csrf: viewer.csrf, hookId: '0' }, { cookie: viewer.cookie });
    expect(byIndex.status).toBe(303);
    expect(await (await get(t, byIndex.headers.get('location')!, { cookie: viewer.cookie })).text()).toContain('你好阿柚，我看到你能帮忙做前端');
  });

  it('自己的页面：可以看，但没有“想聊这个”，chat 404，不记 page_open', async () => {
    const ownerMembership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    const ownerPage = t.repos.pages.findByMembership(ownerMembership?.id ?? '');
    if (!ownerMembership || !ownerPage) throw new Error('缺少组织者页面');
    publishPage(t, { membership: ownerMembership, page: ownerPage }, '林舟', { contact: CONTACT });
    const response = await get(t, `/w/${wall.id}/p/${ownerPage.id}`, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('我的页面');
    expect(html).toContain('这是你自己的页面');
    expect(html).not.toContain('/chat"');
    expect(iframesOf(html)).toHaveLength(1);
    const chat = await postForm(t, `/w/${wall.id}/p/${ownerPage.id}/chat`, { _csrf: owner.csrf, hookId: 'can-help' }, { cookie: owner.cookie });
    expect(chat.status).toBe(404);
    expect(t.repos.events.listForWall(wall.id).filter((event) => ['page_open', 'want_to_chat'].includes(event.type))).toEqual([]);
    // 别人看同一页才记 page_open
    await get(t, `/w/${wall.id}/p/${ownerPage.id}`, { cookie: viewer.cookie });
    expect(t.repos.events.listForWall(wall.id).filter((event) => event.type === 'page_open')).toHaveLength(1);
  });

  it('“想聊这个”的 hookId 也可以是位置编号；联系方式快照带 public:false 时视为不公开', () => {
    const card = parsePublishedCard(JSON.stringify({ displayName: '甲', tagline: 't', hooks: [{ text: '一', opener: 'o' }, { id: 'b', text: '二', opener: '' }] }), '后备');
    expect(card.hooks).toEqual([
      { id: 'hook-1', index: 0, text: '一', opener: 'o' },
      { id: 'b', index: 1, text: '二', opener: '' },
    ]);
    expect(parsePublishedCard('not json', '后备')).toEqual({ displayName: '后备', tagline: '', hooks: [] });
    expect(parsePublishedContact(null)).toBeNull();
    expect(parsePublishedContact(JSON.stringify({ channel: 'wechat', value: 'x', public: false }))).toBeNull();
    expect(parsePublishedContact(JSON.stringify({ contactChannel: 'qq', contactValue: '123', contactPublic: true }))).toEqual({
      channel: 'qq',
      channelLabel: 'QQ',
      value: '123',
    });
    expect(parsePublishedContact(JSON.stringify({ channel: 'wechat', value: '  ' }))).toBeNull();
  });
});

describe('组织者后台（W03）：成员列表、移除、关闭墙', () => {
  let t: TestWeb;
  let owner: TestSession;
  let member: TestSession;
  let wall: Wall;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    member = await login(t, 'member@example.com', '小白');
    ({ wall } = seedWall(t, owner.userId, '周末黑客松'));
  });
  afterEach(async () => {
    await t.close();
  });

  it('后台：邀请链接、二维码（SVG data URI）、复制按钮、聚合数字、成员昵称 / 加入时间 / 发布状态', async () => {
    publishedMember(t, wall, { userId: member.userId, name: '小白', contact: CONTACT });
    seedMember(t, wall, (await login(t, 'c@example.com', '未发布的人')).userId);
    const response = await get(t, `/w/${wall.id}/admin`, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    const inviteUrl = `${t.config.webOrigin}/join/${wall.inviteCode}`;
    expect(html).toContain(inviteUrl);
    expect(elements(html).find((element) => element.attrs['data-copy'] === 'nm-invite-link')).toBeTruthy();
    const qr = elements(html).find((element) => element.tag === 'img');
    expect(qr?.attrs.src).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from((qr?.attrs.src ?? '').split(',')[1] ?? '', 'base64').toString('utf8');
    expect(svg).toBe(qrSvg(inviteUrl));
    expect(svg).not.toMatch(/style=/);
    expect(html).toContain('林舟');
    expect(html).toContain('小白');
    expect(html).toContain('未发布的人');
    expect(html).toContain('已发布');
    expect(html).toContain('未发布');
    expect(html).toMatch(/<dt>成员<\/dt><dd>3<\/dd>/);
    expect(html).toMatch(/<dt>已发布<\/dt><dd>1<\/dd>/);
    // 只有普通成员有移除按钮（组织者自己没有）
    const removeForms = elements(html).filter((element) => element.tag === 'form' && element.attrs.action === `/w/${wall.id}/admin/remove`);
    expect(removeForms).toHaveLength(2);
  });

  it('二维码可以被解码回邀请链接的矩阵尺寸（版本合理，四周有静区）', () => {
    const svg = qrSvg(`${t.config.webOrigin}/join/${wall.inviteCode}`);
    const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
    expect((size - 8 - 17) % 4).toBe(0); // 模块数 = 17 + 4 × 版本，再加两侧各 4 个静区
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it('移除成员：成员关系 removed、页面立即下墙、凭证与未用 token 吊销、记 member_removed；不能再加入', async () => {
    const published = publishedMember(t, wall, { userId: member.userId, name: '小白', contact: CONTACT });
    const credential = await connectAgent(t, wall, published.page);
    expect((await agentGet(t, '/api/agent/context', credential)).status).toBe(200);

    const response = await postForm(t, `/w/${wall.id}/admin/remove`, { _csrf: owner.csrf, membershipId: published.membership.id }, { cookie: owner.cookie });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/w/${wall.id}/admin?notice=removed`);
    expect(t.repos.memberships.findById(published.membership.id)).toMatchObject({ status: 'removed', endedAt: t.clock.now().toISOString() });
    const publication = t.db.prepare('SELECT ended_at, end_reason FROM publications WHERE id = ?').get(published.publicationId);
    expect(publication).toEqual({ ended_at: t.clock.now().toISOString(), end_reason: 'removed' });
    expect(t.repos.credentials.findActiveForPage(published.page.id)).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM agent_tokens WHERE page_id = ? AND used_at IS NULL').get(published.page.id)).toEqual({ n: 0 });
    expect((await agentGet(t, '/api/agent/context', credential)).status).toBe(401);
    expect(t.repos.events.listForWall(wall.id).filter((event) => event.type === 'member_removed')).toEqual([
      expect.objectContaining({ actorId: owner.userId, pageId: published.page.id, props: {} }),
    ]);

    const admin = await (await get(t, `/w/${wall.id}/admin?notice=removed`, { cookie: owner.cookie })).text();
    expect(admin).toContain('已移出');
    expect(admin).not.toContain('小白');
    expect(cardOrder(await (await get(t, `/w/${wall.id}`, { cookie: owner.cookie })).text())).toEqual([]);
    expect((await postForm(t, `/join/${wall.inviteCode}`, { _csrf: member.csrf }, { cookie: member.cookie })).status).toBe(403);
  });

  it('组织者不能移除自己；不属于这面墙、已移除、格式不对的成员关系 → 404，数据库不变', async () => {
    const own = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    const { wall: otherWall } = seedWall(t, member.userId, '别的墙');
    const otherOrganizer = t.repos.memberships.findByWallAndUser(otherWall.id, member.userId);
    const removed = seedMember(t, wall, (await login(t, 'r@example.com', '已移除')).userId);
    t.repos.memberships.markRemoved(removed.membership.id, t.clock.now().toISOString());
    for (const membershipId of [own?.id ?? '', otherOrganizer?.id ?? '', removed.membership.id, 'mem_x', '']) {
      const before = JSON.stringify(t.db.prepare('SELECT * FROM memberships ORDER BY rowid').all());
      const response = await postForm(t, `/w/${wall.id}/admin/remove`, { _csrf: owner.csrf, membershipId }, { cookie: owner.cookie });
      expect(response.status, membershipId).toBe(404);
      expect(JSON.stringify(t.db.prepare('SELECT * FROM memberships ORDER BY rowid').all())).toBe(before);
    }
  });

  it('关闭墙需要勾选确认；关闭后：墙 closed、全部发布以 closed 结束、全部凭证吊销、记 wall_closed', async () => {
    const a = publishedMember(t, wall, { userId: member.userId, name: '小白', contact: CONTACT });
    const b = publishedMember(t, wall, { name: '阿柚' });
    const ownerMembership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    const ownerPage = t.repos.pages.findByMembership(ownerMembership?.id ?? '');
    if (!ownerPage) throw new Error('缺少组织者页面');
    const credentials = [await connectAgent(t, wall, a.page), await connectAgent(t, wall, b.page), await connectAgent(t, wall, ownerPage)];

    const unconfirmed = await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.text()).toContain('请先勾选确认');
    expect(t.repos.walls.findById(wall.id)?.status).toBe('open');

    const closed = await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: owner.csrf, confirm: '1' }, { cookie: owner.cookie });
    expect(closed.status).toBe(303);
    expect(closed.headers.get('location')).toBe('/?notice=wall-closed');
    expect(t.repos.walls.findById(wall.id)).toMatchObject({ status: 'closed', closedAt: t.clock.now().toISOString() });
    const reasons = t.db.prepare('SELECT end_reason FROM publications WHERE id IN (?, ?)').all(a.publicationId, b.publicationId);
    expect(reasons).toEqual([{ end_reason: 'closed' }, { end_reason: 'closed' }]);
    for (const credential of credentials) expect((await agentGet(t, '/api/agent/context', credential)).status).toBe(401);
    expect(t.repos.events.listForWall(wall.id).filter((event) => event.type === 'wall_closed')).toEqual([
      expect.objectContaining({ actorId: owner.userId, props: { members: 3, endedPublications: 2 } }),
    ]);

    // “我的”：显示已关闭，没有进入墙 / 工作区 / 后台的链接
    const home = await (await get(t, '/?notice=wall-closed', { cookie: owner.cookie })).text();
    expect(home).toContain('墙已关闭');
    expect(home).toContain('周末黑客松');
    expect(home).toContain('已关闭');
    expect(home).not.toContain(`href="/w/${wall.id}`);
    // 再次关闭：404（墙已不可见）
    expect((await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: owner.csrf, confirm: '1' }, { cookie: owner.cookie })).status).toBe(404);
  });
});

describe('“我的”', () => {
  let t: TestWeb;

  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('有效的墙：角色、我的页面发布状态、进入墙 / 工作区 / 后台入口；已退出、已移出的墙只显示状态', async () => {
    const me = await login(t, 'me@example.com', '阿柚');
    const other = await login(t, 'other@example.com', '林舟');
    const { wall: mine } = seedWall(t, me.userId, '我组织的墙');
    const { wall: joined } = seedWall(t, other.userId, '我加入的墙');
    const { wall: left } = seedWall(t, other.userId, '我退出的墙');
    const { wall: removed } = seedWall(t, other.userId, '我被移出的墙');
    publishedMember(t, joined, { userId: me.userId, name: '阿柚' });
    t.repos.memberships.markLeft(seedMember(t, left, me.userId).membership.id, t.clock.now().toISOString());
    t.repos.memberships.markRemoved(seedMember(t, removed, me.userId).membership.id, t.clock.now().toISOString());

    const html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(html).toContain('href="/walls/new"');
    expect(html).toContain(`href="/w/${mine.id}"`);
    expect(html).toContain(`href="/w/${mine.id}/me"`);
    expect(html).toContain(`href="/w/${mine.id}/admin"`);
    expect(html).toContain(`href="/w/${joined.id}"`);
    expect(html).not.toContain(`href="/w/${joined.id}/admin"`);
    expect(html).toContain('我的页面：已发布');
    expect(html).toContain('我的页面：未发布');
    expect(html).toContain('已结束的墙');
    expect(html).toContain('我退出的墙');
    expect(html).toContain('已退出');
    expect(html).toContain('我被移出的墙');
    expect(html).toContain('已移出');
    expect(html).not.toContain(`/w/${left.id}`);
    expect(html).not.toContain(`/w/${removed.id}`);
  });
});
