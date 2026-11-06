/**
 * SQLite（`node:sqlite`）：打开数据库、执行迁移、事务。
 *
 * - 迁移文件在 `apps/web/migrations/NNN_<名字>.sql`，按文件名顺序执行，已执行的记在 `schema_migrations`；
 *   每个文件在一个事务里执行。M3 需要新表时加新文件，不要修改已有文件。
 * - 文件数据库用 WAL（主站与种子脚本可以同时打开），外键开启，`busy_timeout` 5 秒。
 * - 所有仓储函数都是同步的（`DatabaseSync`），一个请求里的事务不会和别的请求交错。
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/** 迁移文件目录。本文件位于 `src/db/` 或 `dist/db/`，向上两级即包根。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const MIGRATION_FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface OpenDatabaseOptions {
  /** 迁移目录（测试可替换）。 */
  migrationsDir?: string;
}

/** 打开（必要时创建）数据库并执行迁移。`path` 为 `:memory:` 时用内存数据库。 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db, options.migrationsDir);
  return db;
}

/** 执行尚未执行的迁移，返回本次执行的文件名。可以重复调用。 */
export function migrate(db: Database, migrationsDir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version),
  );
  const files = readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    });
    ran.push(file);
  }
  return ran;
}

let savepointCounter = 0;

/**
 * 在事务中执行 `fn`（同步）。最外层用 `BEGIN IMMEDIATE`（立即拿写锁，避免 WAL 下读升级写时的 SQLITE_BUSY），
 * 嵌套调用用 SAVEPOINT。`fn` 抛错时回滚并重新抛出。不要在 `fn` 里 await。
 */
export function transaction<T>(db: Database, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** 布尔列（0 / 1）。 */
export function toBool(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}
