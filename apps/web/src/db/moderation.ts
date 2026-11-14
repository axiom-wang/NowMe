/**
 * 举报、拉黑、处理记录与停用账号（contracts 15，迁移 012_moderation.sql）。
 *
 * - `reports`：同一举报人对同一页面 / 同一段私信只有一行（重复举报只更新）。
 * - `moderation_actions`：只追加。
 * - `blocks`：单向记录，双向生效（`blockedEitherWay`、`hiddenPeers`）。
 * - `user_suspensions`：有记录即停用。
 */
import { generateId } from '@nowme/contracts';
import type { Database } from './database.js';

export const REPORT_REASONS = ['harassment', 'inappropriate', 'impersonation', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportKind = 'page' | 'conversation';
export type ReportStatus = 'open' | 'dismissed' | 'actioned';
export type ModerationActor = 'organizer' | 'platform';
export type ModerationActionType = 'takedown' | 'dismiss' | 'resolve' | 'suspend' | 'unsuspend';

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}


export interface Report {
  id: string;
  reporterId: string;
  targetKind: ReportKind;
  wallId: string;
  reportedUserId: string;
  pageId: string | null;
  publicationId: string | null;
  conversationId: string | null;
  lastSequence: number | null;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  resolvedBy: ModerationActor | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReportRow {
  id: string;
  reporter_id: string;
  target_kind: ReportKind;
  wall_id: string;
  reported_user_id: string;
  page_id: string | null;
  publication_id: string | null;
  conversation_id: string | null;
  last_sequence: number | null;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  resolved_by: ModerationActor | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function toReport(row: ReportRow | undefined): Report | null {
  if (!row) return null;
  return {
    id: row.id,
    reporterId: row.reporter_id,
    targetKind: row.target_kind,
    wallId: row.wall_id,
    reportedUserId: row.reported_user_id,
    pageId: row.page_id,
    publicationId: row.publication_id,
    conversationId: row.conversation_id,
    lastSequence: row.last_sequence === null ? null : Number(row.last_sequence),
    reason: row.reason,
    note: row.note,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 组织者后台的一行（S12）：只有页面与按原因的次数，没有举报人、补充说明。 */
export interface OrganizerReportRow {
  pageId: string;
  reason: ReportReason;
  count: number;
  lastAt: string;
}

export interface ModerationActionInput {
  actor: ModerationActor;
  actorUserId: string | null;
  action: ModerationActionType;
  wallId?: string | null;
  pageId?: string | null;
  publicationId?: string | null;
  reportId?: string | null;
  userId?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface BlockedUserRow {
  userId: string;
  nickname: string;
  blockedAt: string;
}

export function createModerationRepo(db: Database) {
  const insertReport = db.prepare(
    `INSERT INTO reports (id, reporter_id, target_kind, wall_id, reported_user_id, page_id, publication_id, conversation_id, last_sequence,
                          reason, note, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );
  const pageReportOf = db.prepare("SELECT * FROM reports WHERE target_kind = 'page' AND reporter_id = ? AND page_id = ?");
  const conversationReportOf = db.prepare("SELECT * FROM reports WHERE target_kind = 'conversation' AND reporter_id = ? AND conversation_id = ?");
  const byId = db.prepare('SELECT * FROM reports WHERE id = ?');
  const updateReport = db.prepare(
    `UPDATE reports SET reason = ?, note = ?, publication_id = ?, last_sequence = ?, wall_id = ?, updated_at = ?,
            status = CASE WHEN ? THEN 'open' ELSE status END,
            resolved_by = CASE WHEN ? THEN NULL ELSE resolved_by END,
            resolved_at = CASE WHEN ? THEN NULL ELSE resolved_at END
      WHERE id = ?`,
  );
  const resolveOne = db.prepare("UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'open'");
  const resolveForPage = db.prepare(
    "UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE target_kind = 'page' AND page_id = ? AND status = 'open'",
  );
  const organizerRows = db.prepare(
    `SELECT page_id, reason, COUNT(*) AS n, MAX(updated_at) AS last_at FROM reports
      WHERE wall_id = ? AND target_kind = 'page' AND status = 'open' AND reported_user_id <> ?
      GROUP BY page_id, reason ORDER BY page_id, reason`,
  );
  const openPageReports = db.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE wall_id = ? AND target_kind = 'page' AND page_id = ? AND status = 'open' AND reported_user_id <> ?",
  );
  const insertAction = db.prepare(
    `INSERT INTO moderation_actions (id, actor, actor_user_id, action, wall_id, page_id, publication_id, report_id, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const takedownOf = db.prepare(
    "SELECT actor FROM moderation_actions WHERE action = 'takedown' AND publication_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  );
  const insertBlock = db.prepare('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  const deleteBlock = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
  const blockedOne = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
  const blockedEither = db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
  );
  const peers = db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?');
  const blockedList = db.prepare(
    `SELECT b.blocked_id AS user_id, COALESCE(u.nickname, '成员') AS nickname, b.created_at FROM blocks b
       JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC, b.rowid DESC`,
  );
  const suspended = db.prepare('SELECT 1 FROM user_suspensions WHERE user_id = ?');
  const insertSuspension = db.prepare('INSERT INTO user_suspensions (user_id, reason, suspended_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  const deleteSuspension = db.prepare('DELETE FROM user_suspensions WHERE user_id = ?');

  return {
    findReport(id: string): Report | null {
      return toReport(byId.get(id) as ReportRow | undefined);
    },
    findPageReport(reporterId: string, pageId: string): Report | null {
      return toReport(pageReportOf.get(reporterId, pageId) as ReportRow | undefined);
    },
    findConversationReport(reporterId: string, conversationId: string): Report | null {
      return toReport(conversationReportOf.get(reporterId, conversationId) as ReportRow | undefined);
    },
    insertReport(report: Omit<Report, 'status' | 'resolvedBy' | 'resolvedAt'>): void {
      insertReport.run(
        report.id,
        report.reporterId,
        report.targetKind,
        report.wallId,
        report.reportedUserId,
        report.pageId,
        report.publicationId,
        report.conversationId,
        report.lastSequence,
        report.reason,
        report.note,
        report.createdAt,
        report.updatedAt,
      );
    },
    /** 更新已有举报；`reopen` 为真时回到待处理。 */
    updateReport(
      id: string,
      fields: { reason: ReportReason; note: string | null; publicationId: string | null; lastSequence: number | null; wallId: string; updatedAt: string; reopen: boolean },
    ): void {
      const reopen = fields.reopen ? 1 : 0;
      updateReport.run(fields.reason, fields.note, fields.publicationId, fields.lastSequence, fields.wallId, fields.updatedAt, reopen, reopen, reopen, id);
    },
    resolveReport(id: string, status: Exclude<ReportStatus, 'open'>, by: ModerationActor, now: string): boolean {
      return Number(resolveOne.run(status, by, now, now, id).changes) > 0;
    },
    /** 这一页全部待处理的举报一起结束（组织者下墙 / 忽略，平台下墙）。返回条数。 */
    resolveOpenForPage(pageId: string, status: Exclude<ReportStatus, 'open'>, by: ModerationActor, now: string): number {
      return Number(resolveForPage.run(status, by, now, now, pageId).changes);
    },
    /** 组织者后台：墙上待处理的页面举报，按页面与原因聚合；不含针对组织者自己页面的举报。 */
    organizerRows(wallId: string, organizerId: string): OrganizerReportRow[] {
      return (organizerRows.all(wallId, organizerId) as { page_id: string; reason: ReportReason; n: number; last_at: string }[]).map((row) => ({
        pageId: row.page_id,
        reason: row.reason,
        count: Number(row.n),
        lastAt: row.last_at,
      }));
    },
    countOpenForOrganizer(wallId: string, pageId: string, organizerId: string): number {
      return Number((openPageReports.get(wallId, pageId, organizerId) as { n: number }).n);
    },
    /** 平台运营列表：按状态（null = 全部）、对象类型筛选，最近更新在前。 */
    listReports(filter: { status?: ReportStatus | null; kind?: ReportKind | null; limit?: number } = {}): Report[] {
      const where: string[] = [];
      const params: string[] = [];
      if (filter.status) {
        where.push('status = ?');
        params.push(filter.status);
      }
      if (filter.kind) {
        where.push('target_kind = ?');
        params.push(filter.kind);
      }
      const sql = `SELECT * FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, rowid DESC LIMIT ${Math.max(1, Math.min(filter.limit ?? 100, 1000))}`;
      return (db.prepare(sql).all(...params) as unknown as ReportRow[]).map((row) => toReport(row)!);
    },
    /** 同一对象（页面或私信）的举报总数（平台运营查看时用）。 */
    countForTarget(report: Report): number {
      const row =
        report.targetKind === 'page'
          ? db.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_kind = 'page' AND page_id = ?").get(report.pageId)
          : db.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_kind = 'conversation' AND conversation_id = ?").get(report.conversationId);
      return Number((row as { n: number }).n);
    },
    recordAction(input: ModerationActionInput): string {
      const id = generateId('mda');
      insertAction.run(
        id,
        input.actor,
        input.actorUserId,
        input.action,
        input.wallId ?? null,
        input.pageId ?? null,
        input.publicationId ?? null,
        input.reportId ?? null,
        input.userId ?? null,
        input.note ?? null,
        input.createdAt,
      );
      return id;
    },
    /** 这条发布是不是被组织者 / 平台请下墙的。 */
    takedownActorFor(publicationId: string): ModerationActor | null {
      const row = takedownOf.get(publicationId) as { actor: ModerationActor } | undefined;
      return row?.actor ?? null;
    },

    block(blockerId: string, blockedId: string, now: string): boolean {
      return Number(insertBlock.run(blockerId, blockedId, now).changes) > 0;
    },
    unblock(blockerId: string, blockedId: string): boolean {
      return Number(deleteBlock.run(blockerId, blockedId).changes) > 0;
    },
    /** `blockerId` 是否拉黑了 `blockedId`（单向）。 */
    hasBlocked(blockerId: string, blockedId: string): boolean {
      return !!blockedOne.get(blockerId, blockedId);
    },
    /** 两人之间任一方向有拉黑（拉黑双向生效）。 */
    blockedEitherWay(a: string, b: string): boolean {
      if (a === b) return false;
      return !!blockedEither.get(a, b, b, a);
    },
    /** 与 `userId` 之间有拉黑关系（任一方向）的全部账号。 */
    hiddenPeers(userId: string): Set<string> {
      return new Set((peers.all(userId, userId) as { id: string }[]).map((row) => row.id));
    },
    /** 我拉黑的人（“我的资料”）。不列出谁拉黑了我。 */
    listBlockedBy(blockerId: string): BlockedUserRow[] {
      return (blockedList.all(blockerId) as { user_id: string; nickname: string; created_at: string }[]).map((row) => ({
        userId: row.user_id,
        nickname: row.nickname,
        blockedAt: row.created_at,
      }));
    },

    isSuspended(userId: string): boolean {
      return !!suspended.get(userId);
    },
    suspend(userId: string, reason: string | null, now: string): boolean {
      return Number(insertSuspension.run(userId, reason, now).changes) > 0;
    },
    unsuspend(userId: string): boolean {
      return Number(deleteSuspension.run(userId).changes) > 0;
    },
  };
}

export type ModerationRepo = ReturnType<typeof createModerationRepo>;
