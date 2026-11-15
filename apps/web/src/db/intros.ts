/**
 * `intros` / `intro_picks` 表（contracts 20）：AI 介绍给查看者的人。所有读取都带 `viewer_id`——结果只属于查看者本人。
 * 是否仍可展示（对方的发布没变、双方没有拉黑、查看者仍是有效成员）由 services/intro.ts 在读取时检查。
 */
import type { Database } from './database.js';

export type IntroKind = 'learn' | 'interest' | 'collab';

export interface IntroPickRecord {
  pageId: string;
  publicationId: string;
  kind: IntroKind;
  title: string;
  reason: string;
  mine: string;
  theirs: string;
}

export interface IntroRecord {
  id: string;
  wallId: string;
  viewerId: string;
  sources: { page: boolean; brief: boolean };
  /** 当时交给模型的候选页面。 */
  seen: string[];
  createdAt: string;
  picks: IntroPickRecord[];
}

function parseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function createIntrosRepo(db: Database) {
  const insert = db.prepare('INSERT INTO intros (id, wall_id, viewer_id, sources_json, seen_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertPick = db.prepare(
    'INSERT INTO intro_picks (intro_id, position, page_id, publication_id, kind, title, reason, mine, theirs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const byViewerWall = db.prepare('SELECT * FROM intros WHERE viewer_id = ? AND wall_id = ?');
  const wallsOfViewer = db.prepare('SELECT wall_id FROM intros WHERE viewer_id = ? ORDER BY created_at');
  const picksOf = db.prepare('SELECT * FROM intro_picks WHERE intro_id = ? ORDER BY position');
  const deleteForViewerWall = db.prepare('DELETE FROM intros WHERE viewer_id = ? AND wall_id = ?');
  const deleteForViewer = db.prepare('DELETE FROM intros WHERE viewer_id = ?');
  const deleteForWall = db.prepare('DELETE FROM intros WHERE wall_id = ?');
  // 某一页被删除：引用了那一页文字的整份介绍都删掉（其余几位的理由是和这份一起生成的，不单独留）
  const deleteForPage = db.prepare('DELETE FROM intros WHERE id IN (SELECT intro_id FROM intro_picks WHERE page_id = ?)');
  const countViewerSince = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'intro_generate' AND actor_id = ? AND created_at > ?");
  const countViewerWallSince = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'intro_generate' AND actor_id = ? AND wall_id = ? AND created_at > ?");
  const anyViewerWall = db.prepare("SELECT 1 AS n FROM events WHERE type = 'intro_generate' AND actor_id = ? AND wall_id = ? LIMIT 1");

  return {
    /** 保存一次成功的结果，替换查看者在这面墙的旧结果。调用方放在事务里。 */
    replace(record: IntroRecord): void {
      deleteForViewerWall.run(record.viewerId, record.wallId);
      insert.run(record.id, record.wallId, record.viewerId, JSON.stringify(record.sources), JSON.stringify(record.seen), record.createdAt);
      record.picks.forEach((pick, position) => {
        insertPick.run(record.id, position, pick.pageId, pick.publicationId, pick.kind, pick.title, pick.reason, pick.mine, pick.theirs);
      });
    },
    /** 查看者在某面墙的结果。 */
    findForViewerWall(viewerId: string, wallId: string): IntroRecord | null {
      const row = byViewerWall.get(viewerId, wallId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const picks = (picksOf.all(row.id as string) as Record<string, unknown>[]).map((pick) => ({
        pageId: pick.page_id as string,
        publicationId: pick.publication_id as string,
        kind: pick.kind as IntroKind,
        title: pick.title as string,
        reason: pick.reason as string,
        mine: pick.mine as string,
        theirs: pick.theirs as string,
      }));
      const sources = parseJson<Partial<IntroRecord['sources']>>(row.sources_json as string, {});
      const seen = parseJson<unknown>(row.seen_json as string, []);
      return {
        id: row.id as string,
        wallId: row.wall_id as string,
        viewerId: row.viewer_id as string,
        sources: { page: sources.page === true, brief: sources.brief === true },
        seen: Array.isArray(seen) ? seen.filter((item): item is string => typeof item === 'string') : [],
        createdAt: row.created_at as string,
        picks,
      };
    },
    /** 查看者有结果的墙（数据导出用）。 */
    wallsForViewer(viewerId: string): string[] {
      return (wallsOfViewer.all(viewerId) as { wall_id: string }[]).map((row) => row.wall_id);
    },
    /** 查看者清除自己在某面墙的结果；退出 / 被移出墙、删除自己的页面或采访时也用它。 */
    deleteForViewerWall(viewerId: string, wallId: string): number {
      return Number(deleteForViewerWall.run(viewerId, wallId).changes);
    },
    /** 查看者的全部结果（注销账号时）。 */
    deleteForViewer(viewerId: string): number {
      return Number(deleteForViewer.run(viewerId).changes);
    },
    /** 引用了某一页的全部结果（页面被删除时）。 */
    deleteForPage(pageId: string): number {
      return Number(deleteForPage.run(pageId).changes);
    },
    /** 某面墙的全部结果（墙关闭时）。 */
    deleteForWall(wallId: string): number {
      return Number(deleteForWall.run(wallId).changes);
    },
    /** 查看者在 `sinceIso` 之后发起的次数（跨墙，含失败）。 */
    countAttemptsSince(viewerId: string, sinceIso: string): number {
      return Number((countViewerSince.get(viewerId, sinceIso) as { n: number }).n);
    },
    /** 查看者在 `sinceIso` 之后在某面墙发起的次数（含失败）。 */
    countAttemptsForWallSince(viewerId: string, wallId: string, sinceIso: string): number {
      return Number((countViewerWallSince.get(viewerId, wallId, sinceIso) as { n: number }).n);
    },
    /** 查看者在这面墙发起过没有（任何时候、成功或失败）：没有时墙上自动发起第一次。 */
    hasAttempted(viewerId: string, wallId: string): boolean {
      return anyViewerWall.get(viewerId, wallId) !== undefined;
    },
  };
}
