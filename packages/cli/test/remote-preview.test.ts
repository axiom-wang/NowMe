/**
 * `nowme preview --remote`（随 Skill 包分发的 CLI 里就是 preview）：服务端渲染预览（contracts 1.5、4.1）。
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { capture, makeWorkdir, type TempWorkdir } from './helpers.js';
import { CREDENTIAL, TINY_PNG_BASE64, TOKEN, WALL_ID, previewBody, startMockServer, type MockServer } from './mock-server.js';

let mock: MockServer;
let home: string;
let work: TempWorkdir;
beforeEach(async () => {
  mock = await startMockServer();
  home = join(await mkdtemp(join(tmpdir(), 'nowme-home-')), '.nowme');
  work = await makeWorkdir();
});
afterEach(async () => {
  await mock.close();
  await rm(join(home, '..'), { recursive: true, force: true });
  await work.cleanup();
});

async function cli(args: string[]) {
  const io = capture();
  const code = await run(args, io.io, { env: { INIT_CWD: work.root, NOWME_HOME: home } });
  return { code, out: io.stdout(), err: io.stderr() };
}

async function link() {
  expect((await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin])).code).toBe(0);
  mock.requests.length = 0;
}

const previewRequests = () => mock.requests.filter((request) => request.path === '/api/agent/previews');

describe('nowme preview --remote', () => {
  it('上传白名单文件（凭证只在 Authorization 头），写截图与报告到 .nowme-preview/，缺封面时写入 page/cover.png', async () => {
    await link();
    await writeFile(join(work.pageDir, 'brief.md'), '私密 brief，不能上传');
    const { code, out } = await cli(['preview', '--remote']);
    expect(code).toBe(0);
    const [request] = previewRequests();
    expect(request?.authorization).toBe(`Bearer ${CREDENTIAL}`);
    const uploaded = Object.keys((JSON.parse(request?.body ?? '{}') as { files: Record<string, string> }).files).sort();
    expect(uploaded).toEqual(['card.json', 'index.html', 'manifest.json']);
    expect(request?.body).not.toContain(CREDENTIAL);

    const outDir = join(work.root, '.nowme-preview');
    expect((await readdir(outDir)).sort()).toEqual(['blocks', 'cover.png', 'full-reduced-motion.png', 'full.png', 'report.json']);
    expect((await readFile(join(outDir, 'full.png'))).toString('base64')).toBe(TINY_PNG_BASE64);
    expect(await readdir(join(outDir, 'blocks'))).toEqual(['01-hero.png']);
    expect((await stat(join(work.pageDir, 'cover.png'))).isFile()).toBe(true);
    expect(out).toContain('服务端渲染');
    expect(out).toContain('没有生成版本');
    expect(out).not.toContain(CREDENTIAL);
    // 上报 preview 事件，带 remote 标记
    const event = mock.requests.find((r) => r.path === '/api/agent/events');
    expect(JSON.parse(event?.body ?? '{}')).toMatchObject({ type: 'preview', props: { ok: true, remote: true } });
  });

  it('已有 cover.png 时不覆盖，也照常上传；--cover 时不上传旧封面并覆盖', async () => {
    await link();
    await writeFile(join(work.pageDir, 'cover.png'), Buffer.from('old cover'));
    await cli(['preview', '--remote']);
    expect(await readFile(join(work.pageDir, 'cover.png'), 'utf8')).toBe('old cover');
    expect(previewRequests()[0]?.body).toContain('cover.png');
    mock.requests.length = 0;
    await cli(['preview', '--remote', '--cover']);
    expect(previewRequests()[0]?.body).not.toContain('cover.png');
    expect((await readFile(join(work.pageDir, 'cover.png'))).toString('base64')).toBe(TINY_PNG_BASE64);
  });

  it('服务端报告有错误：打印报告，退出码 1', async () => {
    await link();
    mock.handlers.previews = () => ({
      status: 200,
      body: previewBody({ ok: false, errors: [{ code: 'MISSING_FILE', severity: 'error', file: 'card.json', message: '缺少 card.json', hint: '补上' }] }),
    });
    const { code, out } = await cli(['preview', '--remote']);
    expect(code).toBe(1);
    expect(out).toContain('缺少 card.json');
  });

  it('没有 nowme.json：提示先 fetch，不发请求', async () => {
    const { code, err } = await cli(['preview', '--remote']);
    expect(code).toBe(1);
    expect(err).toContain('nowme fetch');
    expect(previewRequests()).toEqual([]);
  });

  it('401 / 429：中文说明', async () => {
    await link();
    mock.handlers.previews = () => ({ status: 429, body: { error: { code: 'RATE_LIMITED', message: '预览太频繁' } } });
    const limited = await cli(['preview', '--remote']);
    expect(limited.code).toBe(1);
    expect(limited.err).toContain('预览次数已达上限');
    mock.handlers.previews = () => ({ status: 401, body: { error: { code: 'CREDENTIAL_INVALID', message: '凭证无效' } } });
    const invalid = await cli(['preview', '--remote']);
    expect(invalid.err).toContain('重新生成指令');
  });
});
