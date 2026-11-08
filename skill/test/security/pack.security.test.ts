/**
 * Skill 包是公开下载的（contracts 4.5）：里面不能有任何 token / 凭证样式的字符串，打包时发现就拒绝。
 */
import { mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { containsCredentialLike, generateToken } from '@nowme/contracts';
import { SKILL_DIR } from '../../src/index.js';
import { packSkill } from '../../src/pack.js';
import { exportDistribution } from '../../src/export-distribution.js';

describe('Skill 包不含秘密', () => {
  it('打出的归档（解压后的全部字节）没有 nmt_ / nmc_ 样式的字符串', async () => {
    const out = await mkdtemp(join(tmpdir(), 'nowme-pack-sec-'));
    try {
      const result = await packSkill({ outDir: out });
      const tar = gunzipSync(await readFile(result.archivePath));
      expect(containsCredentialLike(tar.toString('latin1'))).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('Skill 内容里混进了凭证：打包失败，不写出归档', async () => {
    const skillDir = await mkdtemp(join(tmpdir(), 'nowme-pack-src-'));
    const out = await mkdtemp(join(tmpdir(), 'nowme-pack-out-'));
    try {
      for (const entry of ['SKILL.md', 'reference', 'scenes', 'templates', 'examples']) {
        await cp(join(SKILL_DIR, entry), join(skillDir, entry), { recursive: true });
      }
      await writeFile(join(skillDir, 'templates', 'brief.md'), `不小心粘贴的凭证 ${generateToken('pageCredential')}\n`);
      await expect(packSkill({ outDir: out, skillDir })).rejects.toThrow(/凭证/);
      await expect(readFile(join(out, 'manifest.json'))).rejects.toThrow();
    } finally {
      await rm(skillDir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
  it('公开仓库只包含成品，生成的全部文件没有凭证或本机绝对路径', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'nowme-public-security-'));
    try {
      const out = join(temp, 'repo');
      await exportDistribution(out, join(temp, 'package'));
      async function inspect(dir: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          expect(['.git', '.env', 'node_modules', 'src', 'test', 'credentials']).not.toContain(entry.name);
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await inspect(path);
          else {
            const text = (await readFile(path)).toString('latin1');
            expect(containsCredentialLike(text), path).toBe(false);
            expect(text, path).not.toContain('/Users/axiom/');
          }
        }
      }
      await inspect(out);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 60_000);
});
