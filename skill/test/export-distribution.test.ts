import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { SKILL_INSTALL_COMMAND } from '@nowme/contracts';
import { exportDistribution } from '../src/export-distribution.js';

it('公开仓库成品完整可安装，说明仅使用远端下载地址，CLI 可独立运行', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'nowme-export-test-'));
  try {
    const out = join(temp, 'repo');
    const result = await exportDistribution(out, join(temp, 'package'));
    expect((await readdir(out)).sort()).toEqual(['README.md', 'install.md', 'manifest.json', 'nowme-page']);
    const doc = await readFile(join(out, 'install.md'), 'utf8');
    expect(doc).toContain(SKILL_INSTALL_COMMAND);
    expect(doc).toContain(result.publicManifest.url);
    expect(doc).toContain(result.manifest.sha256);
    expect(doc).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
    const cli = join(out, 'nowme-page', 'scripts', 'nowme.mjs');
    const run = await promisify(execFile)(process.execPath, [cli, '--version']);
    expect(run.stdout).toContain(`NOWMe Skill ${result.manifest.version}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);
