/**
 * 后台任务队列（contracts 13）：任务表与租约、租约回收、重启语义、进度事件、separate 模式。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemotePreviewResponse, RevisionResponse } from '@nowme/contracts';
import { createFakeModel } from '../src/hosted/fake-model.js';
import type { ModelClient } from '../src/hosted/model-client.js';
import { createUserModels } from '../src/hosted/user-models.js';
import { ModelAccessError } from '../src/hosted/model-errors.js';
import type { SubmissionProcessor } from '../src/services/processor.js';
import { createWorkerRuntime, type WorkerRuntime } from '../src/worker/compose.js';
import { JOB_STAGES } from '../src/db/job-queue.js';
import { balanceOf, topUp } from './billing-helpers.js';
import {
  connectAgent,
  createStaticProcessor,
  createStaticRemoteRenderer,
  createTestWeb,
  createUser,
  exampleFiles,
  KIT_FONTS,
  login,
  MINUTE,
  postJson,
  seedWall,
  type TestWeb,
  type TestWebOptions,
} from './helpers.js';
import { completeInterview, createFakePreviewer, generate, joinAs } from './hosted-helpers.js';
import { post } from './publish-helpers.js';
import { suspendUser } from '../src/services/moderation.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function web(options: TestWebOptions = {}): TestWeb {
  const t = createTestWeb(options);
  cleanups.push(() => t.close());
  return t;
}

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

/** 在测试主站的同一个数据库上起一个“独立的 worker”（separate 模式下的 worker 进程）。 */
function startWorker(
  t: TestWeb,
  options: { processor?: SubmissionProcessor; model?: ModelClient; leaseMs?: number; aiConcurrency?: number; workerId?: string } = {},
): WorkerRuntime {
  const model = options.model ?? createFakeModel();
  const runtime = createWorkerRuntime({
    config: { ...t.config, worker: { ...t.config.worker, aiConcurrency: options.aiConcurrency ?? t.config.worker.aiConcurrency } },
    db: t.db,
    repos: t.repos,
    now: t.clock.now,
    kitFonts: KIT_FONTS,
    log: () => {},
    processor: options.processor ?? createStaticProcessor(),
    remoteRenderer: createStaticRemoteRenderer(),
    previewer: createFakePreviewer(),
    resolveJob: () => ({ client: model, endpoint: { ...t.config.hosted.generate, model: 'claude-sonnet-5-5', ready: true } }),
    workerId: options.workerId,
    leaseMs: options.leaseMs,
    pollMs: 20,
  });
  runtime.worker.start();
  cleanups.push(() => runtime.close());
  return runtime;
}

const SEPARATE = { NOWME_WORKER_MODE: 'separate' };
const lease = (t: TestWeb, owner: string, ms = 60_000) => ({
  owner,
  now: t.clock.now().toISOString(),
  expiresAt: new Date(t.clock.now().getTime() + ms).toISOString(),
});

async function seedAgent(t: TestWeb) {
  const owner = createUser(t, 'owner@example.com');
  const seeded = seedWall(t, owner);
  const credential = await connectAgent(t, seeded.wall, seeded.page);
  return { ...seeded, credential };
}

/** 平台 AI 开启的主站（用户没有自己的 Key，生成扣点）；`model` 用作平台的模型。 */
function platformWeb(model: ModelClient, env: Record<string, string> = {}) {
  return web({ env: { NOWME_PLATFORM_PROVIDER: 'deepseek', ...env }, platformModel: model, previewer: createFakePreviewer() });
}

async function platformOwner(t: TestWeb, credits = 20) {
  const organizer = await login(t, 'org@example.com', '组织者');
  const { wall } = seedWall(t, organizer.userId);
  const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
  await topUp(t, owner.session, credits);
  await completeInterview(t, wall, owner);
  return { wall, owner };
}

