/**
 * T1.3 的两处小修：
 * 1. Kit 角色变量 `--nm-font-sans/serif/mono/body/display/code/hand` 视为已知，不报 FONT_NOT_IN_KIT；
 *    页面把角色变量赋值为清单字体时计入 fontsUsed（contracts 1.1）。
 * 2. 系统文件（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`，任意层级）一律忽略（contracts 1.4）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KIT_FONTS, VALID_MANIFEST, codes, issuesOf, makePage, makeSkeletonPage, run, summary, text } from './fixtures.js';
import { isSystemFile, isSystemFileName, PageDirFiles, validatePage } from '../src/index.js';
import { readPageDir } from '../src/node.js';

const declared = (fonts: { id: string; weights: number[] }[]) => ({ manifest: { ...VALID_MANIFEST, fonts, blocks: undefined } });
const page = (style: string, fonts: { id: string; weights: number[] }[] = []) => run(makeSkeletonPage({ style }, declared(fonts)));

describe('Kit 角色字体变量', () => {
  it.each(['sans', 'serif', 'mono', 'body', 'display', 'code', 'hand'])('font-family: var(--nm-font-%s) 不报 FONT_NOT_IN_KIT', (role) => {
    const report = page(`h1 { font-family: var(--nm-font-${role}); } p { font: 14px/1.5 var(--nm-font-${role}), serif; }`);
    expect(issuesOf(report, 'FONT_NOT_IN_KIT'), summary(report)).toEqual([]);
    expect(report.stats.fontsUsed).toEqual([]);
  });

  it('角色变量赋值为 var(--nm-font-<id>)：计入 fontsUsed，已声明时没有问题', () => {
    const report = page(':root { --nm-font-display: var(--nm-font-lxgw-wenkai); } h1 { font-family: var(--nm-font-display); }', [
      { id: 'lxgw-wenkai', weights: [400] },
    ]);
    expect(report.stats.fontsUsed).toEqual(['lxgw-wenkai']);
    expect([...report.errors, ...report.warnings], summary(report)).toEqual([]);
  });

  it('角色变量赋值为 family 名（可带系统回退）：计入 fontsUsed；没声明时报 FONT_UNDECLARED', () => {
    const report = page(':root { --nm-font-body: "Noto Serif SC", "Songti SC", serif; --nm-font-code: "Inter", var(--nm-font-mono); } body { font-family: var(--nm-font-body); }');
    expect(report.stats.fontsUsed).toEqual(['inter', 'noto-serif-sc']);
    expect(issuesOf(report, 'FONT_UNDECLARED')).toHaveLength(2);
    expect(issuesOf(report, 'FONT_NOT_IN_KIT')).toEqual([]);
  });

  it('角色变量指向另一个角色变量或系统字体栈：不算清单字体', () => {
    const report = page(':root { --nm-font-hand: var(--nm-font-body); --nm-font-display: var(--nm-font-serif); } .x { font-family: var(--nm-font-hand); }');
    expect(report.stats.fontsUsed).toEqual([]);
    expect([...report.errors, ...report.warnings], summary(report)).toEqual([]);
  });

  it('不是角色变量、也不在清单里的 --nm-font-<x> 仍然报 FONT_NOT_IN_KIT', () => {
    const report = page('h1 { font-family: var(--nm-font-headline); } h2 { font-family: var(--nm-font-display); }');
    const issues = issuesOf(report, 'FONT_NOT_IN_KIT');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('--nm-font-headline');
  });
});

describe('系统文件', () => {
  it('isSystemFile / isSystemFileName', () => {
    for (const name of ['.DS_Store', '.ds_store', 'Thumbs.db', 'thumbs.db', 'desktop.ini', 'Desktop.ini', '._index.html', '._']) {
      expect(isSystemFileName(name), name).toBe(true);
    }
    for (const name of ['index.html', 'ds_store', 'thumbs.db.png', '_x.png', '.hidden', 'a._b']) expect(isSystemFileName(name), name).toBe(false);
    expect(isSystemFile('assets/sub/.DS_Store')).toBe(true);
    expect(isSystemFile('assets/._hero.png')).toBe(true);
    expect(isSystemFile('assets/hero.png')).toBe(false);
  });

  const SYSTEM_PATHS = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '._index.html', 'assets/.DS_Store', 'assets/._hero.png', 'assets/photos/Thumbs.db', 'assets/photos/._avatar-2x.jpg'];

  it('validatePage 对任意层级的系统文件不报任何问题（包括 IGNORED_FILE、ASSET_*），也不计入 ignoredFiles', () => {
    const clean = run(makePage());
    const files = makePage();
    for (const path of SYSTEM_PATHS) files.set(path, text('garbage nmc_AAAAAAAAAAAAAAAAAAAAAAAA'));
    const report = run(files);
    expect(report).toEqual(clean);
    expect(report.stats.ignoredFiles).toEqual([]);
    expect(codes(report)).not.toContain('IGNORED_FILE');
  });

  it('readPageDir 跳过的条目里如果有系统文件名，也不报', () => {
    const files = new PageDirFiles(makePage());
    files.skipped.push({ path: 'assets/.DS_Store', reason: 'symlink' }, { path: 'notes.txt', reason: 'symlink' });
    const report = validatePage(files, { kitFonts: KIT_FONTS });
    expect(issuesOf(report, 'IGNORED_FILE').map((issue) => issue.file)).toEqual(['notes.txt']);
  });

  describe('readPageDir', () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'nowme-system-files-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('不读系统文件，也不记为跳过的条目', async () => {
      for (const [path, bytes] of makePage()) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), bytes);
      }
      for (const path of SYSTEM_PATHS) await writeFile(join(root, path), 'x');
      const files = await readPageDir(root);
      expect([...files.keys()].sort()).toEqual([...makePage().keys()].sort());
      expect(files.skipped).toEqual([]);
      expect(validatePage(files, { kitFonts: KIT_FONTS }).errors).toEqual([]);
    });
  });
});
