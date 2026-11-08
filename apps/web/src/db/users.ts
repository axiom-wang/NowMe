/** `users` 表（contracts 3）。email 一律小写。 */
import type { Database } from './database.js';

export interface User {
  id: string;
  email: string;
  /** 首次登录时为空，填写后才能使用其他页面。 */
  nickname: string | null;
  avatarVersion?: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  nickname: string | null;
  avatar_version: string | null;
  created_at: string;
}

function toUser(row: UserRow | undefined): User | null {
  if (!row) return null;
  return { id: row.id, email: row.email, nickname: row.nickname, avatarVersion: row.avatar_version, createdAt: row.created_at };
}

export function createUsersRepo(db: Database) {
  const byId = db.prepare('SELECT id, email, nickname, created_at, avatar_version FROM users WHERE id = ?');
  const byEmail = db.prepare('SELECT id, email, nickname, created_at, avatar_version FROM users WHERE email = ?');
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
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
