/**
 * 提交管线（contracts 3、4.1、13、W10、W19、W21）：
 *
 * 1. 只保留白名单路径（`isPageUploadPath`）；系统文件（`isSystemFile`）静默丢弃；其他路径丢弃并在报告里加
 *    IGNORED_FILE 警告（brief.md、草稿、`../x`、`credentials` 等永远不落盘）。
 * 2. 每页每日（滚动 24 小时）上限 50 次，超出 → rate_limited（429）。
 * 3. 主站把过滤后的文件暂存到 `<dataDir>/jobs/<id>/files/` 并入队（render_jobs，contracts 13），等待 worker；
 *    worker 在串行的渲染通道里调用处理器（默认真实 `buildRevision({ mode: 'submit' })`），不信任客户端的校验结果。
 * 4. 通过 → 写 `revisions/<id>/`（original/、served/、cover.png、render/full.png）再写库；
 *    不通过 → 只存 rejected 记录与报告，不写文件，不影响已有的 accepted 版本与发布。
 * 5. 写库前再确认一次凭证仍有效（处理期间主人可能断开了本地 Agent），并确认仍持有任务租约；
 *    写版本与结束任务在同一个事务里，租约过期后的重试不会重复存版本。
 */
import {
  CREDENTIAL_LIKE_PATTERN,
  generateId,
  isPageUploadPath,
  PAGE_CARD_FILE,
  PAGE_MANIFEST_FILE,
  REVISIONS_PER_PAGE_PER_DAY,
  type KitFont,
  type PageFiles,
  type RevisionSummary,
  type ValidationIssue,
  type ValidationReport,
} from '@nowme/contracts';
import { isSystemFile } from '@nowme/validator';
import { REVISION_RATE_WINDOW_HOURS } from '../constants.js';
import type { AgentAuth, WebConfig } from '../context.js';
import { transaction, type Database, type Repos } from '../db/index.js';
import type { RenderJob } from '../db/job-queue.js';
import type { Revision, RevisionListItem } from '../db/revisions.js';
import type { JobDispatch } from '../worker/dispatch.js';
import type { JobContext } from '../worker/runtime.js';
import { readStaged, removeStaging, stageFiles } from '../worker/staging.js';
import { revalidateAgentAuth, workspaceUrl } from './agent.js';
import type { ProcessedSubmission, SubmissionProcessor } from './processor.js';
import type { SerialQueue } from './queue.js';
import { removeRevisionFiles, writeRevisionFiles } from './revision-storage.js';

export type SubmitOutcome =
  | { kind: 'stored'; summary: RevisionSummary }
  | { kind: 'rate_limited' }
  | { kind: 'credential_invalid' }
  /** 渲染出错（处理器异常、重试次数用完）。 */
  | { kind: 'failed' }
  /** 等了太久还没轮到（worker 没在运行或队列太长）。 */
  | { kind: 'unavailable' };

/** 主站一侧：校验额度、暂存文件、入队，等待 worker 处理完。 */
export interface SubmissionService {
  /** `files`：已通过 revisionsRequestSchema 校验的 `{ 路径: base64 }`。 */
  submit(agent: AgentAuth, files: Readonly<Record<string, string>>): Promise<SubmitOutcome>;
}

export interface SubmissionServiceOptions {
  config: Pick<WebConfig, 'webOrigin' | 'dataDir'>;
  db: Database;
  repos: Repos;
  now: () => Date;
  dispatch: JobDispatch;
  /** 等待渲染结果的上限（毫秒）。 */
  waitMs?: number;
}

/** worker 一侧：真正的渲染与写库。 */
export interface SubmissionStore {
  /** 执行一个提交渲染任务（render_jobs.kind = submission）。 */
  runSubmission(job: RenderJob, ctx: JobContext): Promise<void>;
  /** 托管任务的结果：平台重新校验，通过才存为 `hosted` 版本；不通过不写库（hosted-route 3.1）。 */
  storeHosted(input: HostedStoreInput): Promise<HostedStoreOutcome>;
}

export interface SubmissionStoreOptions {
  config: Pick<WebConfig, 'webOrigin' | 'dataDir'>;
  db: Database;
  repos: Repos;
  now: () => Date;
  kitFonts: KitFont[];
  processor: SubmissionProcessor;
  /** 渲染通道：所有浏览器渲染串行。 */
  lane: SerialQueue;
  log?: (message: string) => void;
}

