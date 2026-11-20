/** 数据库迁移（contracts 第 3 节）：全部表、字段、约束、索引；迁移可重复执行。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateId, generateToken } from '@nowme/contracts';
import { createRepos, migrate, openDatabase, transaction, type Database } from '../src/db/index.js';

const NOW = '2026-11-06T08:00:00.000Z';

/** contracts 第 3 节的表与“主要字段”（实现可以多出字段，但必须包含这些）。 */
const CONTRACT_TABLES: Record<string, string[]> = {
  wall_covers: ['wall_id', 'version', 'image', 'updated_at'],
  conversations: ['id', 'wall_id', 'kind', 'user_a', 'user_b', 'created_at'],
  chat_messages: ['sequence', 'conversation_id', 'sender_id', 'client_id', 'body', 'created_at'],
  chat_reads: ['conversation_id', 'user_id', 'last_sequence'],
  // contracts 9 / hosted-route 4（迁移 002_hosted.sql）
  profile_entries: ['id', 'user_id', 'category', 'text', 'source', 'confirmation', 'created_at', 'updated_at'],
  briefs: ['id', 'page_id', 'owner_id', 'status', 'answers_json', 'followups_json', 'brief_json', 'brief_md', 'confirmed_at', 'created_at', 'updated_at'],
  brief_assets: ['id', 'brief_id', 'page_id', 'owner_id', 'file_name', 'mime', 'bytes', 'sha256', 'created_at'],
  user_model_settings: ['user_id', 'role', 'endpoint_json', 'encrypted_key', 'version', 'updated_at'],
  generation_jobs: ['id', 'page_id', 'owner_id', 'kind', 'status', 'base_revision_id', 'target_block', 'request_text', 'result_message', 'revision_id', 'error_code', 'charged', 'usage_json', 'created_at', 'started_at', 'finished_at'],
  // contracts 11（迁移 008_icebreakers.sql）
  icebreakers: ['id', 'wall_id', 'viewer_id', 'page_id', 'publication_id', 'result_json', 'created_at'],
  // contracts 20（迁移 021_intros.sql）
  intros: ['id', 'wall_id', 'viewer_id', 'sources_json', 'seen_json', 'created_at'],
  intro_picks: ['intro_id', 'position', 'page_id', 'publication_id', 'kind', 'title', 'reason', 'mine', 'theirs'],
  // contracts 21（迁移 022_wall_asks.sql）
  wall_asks: ['id', 'wall_id', 'viewer_id', 'question', 'candidates', 'found', 'created_at'],
  wall_ask_matches: ['ask_id', 'position', 'page_id', 'publication_id', 'reason', 'quote'],
  // contracts 12（迁移 009_credits.sql）
  credit_balances: ['account_kind', 'account_id', 'balance', 'updated_at'],
  credit_entries: ['id', 'account_kind', 'account_id', 'delta', 'balance_after', 'reason', 'ref_id', 'actor_id', 'created_at'],
  redeem_codes: ['id', 'code_hash', 'credits', 'batch', 'expires_at', 'redeemed_by', 'redeemed_at', 'created_at'],
  wall_sponsorships: ['wall_id', 'member_cap', 'updated_at'],
  // contracts 15（迁移 012_moderation.sql）
  reports: ['id', 'reporter_id', 'target_kind', 'wall_id', 'reported_user_id', 'page_id', 'publication_id', 'conversation_id', 'last_sequence', 'reason', 'note', 'status', 'resolved_by', 'resolved_at', 'created_at', 'updated_at'],
  moderation_actions: ['id', 'actor', 'actor_user_id', 'action', 'wall_id', 'page_id', 'publication_id', 'report_id', 'user_id', 'note', 'created_at'],
  blocks: ['blocker_id', 'blocked_id', 'created_at'],
  user_suspensions: ['user_id', 'reason', 'suspended_at'],
  // contracts 14.7（迁移 014_deletion_evidence.sql）
  deletion_evidence: ['report_id', 'kind', 'card_json', 'rendered_text', 'screenshot', 'messages_json', 'created_at', 'expires_at'],
  deleted_emails: ['email_hmac', 'created_at'],
  // contracts 13（迁移 010_job_queue.sql）
  render_jobs: ['id', 'kind', 'status', 'page_id', 'credential_id', 'attempts', 'max_attempts', 'lease_owner', 'lease_expires_at', 'outcome', 'revision_id', 'error_code', 'created_at', 'started_at', 'finished_at'],
  job_events: ['job_id', 'seq', 'stage', 'props_json', 'created_at'],
  // contracts 19（迁移 020_organizer_tools.sql）
  wall_questions: ['id', 'wall_id', 'position', 'prompt', 'kind', 'options_json', 'created_at', 'updated_at'],
  wall_answers: ['question_id', 'user_id', 'wall_id', 'choices_json', 'updated_at'],
  wall_reminders: ['id', 'wall_id', 'organizer_id', 'user_id', 'reason', 'status', 'created_at'],
  wall_portraits: ['wall_id', 'result_json', 'sources_json', 'page_count', 'created_by', 'created_at'],
  job_notices: ['job_id', 'outcome', 'created_at'],
  users: ['id', 'email', 'nickname', 'created_at'],
  login_codes: ['id', 'email', 'code_hash', 'attempts', 'expires_at', 'used_at'],
  sessions: ['id', 'user_id', 'csrf_token', 'created_at', 'expires_at'],
  walls: ['id', 'name', 'description', 'scene_type', 'organizer_note', 'organizer_id', 'invite_code', 'status', 'created_at', 'closed_at'],
  memberships: ['id', 'wall_id', 'user_id', 'role', 'status', 'joined_at', 'ended_at'],
  pages: [
    'id',
    'membership_id',
    'wall_id',
    'owner_id',
    'contact_channel',
    'contact_value',
    'contact_public',
    'public_token',
    'created_at',
    'updated_at',
  ],
  agent_tokens: ['id', 'page_id', 'token_hash', 'expires_at', 'used_at', 'created_at'],
  page_credentials: ['id', 'page_id', 'credential_hash', 'created_at', 'last_used_at', 'revoked_at'],
  revisions: [
    'id',
    'page_id',
    'number',
    'source',
    'credential_id',
    'status',
    'report_json',
    'card_json',
    'manifest_json',
    'rendered_text',
    'render_json',
    'created_at',
  ],
  publications: ['id', 'page_id', 'revision_id', 'card_json', 'contact_json', 'published_at', 'ended_at', 'end_reason'],
  events: ['id', 'type', 'wall_id', 'page_id', 'actor_id', 'props_json', 'created_at'],
};

