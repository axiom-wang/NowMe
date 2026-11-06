/**
 * nowme 命令行入口（contracts 1.5）。
 *
 * 已实现：validate、preview（T1.3）。fetch / submit / status / event 由 T2.3 实现：在 COMMANDS 中给对应命令
 * 加上 `flags` 与 `run` 即可；事件上报用 CliContext.reportEvent（RunOptions.sendEvent 提供真正的发送函数）。
 */
import { WORKDIR_PAGE_DIR } from '@nowme/contracts';
import { parseArgs, type FlagSpec, type ParsedArgs } from './args.js';
import { runPreview } from './commands/preview.js';
import { runValidate } from './commands/validate.js';
import { createContext, type CliContext, type CliIo, type RunOptions } from './context.js';

export type { CliIo, RunOptions } from './context.js';

export const CLI_VERSION = '0.1.0';

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  /** 允许的选项（`--help` 之外）。 */
  flags?: readonly FlagSpec[];
  /** 未实现的命令没有 run。 */
  run?: (ctx: CliContext, args: ParsedArgs) => Promise<number>;
}

/** contracts 1.5 的命令表。 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'fetch', usage: 'nowme fetch <wallId> <token> [--server URL]', summary: '用一次性 token 换取页面凭证并拉取墙情境；已有凭证时刷新 context.json' },
  {
    name: 'validate',
    usage: `nowme validate [dir=${WORKDIR_PAGE_DIR}] [--json] [--no-fix]`,
    summary: '静态校验页面；默认自动补全 manifest.extraChars；有错误时退出码 1',
    flags: [
      { name: 'json', type: 'boolean' },
      { name: 'no-fix', type: 'boolean' },
    ],
    run: runValidate,
  },
  {
    name: 'preview',
    usage: `nowme preview [dir=${WORKDIR_PAGE_DIR}] [--serve] [--cover] [--json] [--port N]`,
    summary: '在双源本地沙箱中渲染、截图、做渲染检查与字体子集化；缺 cover.png 或带 --cover 时写入封面；--serve 保持服务器供浏览器查看',
    flags: [
      { name: 'serve', type: 'boolean' },
      { name: 'cover', type: 'boolean' },
      { name: 'json', type: 'boolean' },
      { name: 'port', type: 'number' },
    ],
    run: runPreview,
  },
  { name: 'submit', usage: `nowme submit [dir=${WORKDIR_PAGE_DIR}]`, summary: '本地校验后只上传白名单文件；发布需要你在应用内确认' },
  { name: 'status', usage: 'nowme status', summary: '显示关联的墙、页面与凭证是否存在（不显示凭证内容）' },
  { name: 'event', usage: 'nowme event <type>', summary: '上报 generate 等事件（只带数字 / 布尔属性）' },
];

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length));
  const lines = [
    `nowme ${CLI_VERSION} — NOWMe 页面命令行（本地路线）`,
    '',
    '用法：nowme <命令> [参数]',
    '',
    '命令：',
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}${command.run ? '' : '（尚未实现）'}`),
    '',
    '选项：',
    '  -h, --help     显示帮助',
    '  -v, --version  显示版本',
    '',
    '相对路径按你执行命令时所在的目录解析（通过 pnpm --dir <仓库> nowme ... 运行时取 INIT_CWD）。',
    '预览产物写在页面目录上一级的 .nowme-preview/ 里，不会写进 page/。',
    '所有命令默认输出中文的人类可读文本，--json 输出机器可读结果。凭证永远不打印完整内容。',
    '',
  ];
  return lines.join('\n');
}

/** 运行 CLI，返回退出码。 */
export async function run(argv: readonly string[], io: CliIo = defaultIo, options: RunOptions = {}): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    io.stdout(helpText());
    return 0;
  }
  if (first === '-v' || first === '--version') {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }
  const command = COMMANDS.find((candidate) => candidate.name === first);
  if (!command) {
    io.stderr(`未知命令：${first}\n运行 nowme --help 查看可用命令。\n`);
    return 1;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout(`用法：${command.usage}\n${command.summary}\n`);
    return 0;
  }
  if (!command.run) {
    io.stderr(`nowme ${command.name} 尚未实现。\n`);
    return 1;
  }
  const parsed = parseArgs(rest, command.flags ?? []);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n用法：${command.usage}\n`);
    return 1;
  }
  const ctx = createContext(io, options);
  try {
    return await command.run(ctx, parsed.args);
  } catch (error) {
    io.stderr(`nowme ${command.name} 失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
