/**
 * `wall_asks` / `wall_ask_matches` 表（contracts 21）：成员在墙上问的一句话，和 AI 找到的人。
 * 所有读取都带 `viewer_id`——提问与结果只属于提问的人。
 * 是否仍可展示（对方的发布没变、双方没有拉黑、查看者仍是有效成员）由 services/ask.ts 在读取时检查。
 */
import type { Database } from './database.js';

export interface AskMatchRecord {
  pageId: string;
  publicationId: string;
  reason: string;
  quote: string;
}

export interface AskRecord {
  id: string;
  wallId: string;
  viewerId: string;
  question: string;
  /** 当时交给模型的候选人数。 */
  candidates: number;
  /** 当时找到几位（0 = AI 明确回答“没找到”）。 */
  found: number;
  createdAt: string;
  matches: AskMatchRecord[];
}

export function createAsksRepo(db: Database) {
  const insert = db.prepare('INSERT INTO wall_asks (id, wall_id, viewer_id, question, candidates, found, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertMatch = db.prepare('INSERT INTO wall_ask_matches (ask_id, position, page_id, publication_id, reason, quote) VALUES (?, ?, ?, ?, ?, ?)');
  const byViewerWall = db.prepare('SELECT * FROM wall_asks WHERE viewer_id = ? AND wall_id = ?');
  const wallsOfViewer = db.prepare('SELECT wall_id FROM wall_asks WHERE viewer_id = ? ORDER BY created_at');
  const matchesOf = db.prepare('SELECT * FROM wall_ask_matches WHERE ask_id = ? ORDER BY position');
  const deleteForViewerWall = db.prepare('DELETE FROM wall_asks WHERE viewer_id = ? AND wall_id = ?');
  const deleteForViewer = db.prepare('DELETE FROM wall_asks WHERE viewer_id = ?');
  const deleteForWall = db.prepare('DELETE FROM wall_asks WHERE wall_id = ?');
  // 某一页被删除：只删引用了那一页原话的那一条（其余几位各有各的依据，互不相干）
  const deleteMatchesForPage = db.prepare('DELETE FROM wall_ask_matches WHERE page_id = ?');
  const countViewerSince = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'ask_generate' AND actor_id = ? AND created_at > ?");
  const countViewerWallSince = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'ask_generate' AND actor_id = ? AND wall_id = ? AND created_at > ?");

  return {
    /** 保存一次成功的结果（含“没找到”），替换查看者在这面墙的上一次提问。调用方放在事务里。 */
    replace(record: AskRecord): void {
      deleteForViewerWall.run(record.viewerId, record.wallId);
      insert.run(record.id, record.wallId, record.viewerId, record.question, record.candidates, record.found, record.createdAt);
      record.matches.forEach((match, position) => {
        insertMatch.run(record.id, position, match.pageId, match.publicationId, match.reason, match.quote);
      });
    },
    /** 查看者在某面墙最近一次提问。 */
    findForViewerWall(viewerId: string, wallId: string): AskRecord | null {
      const row = byViewerWall.get(viewerId, wallId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const matches = (matchesOf.all(row.id as string) as Record<string, unknown>[]).map((match) => ({
        pageId: match.page_id as string,
        publicationId: match.publication_id as string,
        reason: match.reason as string,
        quote: match.quote as string,
      }));
      return {
        id: row.id as string,
        wallId: row.wall_id as string,
        viewerId: row.viewer_id as string,
        question: row.question as string,
        candidates: Number(row.candidates),
        found: Number(row.found),
        createdAt: row.created_at as string,
        matches,
      };
    },
    /** 查看者有提问记录的墙（数据导出用）。 */
    wallsForViewer(viewerId: string): string[] {
      return (wallsOfViewer.all(viewerId) as { wall_id: string }[]).map((row) => row.wall_id);
    },
    /** 查看者清除自己在某面墙的提问；退出 / 被移出墙时也用它。 */
    deleteForViewerWall(viewerId: string, wallId: string): number {
      return Number(deleteForViewerWall.run(viewerId, wallId).changes);
    },
    /** 查看者的全部提问（注销账号时）。 */
    deleteForViewer(viewerId: string): number {
      return Number(deleteForViewer.run(viewerId).changes);
    },
    /** 引用了某一页原话的结果行（页面被删除时）。 */
    deleteMatchesForPage(pageId: string): number {
      return Number(deleteMatchesForPage.run(pageId).changes);
    },
    /** 某面墙的全部提问（墙关闭时）。 */
    deleteForWall(wallId: string): number {
      return Number(deleteForWall.run(wallId).changes);
    },
    /** 查看者在 `sinceIso` 之后问的次数（跨墙，含失败）。 */
    countAttemptsSince(viewerId: string, sinceIso: string): number {
      return Number((countViewerSince.get(viewerId, sinceIso) as { n: number }).n);
    },
    /** 查看者在 `sinceIso` 之后在某面墙问的次数（含失败）。 */
    countAttemptsForWallSince(viewerId: string, wallId: string, sinceIso: string): number {
      return Number((countViewerWallSince.get(viewerId, wallId, sinceIso) as { n: number }).n);
    },
  };
}
