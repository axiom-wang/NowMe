/** `users` 表（contracts 3）。email 一律小写。 */
import type { Database } from './database.js';

export interface User {
  id: string;
  email: string;
  /** 首次登录时为空，填写后才能使用其他页面。 */
  nickname: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  nickname: string | null;
  created_at: string;
}

function toUser(row: UserRow | undefined): User | null {
  if (!row) return null;
  return { id: row.id, email: row.email, nickname: row.nickname, createdAt: row.created_at };
}

export function createUsersRepo(db: Database) {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
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
    setNickname(id: string, nickname: string): void {
      updateNickname.run(nickname, id);
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
