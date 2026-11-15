/**
 * 托管生成 / 修改任务的中止与结算（contracts 12 S10、13.4；T8.11 回归）：
 * - 删除页面、退出墙、被移出、关闭墙时，进行中的任务立即失败（PAGE_GONE）并全额退点，worker 不再发出后续模型请求；
 * - 每轮调用模型前确认页面与成员关系仍有效（即使没有走到上面的中止），失效时停止并退点；
 * - 结算以“是否存下了新版本”为准：版本存下就保留扣点（即使紧接着被停用），没存下才全额退回，
 *   永远不会出现“版本存下了、点数也退了”。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeModel } from '../../src/hosted/fake-model.js';
import type { ModelClient } from '../../src/hosted/model-client.js';
import { suspendUser } from '../../src/services/moderation.js';
import { deletePage, leaveWall } from '../../src/services/page-lifecycle.js';
import { closeWall, removeMember } from '../../src/services/walls.js';
import { findOwnPage } from '../../src/services/access.js';
import { createWorkerRuntime, type WorkerRuntime } from '../../src/worker/compose.js';
import { balanceOf, topUp } from '../billing-helpers.js';
import { createStaticProcessor, createStaticRemoteRenderer, createTestWeb, KIT_FONTS, login, seedWall, type TestWeb } from '../helpers.js';
import { completeInterview, createFakePreviewer, joinAs } from '../hosted-helpers.js';
import { post } from '../publish-helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | null | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await sleep(5);
  }
}

/** 平台 AI 开启、主站只入队（separate），由测试里起的 worker 执行；`model` 是平台的模型。 */
function platformWeb(model: ModelClient): TestWeb {
  const t = createTestWeb({ env: { NOWME_PLATFORM_PROVIDER: 'deepseek', NOWME_WORKER_MODE: 'separate' }, platformModel: model, previewer: createFakePreviewer() });
  cleanups.push(() => t.close());
  return t;
}

function startWorker(t: TestWeb, model: ModelClient, options: { leaseMs?: number; log?: (message: string) => void } = {}): WorkerRuntime {
  const runtime = createWorkerRuntime({
    config: t.config,
    db: t.db,
    repos: t.repos,
    now: t.clock.now,
    kitFonts: KIT_FONTS,
    log: options.log ?? (() => {}),
    processor: createStaticProcessor(),
    remoteRenderer: createStaticRemoteRenderer(),
    previewer: createFakePreviewer(),
    resolveJob: () => ({ client: model, endpoint: { ...t.config.hosted.generate, model: 'claude-sonnet-5-5', ready: true } }),
    leaseMs: options.leaseMs,
    pollMs: 20,
  });
  runtime.worker.start();
  cleanups.push(() => runtime.close());
  return runtime;
}

async function platformOwner(t: TestWeb) {
  const organizer = await login(t, 'org@example.com', '组织者');
  const { wall } = seedWall(t, organizer.userId);
  const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
  await topUp(t, owner.session, 20);
  await completeInterview(t, wall, owner);
  return { wall, owner, organizer };
}

async function startGenerate(t: TestWeb, wallId: string, owner: Awaited<ReturnType<typeof platformOwner>>['owner']): Promise<string> {
  const response = await post(t, owner.session, `/w/${wallId}/me/generate`);
  return /\/jobs\/(gen_[a-z2-7]+)/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
}

