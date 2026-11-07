/**
 * nowme 命令行源码入口（contracts 1.5）：命令表见 cli-core.ts。
 *
 * 这里的 preview 默认在本机用 Playwright 渲染（@nowme/render）；带 `--remote` 时改由服务端渲染，
 * 与随 Skill 包分发的单文件 CLI（bundle-entry.ts）相同。
 */
import { WORKDIR_PAGE_DIR } from '@nowme/contracts';
import { buildCommands, helpText as coreHelpText, runCli, type CommandSpec } from './cli-core.js';
import type { CliIo, RunOptions } from './context.js';
import { runPreview } from './commands/preview.js';
import { runRemotePreview } from './commands/preview-remote.js';

export type { CliIo, RunOptions } from './context.js';
export type { CommandSpec } from './cli-core.js';
export { CLI_VERSION, BUNDLED_SKILL_VERSION, versionLine } from './build-info.js';

export const COMMANDS: readonly CommandSpec[] = buildCommands({
  usage: `nowme preview [dir=${WORKDIR_PAGE_DIR}] [--serve] [--cover] [--json] [--port N] [--remote]`,
  summary:
    '在双源本地沙箱中渲染、截图、做渲染检查与字体子集化；缺 cover.png 或带 --cover 时写入封面；--serve 保持服务器供浏览器查看；--remote 改由服务端渲染（本机没有浏览器时用）',
  flags: [
    { name: 'serve', type: 'boolean' },
    { name: 'cover', type: 'boolean' },
    { name: 'json', type: 'boolean' },
    { name: 'port', type: 'number' },
    { name: 'remote', type: 'boolean' },
  ],
  run: (ctx, args) => (args.flags.get('remote') === true ? runRemotePreview(ctx, args) : runPreview(ctx, args)),
});

export function helpText(): string {
  return coreHelpText(COMMANDS);
}

/** 运行 CLI，返回退出码。 */
export function run(argv: readonly string[], io?: CliIo, options: RunOptions = {}): Promise<number> {
  return runCli(COMMANDS, argv, io, options);
}
