/**
 * `pages` 表（contracts 3）：加入墙时创建，一个成员关系一页。
 *
 * - 联系方式（`contact_*`）：主人每次发布时确认，保存“上次的选择”（不公开时也保存，只给主人自己预填）；
 *   墙上可见的是发布时的快照 `publications.contact_json`，不是这里的值。
 * - 公开链接令牌 `public_token`（`pub_...`，明文，可轮换）：null 表示未开启；关闭即置空，旧链接立即失效。
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
  const byPublicToken = db.prepare('SELECT * FROM pages WHERE public_token = ?');
  const setContact = db.prepare(
    'UPDATE pages SET contact_channel = ?, contact_value = ?, contact_public = ?, updated_at = ? WHERE id = ?',
  );
  const setPublicToken = db.prepare('UPDATE pages SET public_token = ?, updated_at = ? WHERE id = ?');
  const clearPersonal = db.prepare(
    'UPDATE pages SET contact_channel = NULL, contact_value = NULL, contact_public = 0, public_token = NULL, updated_at = ? WHERE id = ?',
  );

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
    /** 公开链接令牌对应的页面（调用方先检查令牌格式）。 */
    findByPublicToken(publicToken: string): Page | null {
      return toPage(byPublicToken.get(publicToken) as PageRow | undefined);
    },
    /** 保存主人确认的联系方式（发布时）。`value` 为空时存 null。 */
    setContact(id: string, contact: { channel: string; value: string | null; isPublic: boolean }, now: string): void {
      setContact.run(contact.channel, contact.value, contact.isPublic ? 1 : 0, now, id);
    },
    /** 开启（新令牌）或关闭（null）公开链接。 */
    setPublicToken(id: string, publicToken: string | null, now: string): void {
      setPublicToken.run(publicToken, now, id);
    },
    /** 删除页面：清空联系方式与公开链接（页面行本身保留，可以重新开始）。 */
    clearContactAndPublicLink(id: string, now: string): void {
      clearPersonal.run(now, id);
    },
  };
}

export type PagesRepo = ReturnType<typeof createPagesRepo>;
