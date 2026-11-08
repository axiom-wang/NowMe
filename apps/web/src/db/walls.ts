/**
 * `walls` 表（contracts 3）：建墙、按 ID / 邀请码查询、关闭墙。
 * 关闭的墙对所有人不可见（services/access.ts 只认 status = open 的墙）。
 */
import type { SceneType } from '@nowme/contracts';
import type { Database } from './database.js';

export type WallStatus = 'open' | 'closed';

export interface Wall {
  id: string;
  name: string;
  description: string;
  sceneType: SceneType;
  organizerNote: string | null;
  organizerId: string;
  /** `inv_...`，明文保存，可轮换。 */
  inviteCode: string;
  status: WallStatus;
  createdAt: string;
  closedAt: string | null;
}

export interface WallRow {
  id: string;
  name: string;
  description: string;
  scene_type: SceneType;
  organizer_note: string | null;
  organizer_id: string;
  invite_code: string;
  status: WallStatus;
  created_at: string;
  closed_at: string | null;
}

export function toWall(row: WallRow): Wall {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sceneType: row.scene_type,
    organizerNote: row.organizer_note,
    organizerId: row.organizer_id,
    inviteCode: row.invite_code,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

function maybeWall(row: unknown): Wall | null {
  return row ? toWall(row as WallRow) : null;
}

export function createWallsRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO walls (id, name, description, scene_type, organizer_note, organizer_id, invite_code, status, created_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM walls WHERE id = ?');
  const byInvite = db.prepare('SELECT * FROM walls WHERE invite_code = ?');
  const byOrganizerName = db.prepare(
    "SELECT * FROM walls WHERE organizer_id = ? AND name = ? AND status = 'open' ORDER BY created_at LIMIT 1",
  );
  const close = db.prepare("UPDATE walls SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'");
  const coverVersion = db.prepare('SELECT version FROM wall_covers WHERE wall_id = ?');
  const cover = db.prepare('SELECT image FROM wall_covers WHERE wall_id = ?');
  const saveCover = db.prepare('INSERT INTO wall_covers (wall_id, version, image, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(wall_id) DO UPDATE SET version = excluded.version, image = excluded.image, updated_at = excluded.updated_at');
  const deleteCover = db.prepare('DELETE FROM wall_covers WHERE wall_id = ?');

  return {
    coverUrl(wallId: string): string | null {
      const row = coverVersion.get(wallId) as { version: string } | undefined;
      return row ? `/w/${wallId}/cover?v=${row.version}` : null;
    },
    findCover(wallId: string): Uint8Array | null {
      const row = cover.get(wallId) as { image: Uint8Array } | undefined;
      return row?.image ?? null;
    },
    saveCover(wallId: string, version: string, image: Uint8Array, now: string): void {
      saveCover.run(wallId, version, image, now);
    },
    deleteCover(wallId: string): void {
      deleteCover.run(wallId);
    },
    create(wall: Wall): Wall {
      insert.run(
        wall.id,
        wall.name,
        wall.description,
        wall.sceneType,
        wall.organizerNote,
        wall.organizerId,
        wall.inviteCode,
        wall.status,
        wall.createdAt,
        wall.closedAt,
      );
      return wall;
    },
    findById(id: string): Wall | null {
      return maybeWall(byId.get(id));
    },
    findByInviteCode(inviteCode: string): Wall | null {
      return maybeWall(byInvite.get(inviteCode));
    },
    /** 某组织者名下同名的、未关闭的墙（开发种子脚本复用已有的墙）。 */
    findOpenByOrganizerAndName(organizerId: string, name: string): Wall | null {
      return maybeWall(byOrganizerName.get(organizerId, name));
    },
    /** 关闭墙（只对 open 的墙生效）。返回是否改变了状态。 */
    close(id: string, now: string): boolean {
      return Number(close.run(now, id).changes) > 0;
    },
  };
}

export type WallsRepo = ReturnType<typeof createWallsRepo>;
