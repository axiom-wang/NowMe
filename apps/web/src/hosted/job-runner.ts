/**
 * 托管生成 / 修改任务的执行（hosted-route 3.1、S8；contracts 13）：只在 worker 里运行。
 *
 * - 任务由主站入队（`generation_jobs.status = queued`，已扣点）；worker 领取后带租约执行，执行中写进度事件；
 * - 每个任务一个独立临时目录，结束必删；结果经平台的提交管线重新校验，通过才存版本；
 * - 结束（成功 / 失败 / 需要补充说明）与结算点数在同一个事务里，且必须仍持有租约：租约被回收后旧 worker 的结果作废；
 *   成功时“写版本 + 结算 + 结束任务”是同一个事务：存下了新版本就一定保留扣点，没存下才全额退回，
 *   不会出现“版本存下了、点数也退了”（停用、注销、租约回收与它们互斥）；
 * - 每轮调用模型前确认仍持有租约、页面与成员关系仍有效（被移出、退出、墙关闭时立即停止，按 PAGE_GONE 退点）；
 * - 不重试：被打断（租约过期、优雅退出超时）的任务标记 INTERRUPTED 并全额退点，避免重复计费。
 */
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTED_JOB_TIMEOUT_MS, type HostedConfig, type ValidationIssue } from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import { validatePage } from '@nowme/validator';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { BriefAsset, GenerationJob, JobUsage } from '../db/hosted.js';
import { findOwnPage, type OwnPage } from '../services/access.js';
import { settleJob } from '../services/billing.js';
import { buildAgentContext } from '../services/agent.js';
import { revisionDir, REVISION_ORIGINAL_DIR } from '../services/revision-storage.js';
import type { SubmissionStore } from '../services/submissions.js';
import type { JobContext } from '../worker/runtime.js';
import { readAsset } from './assets.js';
import { untrusted, type UsageTotals } from './model-client.js';
import { modelFailureCode } from './model-errors.js';
import { RunError, runGeneration } from './runner.js';
import { loadBriefView, usageProps, type BriefView } from './service.js';
import { GenerationWorkspace, type PagePreviewer } from './tools.js';
import type { ResolvedModel } from './user-models.js';

export type GenerationDeps = Pick<AppDeps, 'config' | 'db' | 'repos' | 'now' | 'kitFonts' | 'log'>;

export interface GenerationExecutorOptions {
  settings: HostedConfig;
  /** 按任务入队时记下的来源取模型（`model_source` / `model_version`）。不可用时抛 ModelAccessError。 */
  resolveJob(job: GenerationJob): ResolvedModel;
  previewer: PagePreviewer;
  store: Pick<SubmissionStore, 'storeHosted'>;
  /** 任务临时目录的父目录，默认 `os.tmpdir()`（测试用来断言任务结束后目录被删除）。 */
  tempRoot?: string;
}

/** 每轮调用模型前发现任务不该再继续（租约已不在，或页面 / 成员关系已无效）。 */
class JobStopped extends Error {
  override name = 'JobStopped';
}

export interface GenerationExecutor {
  run(jobId: string, ctx: JobContext): Promise<void>;
  /** 租约过期（执行它的 worker 已经不在了）：标记 INTERRUPTED 并退点。 */
  interrupt(jobId: string): void;
}

