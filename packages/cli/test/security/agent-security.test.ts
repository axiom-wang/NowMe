/**
 * 安全：凭证永远不出现在输出、page/、上传内容里；凭证文件权限。
 */
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskCredential, redactCredentials, run } from '../../src/index.js';
import { capture, makeWorkdir, type TempWorkdir } from '../helpers.js';
import { CREDENTIAL, PAGE_ID, TOKEN, WALL_ID, revision, startMockServer, type MockServer } from '../mock-server.js';

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

async function cli(args: string[], cwd = work.root) {
  const io = capture();
  const code = await run(args, io.io, { env: { INIT_CWD: cwd, NOWME_HOME: home } });
  return { code, text: io.stdout() + io.stderr() };
}

describe('凭证不出现在任何输出里', () => {
  it('掩码只留 nmc_ + 前 4 位；redactCredentials 兜底', () => {
    expect(maskCredential(CREDENTIAL)).toBe(`${CREDENTIAL.slice(0, 8)}…`);
    expect(redactCredentials(`x ${CREDENTIAL} y`)).not.toContain(CREDENTIAL);
  });

  it('各命令的各分支（含 --json、服务器回显凭证的错误信息）', async () => {
    const outputs: string[] = [];
    const record = async (args: string[], cwd?: string) => outputs.push((await cli(args, cwd)).text);
    await record(['fetch', WALL_ID, 'bad', '--server', mock.origin]);
    await record(['fetch', WALL_ID, TOKEN, '--server', mock.origin, '--json']);
    await record(['fetch']);
    await record(['fetch', '--json']);
    await record(['status']);
    await record(['status', '--json']);
    await record(['validate']);
    await record(['validate', '--json']);
    await record(['submit']);
    await record(['submit', '--json']);
    await record(['event', 'generate', '--ok', '--json']);
    await record(['event', 'nope']);
    // 服务器把凭证回显在错误信息里
    mock.handlers.revisions = () => ({ status: 429, body: { error: { code: 'RATE_LIMITED', message: `echo ${CREDENTIAL}` } } });
    await record(['submit']);
    await record(['submit', '--json']);
    mock.handlers.revisions = () => ({ status: 422, body: { revision: revision('rejected', { ok: false, errors: [{ code: 'X', severity: 'error', file: 'index.html', message: `leak ${CREDENTIAL}`, hint: 'h' }] }) } });
    await record(['submit']);
    mock.handlers.context = () => ({ status: 401, body: { error: { code: 'CREDENTIAL_INVALID', message: CREDENTIAL } } });
    await record(['fetch']);
    await mock.close();
    await record(['submit']);
    await record(['fetch']);
    mock = await startMockServer();
    expect(outputs.length).toBeGreaterThan(10);
    for (const text of outputs) expect(text).not.toContain(CREDENTIAL);
  });
});

describe('page/ 里没有凭证和 nowme.json', () => {
  it('fetch / submit / status / event 之后 page/ 内容不变', async () => {
    const before = (await readdir(work.pageDir)).sort();
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    await cli(['submit']);
    await cli(['status']);
    await cli(['event', 'generate']);
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin], work.pageDir);
    expect((await readdir(work.pageDir)).sort()).toEqual(before);
    for (const name of await readdir(work.pageDir)) expect(await readFile(join(work.pageDir, name), 'utf8')).not.toContain('nmc_');
  });

  it('page/ 里放了凭证文件或凭证字符串：credentials 文件被本地校验拦下；字符串在泄露断言阶段被拦下', async () => {
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    mock.requests.length = 0;
    await writeFile(join(work.pageDir, 'credentials'), JSON.stringify({ c: CREDENTIAL }));
    const blocked = await cli(['submit']);
    expect(blocked.code).toBe(1);
    expect(blocked.text).toContain('CREDENTIAL_LEAK');
    expect(mock.requests.filter((candidate) => candidate.path === '/api/agent/revisions')).toHaveLength(0);
    await rm(join(work.pageDir, 'credentials'));

    mock.requests.length = 0;
    const html = await readFile(join(work.pageDir, 'index.html'), 'utf8');
    await writeFile(join(work.pageDir, 'index.html'), html.replace('关于我', `关于我 ${CREDENTIAL}`));
    const result = await cli(['submit']);
    expect(result.code).toBe(1);
    expect(mock.requests.filter((candidate) => candidate.path === '/api/agent/revisions')).toHaveLength(0);
    expect(result.text).not.toContain(CREDENTIAL);
  });
});

describe('凭证文件权限', () => {
  it('创建后目录 0700、文件 0600；重复写入后仍是 0600', async () => {
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, 'credentials'))).mode & 0o777).toBe(0o600);
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('文件或目录被别的用户可读时：使用时收紧并提示', async () => {
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    await chmod(join(home, 'credentials'), 0o644);
    await chmod(home, 0o755);
    const result = await cli(['status']);
    expect(result.text).toContain('收紧');
    expect((await stat(join(home, 'credentials'))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    // 事件钩子路径同样收紧
    await chmod(join(home, 'credentials'), 0o666);
    await cli(['event', 'generate']);
    expect((await stat(join(home, 'credentials'))).mode & 0o777).toBe(0o600);
  });

  it('凭证文件保留其他页面的凭证', async () => {
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    const file = join(home, 'credentials');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.pages.pag_other = { server: 'http://x', wallId: 'wal_o', credential: 'nmc_other', createdAt: 'now' };
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
    await cli(['fetch', WALL_ID, TOKEN, '--server', mock.origin]);
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).pages).sort()).toEqual(['pag_other', PAGE_ID].sort());
  });
});
