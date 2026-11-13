/**
 * `icebreakers` 表（contracts 11）：“和 TA 聊什么”的结果。所有读取都带 `viewer_id`——结果只属于发起的查看者本人。
 * 是否仍可展示（墙未关闭、双方仍是有效成员、对方的发布没有变）由 services/icebreaker.ts 在读取时检查。
 */
import type { Database } from './database.js';

export interface IcebreakerRecord {
  id: string;
  wallId: string;
  viewerId: string;
  pageId: string;
  publicationId: string;
  resultJson: string;
  createdAt: string;
}

function toRecord(row: Record<string, unknown>): IcebreakerRecord {
  return {
    id: row.id as string,
    wallId: row.wall_id as string,
    viewerId: row.viewer_id as string,
    pageId: row.page_id as string,
    publicationId: row.publication_id as string,
    resultJson: row.result_json as string,
    createdAt: row.created_at as string,
  };
}

export function createIcebreakersRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO icebreakers (id, wall_id, viewer_id, page_id, publication_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const latest = db.prepare('SELECT * FROM icebreakers WHERE viewer_id = ? AND page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1');
  const byId = db.prepare('SELECT * FROM icebreakers WHERE id = ? AND viewer_id = ?');
  const deleteForViewerPage = db.prepare('DELETE FROM icebreakers WHERE viewer_id = ? AND page_id = ?');
  const deleteForViewerWall = db.prepare('DELETE FROM icebreakers WHERE viewer_id = ? AND wall_id = ?');
  const deleteForPage = db.prepare('DELETE FROM icebreakers WHERE page_id = ?');
  const deleteForWall = db.prepare('DELETE FROM icebreakers WHERE wall_id = ?');
  const countViewerSince = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'icebreaker_generate' AND actor_id = ? AND created_at > ?");
  const countViewerPageSince = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'icebreaker_generate' AND actor_id = ? AND page_id = ? AND created_at > ?",
  );

  return {
    /** 保存一次成功的结果，并删掉同一查看者对同一页的旧结果（只留最新一份）。调用方放在事务里。 */
    replace(record: IcebreakerRecord): void {
      deleteForViewerPage.run(record.viewerId, record.pageId);
      insert.run(record.id, record.wallId, record.viewerId, record.pageId, record.publicationId, record.resultJson, record.createdAt);
    },
    /** 查看者对某一页的最新结果。 */
    findLatest(viewerId: string, pageId: string): IcebreakerRecord | null {
      const row = latest.get(viewerId, pageId) as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },
    /** 按 ID 取，必须是查看者本人的。 */
    findById(id: string, viewerId: string): IcebreakerRecord | null {
      const row = byId.get(id, viewerId) as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },
    /** 查看者清除自己对某一页的结果。 */
    deleteForViewerPage(viewerId: string, pageId: string): number {
      return Number(deleteForViewerPage.run(viewerId, pageId).changes);
    },
    /** 查看者在某面墙的全部结果（退出 / 被移出墙、删除或重做自己的采访时）。 */
    deleteForViewerWall(viewerId: string, wallId: string): number {
      return Number(deleteForViewerWall.run(viewerId, wallId).changes);
    },
    /** 关于某一页的全部结果（页面被删除时：其中引用了页面上的文字）。 */
    deleteForPage(pageId: string): number {
      return Number(deleteForPage.run(pageId).changes);
    },
    /** 某面墙的全部结果（墙关闭时）。 */
    deleteForWall(wallId: string): number {
      return Number(deleteForWall.run(wallId).changes);
    },
    /** 查看者在 `sinceIso` 之后发起的次数（含失败）。 */
    countAttemptsSince(viewerId: string, sinceIso: string): number {
      return Number((countViewerSince.get(viewerId, sinceIso) as { n: number }).n);
    },
    /** 查看者在 `sinceIso` 之后对某一页发起的次数（含失败）。 */
    countAttemptsForPageSince(viewerId: string, pageId: string, sinceIso: string): number {
      return Number((countViewerPageSince.get(viewerId, pageId, sinceIso) as { n: number }).n);
    },
  };
}
