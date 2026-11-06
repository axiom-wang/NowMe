/**
 * fetch / submit / status / event 对模拟服务器（contracts 4.1）的行为。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { capture, makeWorkdir, type TempWorkdir } from './helpers.js';
import { CREDENTIAL, PAGE_ID, TOKEN, WALL_ID, revision, startMockServer, type MockServer } from './mock-server.js';

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

const env = (cwd: string) => ({ INIT_CWD: cwd, NOWME_HOME: home });

async function cli(args: string[], cwd = work.root) {
  const io = capture();
  const code = await run(args, io.io, { env: env(cwd) });
  return { code, out: io.stdout(), err: io.stderr() };
}

const fetchArgs = () => ['fetch', WALL_ID, TOKEN, '--server', mock.origin];

async function link() {
  expect((await cli(fetchArgs())).code).toBe(0);
  mock.requests.length = 0;
}

describe('nowme fetch', () => {
  it('成功：写 nowme.json、context.json、凭证（0600 / 0700），打印墙信息与下一步', async () => {
    const result = await cli(fetchArgs());
    expect(result.code).toBe(0);
    expect(result.out).toContain('周末黑客松');
    expect(result.out).toContain('欢迎大家！');
    expect(result.out).toContain('scenes/hackathon.json');
    const nowmeJson = JSON.parse(await readFile(join(work.root, 'nowme.json'), 'utf8'));
    expect(nowmeJson).toEqual({ server: mock.origin, wallId: WALL_ID, pageId: PAGE_ID });
    const context = JSON.parse(await readFile(join(work.root, 'context.json'), 'utf8'));
    expect(context.wall.name).toBe('周末黑客松');
    const credentials = JSON.parse(await readFile(join(home, 'credentials'), 'utf8'));
    expect(credentials.version).toBe(1);
    expect(credentials.pages[PAGE_ID]).toMatchObject({ server: mock.origin, wallId: WALL_ID, credential: CREDENTIAL });
    expect((await stat(join(home, 'credentials'))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    for (const text of [await readFile(join(work.root, 'nowme.json'), 'utf8'), await readFile(join(work.root, 'context.json'), 'utf8')]) {
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toContain('nmc_');
    }
    // 上报了 fetch 事件
    const events = mock.requests.filter((request) => request.path === '/api/agent/events');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.body ?? '{}').type).toBe('fetch');
  });

  it('--json 输出结构，不含凭证', async () => {
    const result = await cli([...fetchArgs(), '--json']);
    const data = JSON.parse(result.out);
    expect(data).toMatchObject({ command: 'fetch', ok: true, wallId: WALL_ID, pageId: PAGE_ID, credentialSaved: true });
    expect(result.out).not.toContain(CREDENTIAL);
  });

  it('401：中文说明 token 已用过 / 过期 / 不属于这面墙；不写任何文件', async () => {
    const result = await cli(['fetch', WALL_ID, 'nmt_wrong', '--server', mock.origin]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('token 已用过、过期或不属于这面墙，请在应用的创作工作区重新生成指令');
    await expect(stat(join(work.root, 'nowme.json'))).rejects.toThrow();
    await expect(stat(join(home, 'credentials'))).rejects.toThrow();
  });

  it('在 page/ 目录内运行被拒绝，且不发请求', async () => {
    const result = await cli(fetchArgs(), work.pageDir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('page/');
    expect(mock.requests).toHaveLength(0);
    await expect(stat(join(work.pageDir, 'nowme.json'))).rejects.toThrow();
  });

  it('只接受 http(s) 服务器地址', async () => {
    const result = await cli(['fetch', WALL_ID, TOKEN, '--server', 'ftp://localhost:3000']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('http');
  });

  it('网络错误：中文提示', async () => {
    const result = await cli(['fetch', WALL_ID, TOKEN, '--server', 'http://127.0.0.1:1']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('无法连接');
  });

  it('无参数：刷新 context.json', async () => {
    await link();
    mock.handlers.context = () => ({ status: 200, body: { ...JSON.parse(JSON.stringify(require_context())), wall: { ...require_context().wall, name: '改名后的墙' } } });
    const result = await cli(['fetch']);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(work.root, 'context.json'), 'utf8')).wall.name).toBe('改名后的墙');
    expect(mock.requests.find((request) => request.path === '/api/agent/context')?.authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('无参数且没有 nowme.json：提示先 fetch', async () => {
    const result = await cli(['fetch']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nowme fetch <wallId> <token>');
  });

  it('无参数遇到 CREDENTIAL_INVALID：列出可能原因并提示重新获取指令', async () => {
    await link();
    mock.handlers.context = () => ({ status: 401, body: { error: { code: 'CREDENTIAL_INVALID', message: '凭证已失效' } } });
    const result = await cli(['fetch']);
    expect(result.code).toBe(1);
    for (const phrase of ['断开了连接', '重新生成过指令', '退出了这面墙', '墙已关闭', '重新生成指令']) expect(result.err).toContain(phrase);
  });
});

function require_context() {
  return {
    wall: { id: WALL_ID, name: '周末黑客松', description: '48 小时', sceneType: 'hackathon', organizerNote: '欢迎大家！' },
    page: { id: PAGE_ID, revisionCount: 0, lastSubmittedAt: null, workspaceUrl: 'http://localhost:3000/w' },
    kit: { version: '1', basePath: '/_nowme/kit/v1/', fonts: [] },
    limits: {},
  };
}

describe('nowme submit', () => {
  it('201：只上传白名单文件，打印版本号与发布提醒', async () => {
    await link();
    await writeFile(join(work.root, 'brief.md'), '私密 brief');
    await writeFile(join(work.pageDir, 'brief.md'), '私密 brief');
    await writeFile(join(work.pageDir, '.DS_Store'), 'x');
    await writeFile(join(work.pageDir, 'notes.txt'), 'x');
    const result = await cli(['submit']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('版本 #3');
    expect(result.out).toContain('发布需要你在应用内确认缩略卡和联系方式');
    expect(result.out).toContain('http://localhost:3000/w/wal_testwall/me');
    const request = mock.requests.find((candidate) => candidate.path === '/api/agent/revisions');
    const uploaded = Object.keys(JSON.parse(request?.body ?? '{}').files).sort();
    expect(uploaded).toEqual(['card.json', 'index.html', 'manifest.json']);
    expect(request?.body).not.toContain(CREDENTIAL);
    expect(Buffer.from(JSON.parse(request?.body ?? '{}').files['index.html'], 'base64').toString()).toContain('你好');
    const events = mock.requests.filter((candidate) => candidate.path === '/api/agent/events').map((candidate) => JSON.parse(candidate.body));
    expect(events.at(-1)).toMatchObject({ type: 'submit', props: { ok: true } });
  });

  it('补全 extraChars 后上传补全的 manifest', async () => {
    await link();
    expect((await cli(['submit'])).code).toBe(0);
    const request = mock.requests.find((candidate) => candidate.path === '/api/agent/revisions');
    const manifest = Buffer.from(JSON.parse(request?.body ?? '{}').files['manifest.json'], 'base64').toString();
    expect(JSON.parse(manifest).extraChars).toContain('额');
  });

  it('--json：成功结构', async () => {
    await link();
    const data = JSON.parse((await cli(['submit', '--json'])).out);
    expect(data).toMatchObject({ command: 'submit', ok: true, publishRequiresOwner: true });
    expect(data.revision.number).toBe(3);
    expect(data.uploaded).toContain('index.html');
  });

  it('本地校验失败：不发请求，打印报告，退出码 1', async () => {
    await link();
    await writeFile(join(work.pageDir, 'index.html'), '<html><script>fetch("/x")</script></html>');
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(mock.requests.filter((request) => request.path === '/api/agent/revisions')).toHaveLength(0);
    expect(result.err).toContain('没有上传任何内容');
    expect(result.err).toContain('修复：');
  });

  it('422：打印服务端报告（按文件分组带修复提示），退出码 1', async () => {
    await link();
    mock.handlers.revisions = () => ({
      status: 422,
      body: {
        revision: revision('rejected', {
          ok: false,
          errors: [{ code: 'RENDER_CSP_VIOLATION', severity: 'error', file: 'index.html', line: 3, message: '被拦截的请求', hint: '去掉外部请求' }],
        }),
      },
    });
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('index.html');
    expect(result.err).toContain('RENDER_CSP_VIOLATION');
    expect(result.err).toContain('修复：去掉外部请求');
    const json = JSON.parse((await cli(['submit', '--json'])).out);
    expect(json).toMatchObject({ ok: false, stage: 'server-validation' });
  });

  it.each([
    [401, 'CREDENTIAL_INVALID', '凭证已失效'],
    [429, 'RATE_LIMITED', '提交次数已达上限'],
    [413, 'PAYLOAD_TOO_LARGE', '太大'],
  ])('%i：中文说明，退出码 1', async (status, code, phrase) => {
    await link();
    mock.handlers.revisions = () => ({ status, body: { error: { code, message: '服务器消息' } } });
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(result.err).toContain(phrase);
    const json = JSON.parse((await cli(['submit', '--json'])).out);
    expect(json.error).toMatchObject({ code, status });
  });

  it('网络错误：中文说明，退出码 1', async () => {
    await link();
    await mock.close();
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('无法连接');
    mock = await startMockServer();
  });

  it('没有 nowme.json / 凭证：提示先 fetch', async () => {
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nowme fetch');
  });

  it('超过 12 MB 在本地拒绝，不发请求', async () => {
    await link();
    await mkdir(join(work.pageDir, 'assets'), { recursive: true });
    // 校验会先报资源超限；这里直接绕过：用 6 个 2MB 以内的资源 + 超大 html 都会先被校验拦下，
    // 所以只断言“超限一律不发请求”。
    for (let index = 0; index < 8; index += 1) await writeFile(join(work.pageDir, 'assets', `a${index}.png`), Buffer.alloc(1_900_000, 1));
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(mock.requests.filter((request) => request.path === '/api/agent/revisions')).toHaveLength(0);
  });
});

describe('nowme status', () => {
  it('未关联', async () => {
    const result = await cli(['status']);
    expect(result.code).toBe(0);
    expect(result.out).toContain(work.root);
    expect(result.out).toContain('尚未关联');
  });

  it('已关联：显示服务器 / 墙 / 页面 / 凭证存在，不显示凭证', async () => {
    await link();
    const result = await cli(['status']);
    expect(result.out).toContain(mock.origin);
    expect(result.out).toContain(PAGE_ID);
    expect(result.out).toContain('凭证：已保存在本机');
    expect(result.out).toContain('page/：有');
    const json = JSON.parse((await cli(['status', '--json'])).out);
    expect(json).toMatchObject({ linked: true, credential: true, pageDirExists: true, contextExists: true });
  });
});

describe('nowme event', () => {
  it('只接受 contracts 的事件类型', async () => {
    expect((await cli(['event', 'publish'])).code).toBe(1);
    expect((await cli(['event'])).code).toBe(1);
    expect((await cli(['event', 'generate'])).code).toBe(0);
  });

  it('无凭证：静默成功；--json 说明未上报；不联网', async () => {
    const result = await cli(['event', 'generate']);
    expect(result).toMatchObject({ code: 0, out: '', err: '' });
    const json = JSON.parse((await cli(['event', 'generate', '--json'])).out);
    expect(json).toMatchObject({ sent: false });
    expect(mock.requests).toHaveLength(0);
  });

  it('有凭证：props 只含数字 / 布尔', async () => {
    await link();
    const result = await cli(['event', 'generate', '--ok', '--duration-ms', '1200', '--count', '3', '--json']);
    expect(result.code).toBe(0);
    const sent = mock.requests.find((request) => request.path === '/api/agent/events');
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({ type: 'generate', props: { ok: true, durationMs: 1200, count: 3 } });
    expect(JSON.parse(result.out)).toMatchObject({ sent: true });
    await cli(['event', 'generate', '--no-ok']);
    expect(JSON.parse(mock.requests.filter((request) => request.path === '/api/agent/events').at(-1)?.body ?? '{}').props).toEqual({ ok: false });
    for (const request of mock.requests.filter((candidate) => candidate.path === '/api/agent/events')) {
      for (const value of Object.values(JSON.parse(request.body).props)) expect(['number', 'boolean']).toContain(typeof value);
    }
  });

  it('上报失败不影响退出码', async () => {
    await link();
    mock.handlers.events = () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'x' } } });
    expect((await cli(['event', 'generate'])).code).toBe(0);
  });

  it('validate 结束时真实上报 validate 事件', async () => {
    await link();
    expect((await cli(['validate'])).code).toBe(0);
    const types = mock.requests.filter((request) => request.path === '/api/agent/events').map((request) => JSON.parse(request.body).type);
    expect(types).toContain('validate');
  });
});
