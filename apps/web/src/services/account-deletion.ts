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
 * 事务提交后删除版本目录与托管素材目录（失败只记日志：数据库里已是墓碑，不会再签发票据）。
 */
import { constantTimeEqual, generateId, LOGIN_CODE_DIGITS, LOGIN_CODE_MAX_ATTEMPTS, LOGIN_CODE_TTL_SECONDS, generateLoginCode } from '@nowme/contracts';
import { LOGIN_CODE_RATE_MAX, LOGIN_CODE_RATE_WINDOW_SECONDS } from '../constants.js';
import type { AppDeps } from '../context.js';
import { accountDataQueries } from '../db/account-data.js';
import { transaction } from '../db/index.js';
import { eraseHostedPageRecords } from '../hosted/data.js';
import { removeHostedPageFiles } from '../hosted/assets.js';
import { codeHash } from './auth.js';
import { settleJob, userAccount } from './billing.js';
import { erasePageRecords } from './page-lifecycle.js';
import { removeAllRevisionFiles } from './revision-storage.js';

/** 注销后用户行的昵称（聊天、成员列表等处显示）。 */
export const DELETED_USER_NICKNAME = '已注销用户';
/** 注销后他发出的聊天消息的正文。 */
export const DELETED_MESSAGE_TEXT = '该用户已注销';

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

    // 3. 进行中的任务：直接结束并退点（任务执行器之后写结果会因为状态不再是排队 / 运行而作罢）
    for (const jobId of queries.activeJobIds(userId)) {
      settleJob(deps, jobId, false);
      repos.jobs.finish(jobId, {
        status: 'failed',
        revisionId: null,
        errorCode: 'PAGE_GONE',
        resultMessage: null,
        charged: false,
        usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        finishedAt: nowIso,
      });
    }

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
