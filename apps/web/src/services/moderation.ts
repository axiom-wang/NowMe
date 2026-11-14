/**
 * 举报、拉黑与处理（contracts 15、S12）。路由与运营命令行（scripts/moderation.ts）共用这里的函数。
 *
 * - 举报页面：只能举报同墙上**别人的、已发布**的页面（`found` 必须来自 `findPublishedMemberPage`）；
 *   同一人对同一页面只有一条，重复举报只更新原因与补充说明。已被处理过的举报，只有页面换了一次发布
 *   （内容可能变了）后再举报才会重新打开，免得一个人反复刷到组织者面前。
 * - 举报私信：只能举报自己参与的一对一私信；只进平台运营，组织者永远看不到。
 * - 组织者：只看到墙上仍可见的页面、原因类别与次数；看不到举报人、补充说明、私信举报，也看不到针对自己页面的举报。
 *   可以“请这一页下墙”（与主人撤下同一语义：活跃发布以 withdrawn 结束，处理记录里记下是组织者）或“忽略”。
 * - 拉黑：账号之间、对所有共同的墙生效，双向：互相看不到页面卡片与成员页（404）、不能私信、不能用“和 TA 聊什么”。
 *   对方不会收到通知。
 * - 停用账号（只有平台运营）：会话全部删除、不能登录、全部页面下墙、本地 Agent 连接断开。
 */
import { codePointLength, generateId, isId } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import { isReportReason, type Report, type ReportReason } from '../db/moderation.js';
import { wallQueries } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import type { PublishedMemberPage } from './access.js';
import { disconnectAgent } from './agent.js';
import { parsePublishedCard } from './wall-view.js';

type ModerationDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;

export const REPORT_NOTE_MAX_LENGTH = 500;

export const REPORT_REASON_LABEL: Readonly<Record<ReportReason, string>> = {
  harassment: '骚扰',
  inappropriate: '不当内容',
  impersonation: '冒充他人',
  spam: '垃圾广告',
  other: '其他',
};

export interface ReportInput {
  reason: ReportReason;
  note: string | null;
}

export type ParsedReport = { ok: true; input: ReportInput } | { ok: false; error: string };

/** 表单 → 举报输入。补充说明可选：统一换行、去首尾空白后最多 500 字，不能有控制字符（换行、制表符除外）。 */
export function parseReportForm(fields: Record<string, string | undefined>): ParsedReport {
  if (!isReportReason(fields.reason)) return { ok: false, error: '先选一个原因。' };
  const note = (fields.note ?? '').replace(/\r\n?/g, '\n').trim();
  if (codePointLength(note) > REPORT_NOTE_MAX_LENGTH) return { ok: false, error: `补充说明最多 ${REPORT_NOTE_MAX_LENGTH} 个字。` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) return { ok: false, error: '补充说明里有不支持的字符。' };
  return { ok: true, input: { reason: fields.reason, note: note || null } };
}

export type ReportOutcome = 'created' | 'updated';

