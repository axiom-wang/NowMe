/**
 * 注销账号（contracts 14、S11）。
 *
 * 二次确认：注销前必须向账号邮箱新发一个 `account_delete` 用途的验证码（与登录验证码同样 6 位、10 分钟、5 次、
 * 只存哈希，同一邮箱的发码限流也是同一个），输入正确才注销。登录用的验证码不能拿来注销，反之亦然。
 *
 * 前提：他不是任何一面**仍开放**的墙的组织者（没有转让功能：先由他自己关闭墙，不替他关别人在用的墙）。
 *
 * 注销在**一个数据库事务**里完成（之后才删文件），顺序：
 * 1. 校验验证码、检查前提；
 * 2. 每一页按“删除页面”语义清除（版本与发布留墓碑、活跃发布以 `deleted` 下墙、公开链接与联系方式清空、
 *    凭证吊销、未使用的指令作废），并清除这一页的 brief、素材、任务内容、别人针对这一页的“和 TA 聊什么”；
 * 3. 还在排队 / 运行的生成任务直接以失败结束并退点（随后由第 7 步作废）；
 * 4. 结束全部有效成员关系（`left`，每面墙记一条 `leave` 事件，`accountDeleted: true`）；
 * 5. 他发出的聊天消息正文替换为固定文字、已读位置删除；他得到的“和 TA 聊什么”结果删除；
 * 6. 长期画像、模型配置（含加密的 Key）、会话、全部验证码记录删除；他组织过的（已关闭的）墙的封面删除；
 *    拉黑关系（双向）删除；他提交过的举报保留给平台处理，但补充说明清空；针对他的举报与处理记录保留；
 * 7. 个人余额作废：记一笔 `account_deleted` 流水（流水只追加，不删除；之后流水只关联到这个墓碑账号 ID）；
 * 8. 用户行改为墓碑：邮箱改为 `deleted:<用户 ID>`、昵称“已注销用户”、头像与协议同意记录清空、`deleted_at` 置为当前时间。
 * 事务提交后删除版本目录与托管素材目录（失败只记日志：数据库里已是墓碑，不会再签发票据；
 * 残留的由 `sweepDeletedAccounts` 在启动时幂等清理）。
 *
 * 证据转存（contracts 14.7）：第 2 步之前，针对他的每一条待处理举报，把被举报的内容（页面那一版的缩略卡、页面文字、
 * 整页截图；私信里他发的消息）存进 `deletion_evidence`，只给平台运营的 `moderation show` 看；举报处理完（触发器）
 * 或 180 天后删除。同时记下邮箱的 HMAC（`deleted_emails`），同一邮箱重新注册不再赠送点数。
 */
import { constantTimeEqual, generateId, LOGIN_CODE_DIGITS, LOGIN_CODE_MAX_ATTEMPTS, LOGIN_CODE_TTL_SECONDS, generateLoginCode } from '@nowme/contracts';
import { LOGIN_CODE_RATE_MAX, LOGIN_CODE_RATE_WINDOW_SECONDS } from '../constants.js';
import type { AppDeps } from '../context.js';
import { accountDataQueries } from '../db/account-data.js';
import { transaction } from '../db/index.js';
import { eraseHostedPageRecords } from '../hosted/data.js';
import { cancelActiveJobsForUser } from '../hosted/job-cancel.js';
import { removeHostedPageFiles } from '../hosted/assets.js';
import { codeHash } from './auth.js';
import { userAccount } from './billing.js';
import { erasePageRecords } from './page-lifecycle.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordDeletedEmail } from './deleted-emails.js';
import { REVISION_COVER_FILE, REVISION_FULL_SCREENSHOT, removeAllRevisionFiles, revisionDir } from './revision-storage.js';

/** 注销后用户行的昵称（聊天、成员列表等处显示）。 */
export const DELETED_USER_NICKNAME = '已注销用户';
/** 注销后他发出的聊天消息的正文。 */
export const DELETED_MESSAGE_TEXT = '该用户已注销';
/** 举报证据转存后最多保留多久。 */
export const DELETION_EVIDENCE_TTL_DAYS = 180;
/** 私信证据最多转存他发的最近多少条。 */
export const DELETION_EVIDENCE_MAX_MESSAGES = 200;

