/**
 * S11 补充（contracts 14.7）：
 * - 注销时针对他的待处理举报：被举报的内容转存为只有平台运营（moderation show）能看到的证据；
 *   网页、组织者、其他成员都看不到；举报处理完或 180 天后删除；已处理的举报不转存；
 * - 同一邮箱注销后重新注册不再得到注册赠送点数，库里只有邮箱的带密钥哈希；
 * - 启动清理幂等删除已注销用户残留的页面文件，不碰别人的文件。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestWeb, dumpDb, get, login, type TestWeb } from '../helpers.js';
import type { HostedTestWeb } from '../hosted-helpers.js';
import { memberPath } from '../icebreaker-helpers.js';
import { post } from '../publish-helpers.js';
import { accountWorld, confirmDeletion, requestDeletionCode, type AccountWorld } from '../account-helpers.js';
import { DELETION_EVIDENCE_TTL_DAYS, sweepDeletedAccounts } from '../../src/services/account-deletion.js';
import { deletedEmailHmac } from '../../src/services/deleted-emails.js';
import { findDeletionEvidence, runModerationCommand } from '../../src/services/moderation-cli.js';
import { userAccount } from '../../src/services/billing.js';

let t: HostedTestWeb | TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const HARASSING = '阿柚私聊发的骚扰原话：你不回我就去你宿舍楼下等';
const TAGLINE_WORD = '在天台种番茄';

async function reportedWorld(): Promise<AccountWorld & { pageReport: string; chatReport: string; dismissedReport: string; withThird: string }> {
  const w = await accountWorld();
  t = w.t;
  const { t: web, wall, owner, peer, third, organizer } = w;
  // 林舟举报阿柚的页面（待处理）
  expect((await post(web, peer.session, `${memberPath(w.wall, owner)}/report`, { reason: 'inappropriate', note: '页面不合适' })).status).toBe(303);
  // 小白举报和阿柚的私信（待处理）
  const withThird = web.repos.chat.ensureDirect(wall.id, owner.session.userId, third.session.userId, web.clock.now().toISOString());
  expect((await post(web, owner.session, `/messages/${withThird}/send`, { text: HARASSING, clientId: randomUUID() })).status).toBe(303);
  expect((await post(web, third.session, `/messages/${withThird}/report`, { reason: 'harassment', note: '一直骚扰' })).status).toBe(303);
  // 组织者也举报了阿柚的页面，但已经被忽略（已处理：不转存）
  expect((await post(web, organizer, `${memberPath(w.wall, owner)}/report`, { reason: 'spam' })).status).toBe(303);
  const id = (reporterId: string) => (web.db.prepare('SELECT id FROM reports WHERE reporter_id = ?').get(reporterId) as { id: string }).id;
  const dismissedReport = id(organizer.userId);
  runModerationCommand(web.web.deps, ['resolve', '--id', dismissedReport, '--as', 'dismissed']);
  return { ...w, pageReport: id(peer.session.userId), chatReport: id(third.session.userId), dismissedReport, withThird };
}

async function deleteOwner(w: AccountWorld): Promise<void> {
  const { code } = await requestDeletionCode(w.t, w.owner.session);
  expect((await confirmDeletion(w.t, w.owner.session, code!)).status).toBe(200);
}

function evidenceCount(web: TestWeb): number {
  return Number((web.db.prepare('SELECT COUNT(*) AS n FROM deletion_evidence').get() as { n: number }).n);
}

describe('S11 举报证据只给平台运营', () => {
  it('待处理举报的页面与私信内容转存；只有 moderation show 能看到，网页与组织者看不到', async () => {
    const w = await reportedWorld();
    const { t: web, wall, organizer, peer, third } = w;
    await deleteOwner(w);

    expect(evidenceCount(web)).toBe(2);
    expect(findDeletionEvidence(web.web.deps, w.dismissedReport)).toBeNull();
    const page = findDeletionEvidence(web.web.deps, w.pageReport)!;
    expect(page.kind).toBe('page');
    expect(page.cardJson).toContain(TAGLINE_WORD);
    expect(page.renderedText).toBeTruthy();
    expect(page.screenshot?.byteLength).toBeGreaterThan(0);
    const chat = findDeletionEvidence(web.web.deps, w.chatReport)!;
    expect(chat.messages.map((message) => message.text)).toEqual([HARASSING]);

    // 运营命令：私信里他的消息按原文显示；页面证据另列；截图可导出
    const shownChat = runModerationCommand(web.web.deps, ['show', '--id', w.chatReport]).join('\n');
    expect(shownChat).toContain(`【注销前原文】${HARASSING}`);
    const dir = join(tmpdir(), `nowme-evidence-${randomUUID()}`);
    mkdirSync(dir);
    try {
      const png = join(dir, 'shot.png');
      const shownPage = runModerationCommand(web.web.deps, ['show', '--id', w.pageReport, '--evidence-png', png]).join('\n');
      expect(shownPage).toContain(TAGLINE_WORD);
      expect(readFileSync(png)).toEqual(Buffer.from(page.screenshot!));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 网页上谁都看不到：组织者后台、墙、举报人自己的私信、我的资料
    for (const [session, path] of [
      [organizer, `/w/${wall.id}/admin`],
      [organizer, `/w/${wall.id}`],
      [peer.session, `/w/${wall.id}`],
      [third.session, `/messages/${w.withThird}`],
      [third.session, '/account/data'],
      [peer.session, '/account/data'],
    ] as const) {
      const response = await get(web, path, { cookie: session.cookie });
      const html = await response.text();
      expect(html).not.toContain(HARASSING);
      expect(html).not.toContain(TAGLINE_WORD);
    }
    // 除了证据表，数据库里没有这些内容
    const dump = dumpDb(web.db);
    delete dump.deletion_evidence;
    const text = JSON.stringify(dump);
    expect(text).not.toContain(HARASSING);
    expect(text).not.toContain(TAGLINE_WORD);
  });

  it('举报处理完立即删除证据；没处理的 180 天后删除', async () => {
    const w = await reportedWorld();
    const { t: web } = w;
    await deleteOwner(w);
    expect(evidenceCount(web)).toBe(2);
    runModerationCommand(web.web.deps, ['resolve', '--id', w.chatReport, '--as', 'actioned']);
    expect(findDeletionEvidence(web.web.deps, w.chatReport)).toBeNull();
    expect(evidenceCount(web)).toBe(1);
    expect(runModerationCommand(web.web.deps, ['show', '--id', w.chatReport]).join('\n')).not.toContain(HARASSING);

    web.clock.advance((DELETION_EVIDENCE_TTL_DAYS + 1) * 24 * 3600 * 1000);
    expect(findDeletionEvidence(web.web.deps, w.pageReport)).toBeNull();
    expect(runModerationCommand(web.web.deps, ['show', '--id', w.pageReport]).join('\n')).not.toContain(TAGLINE_WORD);
    expect(evidenceCount(web)).toBe(0);
  });

  it('没有待处理举报时不留任何证据', async () => {
    const w = await accountWorld();
    t = w.t;
    await deleteOwner(w);
    expect(evidenceCount(w.t)).toBe(0);
  });
});

describe('S11 同一邮箱重新注册不再赠送点数', () => {
  it('库里只有邮箱的带密钥哈希；别的邮箱照常赠送', async () => {
    const web = createTestWeb({ env: { NOWME_SIGNUP_CREDITS: '50' } });
    t = web;
    const first = await login(web, 'again@example.com', '第一次');
    expect(web.repos.credits.balanceOf(userAccount(first.userId))).toBe(50);
    await deleteOwner({ t: web, owner: { session: first } } as unknown as AccountWorld);

    const rows = web.db.prepare('SELECT * FROM deleted_emails').all() as { email_hmac: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email_hmac).toBe(deletedEmailHmac(web.config.ticketSecret, ' Again@Example.com'));
    expect(rows[0]!.email_hmac).not.toBe(deletedEmailHmac(`${web.config.ticketSecret}-other`, 'again@example.com'));
    expect(JSON.stringify(dumpDb(web.db)).toLowerCase()).not.toContain('again@example.com');

    const second = await login(web, 'again@example.com', '第二次');
    expect(second.userId).not.toBe(first.userId);
    expect(web.repos.credits.balanceOf(userAccount(second.userId))).toBe(0);
    expect(web.repos.credits.listEntries(userAccount(second.userId), 10)).toEqual([]);
    const other = await login(web, 'someone-else@example.com');
    expect(web.repos.credits.balanceOf(userAccount(other.userId))).toBe(50);
  });
});

describe('S11 启动清理残留文件', () => {
  it('删除已注销用户残留的版本与素材目录，可重复执行，不碰别人的文件', async () => {
    const w = await accountWorld();
    t = w.t;
    const { t: web, owner, peer } = w;
    const ownRevisions = (web.db.prepare("SELECT id FROM revisions WHERE page_id = ? AND status = 'accepted'").all(owner.member.page.id) as { id: string }[]).map((row) => row.id);
    const peerRevision = web.repos.publications.findActiveForPage(peer.member.page.id)!.revisionId;
    await deleteOwner(w);
    // 模拟“提交后进程崩溃”：残留的目录
    for (const id of ownRevisions) {
      mkdirSync(join(web.dataDir, 'revisions', id, 'served'), { recursive: true });
      writeFileSync(join(web.dataDir, 'revisions', id, 'served', 'index.html'), '<p>残留</p>');
    }
    mkdirSync(join(web.dataDir, 'hosted', owner.member.page.id, 'assets'), { recursive: true });
    writeFileSync(join(web.dataDir, 'hosted', owner.member.page.id, 'assets', 'photo-1.png'), 'x');

    expect(await sweepDeletedAccounts(web.web.deps)).toMatchObject({ failed: 0 });
    for (const id of ownRevisions) expect(existsSync(join(web.dataDir, 'revisions', id))).toBe(false);
    expect(existsSync(join(web.dataDir, 'hosted', owner.member.page.id))).toBe(false);
    expect(existsSync(join(web.dataDir, 'revisions', peerRevision))).toBe(true);
    expect(await sweepDeletedAccounts(web.web.deps)).toMatchObject({ failed: 0 });
    expect(existsSync(join(web.dataDir, 'revisions', peerRevision))).toBe(true);
  });
});
