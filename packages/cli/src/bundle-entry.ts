#!/usr/bin/env node
/**
 * 随 Skill 包分发的单文件 CLI 入口（contracts 1.5、4.5）：`node <Skill 目录>/scripts/nowme.mjs <命令>`。
 *
 * 由 bundle.ts 用 esbuild 打成一个文件，只需要 Node ≥ 22.13。与源码入口的区别：
 * - 不含 Playwright：preview 一律由服务端渲染（POST /api/agent/previews）；
 * - 校验用 context.json 里的 Kit 字体清单（包里没有 fonts.json）；
 * - `--version` 报告 Skill 版本，exchange 时把版本告诉主站（工作区显示“Skill 版本”）。
 */
import { WORKDIR_PAGE_DIR } from '@nowme/contracts';
import { buildCommands, runCli } from './cli-core.js';
import { runRemotePreview } from './commands/preview-remote.js';

const commands = buildCommands({
  usage: `nowme preview [dir=${WORKDIR_PAGE_DIR}] [--cover] [--json]`,
  summary: '把页面发给 NOWMe 服务端，用与提交相同的沙箱渲染并取回截图（不保存、不生成版本）；缺 cover.png 或带 --cover 时写入封面',
  flags: [
    { name: 'cover', type: 'boolean' },
    { name: 'json', type: 'boolean' },
    // 与源码入口兼容：带上也没关系
    { name: 'remote', type: 'boolean' },
  ],
  run: runRemotePreview,
});

process.exitCode = await runCli(commands, process.argv.slice(2));