/** 被举报那一版的整页截图（没有时用封面）。读不到返回 null。 */
async function readScreenshot(dataDir: string, revisionId: string): Promise<Uint8Array | null> {
  for (const file of [REVISION_FULL_SCREENSHOT, REVISION_COVER_FILE]) {
    try {
      return new Uint8Array(await readFile(join(revisionDir(dataDir, revisionId), ...file.split('/'))));
    } catch {
      // 换下一个
    }
  }
  return null;
}

/** 删除到期的证据（举报处理完的由触发器删除）。返回删除条数。 */
export function purgeExpiredEvidence(deps: Pick<AppDeps, 'db' | 'now'>): number {
  return Number(deps.db.prepare('DELETE FROM deletion_evidence WHERE expires_at <= ?').run(deps.now().toISOString()).changes);
}

/**
 * 启动时的幂等清理：到期的证据；已注销用户残留的版本目录与托管素材目录（注销时删文件失败、或进程在提交后崩溃）。
 * 不存在的目录直接跳过，可以反复执行。
 */
export async function sweepDeletedAccounts(deps: Pick<AppDeps, 'db' | 'now' | 'config' | 'log'>): Promise<{ evidence: number; failed: number }> {
  const evidence = purgeExpiredEvidence(deps);
  const { revisionIds, pageIds } = accountDataQueries(deps.db).deletedAccountFiles();
  const failed = await removeAllRevisionFiles(deps.config.dataDir, revisionIds);
  for (const pageId of pageIds) {
    try {
      await removeHostedPageFiles(deps.config.dataDir, pageId);
    } catch {
      failed.push(pageId);
    }
  }
  if (failed.length > 0) deps.log(`[web] 清理已注销账号的文件：${failed.length} 个目录没能删除（${failed.join('、')}）`);
  return { evidence, failed: failed.length };
}

type DeletionDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'config' | 'log' | 'outbox' | 'userModels'>;

/** 注销前必须先关闭的墙（他是组织者、仍开放）。 */
export function wallsBlockingDeletion(deps: Pick<AppDeps, 'db'>, userId: string): { id: string; name: string }[] {
  return accountDataQueries(deps.db).openOrganizedWalls(userId);
}

export function deletionCodeMail(code: string): { subject: string; body: string; html: string } {
  const minutes = LOGIN_CODE_TTL_SECONDS / 60;
  return {
    subject: `${code} 是你注销 NOWMe 账号的确认码`,
    body: `你正在注销 NOWMe 账号，确认码是 ${code}，${minutes} 分钟内有效。注销后你的页面、资料和聊天内容都会删除，不能恢复。不是你本人操作的话，请忽略这封邮件，并尽快退出其他设备上的登录。`,
    html: [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#16150f;max-width:420px;margin:0 auto;padding:24px 8px">',
      '<p style="font-size:18px;font-weight:700;margin:0 0 16px">NOW<span style="background:#d4f54a;border:1.5px solid #16150f;border-radius:8px;padding:0 6px;margin-left:2px">Me</span></p>',
      '<p style="font-size:15px;line-height:1.6;margin:0 0 12px">你正在注销 NOWMe 账号，确认码：</p>',
      `<p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>`,
      `<p style="font-size:14px;line-height:1.6;color:#45413a;margin:0 0 8px">${minutes} 分钟内有效，只能用一次。注销后你的页面、资料和聊天内容都会删除，不能恢复。</p>`,
      '<p style="font-size:13px;line-height:1.6;color:#776f62;margin:0">不是你本人操作的话，忽略这封邮件就好，账号不会被注销。</p>',
      '</div>',
    ].join(''),
  };
}

export type RequestDeletionCodeResult = { ok: true } | { ok: false; reason: 'organizer' | 'rate_limited' | 'send_failed' | 'gone' };

