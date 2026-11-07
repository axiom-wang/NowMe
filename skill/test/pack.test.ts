/** Skill 包（contracts 4.5）：版本一致、可复现、只含白名单内容、解压后内置 CLI 能运行。 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skillPackageManifestSchema } from '@nowme/contracts';
import { SKILL_DIR, SKILL_FILE, SKILL_VERSION } from '../src/index.js';
import { createTar, packSkill, type PackSkillResult } from '../src/pack.js';

const exec = promisify(execFile);

let outA: string;
let outB: string;
let first: PackSkillResult;
let second: PackSkillResult;

beforeAll(async () => {
  outA = await mkdtemp(join(tmpdir(), 'nowme-pack-a-'));
  outB = await mkdtemp(join(tmpdir(), 'nowme-pack-b-'));
  first = await packSkill({ outDir: outA });
  second = await packSkill({ outDir: outB });
}, 120_000);
afterAll(async () => {
  await rm(outA, { recursive: true, force: true });
  await rm(outB, { recursive: true, force: true });
});

describe('Skill 包', () => {
  it('版本一致：SKILL.md 里写的版本 = SKILL_VERSION = package.json 的 version = 清单版本', async () => {
    const skillMd = await readFile(SKILL_FILE, 'utf8');
    expect(skillMd).toContain(`Skill 版本：${SKILL_VERSION}`);
    const pkg = JSON.parse(await readFile(join(SKILL_DIR, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(SKILL_VERSION);
    expect(first.manifest.version).toBe(SKILL_VERSION);
    expect(first.manifest.file).toBe(`nowme-page-${SKILL_VERSION}.tar.gz`);
  });

  it('清单符合 schema，sha256 与大小和归档一致；两次打包结果完全相同', async () => {
    const manifest = skillPackageManifestSchema.parse(JSON.parse(await readFile(first.manifestPath, 'utf8')));
    expect(manifest).toEqual(first.manifest);
    const archive = await readFile(first.archivePath);
    expect(archive.byteLength).toBe(manifest.bytes);
    expect(second.manifest.sha256).toBe(first.manifest.sha256);
    expect(Buffer.compare(archive, await readFile(second.archivePath))).toBe(0);
  });

  it('只含白名单内容与内置 CLI，没有 src、test、node_modules、点文件', () => {
    expect(first.files).toContain('SKILL.md');
    expect(first.files).toContain('scripts/nowme.mjs');
    expect(first.files).toContain('scenes/hackathon.json');
    expect(first.files).toContain('examples/index.json');
    for (const file of first.files) {
      expect(file).toMatch(/^(SKILL\.md|reference\/|scenes\/|templates\/|examples\/|scripts\/nowme\.mjs$)/);
      expect(file.split('/').some((part) => part.startsWith('.'))).toBe(false);
    }
  });

  it('用系统 tar 解压：根目录是 nowme-page/，内置 CLI 可执行并报告 Skill 版本', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nowme-pack-x-'));
    try {
      await exec('tar', ['-xzf', first.archivePath, '-C', dir]);
      expect(await readdir(dir)).toEqual(['nowme-page']);
      const cli = join(dir, 'nowme-page', 'scripts', 'nowme.mjs');
      expect((await stat(cli)).mode & 0o111).not.toBe(0);
      const { stdout } = await exec(process.execPath, [cli, '--version']);
      expect(stdout.trim()).toBe(`nowme 0.1.0 · NOWMe Skill ${SKILL_VERSION}`);
      expect(await readFile(join(dir, 'nowme-page', 'SKILL.md'), 'utf8')).toBe(await readFile(SKILL_FILE, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('再次打包到同一目录时删除旧版本的归档', async () => {
    await packSkill({ outDir: outA, version: '0.0.9' });
    await packSkill({ outDir: outA });
    expect((await readdir(outA)).sort()).toEqual(['manifest.json', `nowme-page-${SKILL_VERSION}.tar.gz`]);
  }, 120_000);

  it('tar：长路径拆成 prefix + name；超长报错', () => {
    const long = `${'a'.repeat(90)}/${'b'.repeat(60)}.txt`;
    const tar = createTar('root', [{ path: long, bytes: new Uint8Array([1]), executable: false }]);
    expect(tar.byteLength % 512).toBe(0);
    expect(() => createTar('root', [{ path: 'x'.repeat(300), bytes: new Uint8Array(), executable: false }])).toThrow();
  });
});
