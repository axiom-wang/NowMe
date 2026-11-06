/**
 * 提交管线（contracts 3、4.1）：白名单过滤、rejected 不影响 accepted、编号递增、体积 / 数量 / 频率上限、
 * 文件布局、处理器出错、处理期间被断开、串行处理。真实渲染见 submission-render.test.ts。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVISIONS_PER_PAGE_PER_DAY, type AgentContext, type RevisionResponse } from '@nowme/contracts';
import { disconnectAgent } from '../src/services/agent.js';
import type { SubmissionProcessor } from '../src/services/processor.js';
import {
  agentGet,
  b64,
  brokenFiles,
  connectAgent,
  createStaticProcessor,
  createTestWeb,
  createUser,
  dumpDb,
  exampleFiles,
  HOUR,
  listFiles,
  postJson,
  seedMember,
  seedWall,
  type StaticProcessor,
  type TestWeb,
} from './helpers.js';
import type { Wall } from '../src/db/walls.js';
import type { Page } from '../src/db/pages.js';

async function submit(t: TestWeb, credential: string, files: Record<string, string>) {
  const response = await postJson(t, '/api/agent/revisions', { files }, credential);
  const body = (await response.json()) as RevisionResponse & { error?: { code: string; message: string } };
  return { status: response.status, body };
}

describe('提交管线', () => {
  let t: TestWeb;
  let wall: Wall;
  let page: Page;
  let credential: string;

  beforeEach(async () => {
    t = createTestWeb();
    const owner = createUser(t, 'owner@example.com', '林舟');
    ({ wall, page } = seedWall(t, owner));
    credential = await connectAgent(t, wall, page);
  });
  afterEach(async () => {
    await t.close();
  });

  it('通过：201，按约定布局写 revisions/<id>/，库里存 card / manifest / 渲染文字', async () => {
    const { status, body } = await submit(t, credential, exampleFiles());
    expect(status).toBe(201);
    const { revision } = body;
    expect(revision).toMatchObject({ number: 1, status: 'accepted' });
    expect(revision.id).toMatch(/^rev_[a-z2-7]{26}$/);
    expect(revision.report.ok).toBe(true);
    expect(revision.createdAt).toBe(t.clock.now().toISOString());
    expect(revision.workspaceUrl).toBe(`${t.config.webOrigin}/w/${wall.id}/me?rev=${revision.id}`);

    const dir = join(t.dataDir, 'revisions', revision.id);
    expect(listFiles(dir)).toEqual([
      'cover.png',
      'original/card.json',
      'original/cover.png',
      'original/index.html',
      'original/manifest.json',
      'render/full.png',
      'served/index.html',
    ]);
    const stored = t.repos.revisions.findById(revision.id);
    expect(stored).toMatchObject({ pageId: page.id, source: 'local-agent', status: 'accepted', renderedText: '渲染后的文字' });
    expect(JSON.parse(stored?.cardJson ?? 'null')).toMatchObject({ displayName: '林舟' });
    expect(JSON.parse(stored?.manifestJson ?? 'null')).toMatchObject({ sceneType: 'hackathon' });
    expect(stored?.credentialId).toBe(t.repos.credentials.findActiveForPage(page.id)?.id);
    // 临时目录已清理
    expect(listFiles(join(t.dataDir, 'revisions')).filter((path) => path.startsWith('.tmp-'))).toEqual([]);
  });

  it('白名单过滤：brief.md、../x、assets/.DS_Store、credentials 等不落盘；非系统文件给出 IGNORED_FILE 警告', async () => {
    const files = {
      ...exampleFiles(),
      'brief.md': b64('# 我的 brief：私密内容'),
      'DESIGN.md': b64('设计思路'),
      '../x': b64('穿越'),
      '../../etc/passwd': b64('穿越'),
      '/abs.html': b64('绝对路径'),
      'assets/.DS_Store': b64('系统文件'),
      '.DS_Store': b64('系统文件'),
      'assets/._cover.png': b64('AppleDouble'),
      credentials: b64('{"pg_x":"nmc_secret"}'),
      'page/index.html': b64('嵌套目录'),
      'assets\\evil.png': b64('反斜杠'),
    };
    const { status, body } = await submit(t, credential, files);
    expect(status).toBe(201);
    const ignored = body.revision.report.warnings.filter((issue) => issue.code === 'IGNORED_FILE').map((issue) => issue.file);
    expect(ignored.sort()).toEqual(
      ['../../etc/passwd', '../x', '/abs.html', 'DESIGN.md', 'assets\\evil.png', 'brief.md', 'credentials', 'page/index.html'].sort(),
    );
    expect(body.revision.report.stats.ignoredFiles).toEqual(expect.arrayContaining(['brief.md', 'credentials', '../x']));
    expect(body.revision.report.stats.ignoredFiles.join()).not.toContain('DS_Store');

    const all = listFiles(t.dataDir);
    for (const forbidden of ['brief.md', 'DESIGN.md', 'x', 'passwd', 'abs.html', '.DS_Store', '._cover.png', 'credentials', 'evil.png']) {
      expect(all.some((path) => path.split('/').pop() === forbidden || path.endsWith(forbidden)), forbidden).toBe(false);
    }
    expect(existsSync(join(t.dataDir, '..', 'x'))).toBe(false);
    expect(JSON.stringify(dumpDb(t.db))).not.toContain('私密内容');
  });

  it('assets/credentials 在白名单目录里也会被校验器拒绝（CREDENTIAL_LEAK），不落盘', async () => {
    const { status, body } = await submit(t, credential, { ...exampleFiles(), 'assets/credentials': b64('{}') });
    expect(status).toBe(422);
    expect(body.revision.report.errors.map((issue) => issue.code)).toContain('CREDENTIAL_LEAK');
    expect(listFiles(join(t.dataDir, 'revisions'))).toEqual([]);
  });

  it('rejected：422 + 报告，只存记录不写文件，不影响已有的 accepted 版本；编号与 accepted 共用', async () => {
    const first = await submit(t, credential, exampleFiles());
    expect(first.status).toBe(201);
    const acceptedDir = join(t.dataDir, 'revisions', first.body.revision.id);
    const before = listFiles(acceptedDir);
    const servedBefore = readFileSync(join(acceptedDir, 'served/index.html'));

    const second = await submit(t, credential, brokenFiles());
    expect(second.status).toBe(422);
    const rejected = second.body.revision;
    expect(rejected).toMatchObject({ number: 2, status: 'rejected' });
    expect(rejected.report.ok).toBe(false);
    const codes = rejected.report.errors.map((issue) => issue.code);
    expect(codes).toContain('MISSING_FILE');
    for (const issue of rejected.report.errors) {
      expect(issue.message).toMatch(/[一-鿿]/);
      expect(issue.hint).toMatch(/[一-鿿]/);
    }
    expect(existsSync(join(t.dataDir, 'revisions', rejected.id))).toBe(false);
    const stored = t.repos.revisions.findById(rejected.id);
    expect(stored).toMatchObject({ status: 'rejected', cardJson: null, manifestJson: null, renderedText: null, renderJson: null });

    expect(listFiles(acceptedDir)).toEqual(before);
    expect(readFileSync(join(acceptedDir, 'served/index.html'))).toEqual(servedBefore);
    expect(t.repos.revisions.findLatestAccepted(page.id)?.id).toBe(first.body.revision.id);

    const third = await submit(t, credential, exampleFiles());
    expect(third.body.revision.number).toBe(3);
    expect(t.repos.revisions.listForPage(page.id).map((revision) => [revision.number, revision.status])).toEqual([
      [3, 'accepted'],
      [2, 'rejected'],
      [1, 'accepted'],
    ]);
  });

  it('编号按页递增：另一页从 1 开始；context 反映版本数与最近提交时间', async () => {
    await submit(t, credential, exampleFiles());
    t.clock.advance(60_000);
    await submit(t, credential, brokenFiles());
    const other = createUser(t, 'other@example.com');
    const { page: otherPage } = seedMember(t, wall, other);
    const otherCredential = await connectAgent(t, wall, otherPage);
    const { body } = await submit(t, otherCredential, exampleFiles());
    expect(body.revision.number).toBe(1);

    const context = (await (await agentGet(t, '/api/agent/context', credential)).json()) as AgentContext;
    expect(context.page.revisionCount).toBe(2);
    expect(context.page.lastSubmittedAt).toBe(t.clock.now().toISOString());
  });

  it('请求体超过 12 MB：413 PAYLOAD_TOO_LARGE，不处理、不存储', async () => {
    const processor = t.processor as StaticProcessor;
    const before = dumpDb(t.db);
    const huge = 'A'.repeat(12 * 1024 * 1024 + 16);
    const response = await t.request('/api/agent/revisions', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: { 'assets/big.png': huge } }),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(processor.calls).toBe(0);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('超过 64 个文件、内容不是 base64、请求体不是 JSON：400 BAD_REQUEST', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`assets/a${i}.png`] = b64('x');
    const cases: unknown[] = [{ files: many }, { files: { 'index.html': '这不是 base64!' } }, { file: {} }, { files: [] }, '{oops'];
    for (const body of cases) {
      const response = await postJson(t, '/api/agent/revisions', body, credential);
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      const error = ((await response.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe('BAD_REQUEST');
      expect(error.message).toMatch(/[一-鿿]/);
    }
    expect((t.processor as StaticProcessor).calls).toBe(0);
  });

  it(`每页每 24 小时最多 ${REVISIONS_PER_PAGE_PER_DAY} 次（含 rejected），超出 429 RATE_LIMITED；过了 24 小时恢复`, async () => {
    for (let i = 0; i < REVISIONS_PER_PAGE_PER_DAY; i++) {
      const { status } = await submit(t, credential, brokenFiles());
      expect(status).toBe(422);
      t.clock.advance(1000);
    }
    const processor = t.processor as StaticProcessor;
    const calls = processor.calls;
    const limited = await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(processor.calls).toBe(calls);
    expect(t.repos.revisions.listForPage(page.id)).toHaveLength(REVISIONS_PER_PAGE_PER_DAY);

    // 限额按页计算：同一面墙的另一页不受影响
    const other = createUser(t, 'other@example.com');
    const { page: otherPage } = seedMember(t, wall, other);
    const otherCredential = await connectAgent(t, wall, otherPage);
    expect((await submit(t, otherCredential, exampleFiles())).status).toBe(201);

    t.clock.advance(24 * HOUR);
    expect((await submit(t, credential, exampleFiles())).status).toBe(201);
  });

  it('处理器出错（环境问题）：500 INTERNAL_ERROR，不存任何东西', async () => {
    const failing = createTestWeb({
      processor: {
        async process() {
          throw new Error('浏览器无法启动');
        },
        async close() {},
      },
    });
    try {
      const owner = createUser(failing, 'owner@example.com');
      const seeded = seedWall(failing, owner);
      const cred = await connectAgent(failing, seeded.wall, seeded.page);
      const response = await postJson(failing, '/api/agent/revisions', { files: exampleFiles() }, cred);
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
      expect(failing.repos.revisions.listForPage(seeded.page.id)).toEqual([]);
      expect(listFiles(join(failing.dataDir, 'revisions'))).toEqual([]);
    } finally {
      await failing.close();
    }
  });

  it('处理期间主人断开了本地 Agent：401 CREDENTIAL_INVALID，已写的文件被清理，不存版本', async () => {
    let web: TestWeb | null = null;
    let pageId = '';
    const inner = createStaticProcessor();
    const processor: SubmissionProcessor = {
      async process(input) {
        const result = await inner.process(input);
        if (web) disconnectAgent(web.web.deps, pageId);
        return result;
      },
      async close() {},
    };
    web = createTestWeb({ processor });
    try {
      const owner = createUser(web, 'owner@example.com');
      const seeded = seedWall(web, owner);
      pageId = seeded.page.id;
      const cred = await connectAgent(web, seeded.wall, seeded.page);
      const response = await postJson(web, '/api/agent/revisions', { files: exampleFiles() }, cred);
      expect(response.status).toBe(401);
      expect(web.repos.revisions.listForPage(pageId)).toEqual([]);
      expect(listFiles(join(web.dataDir, 'revisions'))).toEqual([]);
    } finally {
      await web.close();
    }
  });

  it('并发提交串行处理（共享一个渲染器）', async () => {
    let active = 0;
    let maxActive = 0;
    const inner = createStaticProcessor();
    const slow = createTestWeb({
      processor: {
        async process(input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return inner.process(input);
        },
        async close() {},
      },
    });
    try {
      const owner = createUser(slow, 'owner@example.com');
      const seeded = seedWall(slow, owner);
      const cred = await connectAgent(slow, seeded.wall, seeded.page);
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => postJson(slow, '/api/agent/revisions', { files: exampleFiles() }, cred)),
      );
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
      expect(maxActive).toBe(1);
      expect(slow.repos.revisions.listForPage(seeded.page.id).map((revision) => revision.number)).toEqual([4, 3, 2, 1]);
    } finally {
      await slow.close();
    }
  });
});
