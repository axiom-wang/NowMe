/**
 * nowme preview：对一个 Skill 示例产出 page/cover.png 与 .nowme-preview/ 产物，page/ 中没有多余文件；
 * 已有封面时不覆盖（--cover 才重新生成）；--json 结构；--serve 保持服务器、Ctrl+C 退出。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COVER_HEIGHT, COVER_MAX_BYTES, COVER_WIDTH, PAGE_IFRAME_SANDBOX } from '@nowme/contracts';
import { coverIssues, pngSize } from '@nowme/render';
import { PREVIEW_OUTPUT_DIR, run, type PreviewOutput } from '../src/index.js';
import { capture, makeWorkdir, type TempWorkdir } from './helpers.js';

let workdir: TempWorkdir | null = null;
afterEach(async () => {
  await workdir?.cleanup();
  workdir = null;
});

const EXAMPLE = 'hackathon-poster';

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`])),
  );
  return nested.flat().sort();
}

/** 找两个相邻的空闲端口（外壳 p、页面 p+1）。 */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    const ok = await Promise.all([port, port + 1].map((candidate) => new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    })));
    if (ok.every(Boolean)) return port;
  }
  throw new Error('找不到空闲端口');
}

describe('nowme preview', () => {
  it(`对示例 ${EXAMPLE}：写入 page/cover.png，产物在 .nowme-preview/，page/ 里没有多余文件，打印截图的绝对路径`, async () => {
    workdir = await makeWorkdir({ example: EXAMPLE });
    const before = await listFiles(workdir.pageDir);
    expect(before).not.toContain('cover.png');
    const io = capture();
    const code = await run(['preview'], io.io, { env: { INIT_CWD: workdir.root }, cwd: '/' });
    expect(io.stderr()).toBe('');
    expect(code).toBe(0);

    // page/：只多了 cover.png
    expect(await listFiles(workdir.pageDir)).toEqual([...before, 'cover.png'].sort());
    const cover = new Uint8Array(await readFile(join(workdir.pageDir, 'cover.png')));
    expect(pngSize(cover)).toEqual({ width: COVER_WIDTH, height: COVER_HEIGHT });
    expect(cover.byteLength).toBeLessThanOrEqual(COVER_MAX_BYTES);
    expect(coverIssues(cover)).toEqual([]);

    // .nowme-preview/：在工作目录（page/ 的上一级）
    const outDir = join(workdir.root, PREVIEW_OUTPUT_DIR);
    const outputs = await listFiles(outDir);
    for (const file of ['cover.png', 'full.png', 'full-reduced-motion.png', 'report.json', 'served/index.html']) expect(outputs).toContain(file);
    expect(outputs.filter((file) => file.startsWith('blocks/'))).toHaveLength(6);
    expect(outputs.some((file) => file.startsWith('served/_fonts/') || file.startsWith('served/'))).toBe(true);
    expect(outputs.some((file) => file.includes('DESIGN.md') || file.includes('card.json'))).toBe(false);

    const out = io.stdout();
    expect(out).toContain(`封面：已写入 ${join(workdir.pageDir, 'cover.png')}（750×1000`);
    for (const file of ['cover.png', 'full.png', 'full-reduced-motion.png', 'blocks/01-hero.png']) expect(out).toContain(join(outDir, file));
    expect(out).toContain(`报告：${join(outDir, 'report.json')}`);
    expect(out).toContain('结果：通过');

    const report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8')) as PreviewOutput;
    expect(report.ok).toBe(true);
    expect(report.report.errors).toEqual([]);
    expect(report.cover.written).toBe(true);
    expect(report.renderedText.length).toBeGreaterThan(20);

    // 再跑一次：已有封面不覆盖
    const again = capture();
    expect(await run(['preview', 'page'], again.io, { env: { INIT_CWD: workdir.root }, cwd: '/' })).toBe(0);
    expect(again.stdout()).toContain('使用页面自带的');
    expect(new Uint8Array(await readFile(join(workdir.pageDir, 'cover.png')))).toEqual(cover);
    expect(await listFiles(workdir.pageDir)).toEqual([...before, 'cover.png'].sort());
  }, 120_000);

  it('--cover --json：重新生成封面，stdout 是一个完整的 JSON', async () => {
    workdir = await makeWorkdir({ files: { 'cover.png': 'not a png' } });
    const io = capture();
    const code = await run(['preview', '--cover', '--json'], io.io, { env: { INIT_CWD: workdir.root }, cwd: '/' });
    const output = JSON.parse(io.stdout()) as PreviewOutput;
    expect(output.command).toBe('preview');
    // 旧的 cover.png 不合格，但 --cover 会覆盖它，校验时当它不存在
    expect(code).toBe(0);
    expect(output.report.errors).toEqual([]);
    expect(output.cover.written).toBe(true);
    expect(output.cover.generated).toBe(true);
    expect(output.cover).toMatchObject({ width: 750, height: 1000 });
    expect(output.screenshots.full).toBe(join(workdir.root, PREVIEW_OUTPUT_DIR, 'full.png'));
    expect(output.serve).toBeNull();
    expect(coverIssues(new Uint8Array(await readFile(join(workdir.pageDir, 'cover.png'))))).toEqual([]);
    // 再预览时沿用新封面
    const next = capture();
    expect(await run(['preview', '--json'], next.io, { env: { INIT_CWD: workdir.root }, cwd: '/' })).toBe(0);
    expect((JSON.parse(next.stdout()) as PreviewOutput).cover.generated).toBe(false);
  }, 120_000);

  it('--serve：在 --port 给的端口提供外壳（sandbox="allow-scripts"）与页面，Ctrl+C 后关闭', async () => {
    workdir = await makeWorkdir();
    const port = await freePortPair();
    const io = capture();
    let checked: { shell: string; status: number; csp: string | null } | null = null;
    const code = await run(['preview', '--serve', '--port', String(port)], io.io, {
      env: { INIT_CWD: workdir.root },
      cwd: '/',
      untilInterrupted: async () => {
        const shell = await (await fetch(`http://localhost:${port}/`)).text();
        const src = /<iframe[^>]*src="([^"]+)"/.exec(shell)?.[1] ?? '';
        const page = await fetch(src);
        checked = { shell, status: page.status, csp: page.headers.get('content-security-policy') };
      },
    });
    expect(code).toBe(0);
    expect(io.stdout()).toContain(`预览服务器已启动：在浏览器打开 http://localhost:${port}/`);
    expect(io.stdout()).toContain('预览服务器已关闭');
    const result = checked as unknown as { shell: string; status: number; csp: string | null };
    expect(result.shell).toContain(`sandbox="${PAGE_IFRAME_SANDBOX}"`);
    expect(result.shell).toContain(`src="http://127.0.0.1:${port + 1}/v/`);
    expect(result.status).toBe(200);
    expect(result.csp).toContain(`frame-ancestors http://localhost:${port}`);
    // 退出后端口已释放
    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
  }, 120_000);

  it('--port 只能和 --serve 一起用；页面目录不存在时退出码 1', async () => {
    workdir = await makeWorkdir();
    const io = capture();
    expect(await run(['preview', '--port', '4100'], io.io, { env: { INIT_CWD: workdir.root } })).toBe(1);
    expect(io.stderr()).toContain('--port 只在 --serve 时使用');
    const missing = capture();
    expect(await run(['preview', 'nope'], missing.io, { env: { INIT_CWD: workdir.root } })).toBe(1);
    expect(missing.stderr()).toContain('找不到页面目录');
    expect((await stat(workdir.root)).isDirectory()).toBe(true);
  });
});
