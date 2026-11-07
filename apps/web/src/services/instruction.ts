/**
 * Agent 指令（contracts 4.3、W05）：
 *
 * ```
 * /nowme-page wal_xxx nmt_xxx --server http://localhost:3000
 * ```
 *
 * 同时给出一段等价的纯文本说明，给不支持 Skill 的 Agent（第 0 步告诉它去 `/skill/install.md` 下载工具包，
 * 里面的单文件命令行就是 nowme，contracts 4.5）。生成新指令时，该页旧的未使用 token 作废；
 * 有效期 `NOWME_AGENT_TOKEN_TTL_HOURS`（默认 72 小时）。token 明文只在这一次返回值里出现，库里只有哈希。
 */
import { generateId, generateToken, hashToken, SKILL_BUNDLED_CLI_PATH, SKILL_NAME } from '@nowme/contracts';
import type { AppDeps, WebConfig } from '../context.js';
import { transaction } from '../db/index.js';
import type { Page } from '../db/pages.js';
import { formatDateTime } from '../format.js';
import type { Wall } from '../db/walls.js';
import { workspaceUrl } from './agent.js';
import { skillInstallDocUrl } from './skill-package.js';

export interface AgentInstruction {
  /** 一次性 token 明文（只用于本次展示）。 */
  token: string;
  /** `/nowme-page <wallId> <token> --server <webOrigin>` */
  command: string;
  /** 给不支持 Skill 的 Agent 的纯文本说明。 */
  plainText: string;
  expiresAt: Date;
}

export function formatCommand(wallId: string, token: string, server: string): string {
  return `/${SKILL_NAME} ${wallId} ${token} --server ${server}`;
}

export function formatPlainText(input: { wallName: string; wallId: string; token: string; server: string; expiresAt: Date }): string {
  const { wallName, wallId, token, server, expiresAt } = input;
  return [
    `请帮我用 NOWMe 做一页介绍我自己的页面，挂到「${wallName}」这面墙上。按下面的步骤做：`,
    '',
    `0. 准备 nowme 命令行：按 ${skillInstallDocUrl(server)} 下载并解压 NOWMe 工具包（只需要 Node.js 22；你不支持 Skill 也没关系，解压即可，不用装成 Skill）。`,
    `   下文的 nowme 都指 node <解压目录>/${SKILL_NAME}/${SKILL_BUNDLED_CLI_PATH}；已经全局安装了 nowme 的可以直接用。工具包里的 ${SKILL_NAME}/SKILL.md 是更详细的操作手册，可以参考。`,
    '1. 新建一个空的工作目录，在里面运行：',
    `   nowme fetch ${wallId} ${token} --server ${server}`,
    `   这一步用一次性 token 换取页面凭证，并把墙的情境写进 context.json。token 只能用一次，${formatDateTime(expiresAt)}（北京时间）前有效。`,
    '   凭证保存在 ~/.nowme/credentials：不要打印它，不要写进 page/，不要发给任何人。',
    '2. 先读 context.json（墙的名称、场景、可用字体与限制），再用几个简短的问题采访我，把要点整理成 brief.md 给我确认。brief.md 只留在本地，不上传。',
    '3. 在 page/ 目录生成 index.html、card.json、manifest.json（可选 cover.png 与 assets/ 图片）：',
    '   - index.html 是自包含的单文件，以 375px 宽的手机屏幕为准；不能联网，不能引用外部资源，不能用 fetch、存储、弹窗或跳转；',
    '   - 外部链接只能写成 data-nm-href="https://..." 或调用 nowme.openLink("https://...")；',
    '   - 至少 3 个主要区块带 data-nm-id；字体只能用 context.json 里 Kit 提供的字体，并在 manifest.json 中声明；',
    '   - card.json 写一句介绍和 2–3 个具体、可回应的接话点（各带一句开场白）。',
    '4. 运行 nowme validate page，修好所有错误；再运行 nowme preview page 检查渲染效果，按我的意见修改。',
    '5. 运行 nowme submit page 提交。提交只会生成一个新版本，发布需要我本人在工作区确认——你不能替我发布。',
    '',
    `工作区：${workspaceUrl(server, wallId)}`,
  ].join('\n');
}

/** 为页面生成新的一次性 token 与指令（作废旧的未使用 token）。调用方负责确认请求者是页面主人。 */
export function createInstruction(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now'> & { config: Pick<WebConfig, 'webOrigin' | 'agentTokenTtlHours'> },
  wall: Wall,
  page: Page,
): AgentInstruction {
  const now = deps.now();
  const token = generateToken('agentToken');
  const expiresAt = new Date(now.getTime() + deps.config.agentTokenTtlHours * 3600 * 1000);
  transaction(deps.db, () => {
    deps.repos.agentTokens.deleteUnusedForPage(page.id);
    deps.repos.agentTokens.create({
      id: generateId('agt'),
      pageId: page.id,
      tokenHash: hashToken(token),
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    });
  });
  const server = deps.config.webOrigin;
  return {
    token,
    command: formatCommand(wall.id, token, server),
    plainText: formatPlainText({ wallName: wall.name, wallId: wall.id, token, server, expiresAt }),
    expiresAt,
  };
}
