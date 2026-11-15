/**
 * separate 模式（contracts 13.5）：主站进程不启动浏览器。用不注入处理器 / 渲染器 / 预览器的 createWebApp，
 * 并把 `@nowme/render` 的 createRenderer 换成计数的假实现来确认。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@nowme/contracts';

const render = vi.hoisted(() => ({ created: 0 }));
vi.mock('@nowme/render', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nowme/render')>();
  return {
    ...original,
    createRenderer: async () => {
      render.created += 1;
      throw new Error('测试里不启动浏览器');
    },
  };
});

const { createWebApp } = await import('../src/app.js');
const { openDatabase } = await import('../src/db/index.js');
const { createMemoryOutbox } = await import('../src/services/outbox.js');
const { createInstruction } = await import('../src/services/instruction.js');
const { createWall } = await import('../src/services/walls.js');
const { generateId } = await import('@nowme/contracts');
const { exampleFiles, KIT_FONTS, TEST_SECRET } = await import('./helpers.js');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  render.created = 0;
});

function bareWeb(mode: 'inline' | 'separate') {
  const dataDir = mkdtempSync(join(tmpdir(), 'nowme-separate-'));
  const config = { ...loadConfig({ NOWME_DATA_DIR: dataDir, NODE_ENV: 'test', NOWME_WORKER_MODE: mode, NOWME_MODEL_FAKE: '1' }), ticketSecret: TEST_SECRET };
  const db = openDatabase(':memory:');
  const web = createWebApp({ config, db, outbox: createMemoryOutbox(), kitFonts: KIT_FONTS, log: () => {}, skillPackageDir: null });
  cleanups.push(async () => {
    await web.close({ graceMs: 0 });
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { web, db, config };
}

async function submit(app: ReturnType<typeof bareWeb>) {
  const { web, config } = app;
  const deps = web.deps;
  const userId = generateId('usr');
  deps.repos.users.create({ id: userId, email: 'a@example.com', nickname: '阿柚', createdAt: deps.now().toISOString() });
  const { wall, page } = createWall(deps, { organizerId: userId, name: '墙', description: '测试', sceneType: 'hackathon', organizerNote: null });
  const instruction = createInstruction(deps, wall, page);
  const exchanged = await web.request(`${config.webOrigin}/api/agent/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallId: wall.id, token: instruction.token }),
  });
  const { credential } = (await exchanged.json()) as { credential: string };
  return web.request(`${config.webOrigin}/api/agent/revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ files: exampleFiles() }),
  });
}

describe('separate 模式下主站不启动浏览器', () => {
  it('separate：提交只入队，createRenderer 从未被调用', async () => {
    const app = bareWeb('separate');
    expect(app.web.worker).toBeNull();
    submit(app).catch(() => undefined);
    for (let i = 0; i < 50 && Number((app.db.prepare('SELECT COUNT(*) AS n FROM render_jobs').get() as { n: number }).n) === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.db.prepare('SELECT status FROM render_jobs').get()).toEqual({ status: 'queued' });
    expect(render.created).toBe(0);
  });

  it('对照：inline 模式下同样的提交会在本进程里启动渲染器', async () => {
    const app = bareWeb('inline');
    expect(app.web.worker).not.toBeNull();
    const response = await submit(app);
    expect(response.status).toBe(500);
    expect(render.created).toBeGreaterThan(0);
  });
});
