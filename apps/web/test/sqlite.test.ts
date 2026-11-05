/**
 * SQLite 冒烟测试：Node 内置 node:sqlite（DatabaseSync）能在 vitest 下加载、建表、读写，
 * 包括文件数据库、WAL、外键、事务。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { generateId, hashToken } from '@nowme/contracts';

describe('node:sqlite 冒烟测试', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('内存数据库：建表、插入、查询', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname TEXT, created_at TEXT NOT NULL)');
    const id = generateId('usr');
    db.prepare('INSERT INTO users (id, email, nickname, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      'ayou@example.com',
      '阿柚',
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT id, email, nickname FROM users WHERE email = ?').get('ayou@example.com');
    expect(row).toEqual({ id, email: 'ayou@example.com', nickname: '阿柚' });
    expect(() =>
      db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(generateId('usr'), 'ayou@example.com', 'x'),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('文件数据库：WAL、外键、事务回滚、重新打开后数据仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-sqlite-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');

    const db = new DatabaseSync(file);
    expect(db.prepare('PRAGMA journal_mode = WAL').get()).toEqual({ journal_mode: 'wal' });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      CREATE TABLE pages (id TEXT PRIMARY KEY);
      CREATE TABLE agent_tokens (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id),
        token_hash TEXT NOT NULL UNIQUE
      );
    `);
    const pageId = generateId('pg');
    db.prepare('INSERT INTO pages (id) VALUES (?)').run(pageId);
    expect(() =>
      db.prepare('INSERT INTO agent_tokens (id, page_id, token_hash) VALUES (?, ?, ?)').run('agt_x', 'pg_missing', 'h'),
    ).toThrow(/FOREIGN KEY/);

    db.exec('BEGIN');
    db.prepare('INSERT INTO agent_tokens (id, page_id, token_hash) VALUES (?, ?, ?)').run('agt_1', pageId, hashToken('a'));
    db.exec('ROLLBACK');
    db.prepare('INSERT INTO agent_tokens (id, page_id, token_hash) VALUES (?, ?, ?)').run('agt_2', pageId, hashToken('b'));
    db.close();

    const reopened = new DatabaseSync(file, { readOnly: true });
    const rows = reopened.prepare('SELECT id, token_hash FROM agent_tokens ORDER BY id').all();
    expect(rows).toEqual([{ id: 'agt_2', token_hash: hashToken('b') }]);
    reopened.close();
  });
});
