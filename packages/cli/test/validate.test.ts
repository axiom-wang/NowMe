/**
 * nowme validate：退出码、extraChars 自动补全（只改这一个字段）、--no-fix、--json 结构、
 * 中文分组输出、INIT_CWD 解析。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ValidationReport } from '@nowme/contracts';
import { replaceTopLevelString, run, type ValidateOutput } from '../src/index.js';
import { MANIFEST_TEXT, PAGE_HTML, capture, makeWorkdir, type TempWorkdir } from './helpers.js';

let workdir: TempWorkdir | null = null;
afterEach(async () => {
  await workdir?.cleanup();
  workdir = null;
});

/** 在 workdir 根目录“执行”命令（pnpm 设置的 INIT_CWD 指向用户目录，进程 cwd 是别处）。 */
const runIn = (dir: string, argv: string[]) => {
  const io = capture();
  return run(argv, io.io, { env: { INIT_CWD: dir }, cwd: '/' }).then((code) => ({ code, ...io }));
};

describe('nowme validate', () => {
  it('合法页面：退出码 0；默认目录 page；按 INIT_CWD 解析相对路径；自动补全 extraChars 只改这一个字段', async () => {
    workdir = await makeWorkdir();
    const result = await runIn(workdir.root, ['validate']);
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain(`nowme validate：${workdir.pageDir}`);
    expect(result.stdout()).toContain('已自动补全 manifest.extraChars：新增 2 个字（外额）');
    expect(result.stdout()).toContain('结果：通过');
    const after = await readFile(join(workdir.pageDir, 'manifest.json'), 'utf8');
    expect(after).toBe(MANIFEST_TEXT.replace('"extraChars": ""', '"extraChars": "外额"'));
    // 第二次运行没有变化，不再写文件
    const again = await runIn(workdir.root, ['validate', 'page']);
    expect(again.code).toBe(0);
    expect(again.stdout()).not.toContain('已自动补全');
    expect(await readFile(join(workdir.pageDir, 'manifest.json'), 'utf8')).toBe(after);
  });

  it('--no-fix 不写文件，报 EXTRA_CHARS_MISSING 警告；绝对路径参数也可以', async () => {
    workdir = await makeWorkdir();
    const result = await runIn('/', ['validate', workdir.pageDir, '--no-fix']);
    expect(result.code).toBe(0);
    expect(result.stdout()).toContain('EXTRA_CHARS_MISSING');
    expect(await readFile(join(workdir.pageDir, 'manifest.json'), 'utf8')).toBe(MANIFEST_TEXT);
  });

  it('有错误：退出码 1；中文输出按文件分组，每条带行号与修复指引', async () => {
    workdir = await makeWorkdir({ files: { 'brief.md': '# 私密 brief' } });
    await writeFile(join(workdir.pageDir, 'index.html'), PAGE_HTML.replace("event.target.textContent = '额外';", "fetch('https://example.com');"));
    const result = await runIn(workdir.root, ['validate']);
    expect(result.code).toBe(1);
    const out = result.stdout();
    expect(out).toMatch(/结果：1 个错误，\d+ 个警告/);
    expect(out).toMatch(/index\.html\n {2}\[错误\] FORBIDDEN_API 第 15 行：.*fetch/);
    expect(out).toMatch(/\n {9}修复：/);
    expect(out).toMatch(/brief\.md\n {2}\[警告\] IGNORED_FILE/);
    expect(out.indexOf('index.html\n')).toBeLessThan(out.indexOf('brief.md\n'));
  });

  it('--json：输出 { command, ok, pageDir, fixed, report }', async () => {
    workdir = await makeWorkdir();
    const result = await runIn(workdir.root, ['validate', '--json']);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout()) as ValidateOutput;
    expect(Object.keys(output)).toEqual(['command', 'ok', 'pageDir', 'fixed', 'report']);
    expect(output.command).toBe('validate');
    expect(output.ok).toBe(true);
    expect(output.pageDir).toBe(workdir.pageDir);
    expect(output.fixed).toEqual({ extraChars: { before: '', after: '外额', added: '外额' } });
    const report: ValidationReport = output.report;
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.stats.blocks).toEqual(['hero', 'about', 'more']);
    expect(typeof report.validatorVersion).toBe('string');
  });

  it('--json 下有错误时退出码 1、ok 为 false', async () => {
    workdir = await makeWorkdir();
    await writeFile(join(workdir.pageDir, 'card.json'), '{');
    const result = await runIn(workdir.root, ['validate', '--json', '--no-fix']);
    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout()) as ValidateOutput;
    expect(output.ok).toBe(false);
    expect(output.fixed).toBeNull();
    expect(output.report.errors.map((issue) => issue.code)).toEqual(['CARD_INVALID']);
  });

  it('manifest 不是合法 JSON 时不尝试补全', async () => {
    workdir = await makeWorkdir();
    await writeFile(join(workdir.pageDir, 'manifest.json'), '{ "extraChars": ');
    const result = await runIn(workdir.root, ['validate']);
    expect(result.code).toBe(1);
    expect(await readFile(join(workdir.pageDir, 'manifest.json'), 'utf8')).toBe('{ "extraChars": ');
  });

  it('页面目录不存在：退出码 1，说明按哪个目录解析', async () => {
    workdir = await makeWorkdir();
    const result = await runIn(workdir.root, ['validate', 'nope']);
    expect(result.code).toBe(1);
    expect(result.stderr()).toContain(`找不到页面目录：${join(workdir.root, 'nope')}`);
    expect(result.stderr()).toContain(workdir.root);
  });

  it('没有 INIT_CWD 时按进程 cwd 解析', async () => {
    workdir = await makeWorkdir();
    const io = capture();
    expect(await run(['validate', 'page', '--no-fix'], io.io, { env: {}, cwd: workdir.root })).toBe(0);
    expect(io.stdout()).toContain(workdir.pageDir);
  });
});

describe('replaceTopLevelString', () => {
  it('只替换顶层键的字符串值，保留其余文本', () => {
    const text = '{\n  "a": { "extraChars": "inner" },\n  "extraChars": "旧",\n  "b": [1, 2]\n}\n';
    expect(replaceTopLevelString(text, 'extraChars', '新"\\')).toBe('{\n  "a": { "extraChars": "inner" },\n  "extraChars": "新\\"\\\\",\n  "b": [1, 2]\n}\n');
  });

  it('没有这个键、值不是字符串、不是对象、JSON 不合法时返回 null', () => {
    expect(replaceTopLevelString('{"a": 1}', 'extraChars', 'x')).toBeNull();
    expect(replaceTopLevelString('{"extraChars": 1}', 'extraChars', 'x')).toBeNull();
    expect(replaceTopLevelString('["extraChars"]', 'extraChars', 'x')).toBeNull();
    expect(replaceTopLevelString('{"extraChars": "a"', 'extraChars', 'x')).toBeNull();
  });

  it('重复键时替换最后一个（与 JSON.parse 一致）', () => {
    expect(replaceTopLevelString('{"extraChars": "a", "extraChars": "b"}', 'extraChars', 'x')).toBe('{"extraChars": "a", "extraChars": "x"}');
  });
});
