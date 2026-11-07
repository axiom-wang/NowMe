/**
 * nowme 命令行的命令表与运行逻辑（contracts 1.5），源码入口（main.ts）与随 Skill 包分发的单文件入口
 * （bundle-entry.ts）共用。这里不引入 `@nowme/render`（Playwright）：本地渲染的 preview 由 main.ts 注入。
 *
 * 命令：fetch / validate / preview / submit / status / event。所有输出经 redactCredentials 兜底，
 * 任何形如 nmc_… 的完整凭证都只会显示前缀。
 */
import { WORKDIR_PAGE_DIR } from '@nowme/contracts';
import { parseArgs, type FlagSpec, type ParsedArgs } from './args.js';
import { runEvent } from './commands/event.js';
import { runFetch } from './commands/fetch.js';
import { runStatus } from './commands/status.js';
import { runSubmit } from './commands/submit.js';
import { runValidate } from './commands/validate.js';
import { redactCredentials } from './credentials.js';
import { createContext, type CliContext, type CliIo, type RunOptions } from './context.js';
import { IS_BUNDLED, versionLine } from './build-info.js';

export type { CliIo, RunOptions } from './context.js';

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

/** preview 命令的说明与实现（源码入口注入本地渲染 + `--remote`；单文件入口只有远程渲染）。 */
export type PreviewCommand = Pick<CommandSpec, 'usage' | 'summary' | 'flags' | 'run'>;

/** contracts 1.5 的命令表。 */
export function buildCommands(preview: PreviewCommand): readonly CommandSpec[] {
  return [
  {
    name: 'fetch',
    usage: 'nowme fetch [<wallId> <token>] [--server URL] [--json]',
    summary: '用一次性 token 换取页面凭证并拉取墙情境（--server 默认 http://localhost:3000）；不带参数时刷新 context.json',
    flags: [
      { name: 'server', type: 'string' },
      { name: 'json', type: 'boolean' },
    ],
    run: runFetch,
  },
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
  { name: 'preview', ...preview },
  {
    name: 'submit',
    usage: `nowme submit [dir=${WORKDIR_PAGE_DIR}] [--json]`,
    summary: '本地校验后只上传白名单文件；发布需要你在应用内确认缩略卡和联系方式',
    flags: [{ name: 'json', type: 'boolean' }],
    run: runSubmit,
  },
  {
    name: 'status',
    usage: 'nowme status [--json]',
    summary: '显示工作目录、关联的墙与页面、凭证是否存在（不显示凭证内容）',
    flags: [{ name: 'json', type: 'boolean' }],
    run: runStatus,
  },
  {
    name: 'event',
    usage: 'nowme event <type> [--ok|--no-ok] [--duration-ms N] [--count N] [--json]',
    summary: '上报 fetch / validate / preview / generate / submit 事件（只带数字 / 布尔属性；无凭证时静默）',
    flags: [
      { name: 'ok', type: 'boolean' },
      { name: 'no-ok', type: 'boolean' },
      { name: 'duration-ms', type: 'number' },
      { name: 'count', type: 'number' },
      { name: 'json', type: 'boolean' },
    ],
    run: runEvent,
  },
  ];
}

export function helpText(commands: readonly CommandSpec[]): string {
  const width = Math.max(...commands.map((command) => command.usage.length));
  const lines = [
    `${versionLine()} — NOWMe 页面命令行`,
    '',
    '用法：nowme <命令> [参数]',
    '',
    '命令：',
    ...commands.map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}${command.run ? '' : '（尚未实现）'}`),
    '',
    '选项：',
    '  -h, --help     显示帮助',
    '  -v, --version  显示版本',
    '',
    IS_BUNDLED
      ? '相对路径按你执行命令时所在的目录解析。'
      : '相对路径按你执行命令时所在的目录解析（通过 pnpm --dir <仓库> nowme ... 运行时取 INIT_CWD）。',
    '预览产物写在页面目录上一级的 .nowme-preview/ 里，不会写进 page/。',
    '所有命令默认输出中文的人类可读文本，--json 输出机器可读结果。凭证永远不打印完整内容。',
    '',
  ];
  return lines.join('\n');
}

/** 运行 CLI，返回退出码。 */
export async function runCli(
  commands: readonly CommandSpec[],
  argv: readonly string[],
  rawIo: CliIo = defaultIo,
  options: RunOptions = {},
): Promise<number> {
  // 输出层兜底：任何完整凭证都只显示前缀
  const io: CliIo = {
    stdout: (text) => rawIo.stdout(redactCredentials(text)),
    stderr: (text) => rawIo.stderr(redactCredentials(text)),
  };
  const [first, ...rest] = argv;
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    io.stdout(helpText(commands));
    return 0;
  }
  if (first === '-v' || first === '--version') {
    io.stdout(`${versionLine()}\n`);
    return 0;
  }
  const command = commands.find((candidate) => candidate.name === first);
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
