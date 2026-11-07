/**
 * 提交管线（contracts 3、4.1、W10、W19、W21）：
 *
 * 1. 只保留白名单路径（`isPageUploadPath`）；系统文件（`isSystemFile`）静默丢弃；其他路径丢弃并在报告里加
 *    IGNORED_FILE 警告（brief.md、草稿、`../x`、`credentials` 等永远不落盘）。
 * 2. 每页每日（滚动 24 小时）上限 50 次，超出 → rate_limited（429）。
 * 3. 串行队列里调用处理器（默认真实 `buildRevision({ mode: 'submit' })`），不信任客户端的校验结果。
 * 4. 通过 → 写 `revisions/<id>/`（original/、served/、cover.png、render/full.png）再写库；
 *    不通过 → 只存 rejected 记录与报告，不写文件，不影响已有的 accepted 版本与发布。
 * 5. 写库前再确认一次凭证仍有效（处理期间主人可能断开了本地 Agent）。
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
import type { Revision, RevisionListItem } from '../db/revisions.js';
import { revalidateAgentAuth, workspaceUrl } from './agent.js';
import type { ProcessedSubmission, SubmissionProcessor } from './processor.js';
import { createSerialQueue } from './queue.js';
import { removeRevisionFiles, writeRevisionFiles } from './revision-storage.js';

export type SubmitOutcome =
  | { kind: 'stored'; summary: RevisionSummary }
  | { kind: 'rate_limited' }
  | { kind: 'credential_invalid' };

export interface SubmissionService {
  /** `files`：已通过 revisionsRequestSchema 校验的 `{ 路径: base64 }`。 */
  submit(agent: AgentAuth, files: Readonly<Record<string, string>>): Promise<SubmitOutcome>;
  /** 托管任务的结果：平台重新校验，通过才存为 `hosted` 版本；不通过不写库（hosted-route 3.1）。 */
  storeHosted(input: HostedStoreInput): Promise<HostedStoreOutcome>;
  /** 等待排队的提交处理完，然后关闭处理器（渲染器）。 */
  close(): Promise<void>;
}

export interface SubmissionServiceOptions {
  config: Pick<WebConfig, 'webOrigin' | 'dataDir'>;
  db: Database;
  repos: Repos;
  now: () => Date;
  kitFonts: KitFont[];
  processor: SubmissionProcessor;
  log?: (message: string) => void;
}

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
  /** 写库前在事务里调用：成员关系仍有效、墙未关闭、页面未删除时返回 true。 */
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

export function createSubmissionService(options: SubmissionServiceOptions): SubmissionService {
  const { config, db, repos, now, kitFonts, processor } = options;
  const log = options.log ?? ((message: string) => console.warn(`[web] ${message}`));
  const queue = createSerialQueue();

  const overLimit = (pageId: string): boolean => {
    const since = new Date(now().getTime() - REVISION_RATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    return repos.revisions.countForPageSince(pageId, since) >= REVISIONS_PER_PAGE_PER_DAY;
  };

  /** 在队列里调用：重新校验（不信任调用方）→ 写文件 → 事务里写库；失败时清理文件。 */
  async function processAndStore<T>(core: StoreCore<T>): Promise<T> {
    const processed = await processor.process({ files: core.files, kitFonts });
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
    async submit(agent, input) {
      if (overLimit(agent.page.id)) return { kind: 'rate_limited' };
      const prepared = prepareUploadedFiles(input);

      return queue.run(async (): Promise<SubmitOutcome> => {
        // 排队期间可能已有别的提交用掉了额度，或者凭证已被断开
        if (!revalidateAgentAuth(repos, agent.credential.id)) return { kind: 'credential_invalid' };
        if (overLimit(agent.page.id)) return { kind: 'rate_limited' };

        const outcome = await processAndStore<SubmitOutcome>({
          files: prepared.files,
          ignored: prepared.ignored,
          acceptedOnly: false,
          onRejected: () => ({ kind: 'credential_invalid' }),
          onAborted: () => ({ kind: 'credential_invalid' }),
          insertRow: ({ id, status, report, processed }) => {
            const auth = revalidateAgentAuth(repos, agent.credential.id);
            if (!auth) return null;
            const createdAt = now().toISOString();
            const accepted = status === 'accepted';
            const number = repos.revisions.insert({
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
            return {
              kind: 'stored',
              summary: { id, number, status, report, createdAt, workspaceUrl: workspaceUrl(config.webOrigin, auth.wall.id, id) },
            };
          },
        });
        if (outcome.kind === 'stored') {
          const { summary } = outcome;
          log(`提交 ${agent.page.id} #${summary.number}：${summary.status}（${summary.report.errors.length} 个错误，${summary.report.warnings.length} 个警告）`);
        }
        return outcome;
      });
    },
    async storeHosted(input) {
      // 托管任务的结果只取白名单路径（模型工具本来就只能写三个文本文件，这里再过滤一次）
      const files: PageFiles = new Map([...input.files].filter(([path]) => isPageUploadPath(path) && !isSystemFile(path)));
      return queue.run(async (): Promise<HostedStoreOutcome> => {
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
      });
    },
    async close() {
      await queue.idle();
      await processor.close();
    },
  };
}
