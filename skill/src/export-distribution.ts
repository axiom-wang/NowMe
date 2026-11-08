/** 从主仓库生成公开分发仓库；只导出 packSkill 白名单及生成的说明，不复制主项目。 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SKILL_GITHUB_URL, SKILL_INSTALL_COMMAND, skillReleaseArchiveUrl } from '@nowme/contracts';
import { packSkill } from './pack.js';
import { renderPublicInstallDoc } from './distribution.js';

const exec = promisify(execFile);
export async function exportDistribution(outDir: string, packageDir: string) {
  const packed = await packSkill({ outDir: packageDir });
  await mkdir(outDir, { recursive: true });
  await exec('tar', ['-xzf', packed.archivePath, '-C', outDir]);
  const manifest = { ...packed.manifest, url: skillReleaseArchiveUrl(packed.manifest.version) };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(outDir, 'install.md'), renderPublicInstallDoc({ manifest, market: null }));
  await writeFile(join(outDir, 'README.md'), [
    '# NOWMe Skill', '',
    '和你的 AI Agent 一起做一页有个性的自己，挂在刚加入的圈子的墙上。', '',
    '## 安装', '', '```bash', SKILL_INSTALL_COMMAND, '```', '',
    '按提示选择你的 Agent。安装后重开会话，再粘贴 NOWMe 工作区里的 Agent 指令。', '',
    `当前版本：${manifest.version}；需要 Node.js ≥ ${manifest.minNode}。内置 CLI 随 Skill 一起安装。`, '',
    '[完整安装说明与自检](install.md) · [版本下载与更新记录](' + SKILL_GITHUB_URL + '/releases)', '',
    '## 不支持 Skill 的 Agent', '',
    '下载发布包并解压，将 nowme-page/SKILL.md 当作操作手册阅读，用 node 运行 scripts/nowme.mjs。', '',
    '## 跨电脑连接', '',
    '下载、安装 Skill 不需要运行 NOWMe。使用 fetch、preview、submit 时，需要工作区指令里的 --server 地址可访问。localhost 只指当前电脑。', '',
    '## 维护与更新', '',
    '此仓库是 NOWMe 主项目生成的公开分发成品，包含 Skill、参考资料、示例和已打包 CLI。源码在主项目维护；请勿在这里直接修改生成文件。', '',
    '更新时重新运行安装命令并重开会话。发布包提供 sha256 校验值，见 manifest.json。', '',
    '安装包不含用户 token 或凭证。发布页面仍需用户在 NOWMe 工作区亲自确认。', '',
  ].join('\n'));
  return { ...packed, publicManifest: manifest };
}
