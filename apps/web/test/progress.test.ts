/**
 * 生成进度的实时推送（contracts 18.2）：SSE 阶段、续传、心跳、超时、连接数限制、轮询回退、页面上不再用 meta refresh。
 * 权限（非主人 404、被移除后停止）见 security/progress.security.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressHub, progressView } from '../src/services/progress.js';
import { get } from './helpers.js';
import { makeCard, seedRevision } from './wall-helpers.js';
import { finishJob, progressWorld, readSse, type ProgressWorld } from './progress-helpers.js';

let world: ProgressWorld | null = null;
afterEach(async () => {
  await world?.t.close();
  world = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('进度阶段（给人看的名字）', () => {
  it('排队中 / 整理资料 / 设计 / 生成中第 n 轮 / 检查 / 截图 / 完成', () => {
    const view = (stage: Parameters<typeof progressView>[0]) => progressView(stage);
    expect(view(null)).toMatchObject({ stage: 'queued', step: 'queued', label: '排队中，马上轮到你' });
    expect(view({ seq: 2, stage: 'reading', props: {} })).toMatchObject({ step: 'reading', label: '正在整理你的资料' });
    expect(view({ seq: 3, stage: 'designing', props: { turn: 1, maxTurns: 30 } })).toMatchObject({ step: 'designing', label: '正在设计页面（第 1 轮）' });
    expect(view({ seq: 4, stage: 'generating', props: { turn: 3, maxTurns: 30 } })).toMatchObject({ step: 'generating', label: '正在生成页面（第 3 轮）', turn: 3, maxTurns: 30 });
    expect(view({ seq: 5, stage: 'validating', props: {} })).toMatchObject({ step: 'validating', label: '正在检查页面有没有问题' });
    expect(view({ seq: 6, stage: 'rendering', props: {} })).toMatchObject({ step: 'rendering', label: '正在给页面截图、看效果' });
    expect(view({ seq: 7, stage: 'retrying', props: {} })).toMatchObject({ step: 'queued' });
    expect(view({ seq: 8, stage: 'succeeded', props: {} })).toMatchObject({ step: 'succeeded', label: '做好了' });
  });

  it('“在看”：有连接时在看；断开后 presenceMs 内仍算在看；之后不算', () => {
    let now = 0;
    const hub = createProgressHub(() => new Date(now), { presenceMs: 1000, perUser: 1, total: 2 });
    expect(hub.present('gen_a')).toBe(false);
    const slot = hub.open('usr_a', 'gen_a');
    expect(slot).not.toBeNull();
    expect(hub.open('usr_a', 'gen_b')).toBeNull(); // 每用户上限
    expect(hub.open('usr_b', 'gen_c')).not.toBeNull();
    expect(hub.open('usr_c', 'gen_d')).toBeNull(); // 全站上限
    now = 5000;
    expect(hub.present('gen_a')).toBe(true);
    slot?.release();
    slot?.release(); // 重复释放不会少算
    expect(hub.connections()).toBe(1);
    now = 5900;
    expect(hub.present('gen_a')).toBe(true);
    now = 6100;
    expect(hub.present('gen_a')).toBe(false);
    hub.touch('gen_a');
    expect(hub.present('gen_a')).toBe(true);
  });
});

describe('SSE 与轮询', () => {
  it('主人收到每个阶段，完成后收到 done（带预览地址）并关闭连接', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    const response = await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    const reading = readSse(response, { timeoutMs: 3000 });
    await sleep(40);
    t.repos.jobEvents.append(jobId, 'reading', t.clock.now().toISOString());
    t.repos.jobEvents.append(jobId, 'generating', t.clock.now().toISOString(), { turn: 2, maxTurns: 30 });
    await sleep(40);
    const revisionId = seedRevision(t, world.member.page, makeCard('阿柚'));
    finishJob(t, jobId, 'succeeded', revisionId);
    const { events, ended } = await reading;
    expect(ended).toBe(true);
    expect(events[0]).toMatchObject({ event: 'ready' });
    const stages = events.filter((event) => event.event === 'stage').map((event) => JSON.parse(event.data) as { stage: string; label: string; seq: number });
    expect(stages.map((stage) => stage.stage)).toEqual(['queued', 'reading', 'generating', 'succeeded']);
    expect(stages.find((stage) => stage.stage === 'generating')?.label).toBe('正在生成页面（第 2 轮）');
    expect(events.filter((event) => event.event === 'stage').map((event) => Number(event.id))).toEqual(stages.map((stage) => stage.seq));
    const done = events.find((event) => event.event === 'done');
    expect(JSON.parse(done?.data ?? '{}')).toMatchObject({ done: true, status: 'succeeded', next: `/w/${wall.id}/me?rev=${revisionId}#preview-heading` });
    expect(events.at(-1)?.event).toBe('done');
    await sleep(20);
    expect(t.web.deps.progress.connections()).toBe(0);
  });

  it('已经结束的任务：连上就收到 done 并关闭；失败时 next 为空（前端重新载入看原因）', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    finishJob(t, jobId, 'failed');
    const { events, ended } = await readSse(await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie }));
    expect(ended).toBe(true);
    expect(JSON.parse(events.find((event) => event.event === 'done')?.data ?? '{}')).toMatchObject({ done: true, status: 'failed', next: null, label: '这次没有做成' });
  });

  it('Last-Event-ID 续传：只推之后的阶段', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    t.repos.jobEvents.append(jobId, 'reading', t.clock.now().toISOString());
    t.repos.jobEvents.append(jobId, 'designing', t.clock.now().toISOString(), { turn: 1, maxTurns: 30 });
    const response = await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie, headers: { 'Last-Event-ID': '2' } });
    const { events } = await readSse(response, { stop: (list) => list.some((event) => event.event === 'stage') });
    expect(events.filter((event) => event.event === 'stage').map((event) => event.id)).toEqual(['3']);
  });

  it('心跳：没有新阶段时定期发注释行；到最长时间后服务端关闭（浏览器会自动重连）', async () => {
    world = await progressWorld({ heartbeatMs: 30, maxStreamMs: 200 });
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    const started = Date.now();
    const { raw, ended, events } = await readSse(await get(t, `/w/${wall.id}/me/jobs/${jobId}/progress`, { cookie: owner.cookie }), { timeoutMs: 2000 });
    expect(raw).toContain(': keep-alive');
    expect(ended).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(raw).toContain('retry: 3000');
  });

  it('连接数限制：同一用户超过上限返回 429（前端改为轮询）；断开后名额释放', async () => {
    world = await progressWorld({ perUser: 2 });
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    const path = `/w/${wall.id}/me/jobs/${jobId}/progress`;
    const first = await get(t, path, { cookie: owner.cookie });
    const second = await get(t, path, { cookie: owner.cookie });
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await get(t, path, { cookie: owner.cookie });
    expect(third.status).toBe(429);
    expect(t.web.deps.progress.connections()).toBe(2);
    await first.body?.cancel();
    await second.body?.cancel();
    await sleep(60);
    expect(t.web.deps.progress.connections()).toBe(0);
    expect((await get(t, path, { cookie: owner.cookie })).status).toBe(200);
  });

  it('轮询：/status 返回当前阶段与是否结束（只有阶段名与数字）', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    const status = async () => (await get(t, `/w/${wall.id}/me/jobs/${jobId}/status`, { cookie: owner.cookie })).json() as Promise<Record<string, unknown>>;
    expect(await status()).toEqual({ seq: 1, stage: 'queued', step: 'queued', label: '排队中，马上轮到你', turn: null, maxTurns: null, done: false, status: 'queued', next: null });
    t.repos.jobEvents.append(jobId, 'rendering', t.clock.now().toISOString(), { turn: 4 });
    expect(await status()).toMatchObject({ stage: 'rendering', step: 'rendering', done: false });
    finishJob(t, jobId, 'needs_input');
    expect(await status()).toMatchObject({ done: true, status: 'needs_input', next: null, label: '需要你补充一句' });
    expect(t.web.deps.progress.present(jobId)).toBe(true);
  });

  it('任务页与“我的页面”：显示阶段化进度并加载 progress.js，不用 meta refresh', async () => {
    world = await progressWorld();
    const { t, wall, owner } = world;
    const jobId = world.queueJob();
    t.repos.jobEvents.append(jobId, 'generating', t.clock.now().toISOString(), { turn: 5, maxTurns: 30 });
    for (const path of [`/w/${wall.id}/me/jobs/${jobId}`, `/w/${wall.id}/me`]) {
      const html = await (await get(t, path, { cookie: owner.cookie })).text();
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).toContain('<script src="/static/progress.');
      expect(html).toContain(`data-stream="/w/${wall.id}/me/jobs/${jobId}/progress"`);
      expect(html).toContain(`data-status="/w/${wall.id}/me/jobs/${jobId}/status"`);
      expect(html).toContain('正在生成页面（第 5 轮）');
      expect(html).toMatch(/progress__step--current" data-step="generating"/);
      expect(html).toContain('做好后会发邮件告诉你');
    }
    // 结束后的任务页不再加载进度脚本
    finishJob(t, jobId, 'failed');
    const after = await (await get(t, `/w/${wall.id}/me/jobs/${jobId}`, { cookie: owner.cookie })).text();
    expect(after).not.toMatch(/\/static\/progress\./);
  });
});
