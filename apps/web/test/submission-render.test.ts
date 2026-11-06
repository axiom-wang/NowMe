/**
 * 真实渲染的集成测试：默认处理器（`buildRevision({ mode: 'submit' })` + 共享的 `createRenderer()`），
 * 提交一个 Skill 示例页，检查服务端重新校验、渲染、字体子集化与存储布局；再用页面托管（同进程）按工作区
 * iframe 的地址取回页面。Kit 字体源文件缺失时跳过（`pnpm --filter @nowme/kit fonts:fetch`）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifestSchema, parseCsp, type RevisionResponse } from '@nowme/contracts';
import { hasKitFontSource } from '@nowme/kit';
import { createPagesApp } from '@nowme/pages-host';
import { pngSize } from '@nowme/render';
import { EXAMPLES_DIR } from '@nowme/skill';
import { createRenderProcessor } from '../src/services/processor.js';
import {
  b64,
  connectAgent,
  createTestWeb,
  exampleFiles,
  get,
  iframesOf,
  KIT_FONTS,
  listFiles,
  login,
  postJson,
  seedWall,
  TEST_SECRET,
  type TestWeb,
} from './helpers.js';

const EXAMPLE = 'hackathon-terminal';
const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(EXAMPLES_DIR, EXAMPLE, 'manifest.json'), 'utf8')));
const fontsAvailable = manifest.fonts.every(({ id, weights }) => {
  const font = KIT_FONTS.find((item) => item.id === id);
  return font !== undefined && weights.every((weight) => hasKitFontSource(font, weight));
});

describe.skipIf(!fontsAvailable)('提交管线：真实渲染', () => {
  let t: TestWeb;
  let credential: string;
  let wallId: string;
  let cookie: string;

  beforeAll(async () => {
    t = createTestWeb({ processor: createRenderProcessor() });
    const owner = await login(t, 'owner@example.com', '林舟');
    cookie = owner.cookie;
    const { wall, page } = seedWall(t, owner.userId);
    wallId = wall.id;
    credential = await connectAgent(t, wall, page);
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  it(
    '示例页通过：served/ 注入 @font-face 与字体子集，封面 750×1000，整页截图，渲染后文字入库；页面托管能按票据取回',
    async () => {
      const response = await postJson(t, '/api/agent/revisions', { files: exampleFiles(EXAMPLE, { includeCover: false }) }, credential);
      const { revision } = (await response.json()) as RevisionResponse;
      expect(response.status, JSON.stringify(revision.report.errors)).toBe(201);
      expect(revision.report.errors).toEqual([]);
      expect(revision.report.warnings.filter((issue) => issue.code.startsWith('RENDER_'))).toEqual([]);

      const dir = join(t.dataDir, 'revisions', revision.id);
      const files = listFiles(dir);
      expect(files).toEqual(expect.arrayContaining(['cover.png', 'render/full.png', 'served/index.html', 'original/index.html']));
      const fontFiles = files.filter((path) => path.startsWith('served/_fonts/'));
      expect(fontFiles.sort()).toEqual(
        manifest.fonts.flatMap(({ id, weights }) => weights.map((weight) => `served/_fonts/${id}-${weight}.woff2`)).sort(),
      );
      const served = readFileSync(join(dir, 'served/index.html'), 'utf8');
      expect(served).toContain('@font-face');
      expect(pngSize(readFileSync(join(dir, 'cover.png')))).toEqual({ width: 750, height: 1000 });
      expect(readFileSync(join(dir, 'render/full.png')).subarray(1, 4).toString()).toBe('PNG');

      const stored = t.repos.revisions.findById(revision.id);
      expect(stored?.renderedText).toContain('林舟');
      const render = JSON.parse(stored?.renderJson ?? '{}') as { coverGenerated: boolean; metrics: { renderPasses: number } };
      expect(render.coverGenerated).toBe(true);
      expect(render.metrics.renderPasses).toBeGreaterThanOrEqual(1);

      // 工作区 iframe 的地址 → 页面托管（同进程）返回 served/index.html 与 S2 CSP
      const html = await (await get(t, `/w/${wallId}/me`, { cookie })).text();
      const src = iframesOf(html)[0]?.src as string;
      const pages = createPagesApp({ ...t.config, ticketSecret: TEST_SECRET }, { log: () => {}, now: t.clock.now });
      const page = await pages.request(src);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(served);
      expect(parseCsp(page.headers.get('content-security-policy') ?? '').get('frame-ancestors')).toEqual([t.config.webOrigin]);
      const font = await pages.request(`${src}_fonts/${manifest.fonts[0]?.id}-${manifest.fonts[0]?.weights[0]}.woff2`);
      expect(font.status).toBe(200);
      expect(font.headers.get('content-type')).toBe('font/woff2');
      expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    '静态校验通过但渲染时脚本报错：服务端渲染检查拦下（RENDER_SCRIPT_ERROR），422，不写文件',
    async () => {
      const files = exampleFiles(EXAMPLE);
      const html = Buffer.from(files['index.html'] as string, 'base64').toString('utf8');
      files['index.html'] = b64(html.replace('</body>', '<script>throw new Error("boom")</script></body>'));
      const response = await postJson(t, '/api/agent/revisions', { files }, credential);
      const { revision } = (await response.json()) as RevisionResponse;
      expect(response.status).toBe(422);
      expect(revision.report.errors.map((issue) => issue.code)).toContain('RENDER_SCRIPT_ERROR');
      expect(listFiles(join(t.dataDir, 'revisions', revision.id))).toEqual([]);
    },
    120_000,
  );
});
