/** 备份与恢复（contracts 17）：用临时目录，不碰真实数据。 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupError, createBackup, listBackups, restoreBackup } from '../src/ops/backup.js';
import { openDatabase } from '../src/db/index.js';

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nowme-backup-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** 造一个数据目录：WAL 模式的真实数据库（主站保持打开，模拟在线备份）+ 两个页面版本。 */
function makeDataDir() {
  const root = tmp();
  const dataDir = join(root, 'data');
  const db = openDatabase(join(dataDir, 'db.sqlite'));
  db.prepare("INSERT INTO users (id, email, nickname, created_at) VALUES ('usr_a', 'a@example.com', '甲', '2026-11-15T00:00:00.000Z')").run();
  mkdirSync(join(dataDir, 'revisions', 'rev_aaa', 'served'), { recursive: true });
  writeFileSync(join(dataDir, 'revisions', 'rev_aaa', 'served', 'index.html'), '<!doctype html>A');
  mkdirSync(join(dataDir, 'revisions', 'rev_bbb'), { recursive: true });
  writeFileSync(join(dataDir, 'revisions', 'rev_bbb', 'cover.png'), 'PNG');
  writeFileSync(join(dataDir, 'secret'), 'must-not-be-backed-up');
  return { root, dataDir, db, backupDir: join(root, 'backups') };
}

describe('备份', () => {
  it('在线备份：数据库打开着也能得到一致快照，含版本目录，不含 secret', () => {
    const { dataDir, db, backupDir } = makeDataDir();
    const result = createBackup({ dataDir, backupDir, now: () => new Date('2026-11-15T03:04:05.000Z') });
    expect(result.file.endsWith('nowme-backup-20261115T030405Z.tar.gz')).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    const listing = spawnSync('tar', ['-tzf', result.file], { encoding: 'utf8' }).stdout;
    expect(listing).toContain('db.sqlite');
    expect(listing).toContain('revisions/rev_aaa/served/index.html');
    expect(listing).not.toContain('secret');
    expect(readdirSync(backupDir).filter((name) => name.startsWith('.staging-') || name.endsWith('.partial'))).toEqual([]);
    db.close();
  });

  it('保留份数：超出的旧备份被清理', () => {
    const { dataDir, db, backupDir } = makeDataDir();
    for (let i = 1; i <= 4; i++) createBackup({ dataDir, backupDir, keep: 2, now: () => new Date(`2026-11-1${i}T00:00:00.000Z`) });
    expect(listBackups(backupDir)).toEqual(['nowme-backup-20261113T000000Z.tar.gz', 'nowme-backup-20261114T000000Z.tar.gz']);
    db.close();
  });

  it('没有数据库、备份目录在数据目录里面都会拒绝', () => {
    const root = tmp();
    expect(() => createBackup({ dataDir: join(root, 'nope'), backupDir: join(root, 'b') })).toThrow(BackupError);
    const { dataDir, db } = makeDataDir();
    expect(() => createBackup({ dataDir, backupDir: join(dataDir, 'backups') })).toThrow(/不能放在数据目录里面/);
    db.close();
  });
});

describe('恢复', () => {
  it('恢复到空目录：数据与版本文件一致，完整性检查通过', () => {
    const { root, dataDir, db, backupDir } = makeDataDir();
    const { file } = createBackup({ dataDir, backupDir });
    db.close();
    const target = join(root, 'restored');
    const result = restoreBackup({ archive: file, targetDir: target });
    expect(result).toMatchObject({ integrity: 'ok', revisions: 2 });
    expect(readFileSync(join(target, 'revisions', 'rev_aaa', 'served', 'index.html'), 'utf8')).toBe('<!doctype html>A');
    expect(existsSync(join(target, 'secret'))).toBe(false);
    const restored = new DatabaseSync(join(target, 'db.sqlite'), { readOnly: true });
    expect(restored.prepare('SELECT nickname FROM users WHERE id = ?').get('usr_a')).toMatchObject({ nickname: '甲' });
    restored.close();
  });

  it('也接受已存在的空目录；非空目录一律拒绝且不改动其中的文件', () => {
    const { root, dataDir, db, backupDir } = makeDataDir();
    const { file } = createBackup({ dataDir, backupDir });
    db.close();
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(restoreBackup({ archive: file, targetDir: empty }).integrity).toBe('ok');
    expect(() => restoreBackup({ archive: file, targetDir: dataDir })).toThrow(/不是空目录/);
    expect(readFileSync(join(dataDir, 'secret'), 'utf8')).toBe('must-not-be-backed-up');
  });

  it('损坏的数据库：完整性检查失败，并清理半恢复的目录', () => {
    const root = tmp();
    const staging = join(root, 'staging');
    mkdirSync(staging);
    writeFileSync(join(staging, 'db.sqlite'), Buffer.alloc(8192, 7));
    const archive = join(root, 'bad.tar.gz');
    expect(spawnSync('tar', ['-czf', archive, '-C', staging, 'db.sqlite']).status).toBe(0);
    const target = join(root, 'out');
    expect(() => restoreBackup({ archive, targetDir: target })).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('归档里有数据目录以外的路径时拒绝', () => {
    const root = tmp();
    const staging = join(root, 'staging');
    mkdirSync(staging);
    writeFileSync(join(staging, 'db.sqlite'), '');
    writeFileSync(join(staging, 'evil.sh'), 'x');
    const archive = join(root, 'evil.tar.gz');
    spawnSync('tar', ['-czf', archive, '-C', staging, 'db.sqlite', 'evil.sh']);
    expect(() => restoreBackup({ archive, targetDir: join(root, 'out') })).toThrow(/不符合预期/);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('备份文件不存在时报错', () => {
    expect(() => restoreBackup({ archive: join(tmp(), 'missing.tar.gz'), targetDir: join(tmp(), 'out') })).toThrow(/找不到备份文件/);
  });
});