/** 提交渲染任务的最多尝试次数（只有租约过期才会重试；处理器抛错不重试）。 */
export const SUBMISSION_MAX_ATTEMPTS = 3;
/** 主站等待一次提交渲染的上限。CLI 的请求超时更短，这里只防止请求永远挂着。 */
export const SUBMISSION_WAIT_MS = 3 * 60_000;

export interface PreparedFiles {
  files: PageFiles;
  /** 被丢弃的非白名单路径（不含系统文件）。 */
  ignored: string[];
}

/** 解码并过滤上传的文件（见文件头第 1 步）。 */
export function prepareUploadedFiles(input: Readonly<Record<string, string>>): PreparedFiles {
  const files: PageFiles = new Map();
  const ignored: string[] = [];
  for (const [path, base64] of Object.entries(input)) {
    if (isSystemFile(path)) continue;
    if (!isPageUploadPath(path)) {
      ignored.push(path);
      continue;
    }
    files.set(path, new Uint8Array(Buffer.from(base64, 'base64')));
  }
  return { files, ignored };
}

const CREDENTIAL_LIKE_GLOBAL = new RegExp(CREDENTIAL_LIKE_PATTERN.source, 'g');

/** 报告里显示的路径：截断到 80 个字符，并遮住疑似凭证（路径由客户端提供，会存进 report_json）。 */
function displayPath(path: string): string {
  const masked = path.replace(CREDENTIAL_LIKE_GLOBAL, (match) => `${match.slice(0, 8)}…`);
  const chars = Array.from(masked);
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : masked;
}

/** 把服务端丢弃的路径作为 IGNORED_FILE 警告并入报告（不影响 ok）。 */
export function withIgnoredFiles(report: ValidationReport, ignored: readonly string[]): ValidationReport {
  if (ignored.length === 0) return report;
  const warnings: ValidationIssue[] = ignored.map((path) => ({
    code: 'IGNORED_FILE',
    severity: 'warning',
    file: displayPath(path),
    message: `服务端没有接收 ${displayPath(path)}：只接收 index.html、card.json、manifest.json、cover.png 与 assets/ 下的文件`,
    hint: '这个文件没有上传，也不会出现在页面里；brief、草稿与凭证请留在本地，不要放进 page/。',
  }));
  return {
    ...report,
    warnings: [...report.warnings, ...warnings],
    stats: { ...report.stats, ignoredFiles: [...report.stats.ignoredFiles, ...ignored.map(displayPath)] },
  };
}

/** 文件内容 → 规范化的 JSON 文本；解析失败返回 null。 */
function normalizedJson(content: Uint8Array | undefined): string | null {
  if (!content) return null;
  try {
    return JSON.stringify(JSON.parse(Buffer.from(content).toString('utf8')));
  } catch {
    return null;
  }
}

export function revisionSummary(webOrigin: string, wallId: string, revision: Revision | RevisionListItem): RevisionSummary {
  return {
    id: revision.id,
    number: revision.number,
    status: revision.status,
    report: revision.report,
    createdAt: revision.createdAt,
    workspaceUrl: workspaceUrl(webOrigin, wallId, revision.id),
  };
}

/** 托管任务写入版本的结果（hosted-route 3.1 第 4–5 步）。 */
export type HostedStoreOutcome =
  | { kind: 'stored'; revisionId: string; number: number; report: ValidationReport }
  | { kind: 'rejected'; report: ValidationReport }
  | { kind: 'rate_limited' }
  | { kind: 'page_invalid' };

export interface HostedStoreInput {
  pageId: string;
  /** 写库前在事务里调用：成员关系仍有效、墙未关闭、页面未删除（且 worker 仍持有任务租约）时返回 true。 */
  stillValid: () => boolean;
  files: PageFiles;
  /** 平台附加的信息性警告（例如修改任务的 HOSTED_BLOCKS_CHANGED），不影响 ok。 */
  extraWarnings?: ValidationIssue[];
}

/** 处理器 + 写文件 + 写库的共用部分。`insertRow` 在事务里执行，返回 null 表示放弃（文件会被删除）。 */
interface StoreCore<T> {
  files: PageFiles;
  ignored: readonly string[];
  extraWarnings?: readonly ValidationIssue[];
  /** 只有 accepted 才存？false：rejected 也存一条记录（Agent API）；true：rejected 不写库（托管任务）。 */
  acceptedOnly: boolean;
  insertRow: (row: { id: string; status: 'accepted' | 'rejected'; report: ValidationReport; processed: ProcessedSubmission }) => T | null;
  onRejected: (report: ValidationReport) => T;
  onAborted: () => T;
}

