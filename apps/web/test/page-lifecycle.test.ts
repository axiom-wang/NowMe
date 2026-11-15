/**
 * 删除页面（墓碑语义）、退出墙、公开链接页（W15、W16，contracts 3、4.2，build-plan 决策记录）。
 * 安全相关（S1、S4、S5、S6）见 test/security/publish.security.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Card, type RevisionSummary } from '@nowme/contracts';
import {
  brokenFiles,
  connectAgent,
  createTestWeb,
  dumpDb,
  get,
  iframesOf,
  login,
  postJson,
  seedMember,
  seedWall,
  type TestSession,
  type TestWeb,
} from './helpers.js';
import { enablePublicLink, exampleCard, post, publish, revisionDirExists, submitRevision, workspaceHtml } from './publish-helpers.js';
import { DELETED_CARD_JSON } from '../src/db/publications.js';
import type { Page } from '../src/db/pages.js';
import type { Wall } from '../src/db/walls.js';

interface Setup {
  t: TestWeb;
  organizer: TestSession;
  owner: TestSession;
  wall: Wall;
  page: Page;
  credential: string;
  card: Card;
  revisions: RevisionSummary[];
}

/** 组织者建墙；成员（主人）连接 Agent，提交两个通过的版本和一个不通过的版本，发布第 2 版并开启公开链接。 */
async function setup(): Promise<Setup & { token: string }> {
  const t = createTestWeb();
  const organizer = await login(t, 'organizer@example.com', '组织者');
  const owner = await login(t, 'owner@example.com', '林舟');
  const { wall } = seedWall(t, organizer.userId, '周末黑客松');
  const { page } = seedMember(t, wall, owner.userId);
  const credential = await connectAgent(t, wall, page);
  const card = exampleCard();
  const first = await submitRevision(t, credential);
  const second = await submitRevision(t, credential);
  const rejected = await submitRevision(t, credential, brokenFiles());
  expect([first.status, second.status, rejected.status]).toEqual(['accepted', 'accepted', 'rejected']);
  await publish(t, owner, wall.id, first.id, card);
  expect((await publish(t, owner, wall.id, second.id, card)).status).toBe(303);
  const token = await enablePublicLink(t, owner, wall.id, page.id);
  return { t, organizer, owner, wall, page, credential, card, revisions: [first, second, rejected], token };
}

