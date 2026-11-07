/**
 * 随 Skill 包分发的单文件 CLI（contracts 1.5、4.5）：打包产物不含 Playwright，能用 node 直接运行。
 */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleCli, type BundleCliResult } from '../src/bundle.js';
import { EXAMPLES_DIR } from './helpers.js';
import { CREDENTIAL, PAGE_ID, TOKEN, WALL_ID, makeContext, startMockServer, type MockServer } from './mock-server.js';

const exec = promisify(execFile);
const KIT_FONTS_FILE = new URL('../../kit/fonts.json', import.meta.url);

let dir: string;
let file: string;
let result: BundleCliResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nowme-bundle-'));
  file = join(dir, 'nowme.mjs');
  result = await bundleCli(file, { skillVersion: '9.8.7' });
}, 60_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function node(args: string[], cwd: string, env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [file, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('单文件 CLI', () => {
  it('不含 @nowme/render、Playwright；体积有上限；带 shebang', async () => {
    expect(result.inputs.some((input) => /playwright|packages\/render\//.test(input))).toBe(false);
    expect(result.bytes).toBeLessThan(3 * 1024 * 1024);
    expect((await readFile(file, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('--version 报告 Skill 版本；--help 的 preview 说明是服务端渲染', async () => {
    expect((await node(['--version'], dir)).stdout.trim()).toBe('nowme 0.1.0 · NOWMe Skill 9.8.7');
    const help = (await node(['--help'], dir)).stdout;
    expect(help).toContain('服务端');
    expect(help).not.toContain('[--serve]');
  });

  it('validate：用 context.json 里的 Kit 字体清单；没有 context.json 时提示先 fetch', async () => {
    const work = await mkdtemp(join(tmpdir(), 'nowme-bundle-work-'));
    await cp(join(EXAMPLES_DIR, 'hackathon-terminal'), join(work, 'page'), { recursive: true });
    const missing = await node(['validate', '--no-fix'], work);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('nowme fetch');
    const fonts = (JSON.parse(await readFile(KIT_FONTS_FILE, 'utf8')) as { fonts: unknown[] }).fonts;
    await writeFile(join(work, 'context.json'), JSON.stringify({ ...makeContext(), kit: { version: '1', basePath: '/_nowme/kit/v1/', fonts } }));
    const ok = await node(['validate', '--no-fix'], work);
    expect(ok.stdout).toContain('通过');
    expect(ok.code).toBe(0);
    await rm(work, { recursive: true, force: true });
  });

  it('fetch：exchange 自报 cliVersion / skillVersion；服务端 Skill 更新时提示主人更新；输出不含凭证', async () => {
    const mock: MockServer = await startMockServer({
      exchange: () => ({
        status: 200,
        body: { credential: CREDENTIAL, page: { id: PAGE_ID }, context: makeContext({ skill: { version: '9.9.0', installUrl: 'http://localhost:3000/skill' } }) },
      }),
    });
    const work = await mkdtemp(join(tmpdir(), 'nowme-bundle-work-'));
    const home = join(work, '.home');
    const res = await node(['fetch', WALL_ID, TOKEN, '--server', mock.origin], work, { NOWME_HOME: home });
    expect(res.code).toBe(0);
    const exchange = mock.requests.find((r) => r.path === '/api/agent/exchange');
    expect(JSON.parse(exchange?.body ?? '{}')).toMatchObject({ client: { cliVersion: '0.1.0', skillVersion: '9.8.7' } });
    expect(res.stderr).toContain('NOWMe Skill 有新版本 9.9.0');
    expect(res.stderr).toContain('http://localhost:3000/skill');
    expect(`${res.stdout}${res.stderr}`).not.toContain(CREDENTIAL);
    // status 能在打包版里正常运行
    expect((await node(['status'], work, { NOWME_HOME: home })).stdout).toContain(WALL_ID);
    await mock.close();
    await rm(work, { recursive: true, force: true });
  });
});
