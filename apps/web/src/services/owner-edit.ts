/**
 * 直接改文字的主站一侧（contracts 22.2）：拼出新版本的文件 → 暂存 → 入队 → 等 worker 存版本。
 *
 * 新版本的文件 = 基础版本 `original/` 的白名单文件，换上新的 `index.html`，去掉 `cover.png`（旧封面上是旧文字）。
 * 不调用模型、不扣点数、不改 brief。worker 一侧见 `SubmissionStore.runOwnerEdit`。
 */
import { join } from 'node:path';
import { generateId, isPageUploadPath, PAGE_COVER_FILE, PAGE_INDEX_FILE, REVISIONS_PER_PAGE_PER_DAY, type PageFiles, type ValidationReport } from '@nowme/contracts';
import { isSystemFile } from '@nowme/validator';
import { readPageDir } from '@nowme/validator/node';
import { REVISION_RATE_WINDOW_HOURS } from '../constants.js';
import type { WebConfig } from '../context.js';
import { transaction, type Database, type Repos } from '../db/index.js';
import type { Revision } from '../db/revisions.js';
import type { JobDispatch } from '../worker/dispatch.js';
import { readResult, removeStaging, stageFiles } from '../worker/staging.js';
import type { OwnPage } from './access.js';
import { REVISION_ORIGINAL_DIR, revisionDir } from './revision-storage.js';
import { SUBMISSION_MAX_ATTEMPTS, SUBMISSION_WAIT_MS, type OwnerEditRejection } from './submissions.js';

export type OwnerEditOutcome =
  | { kind: 'stored'; revisionId: string }
  | { kind: 'rejected'; report: ValidationReport }
  | { kind: 'rate_limited' }
  /** 等待期间主人失去了这一页（被移出、墙关闭、页面删除）。 */
  | { kind: 'gone' }
  /** 还在排队或渲染中，没等到结果（结果出来后会出现在“做过的每一版”里）。 */
  | { kind: 'pending' }
  | { kind: 'failed' };

export interface OwnerEditService {
  /** 读出基础版本的 `index.html`（不存在时 null）。 */
  readIndex(revision: Revision): Promise<string | null>;
  /** 用新的 `index.html` 存一个新版本。调用方已确认 `own` 是主人、`base` 是这一页可用的版本。 */
  submit(own: OwnPage, base: Revision, html: string): Promise<OwnerEditOutcome>;
}

export interface OwnerEditServiceOptions {
  config: Pick<WebConfig, 'dataDir'>;
  db: Database;
  repos: Repos;
  now: () => Date;
  dispatch: JobDispatch;
  waitMs?: number;
}

export function createOwnerEditService(options: OwnerEditServiceOptions): OwnerEditService {
  const { config, db, repos, now, dispatch } = options;
  const waitMs = options.waitMs ?? SUBMISSION_WAIT_MS;

  const originalDir = (revision: Revision) => join(revisionDir(config.dataDir, revision.id), REVISION_ORIGINAL_DIR);

  const overLimit = (pageId: string): boolean => {
    const since = new Date(now().getTime() - REVISION_RATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    return repos.revisions.countForPageSince(pageId, since) >= REVISIONS_PER_PAGE_PER_DAY;
  };

  return {
    async readIndex(revision) {
      try {
        const files = await readPageDir(originalDir(revision));
        const index = files.get(PAGE_INDEX_FILE);
        return index ? new TextDecoder().decode(index) : null;
      } catch {
        return null;
      }
    },

    async submit(own, base, html) {
      if (overLimit(own.page.id)) return { kind: 'rate_limited' };
      let original: PageFiles;
      try {
        original = await readPageDir(originalDir(base));
      } catch {
        return { kind: 'failed' };
      }
      const files: PageFiles = new Map();
      for (const [path, content] of original) {
        if (!isPageUploadPath(path) || isSystemFile(path) || path === PAGE_COVER_FILE) continue;
        files.set(path, content);
      }
      files.set(PAGE_INDEX_FILE, new TextEncoder().encode(html));

      const jobId = generateId('job');
      await stageFiles(config.dataDir, jobId, files, []);
      try {
        transaction(db, () => {
          const createdAt = now().toISOString();
          repos.queue.enqueueRender({ id: jobId, kind: 'owner-edit', pageId: own.page.id, ownerId: own.page.ownerId, maxAttempts: SUBMISSION_MAX_ATTEMPTS, createdAt });
          repos.jobEvents.append(jobId, 'queued', createdAt, { files: files.size });
        });
      } catch (error) {
        await removeStaging(config.dataDir, jobId);
        throw error;
      }
      dispatch.kick();
      const job = await dispatch.waitRender(jobId, waitMs);
      if (!job) return { kind: 'failed' };
      if (job.status === 'queued' || job.status === 'running') {
        if (repos.queue.abandonRender(jobId, now().toISOString())) {
          await removeStaging(config.dataDir, jobId);
          return { kind: 'failed' };
        }
        return { kind: 'pending' };
      }
      const rejection = job.status === 'done' && job.outcome === 'rejected' ? await readResult<OwnerEditRejection>(config.dataDir, jobId) : null;
      await removeStaging(config.dataDir, jobId);
      if (job.status === 'failed') return { kind: 'failed' };
      switch (job.outcome) {
        case 'stored':
          return job.revisionId ? { kind: 'stored', revisionId: job.revisionId } : { kind: 'failed' };
        case 'rejected':
          return rejection ? { kind: 'rejected', report: rejection.report } : { kind: 'failed' };
        case 'rate_limited':
          return { kind: 'rate_limited' };
        case 'credential_invalid':
          return { kind: 'gone' };
        default:
          return { kind: 'failed' };
      }
    },
  };
}