function columns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name);
}

/** 种一组基础数据：用户、墙、成员关系、页面。 */
function seed(db: Database) {
  const user = generateId('usr');
  const wall = generateId('wal');
  const membership = generateId('mem');
  const page = generateId('pg');
  db.prepare('INSERT INTO users (id, email, nickname, created_at) VALUES (?, ?, ?, ?)').run(user, 'a@example.com', '阿柚', NOW);
  db.prepare(
    "INSERT INTO walls (id, name, description, scene_type, organizer_id, invite_code, status, created_at) VALUES (?, '墙', '', 'hackathon', ?, ?, 'open', ?)",
  ).run(wall, user, generateToken('invite'), NOW);
  db.prepare("INSERT INTO memberships (id, wall_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'organizer', 'active', ?)").run(
    membership,
    wall,
    user,
    NOW,
  );
  db.prepare('INSERT INTO pages (id, membership_id, wall_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    page,
    membership,
    wall,
    user,
    NOW,
    NOW,
  );
  return { user, wall, membership, page };
}

function insertRevision(db: Database, page: string, number: number, status = 'accepted'): string {
  const id = generateId('rev');
  db.prepare('INSERT INTO revisions (id, page_id, number, status, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    page,
    number,
    status,
    '{}',
    NOW,
  );
  return id;
}

