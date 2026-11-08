/** 生成或发布完整 Skill 分发仓库。默认仅导出；--publish 才写 GitHub。 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SKILL_GITHUB_REPOSITORY, SKILL_GITHUB_URL } from '@nowme/contracts';
import { SKILL_VERSION } from '../src/index.js';
import { exportDistribution } from '../src/export-distribution.js';

const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.some((arg, i) => arg !== '--publish' && arg !== '--out' && args[i - 1] !== '--out')) throw new Error('用法：publish:github [--out <目录>] [--publish]');
const outIndex = args.indexOf('--out');
if (outIndex >= 0 && (!args[outIndex + 1] || args[outIndex + 1]?.startsWith('--'))) throw new Error('--out 后面需要目录');
const publish = args.includes('--publish');
const temp = await mkdtemp(join(tmpdir(), 'nowme-skill-release-'));
const out = outIndex >= 0 ? resolve(args[outIndex + 1]!) : join(temp, 'repository');
try {
  if (publish) {
    // 发布版本不可覆盖；先检查，避免推送后才发现版本已存在。
    const tags = await exec('git', ['ls-remote', '--tags', SKILL_GITHUB_URL + '.git', `refs/tags/v${SKILL_VERSION}`]);
    if (tags.stdout.trim()) throw new Error(`v${SKILL_VERSION} 已发布，请先更新 Skill 版本；已有版本不能覆盖`);
    await exec('git', ['clone', '--quiet', SKILL_GITHUB_URL + '.git', out]);
    // out 是临时 clone；只清除本发布器拥有的文件，保留 Git 配置与其他人工维护文件。
    for (const name of ['nowme-page', 'README.md', 'install.md', 'manifest.json']) await rm(join(out, name), { recursive: true, force: true });
  } else if (outIndex >= 0) {
    const existing = await readdir(out).catch(() => []);
    if (existing.length) throw new Error('--out 必须是空目录，避免留下旧文件或覆盖已有内容');
  }
  const result = await exportDistribution(out, join(temp, 'package'));
  if (publish) {
    await exec('git', ['-C', out, 'add', 'nowme-page', 'README.md', 'install.md', 'manifest.json']);
    await exec('git', ['-C', out, 'commit', '-m', `chore: release NOWMe Skill v${SKILL_VERSION}`]);
    await exec('git', ['-C', out, 'tag', `v${SKILL_VERSION}`]);
    await exec('git', ['-C', out, 'push', '--atomic', 'origin', 'HEAD:main', `refs/tags/v${SKILL_VERSION}`]);
    const notes = join(temp, 'release.md');
    await writeFile(notes, `完整 NOWMe Skill ${SKILL_VERSION}，包含单文件 CLI。\n\n安装说明见仓库 README.md / install.md。\n\nsha256: ${result.manifest.sha256}\n`);
    await exec('gh', ['release', 'create', `v${SKILL_VERSION}`, '--repo', SKILL_GITHUB_REPOSITORY, '--verify-tag', '--title', `NOWMe Skill ${SKILL_VERSION}`, '--notes-file', notes, result.archivePath, join(out, 'manifest.json')]);
    console.log(`已发布：${SKILL_GITHUB_URL}/releases/tag/v${SKILL_VERSION}`);
  } else {
    console.log(`已生成公开分发内容：${out}`);
    // 未指定目录时保留结果，便于检查。
  }
} finally {
  if (publish || outIndex >= 0) await rm(temp, { recursive: true, force: true });
}
