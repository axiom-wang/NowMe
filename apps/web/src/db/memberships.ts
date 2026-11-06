/**
 * `memberships` 表（contracts 3）。(wall_id, user_id) 唯一。
 * T3.1 在这里补充退出、移除、重新加入、成员列表等函数。
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

export function createMembershipsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO memberships (id, wall_id, user_id, role, status, joined_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const byId = db.prepare('SELECT * FROM memberships WHERE id = ?');
  const byWallUser = db.prepare('SELECT * FROM memberships WHERE wall_id = ? AND user_id = ?');
  const activeForUser = db.prepare(
    `SELECT m.id AS m_id, m.wall_id AS m_wall_id, m.user_id AS m_user_id, m.role AS m_role, m.status AS m_status,
            m.joined_at AS m_joined_at, m.ended_at AS m_ended_at, p.id AS page_id, w.*
       FROM memberships m
       JOIN walls w ON w.id = m.wall_id
       LEFT JOIN pages p ON p.membership_id = m.id
      WHERE m.user_id = ? AND m.status = 'active' AND w.status = 'open'
      ORDER BY m.joined_at DESC`,
  );

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
      return (activeForUser.all(userId) as Record<string, unknown>[]).map((row) => ({
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
      }));
    },
  };
}

export type MembershipsRepo = ReturnType<typeof createMembershipsRepo>;
