/**
 * `publications` 表（contracts 3）：不可变快照；每页至多一个 `ended_at IS NULL`。
 *
 * T2.1 只读（推导页面展示状态）。T3.2 在这里补充：发布（旧的 `superseded`）、撤下（`withdrawn`）、
 * 删除（`deleted`）；T3.1 补充移除成员（`removed`）、关闭墙（`closed`）。
 */
import type { Database } from './database.js';

export type PublicationEndReason = 'superseded' | 'withdrawn' | 'removed' | 'closed' | 'deleted';

export interface Publication {
  id: string;
  pageId: string;
  revisionId: string;
  cardJson: string;
  contactJson: string | null;
  publishedAt: string;
  endedAt: string | null;
  endReason: PublicationEndReason | null;
}

/** 页面的展示状态（contracts 3：由数据推导）。 */
export type PageDisplayState = 'published' | 'withdrawn' | 'unpublished';

interface PublicationRow {
  id: string;
  page_id: string;
  revision_id: string;
  card_json: string;
  contact_json: string | null;
  published_at: string;
  ended_at: string | null;
  end_reason: PublicationEndReason | null;
}

function toPublication(row: PublicationRow | undefined): Publication | null {
  if (!row) return null;
  return {
    id: row.id,
    pageId: row.page_id,
    revisionId: row.revision_id,
    cardJson: row.card_json,
    contactJson: row.contact_json,
    publishedAt: row.published_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

export function createPublicationsRepo(db: Database) {
  const active = db.prepare('SELECT * FROM publications WHERE page_id = ? AND ended_at IS NULL');
  const anyForPage = db.prepare('SELECT 1 AS x FROM publications WHERE page_id = ? LIMIT 1');

  return {
    findActiveForPage(pageId: string): Publication | null {
      return toPublication(active.get(pageId) as PublicationRow | undefined);
    },
    /** 有活跃发布 → published；有发布历史但当前无 → withdrawn；否则 unpublished。 */
    displayState(pageId: string): PageDisplayState {
      if (active.get(pageId)) return 'published';
      return anyForPage.get(pageId) ? 'withdrawn' : 'unpublished';
    },
  };
}

export type PublicationsRepo = ReturnType<typeof createPublicationsRepo>;