function overLimitFor(repos: Repos, now: () => Date) {
  return (pageId: string): boolean => {
    const since = new Date(now().getTime() - REVISION_RATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    return repos.revisions.countForPageSince(pageId, since) >= REVISIONS_PER_PAGE_PER_DAY;
  };
}

export function createSubmissionService(options: SubmissionServiceOptions): SubmissionService {
  const { config, db, repos, now, dispatch } = options;
  const overLimit = overLimitFor(repos, now);
  const waitMs = options.waitMs ?? SUBMISSION_WAIT_MS;

  return {
    async submit(agent, input) {
      if (overLimit(agent.page.id)) return { kind: 'rate_limited' };
      const prepared = prepareUploadedFiles(input);
      const jobId = generateId('job');
      await stageFiles(config.dataDir, jobId, prepared.files, prepared.ignored);
      try {
        transaction(db, () => {
          const createdAt = now().toISOString();
          repos.queue.enqueueRender({ id: jobId, kind: 'submission', pageId: agent.page.id, credentialId: agent.credential.id, maxAttempts: SUBMISSION_MAX_ATTEMPTS, createdAt });
          repos.jobEvents.append(jobId, 'queued', createdAt, { files: prepared.files.size });
        });
      } catch (error) {
        await removeStaging(config.dataDir, jobId);
        throw error;
      }
      dispatch.kick();
      const job = await dispatch.waitRender(jobId, waitMs);
      if (!job) return { kind: 'failed' };
      if (job.status === 'queued' || job.status === 'running') {
        // 还没轮到就放弃：不再执行；已经在执行的让它做完（结果照常保存）
        if (repos.queue.abandonRender(jobId, now().toISOString())) {
          repos.jobEvents.append(jobId, 'failed', now().toISOString());
          await removeStaging(config.dataDir, jobId);
        }
        return { kind: 'unavailable' };
      }
      if (job.status === 'failed') return { kind: 'failed' };
      switch (job.outcome) {
        case 'stored': {
          const revision = job.revisionId ? repos.revisions.findById(job.revisionId) : null;
          if (!revision) return { kind: 'failed' };
          return { kind: 'stored', summary: revisionSummary(config.webOrigin, agent.wall.id, revision) };
        }
        case 'rate_limited':
          return { kind: 'rate_limited' };
        default:
          return { kind: 'credential_invalid' };
      }
    },
  };
}

export function createSubmissionStore(options: SubmissionStoreOptions): SubmissionStore {
  const { config, db, repos, now, kitFonts, processor, lane } = options;
  const log = options.log ?? ((message: string) => console.warn(`[web] ${message}`));
  const overLimit = overLimitFor(repos, now);

  /** 在渲染通道里调用处理器：重新校验（不信任调用方）→ 写文件 → 事务里写库；失败时清理文件。 */
  async function processAndStore<T>(core: StoreCore<T>): Promise<T> {
    const processed = await lane.run(() => processor.process({ files: core.files, kitFonts }));
    const withIgnored = withIgnoredFiles(processed.report, core.ignored);
    const report =
      core.extraWarnings && core.extraWarnings.length > 0 ? { ...withIgnored, warnings: [...withIgnored.warnings, ...core.extraWarnings] } : withIgnored;
    const status = report.ok ? 'accepted' : 'rejected';
    if (status === 'rejected' && core.acceptedOnly) return core.onRejected(report);
    const id = generateId('rev');
    if (status === 'accepted') {
      await writeRevisionFiles(config.dataDir, id, {
        original: core.files,
        served: processed.served,
        cover: processed.cover,
        fullScreenshot: processed.fullScreenshot,
      });
    }
    let outcome: T | null;
    try {
      outcome = transaction(db, () => core.insertRow({ id, status, report, processed }));
    } catch (error) {
      if (status === 'accepted') await removeRevisionFiles(config.dataDir, id);
      throw error;
    }
    if (outcome === null) {
      if (status === 'accepted') await removeRevisionFiles(config.dataDir, id);
      return core.onAborted();
    }
    return outcome;
  }

  return {
    async runSubmission(job, ctx) {
      const finish = (outcome: 'rate_limited' | 'credential_invalid') => {
        if (repos.queue.completeRender(job.id, ctx.workerId, { outcome, now: now().toISOString() })) ctx.progress('failed');
      };
      try {
        // 排队期间可能已有别的提交用掉了额度，或者凭证已被断开
        if (!revalidateAgentAuth(repos, job.credentialId)) return finish('credential_invalid');
        if (overLimit(job.pageId)) return finish('rate_limited');
        const prepared = await readStaged(config.dataDir, job.id);
        ctx.progress('validating', { attempt: job.attempts });
        ctx.progress('rendering', { attempt: job.attempts });

        let lost = false;
        let invalid = false;
        const stored = await processAndStore<Revision | null>({
          files: prepared.files,
          ignored: prepared.ignored,
          acceptedOnly: false,
          onRejected: () => null,
          onAborted: () => null,
          insertRow: ({ id, status, report, processed }) => {
            // 租约已被回收（别的 worker 会重做）：什么都不写
            if (!repos.queue.holdsRender(job.id, ctx.workerId)) {
              lost = true;
              return null;
            }
            const auth = revalidateAgentAuth(repos, job.credentialId);
            if (!auth) {
              invalid = true;
              return null;
            }
            const createdAt = now().toISOString();
            const accepted = status === 'accepted';
            repos.revisions.insert({
              id,
              pageId: auth.page.id,
              source: 'local-agent',
              credentialId: auth.credential.id,
              status,
              report,
              cardJson: accepted ? normalizedJson(prepared.files.get(PAGE_CARD_FILE)) : null,
              manifestJson: accepted ? normalizedJson(prepared.files.get(PAGE_MANIFEST_FILE)) : null,
              renderedText: accepted ? processed.renderedText : null,
              renderJson: accepted && processed.render ? JSON.stringify(processed.render) : null,
              createdAt,
            });
            repos.credentials.touch(auth.credential.id, createdAt);
            repos.pages.touch(auth.page.id, createdAt);
            // 写版本与结束任务在同一个事务里：重试不会重复存版本
            repos.queue.completeRender(job.id, ctx.workerId, { outcome: 'stored', revisionId: id, now: createdAt });
            return repos.revisions.findById(id);
          },
        });
        if (lost) return;
        if (invalid || !stored) return finish('credential_invalid');
        ctx.progress(stored.status === 'accepted' ? 'succeeded' : 'failed');
        log(`提交 ${job.pageId} #${stored.number}：${stored.status}（${stored.report.errors.length} 个错误，${stored.report.warnings.length} 个警告）`);
      } finally {
        // 任务结束（不论结果）才删暂存；租约丢失或交还时保留，留给重试
        const row = repos.queue.findRender(job.id);
        if (!row || row.status === 'done') await removeStaging(config.dataDir, job.id);
      }
    },
    async storeHosted(input) {
      // 托管任务的结果只取白名单路径（模型工具本来就只能写三个文本文件，这里再过滤一次）
      const files: PageFiles = new Map([...input.files].filter(([path]) => isPageUploadPath(path) && !isSystemFile(path)));
      if (!input.stillValid()) return { kind: 'page_invalid' };
      if (overLimit(input.pageId)) return { kind: 'rate_limited' };
      const outcome = await processAndStore<HostedStoreOutcome>({
        files,
        ignored: [],
        extraWarnings: input.extraWarnings,
        acceptedOnly: true,
        onRejected: (report) => ({ kind: 'rejected', report }),
        onAborted: () => ({ kind: 'page_invalid' }),
        insertRow: ({ id, report, processed }) => {
          if (!input.stillValid()) return null;
          const createdAt = now().toISOString();
          const number = repos.revisions.insert({
            id,
            pageId: input.pageId,
            source: 'hosted',
            credentialId: null,
            status: 'accepted',
            report,
            cardJson: normalizedJson(files.get(PAGE_CARD_FILE)),
            manifestJson: normalizedJson(files.get(PAGE_MANIFEST_FILE)),
            renderedText: processed.renderedText,
            renderJson: processed.render ? JSON.stringify(processed.render) : null,
            createdAt,
          });
          repos.pages.touch(input.pageId, createdAt);
          return { kind: 'stored', revisionId: id, number, report };
        },
      });
      if (outcome.kind === 'stored') log(`托管生成 ${input.pageId} #${outcome.number}：accepted`);
      return outcome;
    },
  };
}