describe('删除页面（W16，墓碑语义）', () => {
  let s: Setup & { token: string };

  beforeEach(async () => {
    s = await setup();
  });
  afterEach(async () => {
    await s.t.close();
  });

  it('GET 确认页说明影响范围：版本数、墙上的版本、公开链接、AI 助手、联系方式；不改变任何状态', async () => {
    const before = dumpDb(s.t.db);
    const response = await get(s.t, `/w/${s.wall.id}/me/delete`, { cookie: s.owner.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('删除这一页做过的 3 版（其中 2 版有页面');
    expect(html).toContain('墙上正在展示的第 2 版立即撤下');
    expect(html).toContain('关闭公开链接');
    expect(html).toContain('断开你电脑上的 AI 助手');
    expect(html).toContain('清除你保存的联系方式');
    expect(html).toContain('你仍是「周末黑客松」的成员');
    expect(html).toContain('name="confirm"');
    expect(dumpDb(s.t.db)).toEqual(before);
  });

  it('没有勾选确认：400，说明原因，什么都没删', async () => {
    const before = dumpDb(s.t.db);
    const response = await post(s.t, s.owner, `/w/${s.wall.id}/me/delete`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('还没有勾选“我明白删除后无法恢复”');
    expect(dumpDb(s.t.db)).toEqual(before);
    for (const revision of s.revisions.slice(0, 2)) expect(revisionDirExists(s.t, revision.id)).toBe(true);
  });

  it('确认删除：文件全部删除、版本内容清空、活跃发布 deleted、发布记录清空、公开链接与联系方式清空、凭证与 token 吊销', async () => {
    const { t, page, wall, owner, token } = s;
    // 留一个未使用的指令，删除后也应作废
    await post(t, owner, `/w/${wall.id}/me/instruction`);
    expect(t.repos.agentTokens.findPendingForPage(page.id, t.clock.now().toISOString())).not.toBeNull();

    const response = await post(t, owner, `/w/${wall.id}/me/delete`, { confirm: '1' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/w/${wall.id}/me?notice=deleted`);

    for (const revision of s.revisions) expect(revisionDirExists(t, revision.id), revision.id).toBe(false);

    const rows = t.db.prepare('SELECT * FROM revisions WHERE page_id = ? ORDER BY number').all(page.id) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.card_json).toBeNull();
      expect(row.manifest_json).toBeNull();
      expect(row.rendered_text).toBeNull();
      expect(row.render_json).toBeNull();
      const report = JSON.parse(String(row.report_json)) as { errors: unknown[]; warnings: unknown[] };
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([]);
    }
    expect(rows.map((row) => row.status)).toEqual(['accepted', 'accepted', 'rejected']);

    const publications = t.db.prepare('SELECT * FROM publications WHERE page_id = ? ORDER BY rowid').all(page.id) as Record<string, unknown>[];
    expect(publications).toHaveLength(2);
    expect(publications.map((row) => row.end_reason)).toEqual(['superseded', 'deleted']);
    for (const row of publications) {
      expect(row.card_json).toBe(DELETED_CARD_JSON);
      expect(row.contact_json).toBeNull();
      expect(row.ended_at).not.toBeNull();
    }
    // 整个数据库里不再有主人的联系方式和缩略卡文字
    const everything = JSON.stringify(dumpDb(t.db));
    expect(everything).not.toContain('linzhou_dev');
    expect(everything).not.toContain(s.card.tagline);
    expect(everything).not.toContain(s.card.hooks[0]?.opener ?? '');

    const after = t.repos.pages.findById(page.id);
    expect(after).toMatchObject({ contactChannel: null, contactValue: null, contactPublic: false, publicToken: null });
    expect(t.repos.publications.displayState(page.id)).toBe('unpublished');
    expect(t.repos.credentials.findActiveForPage(page.id)).toBeNull();
    expect(t.repos.agentTokens.findPendingForPage(page.id, t.clock.now().toISOString())).toBeNull();
    expect((await postJson(t, '/api/agent/revisions', { files: {} }, s.credential)).status).toBe(401);
    expect((await get(t, `/s/${token}`)).status).toBe(404);

    // 成员关系与页面行保留
    expect(t.repos.memberships.findByWallAndUser(wall.id, owner.userId)?.status).toBe('active');
    expect(t.repos.pages.findById(page.id)).not.toBeNull();

    const events = t.repos.events.listForPage(page.id).map((event) => event.type);
    expect(events.slice(-2)).toEqual(['withdraw', 'public_link_off']);
  });

  it('删除后工作区：显示提示、版本列表只剩“已删除”、没有 iframe；?rev= 指向墓碑也不签发票据；墓碑不能发布', async () => {
    const { t, wall, owner } = s;
    await post(t, owner, `/w/${wall.id}/me/delete`, { confirm: '1' });
    const html = await workspaceHtml(t, owner, wall.id, '?notice=deleted');
    expect(html).toContain('已删除');
    expect(iframesOf(html)).toEqual([]);
    expect(html).not.toContain(s.card.tagline);

    const tombstone = await workspaceHtml(t, owner, wall.id, `?rev=${s.revisions[1]?.id}`);
    expect(iframesOf(tombstone)).toEqual([]);

    const before = dumpDb(t.db);
    const response = await publish(t, owner, wall.id, s.revisions[1]?.id ?? '', s.card);
    expect(response.status).toBe(422);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('删除后可以重新开始：重新生成指令、提交（编号继续递增）、发布', async () => {
    const { t, wall, owner, page } = s;
    await post(t, owner, `/w/${wall.id}/me/delete`, { confirm: '1' });
    const credential = await connectAgent(t, wall, page);
    const fresh = await submitRevision(t, credential);
    expect(fresh.status).toBe('accepted');
    expect(fresh.number).toBe(4);
    expect(revisionDirExists(t, fresh.id)).toBe(true);
    expect((await publish(t, owner, wall.id, fresh.id, s.card)).status).toBe(303);
    expect(t.repos.publications.displayState(page.id)).toBe('published');
    const html = await workspaceHtml(t, owner, wall.id);
    expect(iframesOf(html)).toHaveLength(1);
  });

  it('再删一次（没有任何内容）：照常成功，不重复记录事件', async () => {
    const { t, wall, owner, page } = s;
    await post(t, owner, `/w/${wall.id}/me/delete`, { confirm: '1' });
    const count = t.repos.events.listForPage(page.id).length;
    const response = await post(t, owner, `/w/${wall.id}/me/delete`, { confirm: '1' });
    expect(response.status).toBe(303);
    expect(t.repos.events.listForPage(page.id)).toHaveLength(count);
  });
});

describe('退出墙（W16）', () => {
  let s: Setup & { token: string };

  beforeEach(async () => {
    s = await setup();
  });
  afterEach(async () => {
    await s.t.close();
  });

  it('GET 确认页说明影响；POST 后成员关系 left、发布 withdrawn、公开链接关闭、凭证与 token 吊销、事件 leave；版本保留', async () => {
    const { t, wall, owner, page, token } = s;
    const confirm = await get(t, `/w/${wall.id}/leave`, { cookie: owner.cookie });
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain('你的页面立即从墙上撤下');
    expect(confirmHtml).toContain('公开链接关闭');
    expect(confirmHtml).toContain(`action="/w/${wall.id}/leave"`);

    await post(t, owner, `/w/${wall.id}/me/instruction`);
    const response = await post(t, owner, `/w/${wall.id}/leave`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('已退出「周末黑客松」');

    const membership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId);
    expect(membership?.status).toBe('left');
    expect(membership?.endedAt).not.toBeNull();
    expect(t.repos.publications.findActiveForPage(page.id)).toBeNull();
    const last = t.db.prepare('SELECT end_reason FROM publications WHERE page_id = ? ORDER BY rowid DESC LIMIT 1').get(page.id) as {
      end_reason: string;
    };
    expect(last.end_reason).toBe('withdrawn');
    expect(t.repos.pages.findById(page.id)?.publicToken).toBeNull();
    expect((await get(t, `/s/${token}`)).status).toBe(404);
    expect(t.repos.credentials.findActiveForPage(page.id)).toBeNull();
    expect(t.repos.agentTokens.findPendingForPage(page.id, t.clock.now().toISOString())).toBeNull();
    expect((await postJson(t, '/api/agent/revisions', { files: {} }, s.credential)).status).toBe(401);
    expect(t.repos.revisions.listForPage(page.id)).toHaveLength(3);
    for (const revision of s.revisions.slice(0, 2)) expect(revisionDirExists(t, revision.id)).toBe(true);
    const leave = t.repos.events.listForPage(page.id).filter((event) => event.type === 'leave');
    expect(leave).toHaveLength(1);
    expect(leave[0]?.props).toMatchObject({ withdrew: true, publicLinkClosed: true });

    // 退出后工作区与所有操作都是 404
    expect((await get(t, `/w/${wall.id}/me`, { cookie: owner.cookie })).status).toBe(404);
    const before = dumpDb(t.db);
    expect((await post(t, owner, `/w/${wall.id}/leave`)).status).toBe(404);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('组织者不能退出：确认页提示去关闭墙；POST 400，数据库无变化', async () => {
    const { t, wall, organizer } = s;
    const confirm = await get(t, `/w/${wall.id}/leave`, { cookie: organizer.cookie });
    expect(confirm.status).toBe(200);
    const html = await confirm.text();
    expect(html).toContain('你是这面墙的组织者，不能退出');
    expect(html).not.toContain(`action="/w/${wall.id}/leave"`);
    const before = dumpDb(t.db);
    const response = await post(t, organizer, `/w/${wall.id}/leave`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('组织者不能退出这面墙');
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('没发布过的成员也能退出（事件 leave，withdrew=false）', async () => {
    const { t, wall } = s;
    const other = await login(t, 'other@example.com', '小白');
    const { page } = seedMember(t, wall, other.userId);
    const response = await post(t, other, `/w/${wall.id}/leave`);
    expect(response.status).toBe(200);
    expect(t.repos.memberships.findByWallAndUser(wall.id, other.userId)?.status).toBe('left');
    expect(t.repos.events.listForPage(page.id).find((event) => event.type === 'leave')?.props).toMatchObject({ withdrew: false });
  });
});

describe('公开链接页 GET /s/:publicToken（W15）', () => {
  let s: Setup & { token: string };

  beforeEach(async () => {
    s = await setup();
  });
  afterEach(async () => {
    await s.t.close();
  });

  it('未登录可以打开：显示当前发布版本的页面、名字与一行介绍；noindex 头与 meta', async () => {
    const response = await get(s.t, `/s/${s.token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('class="site-header home-header"');
    expect(html).toContain('href="/static/home.css"');
    expect(html).not.toContain('class="home-nav"');
    expect(html).not.toContain('class="home-account"');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    expect(html).toContain(s.card.displayName);
    expect(html).toContain(s.card.tagline);
    expect(iframesOf(html)).toHaveLength(1);
    // 不显示墙名
    expect(html).not.toContain('周末黑客松');
  });

  it('显示的是主人确认后的介绍，不是版本 card.json 里的原文', async () => {
    await publish(s.t, s.owner, s.wall.id, s.revisions[1]?.id ?? '', s.card, { tagline: '确认后改写的介绍' });
    const html = await (await get(s.t, `/s/${s.token}`)).text();
    expect(html).toContain('确认后改写的介绍');
    expect(html).not.toContain(s.card.tagline);
  });

  it('404 也带 noindex', async () => {
    const response = await get(s.t, '/s/pub_doesnotexist');
    expect(response.status).toBe(404);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });
});
