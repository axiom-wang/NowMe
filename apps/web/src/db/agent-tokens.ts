/** `agent_tokens` 表（contracts 3、4.1、S3）：一次性 token，只存哈希。 */
import type { Database } from './database.js';

export interface AgentToken {
  id: string;
  pageId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface AgentTokenRow {
  id: string;
  page_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function toAgentToken(row: AgentTokenRow | undefined): AgentToken | null {
  if (!row) return null;
  return {
    id: row.id,
    pageId: row.page_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export function createAgentTokensRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO agent_tokens (id, page_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
  );
  const byHash = db.prepare('SELECT * FROM agent_tokens WHERE token_hash = ?');
  const markUsed = db.prepare('UPDATE agent_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL');
  const deleteUnused = db.prepare('DELETE FROM agent_tokens WHERE page_id = ? AND used_at IS NULL');
  const latestPending = db.prepare(
    'SELECT * FROM agent_tokens WHERE page_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
  );

  return {
    create(token: Omit<AgentToken, 'usedAt'>): void {
      insert.run(token.id, token.pageId, token.tokenHash, token.expiresAt, token.createdAt);
    },
    findByHash(tokenHash: string): AgentToken | null {
      return toAgentToken(byHash.get(tokenHash) as AgentTokenRow | undefined);
    },
    /** 标记已用；已经用过时返回 false（并发换取时只有一个成功）。 */
    markUsed(id: string, now: string): boolean {
      return Number(markUsed.run(now, id).changes) === 1;
    },
    /** 作废该页所有未使用的 token（重新生成指令、断开时）。 */
    deleteUnusedForPage(pageId: string): number {
      return Number(deleteUnused.run(pageId).changes);
    },
    /** 该页尚未使用、未过期的最新 token（工作区显示“有一条待使用的指令”）。 */
    findPendingForPage(pageId: string, now: string): AgentToken | null {
      return toAgentToken(latestPending.get(pageId, now) as AgentTokenRow | undefined);
    },
  };
}

export type AgentTokensRepo = ReturnType<typeof createAgentTokensRepo>;
