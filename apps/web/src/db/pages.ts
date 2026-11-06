/**
 * `pages` 表（contracts 3）：加入墙时创建，一个成员关系一页。
 * T3.2 在这里补充联系方式、公开链接令牌等函数。
 */
import { toBool, type Database } from './database.js';

export interface Page {
  id: string;
  membershipId: string;
  wallId: string;
  ownerId: string;
  contactChannel: string | null;
  contactValue: string | null;
  contactPublic: boolean;
  /** `pub_...`；null 表示未开启公开链接。 */
  publicToken: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PageRow {
  id: string;
  membership_id: string;
  wall_id: string;
  owner_id: string;
  contact_channel: string | null;
  contact_value: string | null;
  contact_public: number;
  public_token: string | null;
  created_at: string;
  updated_at: string;
}

function toPage(row: PageRow | undefined): Page | null {
  if (!row) return null;
  return {
    id: row.id,
    membershipId: row.membership_id,
    wallId: row.wall_id,
    ownerId: row.owner_id,
    contactChannel: row.contact_channel,
    contactValue: row.contact_value,
    contactPublic: toBool(row.contact_public),
    publicToken: row.public_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPagesRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO pages (id, membership_id, wall_id, owner_id, contact_channel, contact_value, contact_public, public_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM pages WHERE id = ?');
  const byMembership = db.prepare('SELECT * FROM pages WHERE membership_id = ?');
  const touch = db.prepare('UPDATE pages SET updated_at = ? WHERE id = ?');

  return {
    create(page: Page): Page {
      insert.run(
        page.id,
        page.membershipId,
        page.wallId,
        page.ownerId,
        page.contactChannel,
        page.contactValue,
        page.contactPublic ? 1 : 0,
        page.publicToken,
        page.createdAt,
        page.updatedAt,
      );
      return page;
    },
    findById(id: string): Page | null {
      return toPage(byId.get(id) as PageRow | undefined);
    },
    findByMembership(membershipId: string): Page | null {
      return toPage(byMembership.get(membershipId) as PageRow | undefined);
    },
    touch(id: string, now: string): void {
      touch.run(now, id);
    },
  };
}

export type PagesRepo = ReturnType<typeof createPagesRepo>;
