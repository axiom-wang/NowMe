/**
 * `memberships` 表（contracts 3）。(wall_id, user_id) 唯一。
 *
 * 状态变化（build-plan 决策记录）：
 * - 退出：active → left（`markLeft`）；之后可以用邀请重新加入，重新激活同一行（`reactivate`，left → active）；
 * - 移除：active → removed（`markRemoved`，只对 role = member）；被移除的不能再加入；
 * - 组织者不能退出、不能被移除。
 */
import type { Database } from './database.js';
import { toWall, type Wall, type WallRow } from './walls.js';

export type MembershipRole = 'organizer' | 'member';
export type MembershipStatus = 'active' | 'left' | 'removed';

export interface Membership {
  id: string;
  wallId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: string;
  endedAt: string | null;
}

interface MembershipRow {
  id: string;
  wall_id: string;
  user_id: string;
  role: MembershipRole;
  status: MembershipStatus;
  joined_at: string;
  ended_at: string | null;
}

function toMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    wallId: row.wall_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at,
    endedAt: row.ended_at,
  };
}

export interface MembershipWithWall {
  membership: Membership;
  wall: Wall;
  pageId: string | null;
}

const JOINED_SELECT = `SELECT m.id AS m_id, m.wall_id AS m_wall_id, m.user_id AS m_user_id, m.role AS m_role, m.status AS m_status,
            m.joined_at AS m_joined_at, m.ended_at AS m_ended_at, p.id AS page_id, w.*
       FROM memberships m
       JOIN walls w ON w.id = m.wall_id
       LEFT JOIN pages p ON p.membership_id = m.id`;

function toMembershipWithWall(row: Record<string, unknown>): MembershipWithWall {
  return {
    membership: toMembership({
      id: row.m_id as string,
      wall_id: row.m_wall_id as string,
      user_id: row.m_user_id as string,
      role: row.m_role as MembershipRole,
      status: row.m_status as MembershipStatus,
      joined_at: row.m_joined_at as string,
      ended_at: row.m_ended_at as string | null,
    }),
    wall: toWall(row as unknown as WallRow),
    pageId: (row.page_id as string | null) ?? null,
  };
}

export function createMembershipsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO memberships (id, wall_id, user_id, role, status, joined_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const byId = db.prepare('SELECT * FROM memberships WHERE id = ?');
  const byWallUser = db.prepare('SELECT * FROM memberships WHERE wall_id = ? AND user_id = ?');
  const activeForUser = db.prepare(
    `${JOINED_SELECT}
      WHERE m.user_id = ? AND m.status = 'active' AND w.status = 'open'
      ORDER BY m.joined_at DESC, m.rowid DESC`,
  );
  const allForUser = db.prepare(`${JOINED_SELECT} WHERE m.user_id = ? ORDER BY m.joined_at DESC, m.rowid DESC`);
  const markLeft = db.prepare(
    "UPDATE memberships SET status = 'left', ended_at = ? WHERE id = ? AND status = 'active' AND role = 'member'",
  );
  const markRemoved = db.prepare(
    "UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ? AND status = 'active' AND role = 'member'",
  );
  const reactivate = db.prepare(
    "UPDATE memberships SET status = 'active', ended_at = NULL, joined_at = ? WHERE id = ? AND status = 'left'",
  );
  const countActive = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE wall_id = ? AND status = 'active'");
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE wall_id = ?');

  return {
    create(membership: Membership): Membership {
      insert.run(
        membership.id,
        membership.wallId,
        membership.userId,
        membership.role,
        membership.status,
        membership.joinedAt,
        membership.endedAt,
      );
      return membership;
    },
    findById(id: string): Membership | null {
      const row = byId.get(id) as MembershipRow | undefined;
      return row ? toMembership(row) : null;
    },
    findByWallAndUser(wallId: string, userId: string): Membership | null {
      const row = byWallUser.get(wallId, userId) as MembershipRow | undefined;
      return row ? toMembership(row) : null;
    },
    /** 用户当前有效的成员关系（墙未关闭），附带墙与页面 ID，按加入时间倒序。 */
    listActiveForUser(userId: string): MembershipWithWall[] {
      return (activeForUser.all(userId) as Record<string, unknown>[]).map(toMembershipWithWall);
    },
    /** 用户的全部成员关系（含已退出、已移除、墙已关闭），附带墙与页面 ID，按加入时间倒序（“我的”）。 */
    listAllForUser(userId: string): MembershipWithWall[] {
      return (allForUser.all(userId) as Record<string, unknown>[]).map(toMembershipWithWall);
    },
    /** 退出墙：active → left（组织者不能退出）。返回是否改变了状态。 */
    markLeft(id: string, now: string): boolean {
      return Number(markLeft.run(now, id).changes) > 0;
    },
    /** 移除成员：active → removed（只对 role = member）。返回是否改变了状态。 */
    markRemoved(id: string, now: string): boolean {
      return Number(markRemoved.run(now, id).changes) > 0;
    },
    /** 退出后重新加入：left → active，加入时间更新为 `now`。removed 不能重新激活。返回是否改变了状态。 */
    reactivate(id: string, now: string): boolean {
      return Number(reactivate.run(now, id).changes) > 0;
    },
    /** 墙内有效成员数（含组织者）。 */
    countActiveForWall(wallId: string): number {
      return Number((countActive.get(wallId) as { n: number }).n);
    },
    /** 加入过这面墙的人数（含已退出、已移除）。 */
    countAllForWall(wallId: string): number {
      return Number((countAll.get(wallId) as { n: number }).n);
    },
  };
}

export type MembershipsRepo = ReturnType<typeof createMembershipsRepo>;
