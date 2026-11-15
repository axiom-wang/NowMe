/**
 * 备份与恢复（contracts 17）。
 *
 * 备份 = SQLite 在线一致性快照 + 页面版本文件目录，打成一个 `nowme-backup-<时间戳>.tar.gz`：
 * - 数据库用 `VACUUM INTO`：在 WAL 模式下、主站运行时也能得到一致的快照（单个文件，不含 -wal / -shm）；
 * - `revisions/` 里的版本目录写入后不再修改，直接打包；
 * - 不含 `secret`（票据密钥，丢了重新生成即可，旧票据本来就是短期有效）、发件箱日志，也不含 `NOWME_AI_ENCRYPTION_KEY`
 *   ——后者是环境变量，必须单独保管，没有它备份里的用户模型 Key 无法解密。
 *
 * 恢复只写到空目录，并对恢复出的数据库做 `PRAGMA integrity_check`。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DB_FILE, DATA_REVISIONS_DIR } from '@nowme/contracts';

export const BACKUP_PREFIX = 'nowme-backup-';
export const BACKUP_SUFFIX = '.tar.gz';
export const DEFAULT_BACKUP_KEEP = 7;
const BACKUP_FILE_PATTERN = /^nowme-backup-\d{8}T\d{6}Z\.tar\.gz$/;

export class BackupError extends Error {}

export interface BackupOptions {
  dataDir: string;
  backupDir: string;
  /** 保留份数（含本次），默认 7；至少 1。 */
  keep?: number;
  now?: () => Date;
}

export interface BackupResult {
  file: string;
  bytes: number;
  /** 本次清理掉的旧备份文件名。 */
  pruned: string[];
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function runTar(args: string[]): void {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.error) throw new BackupError(`无法运行 tar：${result.error.message}`);
  // 状态 1 表示“打包过程中有文件变化”：版本目录只增不改，数据库是快照，这里按警告处理
  if (result.status !== 0 && result.status !== 1) throw new BackupError(`tar 失败（${result.status}）：${result.stderr.trim()}`);
}

/** 备份目录里已有的备份文件，从旧到新。 */
export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir).filter((name) => BACKUP_FILE_PATTERN.test(name)).sort();
}

export function createBackup(options: BackupOptions): BackupResult {
  const dataDir = resolve(options.dataDir);
  const backupDir = resolve(options.backupDir);
  const keep = options.keep ?? DEFAULT_BACKUP_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new BackupError('保留份数至少为 1');
  const dbFile = join(dataDir, DATA_DB_FILE);
  if (!existsSync(dbFile)) throw new BackupError(`数据目录里没有数据库：${dbFile}`);
  if (backupDir === dataDir || backupDir.startsWith(`${dataDir}/`)) throw new BackupError('备份目录不能放在数据目录里面');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const staging = mkdtempSync(join(backupDir, '.staging-'));
  const finalPath = join(backupDir, `${BACKUP_PREFIX}${timestamp((options.now ?? (() => new Date()))())}${BACKUP_SUFFIX}`);
  try {
    if (existsSync(finalPath)) throw new BackupError(`同一秒内已有备份：${finalPath}`);
    const snapshot = join(staging, DATA_DB_FILE);
    const source = new DatabaseSync(dbFile);
    try {
      source.exec('PRAGMA busy_timeout = 5000');
      // VACUUM INTO 的目标路径作为字符串字面量：路径里的单引号要双写
      source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    const partial = `${finalPath}.partial`;
    // 归档里有整个数据库（邮箱、采访、加密的 Key……）：只给运行备份的账号读写。备份目录可能是事先建好的
    // （例如 docker 挂载的宿主机目录，权限 0755），不能依赖目录权限，归档文件本身先以 0600 建好再交给 tar 写入。
    closeSync(openSync(partial, 'w', 0o600));
    chmodSync(partial, 0o600);
    const args = ['-czf', partial, '-C', staging, DATA_DB_FILE];
    if (existsSync(join(dataDir, DATA_REVISIONS_DIR))) args.push('-C', dataDir, DATA_REVISIONS_DIR);
    runTar(args);
    chmodSync(partial, 0o600);
    renameSync(partial, finalPath); // 先写 .partial 再改名：备份目录里不会出现写了一半的归档
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(`${finalPath}.partial`, { force: true });
  }

  const all = listBackups(backupDir);
  const pruned = all.slice(0, Math.max(0, all.length - keep));
  for (const name of pruned) rmSync(join(backupDir, name), { force: true });
  return { file: finalPath, bytes: statSync(finalPath).size, pruned };
}

export interface RestoreOptions {
  /** 备份归档路径。 */
  archive: string;
  /** 恢复到哪里：必须不存在或是空目录。 */
  targetDir: string;
}

export interface RestoreResult {
  targetDir: string;
  integrity: 'ok';
  revisions: number;
  tables: number;
}

function archiveEntries(archive: string): string[] {
  const result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  if (result.error) throw new BackupError(`无法运行 tar：${result.error.message}`);
  if (result.status !== 0) throw new BackupError(`不是有效的备份归档：${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
}

function isEmptyDir(dir: string): boolean {
  return readdirSync(dir).length === 0;
}

export function restoreBackup(options: RestoreOptions): RestoreResult {
  const archive = resolve(options.archive);
  const target = resolve(options.targetDir);
  if (!existsSync(archive)) throw new BackupError(`找不到备份文件：${archive}`);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new BackupError(`${target} 不是目录`);
    if (!isEmptyDir(target)) throw new BackupError(`${target} 不是空目录：恢复只写到空的数据目录，不会覆盖现有数据`);
  }
  // 只接受我们自己写的结构：db.sqlite 与 revisions/ 下的相对路径
  const entries = archiveEntries(archive);
  const safe = entries.every((entry) => {
    const clean = entry.replace(/^\.\//, '');
    return !clean.startsWith('/') && !clean.split('/').includes('..') && (clean === DATA_DB_FILE || clean === `${DATA_REVISIONS_DIR}/` || clean.startsWith(`${DATA_REVISIONS_DIR}/`));
  });
  if (!safe || !entries.some((entry) => entry.replace(/^\.\//, '') === DATA_DB_FILE)) throw new BackupError('备份归档的内容不符合预期（缺少 db.sqlite，或含有数据目录以外的路径）');

  const existed = existsSync(target);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    runTar(['-xzf', archive, '-C', target, '--no-same-owner']);
    const dbFile = join(target, DATA_DB_FILE);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let tables: number;
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      if (rows.length !== 1 || rows[0]!.integrity_check !== 'ok') {
        throw new BackupError(`数据库完整性检查未通过：${rows.map((row) => row.integrity_check).slice(0, 5).join('；')}`);
      }
      const foreign = db.prepare('PRAGMA foreign_key_check').all();
      if (foreign.length > 0) throw new BackupError(`数据库外键检查未通过（${foreign.length} 处）`);
      tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
    } finally {
      db.close();
    }
    const revisionsDir = join(target, DATA_REVISIONS_DIR);
    return { targetDir: target, integrity: 'ok', revisions: existsSync(revisionsDir) ? readdirSync(revisionsDir).length : 0, tables };
  } catch (error) {
    // 目标原本是空的（或不存在），失败时清回原样，避免留下一个半恢复的数据目录
    if (existed) for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true });
    else rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
