/**
 * 墙级的跨表查询与连锁操作（T3.1）：墙上的已发布卡片、组织者后台的成员列表、移除 / 关闭墙时结束发布。
 *
 * 放在这里而不是 pages.ts / publications.ts，是因为 M3 按文件分工（那两个文件归 T3.2）。
 * 用 `wallQueries(db)` 取得（每个数据库连接缓存一份预编译语句）。
 *
 * 墙上可见的发布（contracts 3、4.2、S6）必须同时满足：
 * - 页面属于这面墙，publication 活跃（`ended_at IS NULL`）；
 * - 页面主人的成员关系有效（`status = active`），且成员关系与页面的墙、主人一致。
 * 墙是否开启、查看者是不是有效成员由 services/access.ts 检查。
 */
import type { Database } from './database.js';
import type { MembershipRole } from './memberships.js';
import type { PageDisplayState, PublicationEndReason } from './publications.js';

/** 一条墙上可见的发布（card / contact 是发布时的快照 JSON，由 services/wall-view.ts 解析）。 */
export interface PublishedEntry {
  pageId: string;
  ownerId: string;
  membershipId: string;
  publicationId: string;
  revisionId: string;
  cardJson: string;
  contactJson: string | null;
  publishedAt: string;
}

/** 组织者后台的一行：只有昵称、头像、角色、加入时间、发布状态（S5）。 */
export interface AdminMemberRow {
  avatarUrl?: string | null;
  membershipId: string;
  nickname: string;
  role: MembershipRole;
  joinedAt: string;
  state: PageDisplayState;
}

interface PublishedRow {
  page_id: string;
  owner_id: string;
  membership_id: string;
  publication_id: string;
  revision_id: string;
  card_json: string;
  contact_json: string | null;
  published_at: string;
}

function toPublishedEntry(row: PublishedRow): PublishedEntry {
  return {
    pageId: row.page_id,
    ownerId: row.owner_id,
    membershipId: row.membership_id,
    publicationId: row.publication_id,
    revisionId: row.revision_id,
    cardJson: row.card_json,
    contactJson: row.contact_json,
    publishedAt: row.published_at,
  };
}

const PUBLISHED_SELECT = `SELECT p.id AS page_id, p.owner_id, m.id AS membership_id, pb.id AS publication_id,
            pb.revision_id, pb.card_json, pb.contact_json, pb.published_at
       FROM publications pb
       JOIN pages p ON p.id = pb.page_id
       JOIN memberships m ON m.id = p.membership_id
      WHERE p.wall_id = ?
        AND pb.ended_at IS NULL
        AND m.status = 'active'
        AND m.wall_id = p.wall_id
        AND m.user_id = p.owner_id`;

function createWallQueries(db: Database) {
  const listPublished = db.prepare(`${PUBLISHED_SELECT} ORDER BY pb.published_at, pb.rowid`);
  const findPublished = db.prepare(`${PUBLISHED_SELECT} AND p.id = ?`);
  const countPublished = db.prepare(`SELECT COUNT(*) AS n FROM (${PUBLISHED_SELECT})`);
  const adminMembers = db.prepare(
    `SELECT CASE WHEN u.avatar_version IS NOT NULL THEN '/w/' || m.wall_id || '/members/' || u.id || '/avatar?v=' || u.avatar_version END AS avatar_url, m.id AS membership_id, u.nickname, m.role, m.joined_at,
            EXISTS (SELECT 1 FROM publications pb WHERE pb.page_id = p.id AND pb.ended_at IS NULL) AS has_active,
            EXISTS (SELECT 1 FROM publications pb WHERE pb.page_id = p.id) AS has_any
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN pages p ON p.membership_id = m.id
      WHERE m.wall_id = ? AND m.status = 'active'
      ORDER BY (m.role = 'organizer') DESC, m.joined_at, m.rowid`,
  );
  const pageIdsForWall = db.prepare('SELECT id FROM pages WHERE wall_id = ? ORDER BY rowid');
  const endForPage = db.prepare('UPDATE publications SET ended_at = ?, end_reason = ? WHERE page_id = ? AND ended_at IS NULL');
  const endForWall = db.prepare(
    'UPDATE publications SET ended_at = ?, end_reason = ? WHERE ended_at IS NULL AND page_id IN (SELECT id FROM pages WHERE wall_id = ?)',
  );

  return {
    /** 墙上可见的全部发布（按发布时间；墙上的展示顺序由调用方随机打乱）。 */
    listPublished(wallId: string): PublishedEntry[] {
      return (listPublished.all(wallId) as unknown as PublishedRow[]).map(toPublishedEntry);
    },
    /** 墙上可见的某一页的发布；不可见时为 null。 */
    findPublished(wallId: string, pageId: string): PublishedEntry | null {
      const row = findPublished.get(wallId, pageId) as PublishedRow | undefined;
      return row ? toPublishedEntry(row) : null;
    },
    /** 墙上可见的发布数（已发布的有效成员数）。 */
    countPublished(wallId: string): number {
      return Number((countPublished.get(wallId) as { n: number }).n);
    },
    /** 组织者后台：有效成员的昵称、角色、加入时间、发布状态（组织者在最前）。 */
    listMembersForAdmin(wallId: string): AdminMemberRow[] {
      return (adminMembers.all(wallId) as Record<string, unknown>[]).map((row) => ({
        ...(row.avatar_url ? { avatarUrl: row.avatar_url as string } : {}),
        membershipId: row.membership_id as string,
        nickname: (row.nickname as string | null) ?? '',
        role: row.role as MembershipRole,
        joinedAt: row.joined_at as string,
        state: Number(row.has_active) ? 'published' : Number(row.has_any) ? 'withdrawn' : 'unpublished',
      }));
    },
    /** 这面墙全部页面的 ID（关闭墙时逐页吊销凭证）。 */
    pageIdsForWall(wallId: string): string[] {
      return (pageIdsForWall.all(wallId) as { id: string }[]).map((row) => row.id);
    },
    /** 结束某页的活跃发布（移除成员：`removed`）。返回结束的条数（0 或 1）。 */
    endActivePublication(pageId: string, reason: PublicationEndReason, now: string): number {
      return Number(endForPage.run(now, reason, pageId).changes);
    },
    /** 结束这面墙全部活跃发布（关闭墙：`closed`）。返回结束的条数。 */
    endActivePublicationsForWall(wallId: string, reason: PublicationEndReason, now: string): number {
      return Number(endForWall.run(now, reason, wallId).changes);
    },
  };
}

export type WallQueries = ReturnType<typeof createWallQueries>;

const cache = new WeakMap<Database, WallQueries>();

/** 这个数据库连接的墙级查询（预编译语句按连接缓存）。 */
export function wallQueries(db: Database): WallQueries {
  let queries = cache.get(db);
  if (!queries) {
    queries = createWallQueries(db);
    cache.set(db, queries);
  }
  return queries;
}