/** 向账号邮箱发注销确认码（作废之前未使用的注销确认码）。与登录共用同一邮箱的发码限流。 */
export async function requestDeletionCode(deps: DeletionDeps, userId: string): Promise<RequestDeletionCodeResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - LOGIN_CODE_RATE_WINDOW_SECONDS * 1000).toISOString();
  const code = generateLoginCode();
  const issued = transaction(deps.db, (): RequestDeletionCodeResult & { email?: string } => {
    const user = deps.repos.users.findById(userId);
    if (!user || user.deletedAt) return { ok: false, reason: 'gone' };
    if (wallsBlockingDeletion(deps, userId).length > 0) return { ok: false, reason: 'organizer' };
    if (deps.repos.loginCodes.countCreatedSince(user.email, windowStart) >= LOGIN_CODE_RATE_MAX) return { ok: false, reason: 'rate_limited' };
    deps.repos.loginCodes.invalidateUnused(user.email, nowIso, 'account_delete');
    const id = generateId('lgc');
    deps.repos.loginCodes.create(
      { id, email: user.email, codeHash: codeHash(id, code), expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_SECONDS * 1000).toISOString(), createdAt: nowIso },
      'account_delete',
    );
    return { ok: true, email: user.email };
  });
  if (!issued.ok || !issued.email) return issued.ok ? { ok: false, reason: 'gone' } : issued;
  try {
    await deps.outbox.send({ at: nowIso, to: issued.email, ...deletionCodeMail(code) });
  } catch {
    deps.repos.loginCodes.invalidateUnused(issued.email, deps.now().toISOString(), 'account_delete');
    return { ok: false, reason: 'send_failed' };
  }
  return { ok: true };
}

export type DeleteAccountResult =
  | { ok: true; pages: number }
  | { ok: false; reason: 'organizer' | 'no_code' | 'locked' | 'gone' }
  | { ok: false; reason: 'mismatch'; remaining: number };