describe('数据库迁移', () => {
  const dirs: string[] = [];
  const dbs: Database[] = [];
  const open = (path = ':memory:') => {
    const db = openDatabase(path);
    dbs.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.isOpen) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('建出 contracts 第 3 节的全部表与主要字段', () => {
    const db = open();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables.sort()).toEqual([...Object.keys(CONTRACT_TABLES), 'schema_migrations'].sort());
    for (const [table, expected] of Object.entries(CONTRACT_TABLES)) {
      expect(columns(db, table), table).toEqual(expect.arrayContaining(expected));
    }
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('迁移可重复执行；文件数据库使用 WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-db-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const db = open(file);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(migrate(db)).toEqual([]);
    db.close();
    const again = open(file);
    expect(again.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: '001_init.sql' }, { version: '002_hosted.sql' }, { version: '003_skill_client.sql' }, { version: '004_user_models.sql' }, { version: '005_chat.sql' }, { version: '006_wall_covers.sql' }, { version: '007_user_avatar.sql' }, { version: '008_icebreakers.sql' }, { version: '009_credits.sql' }, { version: '010_job_queue.sql' }, { version: '011_account_deletion.sql' }, { version: '012_moderation.sql' }, { version: '013_consent.sql' }, { version: '014_deletion_evidence.sql' }, { version: '015_notify_prefs.sql' }, { version: '020_organizer_tools.sql' }, { version: '021_intros.sql' }, { version: '022_wall_asks.sql' }, { version: '023_interview_context.sql' }, { version: '024_owner_edit.sql' }]);
  });

  it('从旧数据库增量升级保留用户、页面、brief、版本、发布与历史任务', () => {
    const db = open();
    db.exec("DROP TABLE user_model_settings; DELETE FROM schema_migrations WHERE version='004_user_models.sql'");
    const data = seed(db);
    const revision = insertRevision(db, data.page, 1);
    db.prepare("INSERT INTO briefs(id,page_id,owner_id,status,answers_json,brief_md,created_at,updated_at) VALUES (?,?,?,'collecting','{}','旧资料',?,?)").run(generateId('brf'), data.page, data.user, NOW, NOW);
    db.prepare("INSERT INTO generation_jobs(id,page_id,owner_id,kind,status,charged,created_at) VALUES (?,?,?,'generate','succeeded',1,?)").run(generateId('gen'), data.page, data.user, NOW);
    db.prepare("INSERT INTO publications(id,page_id,revision_id,card_json,contact_json,published_at) VALUES (?,?,?,'{}','{}',?)").run(generateId('pbl'), data.page, revision, NOW);
    const tables = ['users', 'walls', 'memberships', 'pages', 'briefs', 'revisions', 'publications', 'generation_jobs'];
    const snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    expect(migrate(db)).toEqual(['004_user_models.sql']);
    expect(snapshot()).toEqual(before);
    expect(migrate(db)).toEqual([]);
  });

  it('关键索引存在（部分唯一索引：每页一个有效凭证、一个活跃发布）', () => {
    const db = open();
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        'page_credentials_one_active',
        'publications_one_active',
        'login_codes_email_created',
        'sessions_user',
        'memberships_user',
        'memberships_wall',
        'pages_wall',
        'agent_tokens_page',
        'revisions_page_created',
        'events_wall_type',
      ]),
    );
  });

  it('约束：email 唯一且小写；(wall_id, user_id) 唯一；每个成员关系一页；枚举与状态一致性', () => {
    const db = open();
    const { user, wall, membership } = seed(db);
    expect(() => db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(generateId('usr'), 'a@example.com', NOW)).toThrow(/UNIQUE/);
    expect(() => db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(generateId('usr'), 'B@example.com', NOW)).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO memberships (id, wall_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'member', 'active', ?)").run(
        generateId('mem'),
        wall,
        user,
        NOW,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare('INSERT INTO pages (id, membership_id, wall_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        generateId('pg'),
        membership,
        wall,
        user,
        NOW,
        NOW,
      ),
    ).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE walls SET status = 'closed' WHERE id = ?").run(wall)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE walls SET scene_type = 'party' WHERE id = ?").run(wall)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE memberships SET status = 'removed' WHERE id = ?").run(membership)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE memberships SET role = 'admin' WHERE id = ?").run(membership)).toThrow(/CHECK/);
    db.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?").run(NOW, membership);
    db.prepare("UPDATE walls SET status = 'closed', closed_at = ? WHERE id = ?").run(NOW, wall);
  });

  it('外键：不能为不存在的页面创建 token / 凭证 / 版本', () => {
    const db = open();
    expect(() =>
      db.prepare('INSERT INTO agent_tokens (id, page_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
        generateId('agt'),
        'pg_missing',
        'a'.repeat(64),
        NOW,
        NOW,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => insertRevision(db, 'pg_missing', 1)).toThrow(/FOREIGN KEY/);
  });

  it('每页同时最多一个有效凭证', () => {
    const db = open();
    const { page } = seed(db);
    const insert = db.prepare('INSERT INTO page_credentials (id, page_id, credential_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(generateId('crd'), page, 'a'.repeat(64), NOW, null);
    expect(() => insert.run(generateId('crd'), page, 'b'.repeat(64), NOW, null)).toThrow(/UNIQUE/);
    insert.run(generateId('crd'), page, 'c'.repeat(64), NOW, NOW);
    db.prepare('UPDATE page_credentials SET revoked_at = ? WHERE page_id = ?').run(NOW, page);
    insert.run(generateId('crd'), page, 'd'.repeat(64), NOW, null);
  });

  it('版本编号页内唯一；每页至多一个活跃发布；结束时必须同时给出原因', () => {
    const db = open();
    const { page } = seed(db);
    const first = insertRevision(db, page, 1);
    expect(() => insertRevision(db, page, 1)).toThrow(/UNIQUE/);
    expect(() => insertRevision(db, page, 2, 'pending')).toThrow(/CHECK/);
    const second = insertRevision(db, page, 2);
    const publish = db.prepare(
      'INSERT INTO publications (id, page_id, revision_id, card_json, contact_json, published_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    publish.run(generateId('pbl'), page, first, '{}', null, NOW, null, null);
    expect(() => publish.run(generateId('pbl'), page, second, '{}', null, NOW, null, null)).toThrow(/UNIQUE/);
    expect(() => db.prepare('UPDATE publications SET ended_at = ? WHERE page_id = ?').run(NOW, page)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE publications SET ended_at = ?, end_reason = 'expired' WHERE page_id = ?").run(NOW, page)).toThrow(/CHECK/);
    db.prepare("UPDATE publications SET ended_at = ?, end_reason = 'superseded' WHERE page_id = ?").run(NOW, page);
    publish.run(generateId('pbl'), page, second, '{}', '{"channel":"wechat"}', NOW, null, null);
    const repos = createRepos(db);
    expect(repos.publications.displayState(page)).toBe('published');
    db.prepare("UPDATE publications SET ended_at = ?, end_reason = 'withdrawn' WHERE ended_at IS NULL").run(NOW);
    expect(repos.publications.displayState(page)).toBe('withdrawn');
  });

  it('仓储：版本插入时分配页内编号', () => {
    const db = open();
    const { page } = seed(db);
    const repos = createRepos(db);
    const insert = (status: 'accepted' | 'rejected') =>
      repos.revisions.insert({
        id: generateId('rev'),
        pageId: page,
        source: 'local-agent',
        credentialId: null,
        status,
        report: { ok: status === 'accepted', errors: [], warnings: [], stats: {} as never, validatorVersion: 'x' },
        cardJson: null,
        manifestJson: null,
        renderedText: null,
        renderJson: null,
        createdAt: NOW,
      });
    expect([insert('accepted'), insert('rejected'), insert('accepted')]).toEqual([1, 2, 3]);
    expect(repos.revisions.statsForPage(page)).toEqual({ count: 3, lastCreatedAt: NOW });
  });

  it('事务：出错回滚，嵌套用 SAVEPOINT', () => {
    const db = open();
    const { page } = seed(db);
    expect(() =>
      transaction(db, () => {
        insertRevision(db, page, 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 0 });
    transaction(db, () => {
      insertRevision(db, page, 1);
      expect(() =>
        transaction(db, () => {
          insertRevision(db, page, 2);
          throw new Error('inner');
        }),
      ).toThrow('inner');
      insertRevision(db, page, 3);
    });
    expect(db.prepare('SELECT number FROM revisions ORDER BY number').all()).toEqual([{ number: 1 }, { number: 3 }]);
    expect(db.isTransaction).toBe(false);
  });

  it('事件只存数字与布尔属性', () => {
    const db = open();
    const { page, wall, user } = seed(db);
    const repos = createRepos(db);
    repos.events.record({
      type: 'agent_submit',
      wallId: wall,
      pageId: page,
      actorId: user,
      props: { ok: true, ms: 12, text: '内容' as unknown as number, nan: Number.NaN, 'bad key': 1 },
      createdAt: NOW,
    });
    expect(repos.events.listForPage(page)[0]?.props).toEqual({ ok: true, ms: 12 });
    expect(() => repos.events.record({ type: 'nope' as never, wallId: null, pageId: null, actorId: null, createdAt: NOW })).toThrow();
  });
});
