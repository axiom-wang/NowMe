/** `users` 表（contracts 3）。email 一律小写。 */
import type { Database } from './database.js';

export interface User {
  id: string;
  email: string;
  /** 首次登录时为空，填写后才能使用其他页面。 */
  nickname: string | null;
  avatarVersion?: string | null;
  createdAt: string;
  /** 最近一次确认的用户协议 / 隐私政策版本（contracts 16.3）；还没确认过为 null。 */
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
  /** 注销时间（contracts 14）：非空表示这是注销后的墓碑，不能登录、不能有会话。 */
  deletedAt?: string | null;
}

interface UserRow {
  id: string;
  email: string;
  nickname: string | null;
  avatar_version: string | null;
  created_at: string;
  terms_version: string | null;
  terms_accepted_at: string | null;
  deleted_at: string | null;
}

function toUser(row: UserRow | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    avatarVersion: row.avatar_version,
    createdAt: row.created_at,
    termsVersion: row.terms_version,
    termsAcceptedAt: row.terms_accepted_at,
    deletedAt: row.deleted_at,
  };
}

export function createUsersRepo(db: Database) {
  const byId = db.prepare('SELECT id, email, nickname, created_at, avatar_version, terms_version, terms_accepted_at, deleted_at FROM users WHERE id = ?');
  // 注销的账号（墓碑）按邮箱永远找不到：同一邮箱再次登录会注册成新账号
  const byEmail = db.prepare('SELECT id, email, nickname, created_at, avatar_version, terms_version, terms_accepted_at, deleted_at FROM users WHERE email = ? AND deleted_at IS NULL');
  const insert = db.prepare('INSERT INTO users (id, email, nickname, created_at) VALUES (?, ?, ?, ?)');
  const updateNickname = db.prepare('UPDATE users SET nickname = ? WHERE id = ?');

  return {
    findById(id: string): User | null {
      return toUser(byId.get(id) as UserRow | undefined);
    },
    findByEmail(email: string): User | null {
      return toUser(byEmail.get(email) as UserRow | undefined);
    },
    create(user: User): User {
      insert.run(user.id, user.email, user.nickname, user.createdAt);
      return user;
    },
    avatarForUser(id: string): Uint8Array | null {
      const row = db.prepare('SELECT avatar_webp FROM users WHERE id = ?').get(id) as { avatar_webp: Uint8Array | null } | undefined;
      return row?.avatar_webp ?? null;
    },
    saveProfile(id: string, nickname: string, avatar: { bytes: Uint8Array; version: string } | null | undefined): void {
      if (avatar === undefined) updateNickname.run(nickname, id);
      else db.prepare('UPDATE users SET nickname = ?, avatar_webp = ?, avatar_version = ? WHERE id = ?').run(nickname, avatar?.bytes ?? null, avatar?.version ?? null, id);
    },
    setNickname(id: string, nickname: string): void {
      updateNickname.run(nickname, id);
    },
    /** 记录用户确认了某个版本的用户协议与隐私政策（同时确认已年满 18 岁）。 */
    recordConsent(id: string, version: string, at: string): void {
      db.prepare('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?').run(version, at, id);
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