/** 举报墙上别人的已发布页面。自己的页面返回 null（路由回 404）。 */
export function reportPage(deps: ModerationDeps, found: PublishedMemberPage, reporterId: string, input: ReportInput): ReportOutcome | null {
  if (found.own || found.entry.ownerId === reporterId) return null;
  const nowIso = deps.now().toISOString();
  const { entry } = found;
  return transaction(deps.db, (): ReportOutcome => {
    const existing = deps.repos.moderation.findPageReport(reporterId, entry.pageId);
    if (existing) {
      const reopen = existing.status !== 'open' && existing.publicationId !== entry.publicationId;
      deps.repos.moderation.updateReport(existing.id, {
        reason: input.reason,
        note: input.note,
        publicationId: existing.status === 'open' || reopen ? entry.publicationId : existing.publicationId,
        lastSequence: null,
        wallId: found.wall.id,
        updatedAt: nowIso,
        reopen,
      });
      return 'updated';
    }
    deps.repos.moderation.insertReport({
      id: generateId('rpt'),
      reporterId,
      targetKind: 'page',
      wallId: found.wall.id,
      reportedUserId: entry.ownerId,
      pageId: entry.pageId,
      publicationId: entry.publicationId,
      conversationId: null,
      lastSequence: null,
      reason: input.reason,
      note: input.note,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return 'created';
  });
}

/** 这一页查看者举报过没有（成员页上显示“已举报”）。 */
export function hasReportedPage(deps: Pick<AppDeps, 'repos'>, reporterId: string, pageId: string): boolean {
  return deps.repos.moderation.findPageReport(reporterId, pageId)?.status === 'open';
}

/** 举报一段自己参与的一对一私信（只进平台运营）。无权访问、群聊返回 null。 */
export function reportConversation(deps: ModerationDeps, reporterId: string, conversationId: string, input: ReportInput): ReportOutcome | null {
  if (!isId(conversationId, 'cnv')) return null;
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, (): ReportOutcome | null => {
    const conversation = deps.repos.chat.findVisible(conversationId, reporterId);
    if (!conversation || conversation.kind !== 'direct') return null;
    const other = conversation.userA === reporterId ? conversation.userB : conversation.userA;
    if (!other || other === reporterId) return null;
    const lastSequence = deps.repos.chat.history(conversation.id).messages.at(-1)?.sequence ?? 0;
    const existing = deps.repos.moderation.findConversationReport(reporterId, conversation.id);
    if (existing) {
      const reopen = existing.status !== 'open' && lastSequence > (existing.lastSequence ?? 0);
      deps.repos.moderation.updateReport(existing.id, {
        reason: input.reason,
        note: input.note,
        publicationId: null,
        lastSequence: Math.max(lastSequence, existing.lastSequence ?? 0),
        wallId: conversation.wallId,
        updatedAt: nowIso,
        reopen,
      });
      return 'updated';
    }
    deps.repos.moderation.insertReport({
      id: generateId('rpt'),
      reporterId,
      targetKind: 'conversation',
      wallId: conversation.wallId,
      reportedUserId: other,
      pageId: null,
      publicationId: null,
      conversationId: conversation.id,
      lastSequence,
      reason: input.reason,
      note: input.note,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return 'created';
  });
}

// ---------------------------------------------------------------------------
// 组织者
// ---------------------------------------------------------------------------

/** 组织者后台的一条待处理举报（S12：没有举报人、补充说明）。 */
export interface OrganizerReport {
  pageId: string;
  displayName: string;
  href: string;
  total: number;
  reasons: { reason: ReportReason; label: string; count: number }[];
  lastAt: string;
}

/** 组织者后台：墙上仍可见的被举报页面（不含组织者自己的页面），按次数多的在前。 */
export function loadOrganizerReports(deps: Pick<AppDeps, 'db' | 'repos'>, wall: Wall, organizerId: string): OrganizerReport[] {
  const queries = wallQueries(deps.db);
  const byPage = new Map<string, OrganizerReport>();
  for (const row of deps.repos.moderation.organizerRows(wall.id, organizerId)) {
    let item = byPage.get(row.pageId);
    if (!item) {
      const entry = queries.findPublished(wall.id, row.pageId);
      if (!entry || entry.ownerId === organizerId) continue;
      const nickname = deps.repos.users.findById(entry.ownerId)?.nickname ?? '成员';
      item = {
        pageId: row.pageId,
        displayName: parsePublishedCard(entry.cardJson, nickname).displayName,
        href: `/w/${wall.id}/p/${row.pageId}`,
        total: 0,
        reasons: [],
        lastAt: row.lastAt,
      };
      byPage.set(row.pageId, item);
    }
    item.total += row.count;
    item.reasons.push({ reason: row.reason, label: REPORT_REASON_LABEL[row.reason], count: row.count });
    if (row.lastAt > item.lastAt) item.lastAt = row.lastAt;
  }
  return [...byPage.values()].sort((a, b) => b.total - a.total || b.lastAt.localeCompare(a.lastAt));
}

/** 组织者可以处理的页面：墙上可见、不是组织者自己的、有待处理举报。否则 null（路由回 404）。 */
function organizerTarget(deps: ModerationDeps, wall: Wall, organizerId: string, pageId: string) {
  if (!isId(pageId, 'pg')) return null;
  const entry = wallQueries(deps.db).findPublished(wall.id, pageId);
  if (!entry || entry.ownerId === organizerId) return null;
  if (deps.repos.moderation.countOpenForOrganizer(wall.id, pageId, organizerId) === 0) return null;
  return entry;
}

/** 组织者请这一页下墙：活跃发布以 withdrawn 结束（主人之后可以改了再发布），待处理举报记为已处理。 */
export function organizerTakedown(deps: ModerationDeps, wall: Wall, organizerId: string, pageId: string): boolean {
  return transaction(deps.db, () => {
    const entry = organizerTarget(deps, wall, organizerId, pageId);
    if (!entry) return false;
    const nowIso = deps.now().toISOString();
    wallQueries(deps.db).endActivePublication(entry.pageId, 'withdrawn', nowIso);
    deps.repos.moderation.resolveOpenForPage(entry.pageId, 'actioned', 'organizer', nowIso);
    deps.repos.moderation.recordAction({ actor: 'organizer', actorUserId: organizerId, action: 'takedown', wallId: wall.id, pageId: entry.pageId, publicationId: entry.publicationId, userId: entry.ownerId, createdAt: nowIso });
    deps.repos.events.record({ type: 'withdraw', wallId: wall.id, pageId: entry.pageId, actorId: organizerId, props: { byOrganizer: true }, createdAt: nowIso });
    return true;
  });
}

/** 组织者忽略这一页的待处理举报（页面留在墙上）。 */
export function organizerDismiss(deps: ModerationDeps, wall: Wall, organizerId: string, pageId: string): boolean {
  return transaction(deps.db, () => {
    const entry = organizerTarget(deps, wall, organizerId, pageId);
    if (!entry) return false;
    const nowIso = deps.now().toISOString();
    deps.repos.moderation.resolveOpenForPage(entry.pageId, 'dismissed', 'organizer', nowIso);
    deps.repos.moderation.recordAction({ actor: 'organizer', actorUserId: organizerId, action: 'dismiss', wallId: wall.id, pageId: entry.pageId, publicationId: entry.publicationId, userId: entry.ownerId, createdAt: nowIso });
    return true;
  });
}

// ---------------------------------------------------------------------------
// 拉黑
// ---------------------------------------------------------------------------

/** 拉黑。不能拉黑自己；重复拉黑无副作用。对方不会收到任何通知。 */
export function blockUser(deps: ModerationDeps, blockerId: string, blockedId: string): boolean {
  if (!isId(blockedId, 'usr') || blockedId === blockerId || !deps.repos.users.findById(blockedId)) return false;
  deps.repos.moderation.block(blockerId, blockedId, deps.now().toISOString());
  return true;
}

export function unblockUser(deps: ModerationDeps, blockerId: string, blockedId: string): boolean {
  if (!isId(blockedId, 'usr')) return false;
  return deps.repos.moderation.unblock(blockerId, blockedId);
}

/** 两人之间还能不能私信：没有拉黑（任一方向），对方没有被停用。 */
export function canMessage(deps: Pick<AppDeps, 'repos'>, userId: string, otherId: string): boolean {
  return !deps.repos.moderation.blockedEitherWay(userId, otherId) && !deps.repos.moderation.isSuspended(otherId) && !deps.repos.moderation.isSuspended(userId);
}

// ---------------------------------------------------------------------------
// 平台运营（命令行）
// ---------------------------------------------------------------------------

/** 平台把某一页请下墙（不管在哪面墙），这一页全部待处理举报记为已处理。返回是否结束了活跃发布。 */
export function platformHidePage(deps: ModerationDeps, pageId: string, note: string | null): { ended: boolean; resolved: number } | null {
  if (!isId(pageId, 'pg')) return null;
  return transaction(deps.db, () => {
    const page = deps.repos.pages.findById(pageId);
    if (!page) return null;
    const nowIso = deps.now().toISOString();
    const active = deps.repos.publications.findActiveForPage(page.id);
    const ended = wallQueries(deps.db).endActivePublication(page.id, 'withdrawn', nowIso) > 0;
    const resolved = deps.repos.moderation.resolveOpenForPage(page.id, 'actioned', 'platform', nowIso);
    deps.repos.moderation.recordAction({ actor: 'platform', actorUserId: null, action: 'takedown', wallId: page.wallId, pageId: page.id, publicationId: active?.id ?? null, userId: page.ownerId, note, createdAt: nowIso });
    return { ended, resolved };
  });
}

/** 平台结束一条举报（不做其他处理）。 */
export function platformResolveReport(deps: ModerationDeps, report: Report, status: 'dismissed' | 'actioned', note: string | null): boolean {
  return transaction(deps.db, () => {
    const nowIso = deps.now().toISOString();
    if (!deps.repos.moderation.resolveReport(report.id, status, 'platform', nowIso)) return false;
    deps.repos.moderation.recordAction({ actor: 'platform', actorUserId: null, action: 'resolve', wallId: report.wallId, pageId: report.pageId, reportId: report.id, userId: report.reportedUserId, note: note ?? status, createdAt: nowIso });
    return true;
  });
}

export interface SuspendResult {
  /** 结束的活跃发布数（页面下墙）。 */
  endedPublications: number;
  /** 之前已经是停用状态。 */
  already: boolean;
}

/** 停用账号：删除全部会话、全部页面下墙、断开本地 Agent；之后不能登录（services/auth.ts）。 */
export function suspendUser(deps: ModerationDeps, userId: string, note: string | null): SuspendResult {
  return transaction(deps.db, () => {
    const nowIso = deps.now().toISOString();
    const already = !deps.repos.moderation.suspend(userId, note, nowIso);
    deps.repos.sessions.deleteForUser(userId);
    let endedPublications = 0;
    for (const item of deps.repos.memberships.listAllForUser(userId)) {
      if (!item.pageId) continue;
      endedPublications += wallQueries(deps.db).endActivePublication(item.pageId, 'withdrawn', nowIso);
      disconnectAgent(deps, item.pageId);
    }
    deps.repos.moderation.recordAction({ actor: 'platform', actorUserId: null, action: 'suspend', userId, note, createdAt: nowIso });
    return { endedPublications, already };
  });
}

/** 解除停用：可以重新登录；页面不会自动回到墙上（主人自己重新发布）。 */
export function unsuspendUser(deps: ModerationDeps, userId: string, note: string | null): boolean {
  return transaction(deps.db, () => {
    if (!deps.repos.moderation.unsuspend(userId)) return false;
    deps.repos.moderation.recordAction({ actor: 'platform', actorUserId: null, action: 'unsuspend', userId, note, createdAt: deps.now().toISOString() });
    return true;
  });
}