/** 校验注销确认码并注销（见文件头）。验证码不对时只记一次尝试，什么都不删。 */
export async function deleteAccount(deps: DeletionDeps, userId: string, rawCode: string | undefined): Promise<DeleteAccountResult> {
  const { repos, db } = deps;
  const queries = accountDataQueries(db);
  const input = (rawCode ?? '').replace(/\s+/g, '');
  const nowIso = deps.now().toISOString();
  const expiresAt = new Date(deps.now().getTime() + DELETION_EVIDENCE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  // 截图要读文件（异步），先在事务外读好；事务里再按当时的待处理举报取用
  const screenshots = new Map<string, Uint8Array | null>();
  for (const report of queries.openReportsAgainst(userId)) {
    if (report.revisionId && !screenshots.has(report.revisionId)) screenshots.set(report.revisionId, await readScreenshot(deps.config.dataDir, report.revisionId));
  }

  const outcome = transaction(db, (): DeleteAccountResult & { fileIds?: string[]; pageIds?: string[] } => {
    const user = repos.users.findById(userId);
    if (!user || user.deletedAt) return { ok: false, reason: 'gone' };
    if (queries.openOrganizedWalls(userId).length > 0) return { ok: false, reason: 'organizer' };

    // 1. 注销确认码（与登录验证码同样的计次与作废规则）
    const record = repos.loginCodes.findLatestUsable(user.email, nowIso, 'account_delete');
    if (!record) return { ok: false, reason: 'no_code' };
    if (record.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      repos.loginCodes.markUsed(record.id, nowIso);
      return { ok: false, reason: 'locked' };
    }
    const attempts = repos.loginCodes.incrementAttempts(record.id);
    const wellFormed = new RegExp(`^\\d{${LOGIN_CODE_DIGITS}}$`).test(input);
    if (!wellFormed || !constantTimeEqual(codeHash(record.id, input), record.codeHash)) {
      if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
        repos.loginCodes.markUsed(record.id, nowIso);
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'mismatch', remaining: LOGIN_CODE_MAX_ATTEMPTS - attempts };
    }
    if (!repos.loginCodes.markUsed(record.id, nowIso)) return { ok: false, reason: 'no_code' };

    // 证据转存：必须在清除页面与消息之前
    for (const report of queries.openReportsAgainst(userId)) {
      if (report.kind === 'page') {
        queries.insertEvidence({
          reportId: report.id,
          kind: 'page',
          cardJson: report.cardJson,
          renderedText: report.revisionId ? (repos.revisions.findById(report.revisionId)?.renderedText ?? null) : null,
          screenshot: report.revisionId ? (screenshots.get(report.revisionId) ?? null) : null,
          messagesJson: null,
          createdAt: nowIso,
          expiresAt,
        });
      } else if (report.conversationId) {
        const messages = queries.sentMessagesUntil(report.conversationId, userId, report.lastSequence ?? 0, DELETION_EVIDENCE_MAX_MESSAGES);
        queries.insertEvidence({ reportId: report.id, kind: 'conversation', cardJson: null, renderedText: null, screenshot: null, messagesJson: JSON.stringify(messages), createdAt: nowIso, expiresAt });
      }
    }
    recordDeletedEmail(deps, user.email, nowIso);

    // 2. 每一页按“删除页面”处理（含已退出 / 被移除 / 墙已关闭的页面）
    const memberships = repos.memberships.listAllForUser(userId);
    const fileIds: string[] = [];
    const pageIds: string[] = [];
    for (const { membership, wall, pageId } of memberships) {
      const page = pageId ? repos.pages.findById(pageId) : null;
      if (!page || page.ownerId !== userId) continue;
      fileIds.push(...erasePageRecords(deps, { wall, membership, page }, userId).fileIds);
      eraseHostedPageRecords(deps, page.id);
      pageIds.push(page.id);
    }

    // 3. 进行中的任务：直接结束并退点；worker 发现租约已不在就停止后续模型请求，结果作废（contracts 13.4）
    cancelActiveJobsForUser(deps, userId, 'PAGE_GONE');

    // 4. 成员关系结束（与退出墙相同的 left）
    const ended = new Set(queries.endActiveMemberships(userId, nowIso));
    for (const { membership, wall, pageId } of memberships) {
      if (!ended.has(membership.id)) continue;
      repos.events.record({ type: 'leave', wallId: wall.id, pageId, actorId: userId, props: { accountDeleted: true }, createdAt: nowIso });
    }

    // 5. 聊天与“和 TA 聊什么”
    queries.replaceSentMessages(userId, DELETED_MESSAGE_TEXT);
    queries.deleteChatReads(userId);
    queries.deleteIcebreakersOfViewer(userId);
    queries.deleteIntrosOfViewer(userId);
    // 必答题的回答、提醒记录、他生成的群像（contracts 19）
    repos.questions.deleteAnswersOfUser(userId);
    repos.reminders.deleteForUser(userId);
    repos.portraits.deleteByCreator(userId);

    // 6. 画像、模型配置、会话、验证码、墙封面
    repos.profileEntries.deleteAllForUser(userId);
    deps.userModels.delete(userId);
    repos.sessions.deleteForUser(userId);
    repos.loginCodes.deleteForEmail(user.email);
    queries.deleteOrganizedWallCovers(userId);
    queries.deleteBlocks(userId);
    queries.eraseReportNotes(userId);

    // 7. 余额作废（流水只追加）
    const balance = repos.credits.balanceOf(userAccount(userId));
    if (balance > 0) repos.credits.post({ account: userAccount(userId), delta: -balance, reason: 'account_deleted', at: nowIso });

    // 8. 用户行改为墓碑
    if (!queries.tombstoneUser(userId, DELETED_USER_NICKNAME, nowIso)) throw new Error('注销：用户行没有更新');
    return { ok: true, pages: pageIds.length, fileIds, pageIds };
  });

  if (!outcome.ok) return outcome;
  const failed = await removeAllRevisionFiles(deps.config.dataDir, outcome.fileIds ?? []);
  for (const pageId of outcome.pageIds ?? []) {
    try {
      await removeHostedPageFiles(deps.config.dataDir, pageId);
    } catch {
      failed.push(pageId);
    }
  }
  if (failed.length > 0) deps.log(`[web] 注销账号 ${userId}：${failed.length} 个目录没能删除（${failed.join('、')}），请手动清理`);
  deps.log(`[web] 账号 ${userId} 已注销（${outcome.pages} 页）`);
  return { ok: true, pages: outcome.pages };
}
