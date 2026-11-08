/**
 * Skill 安装说明的文字（contracts 4.5）：`/skill` 安装页、`/skill/install.md`、工作区「安装 NOWMe Skill」与
 * 纯文本说明共用，保证几处说法一致。
 *
 * 通用写法：不写任何具体 Agent 的名字和 Skill 目录（各家不同、还会变）；由 Agent 自己判断装到哪里，
 * 不确定就问用户。安装地址指向公开 GitHub 仓库，可在其他电脑直接使用。**这里的文字里没有任何 token 或凭证。**
 */
import { SKILL_BUNDLED_CLI_PATH, SKILL_NAME, type SkillMarketConfig } from '@nowme/contracts';
import type { SkillPackage } from './skill-package.js';
import { skillInstallDocUrl } from './skill-package.js';
import { renderPublicInstallDoc } from '@nowme/skill/distribution';

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

/** 主站保留安装说明入口；下载与安装都使用公开 GitHub 仓库。 */
export function renderInstallDoc(input: { webOrigin: string; skillPackage: SkillPackage | null; market: SkillMarketConfig | null }): string {
  return renderPublicInstallDoc({ manifest: input.skillPackage?.manifest ?? null, market: input.market });
}
