/** `sessions` 表（contracts 3、4.2）：id 是会话令牌的 SHA-256；30 天。 */
import type { Database } from './database.js';

export interface SessionRecord {
  /** 会话令牌的 SHA-256（hex）。 */
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
}

function toSession(row: SessionRow | undefined): SessionRecord | null {
  if (!row) return null;
  return { id: row.id, userId: row.user_id, csrfToken: row.csrf_token, createdAt: row.created_at, expiresAt: row.expires_at };
}

export function createSessionsRepo(db: Database) {
  const insert = db.prepare('INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
  const valid = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?');
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
  const removeForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    create(session: SessionRecord): void {
      insert.run(session.id, session.userId, session.csrfToken, session.createdAt, session.expiresAt);
    },
    /** 未过期的会话。 */
    findValid(id: string, now: string): SessionRecord | null {
      return toSession(valid.get(id, now) as SessionRow | undefined);
    },
    delete(id: string): void {
      remove.run(id);
    },
    deleteForUser(userId: string): void {
      removeForUser.run(userId);
    },
    deleteExpired(now: string): number {
      return Number(removeExpired.run(now).changes);
    },
  };
}

export type SessionsRepo = ReturnType<typeof createSessionsRepo>;
