/**
 * `page_credentials` 表（contracts 3、6.1、S4）：页面凭证，只存哈希；每页同时最多一个有效凭证。
 * 吊销时机：主人断开、重新生成指令并被换取、退出墙、页面被删除、被移除、墙被关闭（T3.x 调用 revokeAllForPage）。
 */
import type { Database } from './database.js';

export interface PageCredential {
  id: string;
  pageId: string;
  credentialHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** exchange 时 CLI 自报的版本（contracts 4.5）；没报时为 null。 */
  clientCliVersion: string | null;
  clientSkillVersion: string | null;
}

interface PageCredentialRow {
  id: string;
  page_id: string;
  credential_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  client_cli_version: string | null;
  client_skill_version: string | null;
}

function toCredential(row: PageCredentialRow | undefined): PageCredential | null {
  if (!row) return null;
  return {
    id: row.id,
    pageId: row.page_id,
    credentialHash: row.credential_hash,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    clientCliVersion: row.client_cli_version,
    clientSkillVersion: row.client_skill_version,
  };
}

export function createCredentialsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO page_credentials (id, page_id, credential_hash, created_at, last_used_at, revoked_at, client_cli_version, client_skill_version) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)',
  );
  const activeByHash = db.prepare('SELECT * FROM page_credentials WHERE credential_hash = ? AND revoked_at IS NULL');
  const activeForPage = db.prepare('SELECT * FROM page_credentials WHERE page_id = ? AND revoked_at IS NULL');
  const byId = db.prepare('SELECT * FROM page_credentials WHERE id = ?');
  const revokeAll = db.prepare('UPDATE page_credentials SET revoked_at = ? WHERE page_id = ? AND revoked_at IS NULL');
  const touch = db.prepare('UPDATE page_credentials SET last_used_at = ? WHERE id = ?');

  return {
    create(
      credential: Pick<PageCredential, 'id' | 'pageId' | 'credentialHash' | 'createdAt'> &
        Partial<Pick<PageCredential, 'clientCliVersion' | 'clientSkillVersion'>>,
    ): void {
      insert.run(
        credential.id,
        credential.pageId,
        credential.credentialHash,
        credential.createdAt,
        credential.clientCliVersion ?? null,
        credential.clientSkillVersion ?? null,
      );
    },
    findActiveByHash(credentialHash: string): PageCredential | null {
      return toCredential(activeByHash.get(credentialHash) as PageCredentialRow | undefined);
    },
    findActiveForPage(pageId: string): PageCredential | null {
      return toCredential(activeForPage.get(pageId) as PageCredentialRow | undefined);
    },
    findById(id: string): PageCredential | null {
      return toCredential(byId.get(id) as PageCredentialRow | undefined);
    },
    /** 吊销该页全部有效凭证，返回吊销的个数。 */
    revokeAllForPage(pageId: string, now: string): number {
      return Number(revokeAll.run(now, pageId).changes);
    },
    touch(id: string, now: string): void {
      touch.run(now, id);
    },
  };
}

export type CredentialsRepo = ReturnType<typeof createCredentialsRepo>;