/** 生成调用一直挂着直到被取消（采访照常用假模型）。 */
function hangingModel(): ModelClient & { calls: number } {
  const fake = createFakeModel();
  const model = {
    calls: 0,
    async createMessage(params: Parameters<ModelClient['createMessage']>[0], options?: Parameters<ModelClient['createMessage']>[1]) {
      if (params.tool_choice?.type === 'tool') return fake.createMessage(params, options);
      model.calls += 1;
      return new Promise<never>((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  return model;
}

/** 正常完成的假模型，记下生成调用次数；`onGenerate` 在每次生成调用前执行。 */
function countingModel(onGenerate?: (call: number) => void): ModelClient & { calls: number } {
  const fake = createFakeModel();
  const model = {
    calls: 0,
    async createMessage(params: Parameters<ModelClient['createMessage']>[0], options?: Parameters<ModelClient['createMessage']>[1]) {
      if (params.tool_choice?.type !== 'tool') {
        model.calls += 1;
        onGenerate?.(model.calls);
      }
      return fake.createMessage(params, options);
    },
  };
  return model;
}

describe('页面不在了：中止并退点，不再请求模型', () => {
  const cases: [string, (t: TestWeb, ctx: Awaited<ReturnType<typeof platformOwner>>) => Promise<unknown> | unknown][] = [
    ['删除页面', async (t, { wall, owner }) => deletePage(t.web.deps, findOwnPage(t.repos, owner.session.userId, wall.id)!, owner.session.userId)],
    ['退出墙', (t, { wall, owner }) => leaveWall(t.web.deps, findOwnPage(t.repos, owner.session.userId, wall.id)!, owner.session.userId)],
    ['被组织者移出', (t, { wall, owner, organizer }) => removeMember(t.web.deps, wall, organizer.userId, owner.member.membership.id)],
    ['墙被关闭', (t, { wall, organizer }) => closeWall(t.web.deps, t.repos.walls.findById(wall.id)!, organizer.userId)],
  ];

  for (const [label, act] of cases) {
    it(`${label}：执行中的任务立即失败（PAGE_GONE）、全额退点，worker 停止后续请求，不存版本`, async () => {
      const model = hangingModel();
      const t = platformWeb(model);
      const ctx = await platformOwner(t);
      const jobId = await startGenerate(t, ctx.wall.id, ctx.owner);
      const runtime = startWorker(t, model, { leaseMs: 300 });
      await until(() => model.calls > 0);
      await act(t, ctx);
      expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'PAGE_GONE', charged: false });
      expect(t.repos.credits.findJobEntry('job_refund', jobId)?.delta).toBe(10);
      await until(() => runtime.worker.activeCount === 0);
      expect(model.calls).toBe(1);
      expect(t.repos.revisions.listForPage(ctx.owner.member.page.id)).toEqual([]);
      expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'PAGE_GONE', revisionId: null });
    });
  }

  it('排队中的任务被移出时直接中止：worker 不会执行，也不请求模型', async () => {
    const model = countingModel();
    const t = platformWeb(model);
    const ctx = await platformOwner(t);
    const jobId = await startGenerate(t, ctx.wall.id, ctx.owner);
    removeMember(t.web.deps, ctx.wall, ctx.organizer.userId, ctx.owner.member.membership.id);
    expect(balanceOf(t, ctx.owner.session.userId)).toBe(20);
    const runtime = startWorker(t, model);
    await sleep(50);
    await runtime.worker.idle();
    expect(model.calls).toBe(0);
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'PAGE_GONE' });
  });

  it('每轮调用模型前也确认成员关系：失效后（即使任务没被中止）下一轮不再请求，按 PAGE_GONE 退点', async () => {
    let t!: TestWeb;
    let membershipId = '';
    // 第一次生成调用之前直接把成员关系改成 left（绕过退出流程，模拟任何没走到中止的失效路径）
    const model = countingModel((call) => {
      if (call === 1) t.db.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE id = ?").run(new Date().toISOString(), membershipId);
    });
    t = platformWeb(model);
    const ctx = await platformOwner(t);
    membershipId = ctx.owner.member.membership.id;
    const jobId = await startGenerate(t, ctx.wall.id, ctx.owner);
    const runtime = startWorker(t, model);
    await sleep(50);
    await runtime.worker.idle();
    expect(model.calls).toBe(1);
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'PAGE_GONE', revisionId: null });
    expect(t.repos.credits.findJobEntry('job_refund', jobId)?.delta).toBe(10);
    expect(balanceOf(t, ctx.owner.session.userId)).toBe(20);
  });
});

describe('结算以“是否存下了新版本”为准', () => {
  it('版本刚写进库就被停用：保留扣点、任务是 succeeded，不会“版本存下又全额退回”', async () => {
    const model = countingModel();
    const t = platformWeb(model);
    const ctx = await platformOwner(t);
    const jobId = await startGenerate(t, ctx.wall.id, ctx.owner);
    let suspended: ReturnType<typeof suspendUser> | null = null;
    // 写版本的事务一提交，提交管线就会记这条日志：在这一刻停用账号（之前的实现在这里还没结算）
    const runtime = startWorker(t, model, {
      log: (message) => {
        if (!suspended && message.includes('托管生成')) suspended = suspendUser(t.web.deps, ctx.owner.session.userId, null);
      },
    });
    await sleep(50);
    await runtime.worker.idle();
    expect(suspended).toMatchObject({ cancelledJobs: 0 });
    const job = t.repos.jobs.findById(jobId);
    expect(job).toMatchObject({ status: 'succeeded', charged: true });
    expect(job?.revisionId).toBeTruthy();
    expect(t.repos.revisions.findById(job?.revisionId ?? '')?.pageId).toBe(ctx.owner.member.page.id);
    expect(t.repos.credits.findJobEntry('job_refund', jobId)).toBeNull();
    expect(balanceOf(t, ctx.owner.session.userId)).toBe(10);
  });

});
