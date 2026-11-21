/**
 * 组织者工具的表（contracts 19，迁移 `014_organizer_tools.sql`）：必答题与回答、提醒记录、墙的群像，
 * 以及用户的“接收提醒邮件”开关。
 *
 * 这里只做存取；谁能读写、回答是否仍然有效、群像能不能展示由 services/ 下的对应模块判断。
 */
import type { Database } from './database.js';

/** 单选、多选、填空（填空题没有选项，回答是成员写的一行文字）。 */
export type QuestionKind = 'single' | 'multi' | 'text';

export interface WallQuestion {
  id: string;
  wallId: string;
  position: number;
  prompt: string;
  kind: QuestionKind;
  options: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredAnswer {
  questionId: string;
  userId: string;
  /** 存的选项文字（可能包含组织者后来删掉的选项，读取时过滤）；填空题是只有一项的数组。 */
  choices: string[];
  updatedAt: string;
}

export type ReminderReason = 'publish' | 'answer' | 'both';
export type ReminderStatus = 'pending' | 'sent' | 'failed';

export interface PortraitRecord {
  wallId: string;
  resultJson: string;
  sources: string[];
  pageCount: number;
  createdBy: string;
  createdAt: string;
}

function stringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toQuestion(row: Record<string, unknown>): WallQuestion {
  return {
    id: row.id as string,
    wallId: row.wall_id as string,
    position: Number(row.position),
    prompt: row.prompt as string,
    kind: row.kind === 'multi' || row.kind === 'text' ? row.kind : 'single',
    options: stringArray(row.options_json as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createQuestionsRepo(db: Database) {
  const forWall = db.prepare('SELECT * FROM wall_questions WHERE wall_id = ? ORDER BY position, rowid');
  const insert = db.prepare(
    'INSERT INTO wall_questions (id, wall_id, position, prompt, kind, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const update = db.prepare('UPDATE wall_questions SET position = ?, prompt = ?, kind = ?, options_json = ?, updated_at = ? WHERE id = ? AND wall_id = ?');
  const remove = db.prepare('DELETE FROM wall_questions WHERE id = ? AND wall_id = ?');
  const answersForQuestion = db.prepare('DELETE FROM wall_answers WHERE question_id = ?');
  const answersForWall = db.prepare('SELECT question_id, user_id, choices_json, updated_at FROM wall_answers WHERE wall_id = ?');
  const answersForUser = db.prepare('SELECT question_id, user_id, choices_json, updated_at FROM wall_answers WHERE wall_id = ? AND user_id = ?');
  const upsertAnswer = db.prepare(
    `INSERT INTO wall_answers (question_id, user_id, wall_id, choices_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (question_id, user_id) DO UPDATE SET choices_json = excluded.choices_json, updated_at = excluded.updated_at`,
  );
  const allAnswersOfUser = db.prepare(
    `SELECT a.wall_id, q.prompt, a.choices_json, a.updated_at FROM wall_answers a JOIN wall_questions q ON q.id = a.question_id
      WHERE a.user_id = ? ORDER BY a.wall_id, q.position`,
  );
  const deleteAnswersOfUser = db.prepare('DELETE FROM wall_answers WHERE user_id = ?');

  const toAnswer = (row: Record<string, unknown>): StoredAnswer => ({
    questionId: row.question_id as string,
    userId: row.user_id as string,
    choices: stringArray(row.choices_json as string),
    updatedAt: row.updated_at as string,
  });

  return {
    listForWall(wallId: string): WallQuestion[] {
      return (forWall.all(wallId) as Record<string, unknown>[]).map(toQuestion);
    },
    insert(question: WallQuestion): void {
      insert.run(question.id, question.wallId, question.position, question.prompt, question.kind, JSON.stringify(question.options), question.createdAt, question.updatedAt);
    },
    update(question: WallQuestion): boolean {
      return Number(update.run(question.position, question.prompt, question.kind, JSON.stringify(question.options), question.updatedAt, question.id, question.wallId).changes) === 1;
    },
    /** 删除一道题（回答随外键级联删除）。 */
    remove(wallId: string, questionId: string): void {
      remove.run(questionId, wallId);
    },
    deleteAnswersForQuestion(questionId: string): void {
      answersForQuestion.run(questionId);
    },
    answersForWall(wallId: string): StoredAnswer[] {
      return (answersForWall.all(wallId) as Record<string, unknown>[]).map(toAnswer);
    },
    answersForUser(wallId: string, userId: string): StoredAnswer[] {
      return (answersForUser.all(wallId, userId) as Record<string, unknown>[]).map(toAnswer);
    },
    saveAnswer(wallId: string, questionId: string, userId: string, choices: string[], now: string): void {
      upsertAnswer.run(questionId, userId, wallId, JSON.stringify(choices), now);
    },
    /** 导出（contracts 14）：这个人在所有墙的回答。 */
    allAnswersOfUser(userId: string): { wallId: string; prompt: string; choices: string[]; updatedAt: string }[] {
      return (allAnswersOfUser.all(userId) as Record<string, unknown>[]).map((row) => ({
        wallId: row.wall_id as string,
        prompt: row.prompt as string,
        choices: stringArray(row.choices_json as string),
        updatedAt: row.updated_at as string,
      }));
    },
    /** 注销（contracts 14）：删除这个人的全部回答。 */
    deleteAnswersOfUser(userId: string): void {
      deleteAnswersOfUser.run(userId);
    },
  };
}

export function createRemindersRepo(db: Database) {
  const insert = db.prepare('INSERT INTO wall_reminders (id, wall_id, organizer_id, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const setStatus = db.prepare('UPDATE wall_reminders SET status = ? WHERE id = ?');
  const stats = db.prepare('SELECT user_id, COUNT(*) AS n, MAX(created_at) AS last FROM wall_reminders WHERE wall_id = ? GROUP BY user_id');
  const lastForWall = db.prepare('SELECT created_at, COUNT(*) OVER () AS n FROM wall_reminders WHERE wall_id = ? AND created_at = (SELECT MAX(created_at) FROM wall_reminders WHERE wall_id = ?)');
  const deleteForUser = db.prepare('DELETE FROM wall_reminders WHERE user_id = ? OR organizer_id = ?');
  const optOut = db.prepare('SELECT reminder_emails FROM users WHERE id = ?');
  const setOptOut = db.prepare('UPDATE users SET reminder_emails = ? WHERE id = ?');

  return {
    insert(record: { id: string; wallId: string; organizerId: string; userId: string; reason: ReminderReason; createdAt: string }): void {
      insert.run(record.id, record.wallId, record.organizerId, record.userId, record.reason, 'pending', record.createdAt);
    },
    setStatus(id: string, status: ReminderStatus): void {
      setStatus.run(status, id);
    },
    /** 这面墙里每个人被提醒过几次、最近一次是什么时候。 */
    statsForWall(wallId: string): Map<string, { count: number; last: string }> {
      const result = new Map<string, { count: number; last: string }>();
      for (const row of stats.all(wallId) as { user_id: string; n: number; last: string }[]) result.set(row.user_id, { count: Number(row.n), last: row.last });
      return result;
    },
    /** 最近一次一键提醒：时间与那一次提醒了几个人。 */
    lastBatch(wallId: string): { at: string; count: number } | null {
      const row = lastForWall.get(wallId, wallId) as { created_at: string; n: number } | undefined;
      return row ? { at: row.created_at, count: Number(row.n) } : null;
    },
    deleteForUser(userId: string): void {
      deleteForUser.run(userId, userId);
    },
    /** 用户是否接收组织者的提醒邮件（默认接收）。 */
    acceptsReminders(userId: string): boolean {
      const row = optOut.get(userId) as { reminder_emails: number } | undefined;
      return row ? Number(row.reminder_emails) === 1 : false;
    },
    setAcceptsReminders(userId: string, accept: boolean): void {
      setOptOut.run(accept ? 1 : 0, userId);
    },
  };
}

export function createPortraitsRepo(db: Database) {
  const find = db.prepare('SELECT * FROM wall_portraits WHERE wall_id = ?');
  const replace = db.prepare(
    `INSERT INTO wall_portraits (wall_id, result_json, sources_json, page_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (wall_id) DO UPDATE SET result_json = excluded.result_json, sources_json = excluded.sources_json,
       page_count = excluded.page_count, created_by = excluded.created_by, created_at = excluded.created_at`,
  );
  const remove = db.prepare('DELETE FROM wall_portraits WHERE wall_id = ?');
  const removeByCreator = db.prepare('DELETE FROM wall_portraits WHERE created_by = ?');
  const sourceStates = db.prepare(`SELECT id, ended_at, end_reason FROM publications WHERE id IN (SELECT value FROM json_each(?))`);

  return {
    find(wallId: string): PortraitRecord | null {
      const row = find.get(wallId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        wallId: row.wall_id as string,
        resultJson: row.result_json as string,
        sources: stringArray(row.sources_json as string),
        pageCount: Number(row.page_count),
        createdBy: row.created_by as string,
        createdAt: row.created_at as string,
      };
    },
    replace(record: PortraitRecord): void {
      replace.run(record.wallId, record.resultJson, JSON.stringify(record.sources), record.pageCount, record.createdBy, record.createdAt);
    },
    deleteForWall(wallId: string): void {
      remove.run(wallId);
    },
    deleteByCreator(userId: string): void {
      removeByCreator.run(userId);
    },
    /** 来源发布现在的状态（已经不存在的发布不在结果里）。 */
    sourceStates(sources: string[]): Map<string, { endedAt: string | null; endReason: string | null }> {
      const result = new Map<string, { endedAt: string | null; endReason: string | null }>();
      for (const row of sourceStates.all(JSON.stringify(sources)) as { id: string; ended_at: string | null; end_reason: string | null }[]) {
        result.set(row.id, { endedAt: row.ended_at, endReason: row.end_reason });
      }
      return result;
    },
  };
}
