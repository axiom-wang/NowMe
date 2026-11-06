/**
 * 发布确认、撤下、恢复旧版本、公开链接（W10、W11、W12、W15、W19，contracts 3、4.2）。
 * 安全相关（S1、S4、S5、S6）见 test/security/publish.security.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTokenFormat, verifyTicket, type Card, type RevisionSummary } from '@nowme/contracts';
import {
  brokenFiles,
  connectAgent,
  createTestWeb,
  dumpDb,
  get,
  iframesOf,
  login,
  seedMember,
  seedWall,
  TEST_SECRET,
  type TestSession,
  type TestWeb,
} from './helpers.js';
import {
  enablePublicLink,
  escapeHtml,
  exampleCard,
  filesWithCard,
  post,
  publish,
  submitRevision,
  workspaceHtml,
} from './publish-helpers.js';
import { createWall } from '../src/services/walls.js';
import { DELETED_CARD_JSON, parsePublishedCard, parsePublishedContact } from '../src/db/publications.js';
import type { Page } from '../src/db/pages.js';
import type { Wall } from '../src/db/walls.js';

function ticketRevision(src: string | undefined, t: TestWeb): string | null {
  const ticket = src?.match(/\/v\/([^/]+)\/$/)?.[1] ?? '';
  const result = verifyTicket(ticket, TEST_SECRET, t.clock.now());
  return result.ok ? result.revisionId : null;
}

describe('发布确认（W11、W12）', () => {
  let t: TestWeb;
  let owner: TestSession;
  let wall: Wall;
  let page: Page;
  let credential: string;
  let card: Card;
  let first: RevisionSummary;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    ({ wall, page } = seedWall(t, owner.userId, '周末黑客松'));
    credential = await connectAgent(t, wall, page);
    card = exampleCard();
    first = await submitRevision(t, credential);
    expect(first.status).toBe('accepted');
  });
  afterEach(async () => {
    await t.close();
  });

  it('工作区：未发布时显示发布确认表单，预填这一版 card.json；黑客松场景默认勾选“公开联系方式”；确认勾选默认不勾', async () => {
    const html = await workspaceHtml(t, owner, wall.id);
    expect(html).toContain('墙上的页面');
    expect(html).toContain('未发布');
    expect(html).toContain('发布第 1 版到墙上');
    expect(html).toContain(`name="revisionId" value="${first.id}"`);
    expect(html).toContain(`value="${escapeHtml(card.displayName)}"`);
    expect(html).toContain(`value="${escapeHtml(card.tagline)}"`);
    for (const [index, hook] of card.hooks.entries()) {
      expect(html).toContain(`name="hooks[${index}][id]" value="${hook.id}"`);
      expect(html).toContain(escapeHtml(hook.text));
      expect(html).toContain(escapeHtml(hook.opener));
    }
    expect(html).toContain('预填的是 Agent 写在这一版 card.json 里的草稿');
    expect(html).toMatch(/<input type="checkbox" name="contactPublic" value="1" checked=""/);
    expect(html).toMatch(/<input type="checkbox" name="confirm" value="1" required=""\/>/);
    expect(html).toContain('发布后，以上内容对这面墙的成员可见');
    expect(html).toContain('按这面墙的场景习惯预选');
  });

  it('兴趣社群场景默认不公开联系方式（场景指南 defaults.contactPublic）', async () => {
    const other = await login(t, 'interest@example.com', '阿柚');
    const { wall: interest, page: interestPage } = createWall(t.web.deps, {
      organizerId: other.userId,
      name: '胶片社',
      description: '',
      sceneType: 'interest',
      organizerNote: null,
    });
    const cred = await connectAgent(t, interest, interestPage);
    await submitRevision(t, cred);
    const html = await workspaceHtml(t, other, interest.id);
    expect(html).toMatch(/<input type="checkbox" name="contactPublic" value="1"\/>/);
  });

  it('发布只存主人确认后的缩略卡：改写的介绍、改写的开场白、删掉的接话点不会出现在墙上', async () => {
    const removed = card.hooks[2] as Card['hooks'][number];
    const response = await publish(t, owner, wall.id, first.id, card, {
      displayName: '  阿舟  ',
      tagline: '后端，想找设计一起做通知变待办',
      'hooks[0][opener]': '你好，我是做设计的，\n想聊聊你们的点子',
      'hooks[2][remove]': '1',
      contactChannel: 'wechat',
      contactValue: 'azhou_2026',
      contactPublic: '1',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/w/${wall.id}/me?rev=${first.id}&notice=published#wall-status`);

    const active = t.repos.publications.findActiveForPage(page.id);
    expect(active?.revisionId).toBe(first.id);
    const stored = JSON.parse(active?.cardJson ?? '') as Card;
    expect(stored).toEqual({
      schemaVersion: 1,
      displayName: '阿舟',
      tagline: '后端，想找设计一起做通知变待办',
      hooks: [
        { ...card.hooks[0], opener: '你好，我是做设计的， 想聊聊你们的点子' },
        card.hooks[1],
      ],
    });
    expect(active?.cardJson).not.toContain(removed.text);
    expect(active?.cardJson).not.toContain(removed.opener);
    expect(active?.cardJson).not.toContain(card.tagline);
    expect(parsePublishedContact(active?.contactJson ?? null)).toEqual({ channel: 'wechat', value: 'azhou_2026' });

    const pageRow = t.repos.pages.findById(page.id);
    expect(pageRow).toMatchObject({ contactChannel: 'wechat', contactValue: 'azhou_2026', contactPublic: true });
    expect(t.repos.publications.displayState(page.id)).toBe('published');

    const events = t.repos.events.listForPage(page.id).filter((event) => event.type === 'publish');
    expect(events).toHaveLength(1);
    expect(events[0]?.props).toEqual({ revisionNumber: 1, hookCount: 2, contactPublic: true, replaced: false, restored: false });
    expect(JSON.stringify(events[0])).not.toContain('azhou');

    const html = await workspaceHtml(t, owner, wall.id, `?rev=${first.id}&notice=published`);
    expect(html).toContain('已发布：墙上的成员现在看到的是这一版');
    expect(html).toContain('墙上展示的是第 1 版');
    expect(html).toContain('墙上展示中');
    expect(html).toContain('修改缩略卡或联系方式');
    expect(html).toContain('公开（微信：azhou_2026）');
    // 再次预填的是上次确认的内容（删掉的接话点不会回来）
    expect(html).toContain('预填的是你上次发布这一版时确认的内容');
    expect(html).not.toContain(escapeHtml(removed.text));
  });

  it('联系方式不公开：发布快照 contact_json 为 null，页面保存主人的选择；下次预填沿用（优先于场景默认）', async () => {
    const response = await publish(t, owner, wall.id, first.id, card, { contactPublic: undefined, contactValue: 'secret_wx' });
    expect(response.status).toBe(303);
    const active = t.repos.publications.findActiveForPage(page.id);
    expect(active?.contactJson).toBeNull();
    expect(JSON.stringify(dumpDb(t.db).publications)).not.toContain('secret_wx');
    expect(t.repos.pages.findById(page.id)).toMatchObject({ contactChannel: 'wechat', contactValue: 'secret_wx', contactPublic: false });

    const second = await submitRevision(t, credential);
    const html = await workspaceHtml(t, owner, wall.id, `?rev=${second.id}`);
    expect(html).toContain('预选的是你上次的选择');
    expect(html).toMatch(/<input type="checkbox" name="contactPublic" value="1"\/>/);
    expect(html).toContain('value="secret_wx"');
    expect(html).toContain('不公开：墙上不显示“想聊这个”');
  });

  it('不公开时联系方式可以留空；公开时必须填写', async () => {
    const empty = await publish(t, owner, wall.id, first.id, card, { contactPublic: undefined, contactValue: '' });
    expect(empty.status).toBe(303);
    expect(t.repos.pages.findById(page.id)).toMatchObject({ contactChannel: 'wechat', contactValue: null, contactPublic: false });

    const before = dumpDb(t.db);
    const missing = await publish(t, owner, wall.id, first.id, card, { contactPublic: '1', contactValue: '   ' });
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain('要公开联系方式，先填写你的账号或号码');
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('W19 校验：每个问题给出具体原因，表单回显主人的输入，数据库无变化', async () => {
    const cases: { overrides: Record<string, string | undefined>; message: string }[] = [
      { overrides: { 'hooks[1][remove]': '1', 'hooks[2][remove]': '1' }, message: '至少保留 2 个接话点（现在 1 个）' },
      { overrides: { 'hooks[0][text]': '好' }, message: '接话点至少 2 个字，现在 1 个' },
      { overrides: { 'hooks[0][text]': '这'.repeat(33) }, message: '接话点最多 32 个字，现在 33 个' },
      { overrides: { 'hooks[1][opener]': '嗨'.repeat(81) }, message: '开场白最多 80 个字，现在 81 个' },
      { overrides: { 'hooks[1][opener]': '   ' }, message: '开场白不能为空' },
      { overrides: { displayName: '' }, message: '名字不能为空' },
      { overrides: { displayName: '名'.repeat(25) }, message: '名字最多 24 个字，现在 25 个' },
      { overrides: { tagline: '介'.repeat(41) }, message: '一行介绍最多 40 个字，现在 41 个' },
      { overrides: { tagline: '有\t制表符' }, message: '一行介绍不能包含制表符等特殊字符' },
      { overrides: { confirm: undefined }, message: '请勾选“发布后，以上内容对这面墙的成员可见”' },
      { overrides: { contactChannel: 'telegram' }, message: '请选择联系方式的渠道' },
      { overrides: { contactChannel: 'email', contactValue: 'not-an-email' }, message: '邮箱格式不对' },
      { overrides: { contactChannel: 'phone', contactValue: '电话12' }, message: '手机号格式不对' },
      { overrides: { contactChannel: 'qq', contactValue: '12' }, message: 'QQ 号应为 5–12 位数字' },
      { overrides: { contactValue: 'x'.repeat(65) }, message: '联系方式最多 64 个字' },
      { overrides: { 'hooks[0][id]': 'not-in-card' }, message: '接话点和这个版本对不上' },
      { overrides: { 'hooks[1][id]': card.hooks[0]?.id }, message: '接话点和这个版本对不上' },
    ];
    for (const { overrides, message } of cases) {
      const before = dumpDb(t.db);
      const response = await publish(t, owner, wall.id, first.id, card, overrides);
      expect(response.status, message).toBe(422);
      const html = await response.text();
      expect(html, message).toContain(escapeHtml(message));
      expect(html, message).toContain('发布没有完成');
      expect(html, message).toContain('墙上的页面没有变化');
      expect(dumpDb(t.db), message).toEqual(before);
    }
    // 回显输入
    const echoed = await publish(t, owner, wall.id, first.id, card, { tagline: '我刚改的介绍', 'hooks[0][text]': '好' });
    const html = await echoed.text();
    expect(html).toContain('value="我刚改的介绍"');
    expect(html).toContain('aria-invalid="true"');
  });

  it('长度按码点计算：24 个 emoji 的名字可以发布', async () => {
    const response = await publish(t, owner, wall.id, first.id, card, { displayName: '🦊'.repeat(24) });
    expect(response.status).toBe(303);
    expect(parsePublishedCard(t.repos.publications.findActiveForPage(page.id)?.cardJson ?? '')?.displayName).toBe('🦊'.repeat(24));
  });

  it('只有 2 个接话点的版本不能再删；card.json 里多出的字段不会被带进发布（只按 id 取接话点）', async () => {
    const twoHooks = { ...card, hooks: card.hooks.slice(0, 2) };
    const revision = await submitRevision(t, credential, filesWithCard(twoHooks));
    expect(revision.status).toBe('accepted');
    const before = dumpDb(t.db);
    const response = await publish(t, owner, wall.id, revision.id, twoHooks as Card, { 'hooks[1][remove]': '1' });
    expect(response.status).toBe(422);
    expect(dumpDb(t.db)).toEqual(before);
    // 表单里塞第 4 个接话点：只读前 3 行，伪造的接话点进不来
    const ok = await publish(t, owner, wall.id, revision.id, twoHooks as Card, {
      'hooks[3][id]': 'evil',
      'hooks[3][text]': '伪造的接话点',
      'hooks[3][opener]': '伪造',
    });
    expect(ok.status).toBe(303);
    expect(t.repos.publications.findActiveForPage(page.id)?.cardJson).not.toContain('伪造');
  });

  it('W10：不能发布校验不通过的版本（422，提示原因，数据库无变化）', async () => {
    const rejected = await submitRevision(t, credential, brokenFiles());
    expect(rejected.status).toBe('rejected');
    const before = dumpDb(t.db);
    const response = await publish(t, owner, wall.id, rejected.id, card);
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('这个版本没有通过校验，不能发布');
    expect(dumpDb(t.db)).toEqual(before);
    // rejected 版本在版本列表里没有发布入口
    const html = await workspaceHtml(t, owner, wall.id);
    expect(html).not.toContain(`?rev=${rejected.id}#publish`);
  });

  it('不能发布别人的版本，也不能发布不存在或格式不对的版本：404，数据库无变化', async () => {
    const member = await login(t, 'member@example.com', '小白');
    const { page: memberPage } = seedMember(t, wall, member.userId);
    const memberCredential = await connectAgent(t, wall, memberPage);
    const memberRevision = await submitRevision(t, memberCredential);
    for (const revisionId of [memberRevision.id, 'rev_aaaaaaaaaaaaaaaaaaaaaaaaaa', '../etc/passwd', '']) {
      const before = dumpDb(t.db);
      const response = await publish(t, owner, wall.id, revisionId, card);
      expect(response.status, revisionId).toBe(404);
      expect(dumpDb(t.db), revisionId).toEqual(before);
    }
  });

  it('superseded 链：更新到新版本时旧发布以 superseded 结束，每页只有一个活跃发布', async () => {
    expect((await publish(t, owner, wall.id, first.id, card)).status).toBe(303);
    t.clock.advance(60_000);
    const second = await submitRevision(t, credential);
    let html = await workspaceHtml(t, owner, wall.id);
    expect(html).toContain('用第 2 版更新墙上的页面');
    expect(html).toContain('更新为第 2 版');
    expect((await publish(t, owner, wall.id, second.id, card)).status).toBe(303);
    t.clock.advance(60_000);
    // 同一版本只改联系方式也会生成新的发布
    expect((await publish(t, owner, wall.id, second.id, card, { contactValue: 'new_wx' })).status).toBe(303);

    const rows = t.db.prepare('SELECT revision_id, ended_at, end_reason FROM publications WHERE page_id = ? ORDER BY rowid').all(page.id) as {
      revision_id: string;
      ended_at: string | null;
      end_reason: string | null;
    }[];
    expect(rows.map((row) => [row.revision_id, row.end_reason])).toEqual([
      [first.id, 'superseded'],
      [second.id, 'superseded'],
      [second.id, null],
    ]);
    expect(rows.filter((row) => row.ended_at === null)).toHaveLength(1);
    const events = t.repos.events.listForPage(page.id).filter((event) => event.type === 'publish');
    expect(events.map((event) => event.props.replaced)).toEqual([false, true, true]);
    html = await workspaceHtml(t, owner, wall.id);
    expect(html).toContain('恢复为此版本');
  });

  it('W12：更新失败不影响已发布的版本', async () => {
    await publish(t, owner, wall.id, first.id, card);
    const active = t.repos.publications.findActiveForPage(page.id);
    const second = await submitRevision(t, credential);
    const failed = await publish(t, owner, wall.id, second.id, card, { confirm: undefined });
    expect(failed.status).toBe(422);
    expect(t.repos.publications.findActiveForPage(page.id)).toEqual(active);
    const rejected = await submitRevision(t, credential, brokenFiles());
    expect((await publish(t, owner, wall.id, rejected.id, card)).status).toBe(422);
    expect(t.repos.publications.findActiveForPage(page.id)).toEqual(active);
  });

  it('撤下：活跃发布以 withdrawn 结束，事件 withdraw；再撤一次提示“不需要撤下”且无变化；之后可以重新发布', async () => {
    await publish(t, owner, wall.id, first.id, card);
    const response = await post(t, owner, `/w/${wall.id}/me/withdraw`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/w/${wall.id}/me?notice=withdrawn`);
    expect(t.repos.publications.findActiveForPage(page.id)).toBeNull();
    expect(t.repos.publications.displayState(page.id)).toBe('withdrawn');
    const ended = t.db.prepare('SELECT end_reason FROM publications WHERE page_id = ?').get(page.id) as { end_reason: string };
    expect(ended.end_reason).toBe('withdrawn');
    expect(t.repos.events.listForPage(page.id).map((event) => event.type)).toContain('withdraw');

    const html = await workspaceHtml(t, owner, wall.id, '?notice=withdrawn');
    expect(html).toContain('已从墙上撤下');
    expect(html).toContain('已撤下');
    expect(html).toContain('重新发布：第 1 版');

    const before = dumpDb(t.db);
    const again = await post(t, owner, `/w/${wall.id}/me/withdraw`);
    expect(again.headers.get('location')).toBe(`/w/${wall.id}/me?notice=not-published`);
    expect(dumpDb(t.db)).toEqual(before);

    expect((await publish(t, owner, wall.id, first.id, card)).status).toBe(303);
    expect(t.repos.publications.displayState(page.id)).toBe('published');
  });

  it('W10 恢复旧版本：走同一个发布确认；预填上次确认的内容；不改变公开链接；旧发布 superseded', async () => {
    await publish(t, owner, wall.id, first.id, card, { 'hooks[2][remove]': '1', tagline: '第一版的介绍' });
    const second = await submitRevision(t, credential);
    await publish(t, owner, wall.id, second.id, card, { tagline: '第二版的介绍' });
    const token = await enablePublicLink(t, owner, wall.id, page.id);

    const list = await workspaceHtml(t, owner, wall.id);
    expect(list).toContain(`href="/w/${wall.id}/me?rev=${first.id}#publish"`);
    expect(list).toContain('恢复为此版本');

    const html = await workspaceHtml(t, owner, wall.id, `?rev=${first.id}`);
    expect(ticketRevision(iframesOf(html)[0]?.src, t)).toBe(first.id);
    expect(html).toContain('恢复为第 1 版');
    expect(html).toContain('墙上现在是第 2 版');
    expect(html).toContain('value="第一版的介绍"');
    // 预填的是第 1 版上次确认的内容：删掉的第 3 个接话点不会回到表单里（它只出现在“墙上现在的第 2 版”的缩略卡里）
    const formHtml = html.slice(html.indexOf('id="publish"'));
    expect(formHtml).not.toContain('name="hooks[2][id]"');
    expect(formHtml).not.toContain(escapeHtml(card.hooks[2]?.text ?? ''));

    const restored = await publish(t, owner, wall.id, first.id, card, {
      'hooks[2][id]': undefined,
      'hooks[2][text]': undefined,
      'hooks[2][opener]': undefined,
      tagline: '第一版的介绍',
      contactPublic: undefined,
    });
    expect(restored.status).toBe(303);
    const active = t.repos.publications.findActiveForPage(page.id);
    expect(active?.revisionId).toBe(first.id);
    expect(active?.contactJson).toBeNull();
    expect(t.repos.pages.findById(page.id)?.publicToken).toBe(token);
    const events = t.repos.events.listForPage(page.id).filter((event) => event.type === 'publish');
    expect(events.at(-1)?.props).toMatchObject({ revisionNumber: 1, restored: true, replaced: true });
    expect((await get(t, `/s/${token}`)).status).toBe(200);
  });
});

describe('公开链接开关（W15）', () => {
  let t: TestWeb;
  let owner: TestSession;
  let wall: Wall;
  let page: Page;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    ({ wall, page } = seedWall(t, owner.userId, '周末黑客松'));
    const credential = await connectAgent(t, wall, page);
    const revision = await submitRevision(t, credential);
    await publish(t, owner, wall.id, revision.id, exampleCard());
  });
  afterEach(async () => {
    await t.close();
  });

  it('开启：生成 pub_ 令牌，工作区显示 /s/<令牌> 与复制按钮；事件 public_link_on', async () => {
    const response = await post(t, owner, `/w/${wall.id}/me/public-link`, { enabled: '1' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/w/${wall.id}/me?notice=public-link-on#public-link`);
    const token = t.repos.pages.findById(page.id)?.publicToken ?? '';
    expect(isTokenFormat(token, 'publicLink')).toBe(true);
    expect(token).not.toMatch(/^pbl_/);
    const html = await workspaceHtml(t, owner, wall.id, '?notice=public-link-on');
    expect(html).toContain(`${t.config.webOrigin}/s/${token}`);
    expect(html).toContain('data-copy="nm-public-link"');
    expect(html).toContain('公开链接已开启');
    expect(t.repos.events.listForPage(page.id).filter((event) => event.type === 'public_link_on')).toHaveLength(1);
  });

  it('每次开启都轮换令牌；关闭后置空；事件 public_link_off 只在真正关闭时记录', async () => {
    const firstToken = await enablePublicLink(t, owner, wall.id, page.id);
    const secondToken = await enablePublicLink(t, owner, wall.id, page.id);
    expect(secondToken).not.toBe(firstToken);
    const off = await post(t, owner, `/w/${wall.id}/me/public-link`, { enabled: '0' });
    expect(off.headers.get('location')).toBe(`/w/${wall.id}/me?notice=public-link-off#public-link`);
    expect(t.repos.pages.findById(page.id)?.publicToken).toBeNull();
    await post(t, owner, `/w/${wall.id}/me/public-link`, { enabled: '0' });
    const types = t.repos.events.listForPage(page.id).map((event) => event.type);
    expect(types.filter((type) => type === 'public_link_on')).toHaveLength(2);
    expect(types.filter((type) => type === 'public_link_off')).toHaveLength(1);
    const html = await workspaceHtml(t, owner, wall.id);
    expect(html).toContain('开启公开链接');
    expect(html).not.toContain('/s/pub_');
  });

  it('开关参数不对：400，说明原因，数据库无变化', async () => {
    for (const enabled of ['', 'true', '2']) {
      const before = dumpDb(t.db);
      const response = await post(t, owner, `/w/${wall.id}/me/public-link`, { enabled });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('公开链接的开关参数不对');
      expect(dumpDb(t.db)).toEqual(before);
    }
  });

  it('撤下后链接仍保持开启但显示“找不到”，工作区提醒；重新发布后链接恢复', async () => {
    const token = await enablePublicLink(t, owner, wall.id, page.id);
    await post(t, owner, `/w/${wall.id}/me/withdraw`);
    expect((await get(t, `/s/${token}`)).status).toBe(404);
    const html = await workspaceHtml(t, owner, wall.id);
    expect(html).toContain('打开这个链接会显示“找不到”');
    const revision = t.repos.revisions.findLatestAccepted(page.id);
    await publish(t, owner, wall.id, revision?.id ?? '', exampleCard());
    expect((await get(t, `/s/${token}`)).status).toBe(200);
  });

  it('删除后的发布墓碑不算发布历史', () => {
    expect(DELETED_CARD_JSON).not.toBe('{}');
    expect(parsePublishedCard(DELETED_CARD_JSON)).toBeNull();
  });
});