export function createGenerationExecutor(deps: GenerationDeps, options: GenerationExecutorOptions): GenerationExecutor {
  const { repos, db, config } = deps;
  const { settings, previewer } = options;

  const stillValid = (pageId: string, ownerId: string, wallId: string) => () => {
    const own = findOwnPage(repos, ownerId, wallId);
    return own !== null && own.page.id === pageId;
  };

  function firstMessage(own: OwnPage, job: GenerationJob, briefMd: string | null, assets: BriefAsset[], baseNumber: number | null, imageNotes: Map<string, string>): string {
    const context = buildAgentContext({ repos, config, kitFonts: deps.kitFonts }, own.wall, own.page);
    const parts = [
      job.kind === 'generate' ? '任务：按 brief 生成主人的页面（Skill 第 4–5 步），完成后调用 finish。' : '任务：按主人的修改要求修改页面（Skill 第 6 步），完成后调用 finish。',
      untrusted('wall_context', JSON.stringify({ wall: context.wall, kit: { version: context.kit.version, basePath: context.kit.basePath, fonts: context.kit.fonts.map(({ id, family, cjk, weights }) => ({ id, family, cjk, weights })) }, limits: context.limits }, null, 2)),
      untrusted('scene_guide', JSON.stringify(loadSceneGuide(own.wall.sceneType), null, 2)),
      briefMd ? untrusted('owner_brief', briefMd) : '（这一页没有应用内采访的 brief；修改时只用页面里已有的内容和修改要求里主人新说的话。）',
      assets.length > 0
        ? `page/assets/ 里已有主人上传的图片：\n${assets.map((asset) => `- assets/${asset.fileName}${imageNotes.get(asset.fileName) ? `：${imageNotes.get(asset.fileName)}` : ''}`).join('\n')}`
        : 'page/assets/ 里没有主人上传的图片；装饰请用内联 SVG / CSS。',
    ];
    if (job.kind === 'edit') {
      parts.push(`基础版本：第 ${baseNumber ?? '?'} 版，文件已经在 page/ 里（先用 read_page_file 读）。`);
      parts.push(`目标区块：${job.targetBlock ? `data-nm-id="${job.targetBlock}"（只改这个区块）` : '主人没有指定；从修改要求判断，范围不清时用 finish 的 clarify 提问'}`);
      parts.push(untrusted('owner_edit_request', job.requestText ?? ''));
    }
    return parts.join('\n\n');
  }

  async function prepareDir(own: OwnPage, job: GenerationJob, view: BriefView | null): Promise<{ dir: string; baseBlocks: string[] | null; baseNumber: number | null }> {
    const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'nowme-gen-'));
    const pageDir = join(dir, 'page');
    await mkdir(join(pageDir, 'assets'), { recursive: true });
    let baseBlocks: string[] | null = null;
    let baseNumber: number | null = null;
    if (job.kind === 'edit' && job.baseRevisionId) {
      const base = repos.revisions.findById(job.baseRevisionId);
      if (!base || base.pageId !== own.page.id) throw new Error('基础版本不存在');
      baseBlocks = base.report.stats.blocks;
      baseNumber = base.number;
      await cp(join(revisionDir(config.dataDir, base.id), REVISION_ORIGINAL_DIR), pageDir, { recursive: true, force: true });
      // 封面会由平台重新生成，避免修改后封面不更新
      await rm(join(pageDir, 'cover.png'), { force: true });
    }
    if (view) {
      const present = new Set(await readdir(join(pageDir, 'assets')));
      for (const asset of view.assets) {
        if (present.has(asset.fileName)) continue;
        await writeFile(join(pageDir, 'assets', asset.fileName), await readAsset(config.dataDir, own.page.id, asset.fileName));
      }
      if (view.record.briefMd) await writeFile(join(dir, 'brief.md'), view.record.briefMd, 'utf8');
    }
    const context = buildAgentContext({ repos, config, kitFonts: deps.kitFonts }, own.wall, own.page);
    await writeFile(join(dir, 'context.json'), JSON.stringify(context, null, 2), 'utf8');
    return { dir, baseBlocks, baseNumber };
  }

  async function run(jobId: string, ctx: JobContext): Promise<void> {
    const job = repos.jobs.findById(jobId);
    if (!job) return;
    const page = repos.pages.findById(job.pageId);
    const own = page ? findOwnPage(repos, job.ownerId, page.wallId) : null;
    const started = Date.now();
    let usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let turns = 0;
    let dir: string | null = null;

    type FinishInput = { revisionId?: string; errorCode?: string; message?: string; httpStatus?: number | null };
    type FinishStatus = 'succeeded' | 'failed' | 'needs_input';

    /** 结算与结束同一个事务，且必须仍持有租约：成功才保留扣点；失败、需要补充说明都全额退回。可以嵌套在写版本的事务里。 */
    const settleAndFinish = (status: FinishStatus, input: FinishInput): boolean => {
      const jobUsage: JobUsage = { turns, ...usage };
      return transaction(db, () => {
        if (!repos.queue.holdsGeneration(jobId, ctx.workerId)) return false;
        const charged = settleJob(deps, jobId, status === 'succeeded');
        return repos.jobs.finishLeased(jobId, ctx.workerId, {
          status,
          revisionId: input.revisionId ?? null,
          errorCode: input.errorCode ?? null,
          resultMessage: input.message ?? null,
          charged,
          usage: jobUsage,
          finishedAt: deps.now().toISOString(),
        });
      });
    };

    /** 任务已经结束之后：进度事件、统计事件与日志。 */
    const announce = (status: FinishStatus, input: FinishInput) => {
      const ok = status === 'succeeded';
      ctx.progress(status, turns > 0 ? { turn: turns } : undefined);
      if (page) {
        repos.events.record({
          type: job.kind === 'generate' ? 'hosted_generate' : 'hosted_edit',
          wallId: page.wallId,
          pageId: page.id,
          actorId: job.ownerId,
          props: {
            ok,
            clarify: status === 'needs_input',
            turns,
            durationMs: Date.now() - started,
            ...usageProps(usage),
            ...(job.kind === 'edit' ? { targeted: job.targetBlock !== null } : {}),
          },
          createdAt: deps.now().toISOString(),
        });
      }
      deps.log(`[web] 托管任务 ${jobId}（${job.kind}）：${status}${input.errorCode ? ` ${input.errorCode}` : ''}${input.httpStatus ? `（HTTP ${input.httpStatus}）` : ''}，${turns} 轮`);
    };

    const finish = (status: FinishStatus, input: FinishInput) => {
      if (!settleAndFinish(status, input)) {
        deps.log(`[web] 托管任务 ${jobId}（${job.kind}）的租约已被回收，本次结果作废`);
        return;
      }
      announce(status, input);
    };

    if (!own || !page) {
      finish('failed', { errorCode: 'PAGE_GONE' });
      return;
    }
    // 迁移 010 之前入队的任务不知道该用谁的模型：按被打断处理（退点）
    if (!job.modelSource) {
      finish('failed', { errorCode: 'INTERRUPTED' });
      return;
    }
    const valid = stillValid(page.id, job.ownerId, page.wallId);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), HOSTED_JOB_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout.signal, ctx.signal]);
    // 优雅退出或租约丢失导致的取消：算作被打断，而不是超时
    const interruptedCode = (code: string) => (ctx.signal.aborted ? 'INTERRUPTED' : code);
    try {
      const model = options.resolveJob(job);
      ctx.progress('reading');
      const view = loadBriefView(repos, own, job.ownerId);
      const confirmed = view?.record.status === 'confirmed' ? view : null;
      const prepared = await prepareDir(own, job, confirmed);
      dir = prepared.dir;
      const notes = new Map((view?.brief?.images ?? []).map((image) => [image.file, image.description]));
      const workspace = new GenerationWorkspace(dir, deps.kitFonts, previewer);
      let wrote = false;
      let currentTurn = 0;
      const result = await runGeneration({
        client: model.client,
        model: model.endpoint.model!,
        maxTurns: settings.maxTurns,
        workspace,
        firstMessage: firstMessage(own, job, confirmed?.record.briefMd ?? null, confirmed?.assets ?? [], prepared.baseNumber, notes),
        signal,
        onTurn: (turn) => {
          // 每轮调用模型前确认仍持有租约、页面与成员关系仍有效：任务被中止（停用账号、注销、删除页面、退出、被移出、
          // 关闭墙）或被回收后，不再发出后续模型请求
          if (!repos.queue.holdsGeneration(jobId, ctx.workerId) || !valid()) throw new JobStopped('任务已被中止、租约已被回收或页面已不可用');
          currentTurn = turn;
          // 还没写过文件时模型在读参考、构思版式（设计）；写过之后是生成与修改
          ctx.progress(wrote ? 'generating' : 'designing', { turn, maxTurns: settings.maxTurns });
        },
        onTool: (name) => {
          if (name === 'write_page_file') wrote = true;
          else if (name === 'validate_page') ctx.progress('validating', { turn: currentTurn });
          else if (name === 'preview_page') ctx.progress('rendering', { turn: currentTurn });
        },
      });
      usage = result.usage;
      turns = result.turns;
      if (ctx.signal.aborted) {
        finish('failed', { errorCode: 'INTERRUPTED' });
        return;
      }
      if (result.finish.outcome === 'clarify') {
        finish('needs_input', { message: result.finish.message || '需要你说得再具体一点：想改哪一块？' });
        return;
      }
      ctx.progress('validating', { turn: turns });
      const files = await workspace.readFiles();
      const extraWarnings: ValidationIssue[] = [];
      if (job.kind === 'edit' && job.targetBlock && prepared.baseBlocks) {
        const after = validatePage(files, { kitFonts: deps.kitFonts }).stats.blocks;
        const same = after.length === prepared.baseBlocks.length && after.every((block) => prepared.baseBlocks?.includes(block));
        if (!same) {
          extraWarnings.push({
            code: 'HOSTED_BLOCKS_CHANGED',
            severity: 'warning',
            file: 'index.html',
            message: `这次只要求修改区块 ${job.targetBlock}，但页面的区块从 ${prepared.baseBlocks.join('、')} 变成了 ${after.join('、')}`,
            hint: '预览时留意其他区块是否被改动；不满意可以继续修改，或发布之前的版本。',
          });
        }
      }
      ctx.progress('rendering', { turn: turns });
      const message = result.finish.message;
      const stored = await options.store.storeHosted({
        pageId: page.id,
        // 写版本时仍须持有租约：租约被回收（任务已被标记失败并退点）后不能再存版本
        stillValid: () => repos.queue.holdsGeneration(jobId, ctx.workerId) && valid(),
        files,
        extraWarnings,
        // 与写版本同一个事务：结算（保留扣点）并结束任务。上面的 stillValid 已在这个事务里确认持有租约
        onStored: (revisionId) => {
          if (!settleAndFinish('succeeded', { revisionId, message })) throw new Error('写版本时租约已不在');
        },
      });
      switch (stored.kind) {
        case 'stored':
          announce('succeeded', { revisionId: stored.revisionId, message });
          return;
        case 'rejected':
          finish('failed', { errorCode: 'REJECTED' });
          return;
        case 'rate_limited':
          finish('failed', { errorCode: 'RATE_LIMITED' });
          return;
        case 'page_invalid':
          finish('failed', { errorCode: 'PAGE_GONE' });
          return;
      }
    } catch (error) {
      if (error instanceof JobStopped) {
        // 已被中止（停用 / 注销 / 删除页面等）时这里什么都不会写；只是页面或成员关系失效时按 PAGE_GONE 结束并退点
        finish('failed', { errorCode: 'PAGE_GONE' });
      } else if (error instanceof RunError) {
        usage = error.usage;
        turns = error.turns;
        finish('failed', { errorCode: interruptedCode(error.code), httpStatus: error.status });
      } else {
        deps.log(`[web] 托管任务 ${jobId} 出错`);
        finish('failed', { errorCode: interruptedCode(modelFailureCode(error) ?? 'INTERNAL') });
      }
    } finally {
      clearTimeout(timer);
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    run,
    interrupt(jobId) {
      const interrupted = transaction(db, () => {
        if (!repos.jobs.interrupt(jobId, deps.now().toISOString())) return false;
        settleJob(deps, jobId, false);
        return true;
      });
      if (!interrupted) return;
      repos.jobEvents.append(jobId, 'failed', deps.now().toISOString());
      deps.log(`[web] 托管任务 ${jobId} 被打断（执行它的进程已退出），已标记失败并退回点数`);
    },
  };
}
