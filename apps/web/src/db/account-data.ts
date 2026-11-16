/**
 * 账号注销与数据导出（contracts 14）用到的跨表查询。所有函数都以**当前登录用户**的 ID 为参数，
 * 读取的列都是显式列出的白名单：没有哈希、令牌、凭证、加密的 Key、邀请码、公开链接令牌。
 */
import type { Database } from './database.js';

export interface ExportBriefRow {
  id: string;
  pageId: string;
  status: string;
  answersJson: string | null;
  followupsJson: string | null;
  briefJson: string | null;
  briefMd: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExportAssetRow {
  pageId: string;
  fileName: string;
  mime: string;
  createdAt: string;
}

export interface ExportJobRow {
  pageId: string;
  kind: string;
  status: string;
  requestText: string | null;
  resultMessage: string | null;
  errorCode: string | null;
  revisionId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ExportPublicationRow {
  pageId: string;
  revisionId: string;
  cardJson: string;
  contactJson: string | null;
  publishedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface ExportConversationRow {
  id: string;
  wallId: string;
  kind: 'group' | 'direct';
  peerId: string | null;
  createdAt: string;
}

export interface ExportMessageRow {
  sequence: number;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

export interface ExportCreditRow {
  delta: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
}

export interface ExportReportRow {
  targetKind: string;
  wallId: string;
  reason: string;
  note: string | null;
  createdAt: string;
}

export interface ExportIcebreakerRow {
  wallId: string;
  pageId: string;
  resultJson: string;
  createdAt: string;
}

export function accountDataQueries(db: Database) {
  const all = <T>(sql: string, ...params: (string | number)[]): T[] => db.prepare(sql).all(...params) as unknown as T[];
  return {
    // ----- 导出 -----
    briefs(userId: string): ExportBriefRow[] {
      return all(
        `SELECT id, page_id AS pageId, status, answers_json AS answersJson, followups_json AS followupsJson, brief_json AS briefJson,
                brief_md AS briefMd, confirmed_at AS confirmedAt, created_at AS createdAt, updated_at AS updatedAt
           FROM briefs WHERE owner_id = ? ORDER BY created_at`,
        userId,
      );
    },
    assets(userId: string): ExportAssetRow[] {
      return all('SELECT page_id AS pageId, file_name AS fileName, mime, created_at AS createdAt FROM brief_assets WHERE owner_id = ? ORDER BY page_id, file_name', userId);
    },
    jobs(userId: string): ExportJobRow[] {
      return all(
        `SELECT page_id AS pageId, kind, status, request_text AS requestText, result_message AS resultMessage, error_code AS errorCode,
                revision_id AS revisionId, created_at AS createdAt, finished_at AS finishedAt
           FROM generation_jobs WHERE owner_id = ? ORDER BY created_at`,
        userId,
      );
    },
    publications(pageId: string): ExportPublicationRow[] {
      return all(
        `SELECT page_id AS pageId, revision_id AS revisionId, card_json AS cardJson, contact_json AS contactJson, published_at AS publishedAt,
                ended_at AS endedAt, end_reason AS endReason
           FROM publications WHERE page_id = ? ORDER BY published_at, rowid`,
        pageId,
      );
    },
    /** 用户参与过的会话：他（曾经）所在墙的全员群，和他是一方的私聊。 */
    conversations(userId: string): ExportConversationRow[] {
      return all(
        `SELECT c.id, c.wall_id AS wallId, c.kind, CASE WHEN c.kind = 'direct' THEN (CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END) END AS peerId,
                c.created_at AS createdAt
           FROM conversations c
          WHERE (c.kind = 'group' AND c.wall_id IN (SELECT wall_id FROM memberships WHERE user_id = ?))
             OR (c.kind = 'direct' AND (c.user_a = ? OR c.user_b = ?))
          ORDER BY c.created_at, c.id`,
        userId,
        userId,
        userId,
        userId,
      );
    },
    /** 一个会话的消息；`onlySender` 给出时只取这个人发的。 */
    messages(conversationId: string, onlySender: string | null): ExportMessageRow[] {
      const select = `SELECT m.sequence, m.sender_id AS senderId, COALESCE(u.nickname, '成员') AS senderName, m.body AS text, m.created_at AS createdAt
           FROM chat_messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ?`;
      return onlySender
        ? all(`${select} AND m.sender_id = ? ORDER BY m.sequence`, conversationId, onlySender)
        : all(`${select} ORDER BY m.sequence`, conversationId);
    },
    creditEntries(userId: string): ExportCreditRow[] {
      return all(
        `SELECT delta, balance_after AS balanceAfter, reason, created_at AS createdAt
           FROM credit_entries WHERE account_kind = 'user' AND account_id = ? ORDER BY created_at, rowid`,
        userId,
      );
    },
    icebreakers(userId: string): ExportIcebreakerRow[] {
      return all('SELECT wall_id AS wallId, page_id AS pageId, result_json AS resultJson, created_at AS createdAt FROM icebreakers WHERE viewer_id = ? ORDER BY created_at', userId);
    },

    /** 他提交过的举报（自己写的原因与说明；不含处理结果与对方信息）。 */
    reportsFiled(userId: string): ExportReportRow[] {
      return all('SELECT target_kind AS targetKind, wall_id AS wallId, reason, note, created_at AS createdAt FROM reports WHERE reporter_id = ? ORDER BY created_at', userId);
    },

    // ----- 注销 -----
    /** 针对他的待处理举报（注销时转存证据）：页面举报带被举报那一版的版本 ID 与缩略卡。 */
    openReportsAgainst(userId: string): { id: string; kind: 'page' | 'conversation'; conversationId: string | null; lastSequence: number | null; revisionId: string | null; cardJson: string | null }[] {
      return all(
        `SELECT r.id, r.target_kind AS kind, r.conversation_id AS conversationId, r.last_sequence AS lastSequence,
                p.revision_id AS revisionId, p.card_json AS cardJson
           FROM reports r LEFT JOIN publications p ON p.id = r.publication_id
          WHERE r.reported_user_id = ? AND r.status = 'open'
          ORDER BY r.created_at`,
        userId,
      );
    },
    /** 某段会话里他发的消息（到 `untilSequence` 为止，最近的 `limit` 条，按时间顺序）。 */
    sentMessagesUntil(conversationId: string, userId: string, untilSequence: number, limit: number): { sequence: number; at: string; text: string }[] {
      return all<{ sequence: number; at: string; text: string }>(
        `SELECT sequence, created_at AS at, body AS text FROM chat_messages
          WHERE conversation_id = ? AND sender_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT ?`,
        conversationId,
        userId,
        untilSequence,
        limit,
      ).reverse();
    },
    insertEvidence(input: { reportId: string; kind: 'page' | 'conversation'; cardJson: string | null; renderedText: string | null; screenshot: Uint8Array | null; messagesJson: string | null; createdAt: string; expiresAt: string }): void {
      db.prepare(
        `INSERT INTO deletion_evidence (report_id, kind, card_json, rendered_text, screenshot, messages_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (report_id) DO NOTHING`,
      ).run(input.reportId, input.kind, input.cardJson, input.renderedText, input.screenshot, input.messagesJson, input.createdAt, input.expiresAt);
    },
    /** 已注销用户名下、通过校验的版本 ID 与页面 ID（启动时清理残留文件）。 */
    deletedAccountFiles(): { revisionIds: string[]; pageIds: string[] } {
      const pages = all<{ id: string }>('SELECT p.id FROM pages p JOIN users u ON u.id = p.owner_id WHERE u.deleted_at IS NOT NULL');
      const revisions = all<{ id: string }>(
        "SELECT r.id FROM revisions r JOIN pages p ON p.id = r.page_id JOIN users u ON u.id = p.owner_id WHERE u.deleted_at IS NOT NULL AND r.status = 'accepted'",
      );
      return { revisionIds: revisions.map((row) => row.id), pageIds: pages.map((row) => row.id) };
    },
    /** 他是组织者、仍开放的墙（注销前必须先关闭）。 */
    openOrganizedWalls(userId: string): { id: string; name: string }[] {
      return all("SELECT id, name FROM walls WHERE organizer_id = ? AND status = 'open' ORDER BY created_at", userId);
    },
    /** 他名下还在排队 / 运行的生成任务。 */
    activeJobIds(userId: string): string[] {
      return all<{ id: string }>("SELECT id FROM generation_jobs WHERE owner_id = ? AND status IN ('queued', 'running')", userId).map((row) => row.id);
    },
    /** 结束全部有效成员关系（状态 left，与退出墙相同），返回被结束的成员关系 ID。 */
    endActiveMemberships(userId: string, nowIso: string): string[] {
      return (db.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE user_id = ? AND status = 'active' RETURNING id").all(nowIso, userId) as { id: string }[]).map(
        (row) => row.id,
      );
    },
    replaceSentMessages(userId: string, text: string): number {
      return Number(db.prepare('UPDATE chat_messages SET body = ? WHERE sender_id = ?').run(text, userId).changes);
    },
    deleteChatReads(userId: string): void {
      db.prepare('DELETE FROM chat_reads WHERE user_id = ?').run(userId);
    },
    deleteIcebreakersOfViewer(userId: string): void {
      db.prepare('DELETE FROM icebreakers WHERE viewer_id = ?').run(userId);
    },
    deleteIntrosOfViewer(userId: string): void {
      db.prepare('DELETE FROM intros WHERE viewer_id = ?').run(userId);
    },
    deleteAsksOfViewer(userId: string): void {
      db.prepare('DELETE FROM wall_asks WHERE viewer_id = ?').run(userId);
    },
    /** 他组织过的墙（此时都已关闭）上传的封面。 */
    deleteOrganizedWallCovers(userId: string): void {
      db.prepare('DELETE FROM wall_covers WHERE wall_id IN (SELECT id FROM walls WHERE organizer_id = ?)').run(userId);
    },
    /** 拉黑关系（他拉黑别人、别人拉黑他）全部删除。 */
    deleteBlocks(userId: string): void {
      db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?').run(userId, userId);
    },
    /** 他提交过的举报留给平台处理，但删去他写的补充说明（与身份脱钩：举报人只剩墓碑账号 ID）。 */
    eraseReportNotes(userId: string): void {
      db.prepare('UPDATE reports SET note = NULL WHERE reporter_id = ?').run(userId);
    },
    /** 用户行改为墓碑：不留邮箱、昵称、头像、协议同意记录。 */
    tombstoneUser(userId: string, nickname: string, nowIso: string): boolean {
      return (
        Number(
          db
            .prepare(
              `UPDATE users SET email = 'deleted:' || id, nickname = ?, avatar_webp = NULL, avatar_version = NULL,
                      terms_version = NULL, terms_accepted_at = NULL, deleted_at = ?
                WHERE id = ? AND deleted_at IS NULL`,
            )
            .run(nickname, nowIso, userId).changes,
        ) === 1
      );
    },
  };
}