/** 生成调用（非采访调用）一直挂着直到被取消的模型；采访照常用假模型。 */
function hangingGenerationModel(): ModelClient & { generationCalls: number } {
  const fake = createFakeModel();
  const model = {
    generationCalls: 0,
    async createMessage(params: Parameters<ModelClient['createMessage']>[0], options?: Parameters<ModelClient['createMessage']>[1]) {
      if (params.tool_choice?.type === 'tool') return fake.createMessage(params, options);
      model.generationCalls += 1;
      return new Promise<never>((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  return model;
}

describe('任务表与租约', () => {
  it('按入队顺序领取，写入租约与尝试次数；结束、续约都必须仍持有租约', () => {
    const t = web({ env: SEPARATE });
    const at = t.clock.now().toISOString();
    for (const id of ['job_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'job_bbbbbbbbbbbbbbbbbbbbbbbbbb']) {
      t.repos.queue.enqueueRender({ id, kind: 'submission', pageId: 'pg_x', credentialId: 'crd_x', maxAttempts: 2, createdAt: at });
    }
    const first = t.repos.queue.claimRender(lease(t, 'w1'));
    expect(first).toMatchObject({ id: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'running', attempts: 1, leaseOwner: 'w1' });
    expect(t.repos.queue.claimRender(lease(t, 'w2'))?.id).toBe('job_bbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(t.repos.queue.claimRender(lease(t, 'w3'))).toBeNull();
    // 别人不能续约、不能结束
    expect(t.repos.queue.renewRender(first!.id, lease(t, 'w2'))).toBe(false);
    expect(t.repos.queue.completeRender(first!.id, 'w2', { outcome: 'stored', now: at })).toBe(false);
    expect(t.repos.queue.renewRender(first!.id, lease(t, 'w1'))).toBe(true);
    expect(t.repos.queue.completeRender(first!.id, 'w1', { outcome: 'stored', revisionId: null, now: at })).toBe(true);
    expect(t.repos.queue.findRender(first!.id)).toMatchObject({ status: 'done', outcome: 'stored', leaseOwner: null });
    // 表里只有 ID、状态、计数与时间
    const row = t.db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(first!.id) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ['attempts', 'created_at', 'credential_id', 'error_code', 'finished_at', 'id', 'kind', 'lease_expires_at', 'lease_owner', 'max_attempts', 'outcome', 'page_id', 'revision_id', 'started_at', 'status'].sort(),
    );
  });

  it('租约过期：渲染任务还有次数就回到队列，用完就失败；不回收自己持有的；AI 任务只报告 ID', () => {
    const t = web({ env: SEPARATE });
    const at = t.clock.now().toISOString();
    t.repos.queue.enqueueRender({ id: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'submission', pageId: 'pg_x', credentialId: 'crd_x', maxAttempts: 2, createdAt: at });
    t.repos.queue.claimRender(lease(t, 'dead', 1000));
    t.clock.advance(2000);
    expect(t.repos.queue.reclaimExpired(t.clock.now().toISOString(), 'dead').retried).toEqual([]); // 自己持有的不回收
    const first = t.repos.queue.reclaimExpired(t.clock.now().toISOString(), 'w2');
    expect(first.retried.map((job) => job.id)).toEqual(['job_aaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(t.repos.queue.findRender('job_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ status: 'queued', attempts: 1, leaseOwner: null });
    t.repos.queue.claimRender(lease(t, 'dead-again', 1000));
    t.clock.advance(2000);
    const second = t.repos.queue.reclaimExpired(t.clock.now().toISOString(), 'w2');
    expect(second.failed.map((job) => job.id)).toEqual(['job_aaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(t.repos.queue.findRender('job_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED', attempts: 2 });
  });

  it('交还租约（优雅退出）：回到队列，这次不计入尝试次数；等待方放弃时排队中的任务不再执行', () => {
    const t = web({ env: SEPARATE });
    const at = t.clock.now().toISOString();
    t.repos.queue.enqueueRender({ id: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'submission', pageId: 'pg_x', credentialId: 'crd_x', maxAttempts: 2, createdAt: at });
    t.repos.queue.claimRender(lease(t, 'w1'));
    expect(t.repos.queue.releaseRender('job_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'w1')).toBe(true);
    expect(t.repos.queue.findRender('job_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ status: 'queued', attempts: 0 });
    expect(t.repos.queue.abandonRender('job_aaaaaaaaaaaaaaaaaaaaaaaaaa', at)).toBe(true);
    expect(t.repos.queue.claimRender(lease(t, 'w1'))).toBeNull();
  });
});

describe('进度事件', () => {
  it('序号逐条递增，按序号续读；只接受白名单里的非负整数属性', () => {
    const t = web({ env: SEPARATE });
    const at = t.clock.now().toISOString();
    expect(t.repos.jobEvents.append('gen_x', 'queued', at)).toBe(1);
    expect(t.repos.jobEvents.append('gen_x', 'generating', at, { turn: 2, maxTurns: 30 })).toBe(2);
    expect(t.repos.jobEvents.append('gen_y', 'queued', at)).toBe(1);
    expect(t.repos.jobEvents.listAfter('gen_x', 1)).toEqual([{ jobId: 'gen_x', seq: 2, stage: 'generating', props: { turn: 2, maxTurns: 30 }, createdAt: at }]);
    expect(t.repos.jobEvents.listAfter('gen_x', 2)).toEqual([]);
    expect(() => t.repos.jobEvents.append('gen_x', 'generating', at, { text: 1 } as never)).toThrow();
    expect(() => t.repos.jobEvents.append('gen_x', 'generating', at, { turn: 'x' } as never)).toThrow();
    expect(() => t.repos.jobEvents.append('gen_x', 'thinking' as never, at)).toThrow();
  });

  it('托管生成：排队中 → 读取资料 → 设计 → 生成中（第 n 轮）→ 校验 → 渲染截图 → 完成；不含任何内容', async () => {
    const t = web({ env: { NOWME_MODEL_FAKE: '1' }, model: createFakeModel(), previewer: createFakePreviewer() });
    const organizer = createUser(t, 'org@example.com');
    const { wall } = seedWall(t, organizer);
    const owner = await joinAs(t, wall, 'a@example.com', '阿柚');
    await completeInterview(t, wall, owner);
    const { job } = await generate(t, wall, owner);
    expect(job?.status).toBe('succeeded');
    const events = t.repos.jobEvents.listAfter(job!.id);
    const stages = events.map((event) => event.stage);
    expect(stages[0]).toBe('queued');
    expect(stages[1]).toBe('reading');
    expect(stages).toContain('designing');
    expect(stages).toContain('generating');
    expect(stages).toContain('validating');
    expect(stages).toContain('rendering');
    expect(stages.at(-1)).toBe('succeeded');
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.find((event) => event.stage === 'generating')?.props.turn).toBeGreaterThan(1);
    // 只有阶段、序号、时间与数字
    const rows = t.db.prepare('SELECT props_json FROM job_events WHERE job_id = ?').all(job!.id) as { props_json: string }[];
    for (const row of rows) expect(Object.values(JSON.parse(row.props_json) as Record<string, unknown>).every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('阿柚');
    expect(new Set(stages).size).toBeLessThanOrEqual(JOB_STAGES.length);
  });

  it('本地提交：排队中 → 校验 → 渲染截图 → 完成；暂存目录在结束后删除', async () => {
    const t = web();
    const { credential } = await seedAgent(t);
    const response = await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    expect(response.status).toBe(201);
    const job = t.db.prepare("SELECT id FROM render_jobs WHERE kind = 'submission'").get() as { id: string };
    expect(t.repos.jobEvents.listAfter(job.id).map((event) => event.stage)).toEqual(['queued', 'validating', 'rendering', 'succeeded']);
    const revision = ((await response.json()) as RevisionResponse).revision;
    expect(t.repos.queue.findRender(job.id)).toMatchObject({ status: 'done', outcome: 'stored', revisionId: revision.id });
    const jobsDir = join(t.dataDir, 'jobs');
    expect(existsSync(jobsDir) ? readdirSync(jobsDir) : []).toEqual([]);
  });
});

describe('重启语义', () => {
  it('提交渲染可重试：执行它的 worker 退出（租约过期）后由新 worker 重做，只存一个版本', async () => {
    const t = web({ env: SEPARATE });
    const { page, credential } = await seedAgent(t);
    const pending = postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    const jobId = await until(() => (t.db.prepare('SELECT id FROM render_jobs').get() as { id: string } | undefined)?.id);
    // 一个 worker 领走了任务，然后进程消失了（不再续约）
    expect(t.repos.queue.claimRender(lease(t, 'dead', 30_000))?.id).toBe(jobId);
    t.clock.advance(MINUTE);
    const processor = createStaticProcessor();
    startWorker(t, { processor });
    const response = await pending;
    expect(response.status).toBe(201);
    expect(processor.calls).toBe(1);
    expect(t.repos.revisions.listForPage(page.id)).toHaveLength(1);
    expect(t.repos.queue.findRender(jobId)).toMatchObject({ status: 'done', attempts: 2 });
    expect(t.repos.jobEvents.listAfter(jobId).map((event) => event.stage)).toContain('retrying');
  });

  it('AI 任务不重试：执行它的进程退出后标记 INTERRUPTED，并全额退点', async () => {
    const t = platformWeb(createFakeModel(), SEPARATE);
    const { wall, owner } = await platformOwner(t);
    const response = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'queued', modelSource: 'platform' });
    expect(balanceOf(t, owner.session.userId)).toBe(10);
    expect(t.repos.queue.claimGeneration(lease(t, 'dead', 30_000))).toBe(jobId);
    t.clock.advance(MINUTE);
    const model = hangingGenerationModel();
    const runtime = startWorker(t, { model });
    await until(() => t.repos.jobs.findById(jobId)?.status === 'failed');
    await runtime.worker.idle();
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED', charged: false, attempts: 1 });
    expect(balanceOf(t, owner.session.userId)).toBe(20);
    expect(model.generationCalls).toBe(0);
    expect(t.repos.jobEvents.latest(jobId)?.stage).toBe('failed');
  });

  it('重启前还在排队的 AI 任务不受影响：新 worker 起来后照常执行', async () => {
    const t = platformWeb(createFakeModel(), SEPARATE);
    const { wall, owner } = await platformOwner(t);
    const response = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
    const runtime = startWorker(t);
    await until(() => t.repos.jobs.findById(jobId)?.status === 'succeeded');
    await runtime.worker.idle();
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'succeeded', charged: true });
    expect(balanceOf(t, owner.session.userId)).toBe(10);
  });

  it('优雅退出：AI 任务在宽限时间内没结束就取消，标记 INTERRUPTED 并退点', async () => {
    const model = hangingGenerationModel();
    const t = platformWeb(model);
    const { wall, owner } = await platformOwner(t);
    const response = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
    await until(() => model.generationCalls > 0);
    expect(t.repos.jobs.findById(jobId)?.status).toBe('running');
    await t.web.close({ graceMs: 20 });
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED', charged: false });
    expect(balanceOf(t, owner.session.userId)).toBe(20);
  });

  it('优雅退出：渲染任务在宽限时间内没结束就交还队列，由下一个 worker 重做', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = createStaticProcessor();
    let started = false;
    const t = web({
      processor: {
        async process(input) {
          started = true;
          await gate;
          return inner.process(input);
        },
        async close() {},
      },
    });
    const { page, credential } = await seedAgent(t);
    const pending = postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    await until(() => started);
    const jobId = (t.db.prepare('SELECT id FROM render_jobs').get() as { id: string }).id;
    const closing = t.web.close({ graceMs: 20 });
    await until(() => t.repos.queue.findRender(jobId)?.status === 'queued');
    expect(t.repos.queue.findRender(jobId)).toMatchObject({ status: 'queued', attempts: 0, leaseOwner: null });
    release();
    await closing;
    // 旧 worker 的结果作废（不再持有租约），没有写版本
    expect(t.repos.revisions.listForPage(page.id)).toEqual([]);
    startWorker(t);
    expect((await pending).status).toBe(201);
    expect(t.repos.revisions.listForPage(page.id)).toHaveLength(1);
  });

  it('入队时记下模型配置的版本：排队期间配置被更换，worker 不会改用新配置', () => {
    const t = web({ env: SEPARATE });
    const userId = createUser(t, 'a@example.com');
    const models = createUserModels(t.db, { encryptionKey: 'a'.repeat(64), allowLocal: false, now: t.clock.now });
    const input = { provider: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-test-0123456789', vision: true };
    models.save(userId, { interview: input, generate: input });
    const pinned = models.version(userId, 'generate');
    expect(pinned).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => models.resolve(userId, 'generate', pinned)).not.toThrow();
    models.save(userId, { interview: input, generate: { ...input, apiKey: 'sk-ant-other-0123456789' } });
    expect(() => models.resolve(userId, 'generate', pinned)).toThrow(ModelAccessError);
    models.delete(userId);
    expect(models.version(userId, 'generate')).toBeNull();
  });
});

describe('停用账号中止托管任务', () => {
  it('排队中的任务：标记 SUSPENDED、全额退点；之后的 worker 不再执行', async () => {
    const model = hangingGenerationModel();
    const t = platformWeb(model, SEPARATE);
    const { wall, owner } = await platformOwner(t);
    const response = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
    expect(balanceOf(t, owner.session.userId)).toBe(10);
    expect(suspendUser(t.web.deps, owner.session.userId, null).cancelledJobs).toBe(1);
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'SUSPENDED', charged: false });
    expect(balanceOf(t, owner.session.userId)).toBe(20);
    const runtime = startWorker(t, { model });
    await sleep(50);
    await runtime.worker.idle();
    expect(model.generationCalls).toBe(0);
    expect(t.repos.jobEvents.latest(jobId)?.stage).toBe('failed');
  });

  it('执行中的任务：立即失败并退点；worker 发现租约已不在，停止后续模型请求，不存版本、不改结果', async () => {
    const model = hangingGenerationModel();
    const t = platformWeb(model, SEPARATE);
    const { wall, owner } = await platformOwner(t);
    const response = await post(t, owner.session, `/w/${wall.id}/me/generate`);
    const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(response.headers.get('location') ?? '')?.[1] ?? '';
    const runtime = startWorker(t, { model, leaseMs: 300 });
    await until(() => model.generationCalls > 0);
    expect(suspendUser(t.web.deps, owner.session.userId, null).cancelledJobs).toBe(1);
    expect(balanceOf(t, owner.session.userId)).toBe(20);
    // 续约失败（每 100 毫秒一次）→ 取消正在进行的模型调用
    await until(() => runtime.worker.activeCount === 0);
    expect(model.generationCalls).toBe(1);
    expect(t.repos.jobs.findById(jobId)).toMatchObject({ status: 'failed', errorCode: 'SUSPENDED', revisionId: null });
    expect(t.repos.revisions.listForPage(owner.member.page.id)).toEqual([]);
    expect(t.repos.credits.findJobEntry('job_refund', jobId)?.delta).toBe(10);
  });
});

describe('separate 模式', () => {
  it('主站只入队：不建 worker，不调用处理器、渲染器、预览器与生成模型；独立 worker 执行后请求返回', async () => {
    const processor = createStaticProcessor();
    const renderer = createStaticRemoteRenderer();
    const previewer = createFakePreviewer();
    const model = createFakeModel();
    const t = web({ env: SEPARATE, processor, remoteRenderer: renderer, previewer, platformModel: model });
    expect(t.web.worker).toBeNull();
    const { page, credential } = await seedAgent(t);
    let settled = false;
    const pending = postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential).then((response) => {
      settled = true;
      return response;
    });
    const preview = postJson(t, '/api/agent/previews', { files: exampleFiles() }, credential);
    await until(() => Number((t.db.prepare('SELECT COUNT(*) AS n FROM render_jobs').get() as { n: number }).n) === 2);
    await sleep(300);
    expect(settled).toBe(false);
    expect(processor.calls).toBe(0);
    expect(renderer.calls).toBe(0);
    expect(t.db.prepare("SELECT status FROM render_jobs WHERE kind = 'submission'").get()).toEqual({ status: 'queued' });
    // 暂存目录里只有白名单文件
    const files = readdirSync(join(t.dataDir, 'jobs'));
    expect(files).toHaveLength(2);

    const workerProcessor = createStaticProcessor();
    startWorker(t, { processor: workerProcessor });
    expect((await pending).status).toBe(201);
    const body = (await (await preview).json()) as RemotePreviewResponse;
    expect(body.rendered).toBe(true);
    expect(workerProcessor.calls).toBe(1);
    expect(processor.calls).toBe(0);
    expect(previewer.calls).toBe(0);
    expect(model.calls).toHaveLength(0);
    expect(t.repos.revisions.listForPage(page.id)).toHaveLength(1);
    // 远程预览什么都不留：任务行与暂存目录都已删除
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM render_jobs WHERE kind = 'preview'").get()).toEqual({ n: 0 });
    expect(readdirSync(join(t.dataDir, 'jobs'))).toEqual([]);
  });

  it('等不到 worker：超时后排队中的任务被放弃，返回 500 而不是一直挂着', async () => {
    const t = web({ env: SEPARATE });
    const { page, credential } = await seedAgent(t);
    // 把等待上限缩短到 50 毫秒
    const service = (await import('../src/services/submissions.js')).createSubmissionService({
      config: t.config,
      db: t.db,
      repos: t.repos,
      now: t.clock.now,
      dispatch: { kick() {}, idle: async () => {}, waitRender: async (id) => t.repos.queue.findRender(id) },
      waitMs: 50,
    });
    const agent = { credential: t.repos.credentials.findActiveForPage(page.id)!, page, wall: t.repos.walls.findById(page.wallId)!, membership: t.repos.memberships.findById(page.membershipId)! };
    expect(credential).toBeTruthy();
    expect(await service.submit(agent, exampleFiles())).toEqual({ kind: 'unavailable' });
    expect(t.db.prepare('SELECT status, error_code FROM render_jobs').get()).toEqual({ status: 'failed', error_code: 'ABANDONED' });
    expect(readdirSync(join(t.dataDir, 'jobs'))).toEqual([]);
  });
});
