/**
 * readPageDir：读取临时目录（含子目录），不跟随符号链接。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KIT_FONTS, makePage } from './fixtures.js';
import { PageDirFiles, readPageDir as readFromMain, validatePage } from '../src/index.js';
import { readPageDir } from '../src/node.js';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nowme-page-'));
  outside = await mkdtemp(join(tmpdir(), 'nowme-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function writePage(dir: string): Promise<void> {
  for (const [path, bytes] of makePage()) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), bytes);
  }
}

describe('readPageDir', () => {
  it('读出全部文件（含子目录），键用 / 分隔，可直接校验', async () => {
    await writePage(root);
    const files = await readPageDir(root);
    expect(files).toBeInstanceOf(PageDirFiles);
    const expected = makePage();
    expect([...files.keys()].sort()).toEqual([...expected.keys()].sort());
    expect(files.get('assets/photos/avatar-2x.jpg')).toEqual(expected.get('assets/photos/avatar-2x.jpg'));
    expect(files.skipped).toEqual([]);
    const report = validatePage(files, { kitFonts: KIT_FONTS });
    expect(report.errors).toEqual([]);
  });

  it('主入口的 readPageDir 也可用', async () => {
    await writePage(root);
    expect([...(await readFromMain(root)).keys()].sort()).toEqual([...makePage().keys()].sort());
  });

  it('不跟随符号链接（文件与目录，指向目录外或目录内），并在报告里给出警告', async () => {
    await writePage(root);
    await writeFile(join(outside, 'secret.png'), 'secret');
    await mkdir(join(outside, 'dir'));
    await writeFile(join(outside, 'dir', 'x.png'), 'x');
    await symlink(join(outside, 'secret.png'), join(root, 'assets', 'linked.png'));
    await symlink(join(outside, 'dir'), join(root, 'assets', 'linked-dir'));
    await symlink(join(root, 'card.json'), join(root, 'card-link.json'));
    const files = await readPageDir(root);
    expect(files.has('assets/linked.png')).toBe(false);
    expect([...files.keys()].some((path) => path.startsWith('assets/linked-dir'))).toBe(false);
    expect(files.skipped.map((entry) => `${entry.path}:${entry.reason}`).sort()).toEqual([
      'assets/linked-dir:symlink',
      'assets/linked.png:symlink',
      'card-link.json:symlink',
    ]);
    const report = validatePage(files, { kitFonts: KIT_FONTS });
    const ignored = report.warnings.filter((issue) => issue.code === 'IGNORED_FILE').map((issue) => issue.file).sort();
    expect(ignored).toEqual(['assets/linked-dir', 'assets/linked.png', 'card-link.json']);
    expect(report.warnings.find((issue) => issue.file === 'assets/linked.png')?.message).toContain('符号链接');
  });

  it('被引用的符号链接图片会报 ASSET_MISSING', async () => {
    await writePage(root);
    await rm(join(root, 'assets', 'hero.png'));
    await writeFile(join(outside, 'hero.png'), new Uint8Array(makePage().get('assets/hero.png') ?? []));
    await symlink(join(outside, 'hero.png'), join(root, 'assets', 'hero.png'));
    const report = validatePage(await readPageDir(root), { kitFonts: KIT_FONTS });
    expect(report.errors.map((issue) => issue.code)).toContain('ASSET_MISSING');
  });

  it('不是目录时报错', async () => {
    await writeFile(join(root, 'file.txt'), 'x');
    await expect(readPageDir(join(root, 'file.txt'))).rejects.toThrow('不是目录');
    await expect(readPageDir(join(root, 'missing'))).rejects.toThrow();
  });
});
