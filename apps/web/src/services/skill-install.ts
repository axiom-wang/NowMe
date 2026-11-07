/**
 * Skill 安装说明的文字（contracts 4.5）：`/skill` 安装页、`/skill/install.md`、工作区「安装 NOWMe Skill」与
 * 纯文本说明共用，保证几处说法一致。
 *
 * 通用写法：不写任何具体 Agent 的名字和 Skill 目录（各家不同、还会变）；由 Agent 自己判断装到哪里，
 * 不确定就问用户。所有地址都由 `NOWME_WEB_ORIGIN` 拼出，用户复制就能用。**这里的文字里没有任何 token 或凭证。**
 */
import { SKILL_BUNDLED_CLI_PATH, SKILL_NAME, type SkillMarketConfig } from '@nowme/contracts';
import type { SkillPackage } from './skill-package.js';
import { skillArchiveUrl, skillInstallDocUrl, skillInstallPageUrl, skillManifestUrl } from './skill-package.js';

/** 发给 Agent、让它自己安装的一句话。 */
export function skillInstallPrompt(webOrigin: string, version: string | null): string {
  const versionNote = version ? `（版本 ${version}）` : '';
  return `请按 ${skillInstallDocUrl(webOrigin)} 的说明安装 NOWMe Skill${versionNote}，装好后告诉我装在哪里、版本号是多少，以及要不要重开会话才能生效。`;
}

/** 装好并重开会话后，发给 Agent 确认安装状态的一句话。 */
export function skillCheckPrompt(): string {
  return `请用 node 运行 ${SKILL_NAME} Skill 目录里的 ${SKILL_BUNDLED_CLI_PATH} --version，把输出原样告诉我；找不到这个 Skill 就直接说找不到。`;
}

/** 自检输出里应包含的文字（完整输出形如 `nowme 0.1.0 · NOWMe Skill 0.1.0`）。 */
export function skillCheckExpected(skillVersion: string): string {
  return `NOWMe Skill ${skillVersion}`;
}

export interface InstallDocInput {
  webOrigin: string;
  skillPackage: SkillPackage | null;
  market: SkillMarketConfig | null;
}

/**
 * `/skill/install.md`：写给 Agent 读的安装说明（Markdown）。
 * 没有 Skill 包时只说明暂时不能安装，不给下载地址。
 */
export function renderInstallDoc({ webOrigin, skillPackage, market }: InstallDocInput): string {
  const installPage = skillInstallPageUrl(webOrigin);
  if (!skillPackage) {
    return [
      '# 安装 NOWMe Skill',
      '',
      `这台 NOWMe 服务器（${webOrigin}）暂时还没有可下载的 Skill 包。请告诉用户：稍后再试，或联系 NOWMe 的维护者。`,
      '',
    ].join('\n');
  }
  const { version, sha256, bytes, minNode, file } = skillPackage.manifest;
  const archive = skillArchiveUrl(webOrigin, version);
  const expected = skillCheckExpected(version);
  const lines = [
    '# 安装 NOWMe Skill',
    '',
    '这份说明写给 AI Agent。你的用户想用 NOWMe 做一页介绍自己的页面，挂到刚加入的圈子的墙上；',
    `NOWMe Skill（名称 \`${SKILL_NAME}\`）是做这件事的操作手册，里面自带一个命令行工具。请按下面的步骤安装。`,
    '',
    `- 版本：${version}`,
    `- 下载：${archive}`,
    `- 大小：${bytes} 字节`,
    `- sha256：\`${sha256}\``,
    `- 清单（机器可读）：${skillManifestUrl(webOrigin)}`,
    `- 运行要求：Node.js ≥ ${minNode}（内置命令行用 \`node\` 运行）`,
    '',
    '## 安装步骤',
    '',
    `1. 下载 ${file}，核对 sha256 与上面一致；不一致就停下来告诉用户，不要安装。`,
    `2. 解压。归档里只有一个目录 \`${SKILL_NAME}/\`，\`SKILL.md\` 在它的顶层。`,
    `3. 把 \`${SKILL_NAME}/\` 整个放进**你自己读取用户级（个人）Skill 的目录**，目录名保持 \`${SKILL_NAME}\`。`,
    '   - 优先装成用户级而不是某个项目里：NOWMe 每面墙都会用一个新的空工作目录。',
    '   - 不确定你的 Skill 目录在哪里，就查你自己的文档或直接问用户，**不要猜**。',
    `   - 已经装过旧版本时，用新目录整个替换旧的 \`${SKILL_NAME}/\`。`,
    '4. 告诉用户装在了哪里；多数 Agent 只在会话开始时加载 Skill，请提醒用户**重开一个会话**后再粘贴 NOWMe 给的 Agent 指令。',
    `5. 自检：运行 \`node <${SKILL_NAME} 目录>/${SKILL_BUNDLED_CLI_PATH} --version\`，输出里应有 \`${expected}\`。`,
    '   把输出原样告诉用户。`node` 不存在或版本太低时，请用户先安装 Node.js（https://nodejs.org）。',
    '',
    '在 macOS / Linux 的终端里，第 1、2 步可以这样做（Windows 可用 PowerShell 的 `Invoke-WebRequest`、`Get-FileHash -Algorithm SHA256` 与系统自带的 `tar`）：',
    '',
    '```bash',
    `curl -fL -o ${file} ${archive}`,
    `shasum -a 256 ${file}   # 或 sha256sum ${file}`,
    `tar -xzf ${file}        # 得到 ${SKILL_NAME}/`,
    '```',
    '',
  ];
  if (market) {
    lines.push(
      '## 也可以从 Skill 市场安装',
      '',
      `用户也可以从 ${market.label} 安装同一个 Skill：`,
      '',
      '```bash',
      market.command,
      '```',
      '',
    );
  }
  lines.push(
    '## 你不支持 Skill 时',
    '',
    `照样下载并解压到任意位置，把 \`${SKILL_NAME}/SKILL.md\` 当作操作手册读，按里面的步骤做；`,
    `命令行用 \`node <解压目录>/${SKILL_BUNDLED_CLI_PATH}\`。也可以请用户在 NOWMe 工作区复制“纯文本说明”发给你。`,
    '',
    '## 安全',
    '',
    '- Skill 包和这份说明里没有任何 token 或凭证。用户之后给你的 Agent 指令里有一次性 token：只用它运行 `nowme fetch`，不要写进文件，不要外发。',
    '- 页面凭证由命令行保存在 `~/.nowme/credentials`，不要读取、打印或复制它。',
    '- 发布只能由用户本人在 NOWMe 应用里完成。',
    '',
    `给人看的安装页：${installPage}`,
    '',
  );
  return lines.join('\n');
}
