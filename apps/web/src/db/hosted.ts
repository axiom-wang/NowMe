/**
 * 平台托管路线的表（contracts 9 / hosted-route 4）：`profile_entries`、`briefs`、`brief_assets`、`generation_jobs`。
 *
 * 这些表里的内容只属于主人（S7）：所有读取函数都按 `owner_id` / `user_id` 过滤，调用方传入的是**当前登录用户**，
 * 不要用别人的 ID 调用。授权（是不是页面主人）仍由路由用 `findOwnPage` 检查。
 */
import type { Database } from './database.js';

// ---------------------------------------------------------------------------
// profile_entries
// ---------------------------------------------------------------------------

export type ProfileCategory = 'fact' | 'quote' | 'preference' | 'boundary';
export const PROFILE_CATEGORIES: readonly ProfileCategory[] = ['fact', 'quote', 'preference', 'boundary'];

export interface ProfileEntry {
  id: string;
  userId: string;
  scope?: string;
  sourceWallId?: string | null;
  questionKey?: string | null;
  category: ProfileCategory;
  text: string;
  source: 'interview' | 'owner-file';
  confirmation: 'owner-stated' | 'owner-confirmed';
  createdAt: string;
  updatedAt: string;
}

function toProfileEntry(row: Record<string, unknown>): ProfileEntry {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    scope: row.scope as string,
    sourceWallId: row.source_wall_id as string | null,
    questionKey: row.question_key as string | null,
    category: row.category as ProfileCategory,
    text: row.text as string,
    source: row.source as ProfileEntry['source'],
    confirmation: row.confirmation as ProfileEntry['confirmation'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createProfileEntriesRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO profile_entries (id, user_id, category, text, source, confirmation, created_at, updated_at, scope, source_wall_id, question_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const list = db.prepare('SELECT * FROM profile_entries WHERE user_id = ? ORDER BY created_at, id');
  const deleteOne = db.prepare('DELETE FROM profile_entries WHERE id = ? AND user_id = ?');
  const deleteAll = db.prepare('DELETE FROM profile_entries WHERE user_id = ?');
  const exists = db.prepare('SELECT 1 FROM profile_entries WHERE user_id = ? AND category = ? AND text = ?');

  return {
    insert(entry: ProfileEntry): void {
      insert.run(entry.id, entry.userId, entry.category, entry.text, entry.source, entry.confirmation, entry.createdAt, entry.updatedAt, entry.scope ?? 'all', entry.sourceWallId ?? null, entry.questionKey ?? null);
    },
    updateForUser(userId: string, id: string, text: string, category: ProfileCategory, scope: string, now: string): boolean {
      return Number(db.prepare('UPDATE profile_entries SET text = ?, category = ?, scope = ?, question_key = NULL, confirmation = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(text, category, scope, 'owner-stated', now, id, userId).changes) === 1;
    },
    has(userId: string, category: ProfileCategory, text: string): boolean {
      return exists.get(userId, category, text) !== undefined;
    },
    listForUser(userId: string): ProfileEntry[] {
      return (list.all(userId) as Record<string, unknown>[]).map(toProfileEntry);
    },
    /** 只删自己的条目；返回删除的条数。 */
    deleteForUser(userId: string, entryId: string): number {
      return Number(deleteOne.run(entryId, userId).changes);
    },
    deleteAllForUser(userId: string): number {
      return Number(deleteAll.run(userId).changes);
    },
  };
}

// ---------------------------------------------------------------------------
// briefs
// ---------------------------------------------------------------------------

export type BriefStatus = 'collecting' | 'followups' | 'review' | 'confirmed';

export interface BriefRecord {
  id: string;
  pageId: string;
  ownerId: string;
  status: BriefStatus;
  answersJson: string | null;
  followupsJson: string | null;
  briefJson: string | null;
  briefMd: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toBrief(row: Record<string, unknown> | undefined): BriefRecord | null {
  if (!row) return null;
  return {
    id: row.id as string,
    pageId: row.page_id as string,
    ownerId: row.owner_id as string,
    status: row.status as BriefStatus,
    answersJson: row.answers_json as string | null,
    followupsJson: row.followups_json as string | null,
    briefJson: row.brief_json as string | null,
    briefMd: row.brief_md as string | null,
    confirmedAt: row.confirmed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** “我的资料”里列出的 brief（含墙名；墙已关闭 / 已退出也列出，只给主人自己）。 */
export interface OwnBriefListItem {
  id: string;
  pageId: string;
  wallId: string;
  wallName: string;
  wallClosed: boolean;
  membershipStatus: 'active' | 'left' | 'removed';
  status: BriefStatus;
  updatedAt: string;
}

export function createBriefsRepo(db: Database) {
  const byPage = db.prepare('SELECT * FROM briefs WHERE page_id = ? AND owner_id = ?');
  const byId = db.prepare('SELECT * FROM briefs WHERE id = ? AND owner_id = ?');
  const insert = db.prepare(
    `INSERT INTO briefs (id, page_id, owner_id, status, answers_json, followups_json, brief_json, brief_md, confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE briefs SET status = ?, answers_json = ?, followups_json = ?, brief_json = ?, brief_md = ?, confirmed_at = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?`,
  );
  const deleteById = db.prepare('DELETE FROM briefs WHERE id = ? AND owner_id = ?');
  const deleteByPage = db.prepare('DELETE FROM briefs WHERE page_id = ?');
  const listForOwner = db.prepare(
    `SELECT b.id, b.page_id, b.status, b.updated_at, w.id AS wall_id, w.name AS wall_name, w.status AS wall_status, m.status AS membership_status
       FROM briefs b
       JOIN pages p ON p.id = b.page_id
       JOIN walls w ON w.id = p.wall_id
       JOIN memberships m ON m.id = p.membership_id
      WHERE b.owner_id = ? AND p.owner_id = b.owner_id
      ORDER BY b.updated_at DESC`,
  );

  return {
    findForPage(pageId: string, ownerId: string): BriefRecord | null {
      return toBrief(byPage.get(pageId, ownerId) as Record<string, unknown> | undefined);
    },
    findById(id: string, ownerId: string): BriefRecord | null {
      return toBrief(byId.get(id, ownerId) as Record<string, unknown> | undefined);
    },
    insert(brief: BriefRecord): void {
      insert.run(
        brief.id,
        brief.pageId,
        brief.ownerId,
        brief.status,
        brief.answersJson,
        brief.followupsJson,
        brief.briefJson,
        brief.briefMd,
        brief.confirmedAt,
        brief.createdAt,
        brief.updatedAt,
      );
    },
    update(brief: BriefRecord): void {
      update.run(
        brief.status,
        brief.answersJson,
        brief.followupsJson,
        brief.briefJson,
        brief.briefMd,
        brief.confirmedAt,
        brief.updatedAt,
        brief.id,
        brief.ownerId,
      );
    },
    deleteById(id: string, ownerId: string): number {
      return Number(deleteById.run(id, ownerId).changes);
    },
    /** 删除页面时调用（调用方已确认是页面主人）。 */
    deleteForPage(pageId: string): number {
      return Number(deleteByPage.run(pageId).changes);
    },
    listForOwner(ownerId: string): OwnBriefListItem[] {
      return (listForOwner.all(ownerId) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        pageId: row.page_id as string,
        wallId: row.wall_id as string,
        wallName: row.wall_name as string,
        wallClosed: row.wall_status === 'closed',
        membershipStatus: row.membership_status as OwnBriefListItem['membershipStatus'],
        status: row.status as BriefStatus,
        updatedAt: row.updated_at as string,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// brief_assets
// ---------------------------------------------------------------------------

export type BriefAssetMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface BriefAsset {
  id: string;
  briefId: string;
  pageId: string;
  ownerId: string;
  fileName: string;
  mime: BriefAssetMime;
  bytes: number;
  sha256: string;
  createdAt: string;
}

function toAsset(row: Record<string, unknown>): BriefAsset {
  return {
    id: row.id as string,
    briefId: row.brief_id as string,
    pageId: row.page_id as string,
    ownerId: row.owner_id as string,
    fileName: row.file_name as string,
    mime: row.mime as BriefAssetMime,
    bytes: Number(row.bytes),
    sha256: row.sha256 as string,
    createdAt: row.created_at as string,
  };
}

export function createBriefAssetsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO brief_assets (id, brief_id, page_id, owner_id, file_name, mime, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const listForBrief = db.prepare('SELECT * FROM brief_assets WHERE brief_id = ? AND owner_id = ? ORDER BY file_name');
  const byId = db.prepare('SELECT * FROM brief_assets WHERE id = ? AND owner_id = ?');
  const deleteForBrief = db.prepare('DELETE FROM brief_assets WHERE brief_id = ?');
  const deleteForPage = db.prepare('DELETE FROM brief_assets WHERE page_id = ?');

  return {
    insert(asset: BriefAsset): void {
      insert.run(asset.id, asset.briefId, asset.pageId, asset.ownerId, asset.fileName, asset.mime, asset.bytes, asset.sha256, asset.createdAt);
    },
    listForBrief(briefId: string, ownerId: string): BriefAsset[] {
      return (listForBrief.all(briefId, ownerId) as Record<string, unknown>[]).map(toAsset);
    },
    findById(id: string, ownerId: string): BriefAsset | null {
      const row = byId.get(id, ownerId) as Record<string, unknown> | undefined;
      return row ? toAsset(row) : null;
    },
    deleteForBrief(briefId: string): number {
      return Number(deleteForBrief.run(briefId).changes);
    },
    deleteForPage(pageId: string): number {
      return Number(deleteForPage.run(pageId).changes);
    },
  };
}

// ---------------------------------------------------------------------------
// generation_jobs
// ---------------------------------------------------------------------------

export type JobKind = 'generate' | 'edit';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_input';

export interface JobUsage {
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GenerationJob {
  id: string;
  pageId: string;
  ownerId: string;
  kind: JobKind;
  status: JobStatus;
  baseRevisionId: string | null;
  targetBlock: string | null;
  requestText: string | null;
  rememberFacts?: boolean;
  resultMessage: string | null;
  revisionId: string | null;
  errorCode: string | null;
  charged: boolean;
  usage: JobUsage;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 入队时确定的模型来源（迁移 010 之前的任务为 null）。 */
  modelSource: JobModelSource | null;
  /** 用户模型配置的版本号（只对 own 有意义）：排队期间配置被删除或更换时任务失败。 */
  modelVersion: string | null;
  attempts: number;
}

export type JobModelSource = 'own' | 'platform';

function toJob(row: Record<string, unknown> | undefined): GenerationJob | null {
  if (!row) return null;
  return {
    id: row.id as string,
    pageId: row.page_id as string,
    ownerId: row.owner_id as string,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    baseRevisionId: row.base_revision_id as string | null,
    targetBlock: row.target_block as string | null,
    requestText: row.request_text as string | null,
    rememberFacts: Number(row.remember_facts) === 1,
    resultMessage: row.result_message as string | null,
    revisionId: row.revision_id as string | null,
    errorCode: row.error_code as string | null,
    charged: Number(row.charged) === 1,
    usage: JSON.parse((row.usage_json as string) || '{}') as JobUsage,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null,
    modelSource: (row.model_source as JobModelSource | null) ?? null,
    modelVersion: (row.model_version as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
  };
}

export interface FinishJobInput {
  status: 'succeeded' | 'failed' | 'needs_input';
  revisionId: string | null;
  errorCode: string | null;
  resultMessage: string | null;
  charged: boolean;
  usage: JobUsage;
  finishedAt: string;
}

export function createGenerationJobsRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO generation_jobs (id, page_id, owner_id, kind, status, base_revision_id, target_block, request_text, created_at, model_source, model_version)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  );
  const byId = db.prepare('SELECT * FROM generation_jobs WHERE id = ?');
  const byIdForOwner = db.prepare('SELECT * FROM generation_jobs WHERE id = ? AND page_id = ? AND owner_id = ?');
  const finish = db.prepare(
    `UPDATE generation_jobs SET status = ?, revision_id = ?, error_code = ?, result_message = ?, charged = ?, usage_json = ?, finished_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
  );
  // worker 结束任务：必须仍持有租约（租约被回收后，旧 worker 的结果作废）
  const finishLeased = db.prepare(
    `UPDATE generation_jobs SET status = ?, revision_id = ?, error_code = ?, result_message = ?, charged = ?, usage_json = ?, finished_at = ?,
        lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  );
  const markRunning = db.prepare("UPDATE generation_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'");
  const activeForOwner = db.prepare("SELECT id FROM generation_jobs WHERE owner_id = ? AND status IN ('queued', 'running') ORDER BY created_at");
  const activeIdsForPage = db.prepare("SELECT id FROM generation_jobs WHERE page_id = ? AND status IN ('queued', 'running') ORDER BY created_at");
  const cancelOne = db.prepare(
    "UPDATE generation_jobs SET status = 'failed', error_code = ?, charged = 0, finished_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('queued', 'running')",
  );
  const interruptOne = db.prepare(
    "UPDATE generation_jobs SET status = 'failed', error_code = 'INTERRUPTED', charged = 0, finished_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('queued', 'running')",
  );
  const active = db.prepare(
    "SELECT * FROM generation_jobs WHERE page_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
  );
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs WHERE page_id = ? AND created_at > ?');
  const recent = db.prepare('SELECT * FROM generation_jobs WHERE page_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT ?');
  const interrupt = db.prepare(
    "UPDATE generation_jobs SET status = 'failed', error_code = 'INTERRUPTED', charged = 0, finished_at = ? WHERE status IN ('queued', 'running')",
  );
  const eraseForPage = db.prepare('UPDATE generation_jobs SET request_text = NULL, result_message = NULL, target_block = NULL WHERE page_id = ?');

  return {
    create(
      job: Pick<GenerationJob, 'id' | 'pageId' | 'ownerId' | 'kind' | 'baseRevisionId' | 'targetBlock' | 'requestText' | 'createdAt'> &
        Partial<Pick<GenerationJob, 'modelSource' | 'modelVersion'>>,
    ): void {
      insert.run(job.id, job.pageId, job.ownerId, job.kind, job.baseRevisionId, job.targetBlock, job.requestText, job.createdAt, job.modelSource ?? null, job.modelVersion ?? null);
    },
    /** 内部使用（任务执行器）；路由请用 `findForOwner`。 */
    findById(id: string): GenerationJob | null {
      return toJob(byId.get(id) as Record<string, unknown> | undefined);
    },
    findForOwner(id: string, pageId: string, ownerId: string): GenerationJob | null {
      return toJob(byIdForOwner.get(id, pageId, ownerId) as Record<string, unknown> | undefined);
    },
    finish(id: string, input: FinishJobInput): boolean {
      return (
        Number(
          finish.run(
            input.status,
            input.revisionId,
            input.errorCode,
            input.resultMessage,
            input.charged ? 1 : 0,
            JSON.stringify(input.usage),
            input.finishedAt,
            id,
          ).changes,
        ) === 1
      );
    },
    /** worker 结束任务（必须仍持有租约 `owner`）。 */
    finishLeased(id: string, owner: string, input: FinishJobInput): boolean {
      return (
        Number(
          finishLeased.run(
            input.status,
            input.revisionId,
            input.errorCode,
            input.resultMessage,
            input.charged ? 1 : 0,
            JSON.stringify(input.usage),
            input.finishedAt,
            id,
            owner,
          ).changes,
        ) === 1
      );
    },
    /** 测试用：不经 worker 直接标记执行中（没有租约，worker 会把它当作租约已过期回收）。 */
    markRunning(id: string, now: string): boolean {
      return Number(markRunning.run(now, id).changes) === 1;
    },
    /** 主人的排队中 / 执行中的任务 ID（停用账号、注销时用）。 */
    listActiveIdsForOwner(ownerId: string): string[] {
      return (activeForOwner.all(ownerId) as { id: string }[]).map((row) => row.id);
    },
    /** 这一页排队中 / 执行中的任务 ID（删除页面、退出、被移出、关闭墙时用）。 */
    listActiveIdsForPage(pageId: string): string[] {
      return (activeIdsForPage.all(pageId) as { id: string }[]).map((row) => row.id);
    },
    /**
     * 中止一个排队中 / 执行中的任务（停用账号、注销）：标记失败并清掉租约。执行它的 worker 下一次续约或下一轮调用模型前
     * 发现租约已不在，停止后续请求，结果作废（contracts 13.4）。退点由调用方在同一个事务里做（`settleJob`）。
     */
    cancel(id: string, errorCode: string, now: string): boolean {
      return Number(cancelOne.run(errorCode, now, id).changes) === 1;
    },
    /** 被打断的任务（租约过期、优雅退出）：标记 INTERRUPTED。不重试。 */
    interrupt(id: string, now: string): boolean {
      return Number(interruptOne.run(now, id).changes) === 1;
    },
    findActive(pageId: string): GenerationJob | null {
      return toJob(active.get(pageId) as Record<string, unknown> | undefined);
    },
    countSince(pageId: string, since: string): number {
      return Number((countSince.get(pageId, since) as { n: number }).n);
    },
    listRecent(pageId: string, ownerId: string, limit = 5): GenerationJob[] {
      return (recent.all(pageId, ownerId, limit) as Record<string, unknown>[]).map((row) => toJob(row) as GenerationJob);
    },
    /** 遗留的排队 / 运行中任务一律失败（运维与测试用；worker 启动时按租约逐个回收，不再整体打断）。 */
    interruptAll(now: string): number {
      return Number(interrupt.run(now).changes);
    },
    /** 删除页面：清空内容字段，保留行。 */
    eraseContentForPage(pageId: string): number {
      return Number(eraseForPage.run(pageId).changes);
    },
  };
}
