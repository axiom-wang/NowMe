/** 备份归档的文件权限（contracts 17，T8.11 回归）：归档里有整个数据库，只给运行备份的账号读写。 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup } from '../../src/ops/backup.js';
import { openDatabase } from '../../src/db/index.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('备份归档权限', () => {
  it('备份目录事先存在且是 0755（例如 docker 挂载的宿主机目录）时，归档仍是 0600', () => {
    const root = mkdtempSync(join(tmpdir(), 'nowme-backup-perm-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const db = openDatabase(join(dataDir, 'db.sqlite'));
    db.prepare("INSERT INTO users (id, email, nickname, created_at) VALUES ('usr_a', 'a@example.com', '甲', '2026-11-15T00:00:00.000Z')").run();
    const backupDir = join(root, 'backups');
    mkdirSync(backupDir);
    chmodSync(backupDir, 0o755);
    try {
      const result = createBackup({ dataDir, backupDir, now: () => new Date('2026-11-15T03:04:05.000Z') });
      expect(statSync(result.file).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });
});
