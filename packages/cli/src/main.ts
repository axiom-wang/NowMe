/**
 * nowme 命令行入口（contracts 1.5）。
 *
 * 占位（T0.2）：只实现 `--help` / `--version`；各命令由 T1.3（validate / preview）与 T2.3（fetch / submit / status / event）实现。
 */
import { WORKDIR_PAGE_DIR } from '@nowme/contracts';

export const CLI_VERSION = '0.0.0';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** contracts 1.5 的命令表。 */
export const COMMANDS = [
  { name: 'fetch', usage: 'nowme fetch <wallId> <token> [--server URL]', summary: '用一次性 token 换取页面凭证并拉取墙情境；已有凭证时刷新 context.json' },
  { name: 'validate', usage: `nowme validate [dir=${WORKDIR_PAGE_DIR}] [--json] [--no-fix]`, summary: '静态校验页面；默认自动补全 manifest.extraChars；有错误时退出码 1' },
  { name: 'preview', usage: `nowme preview [dir=${WORKDIR_PAGE_DIR}] [--serve] [--cover]`, summary: '在双源本地沙箱中渲染、截图、做渲染检查与字体子集化' },
  { name: 'submit', usage: `nowme submit [dir=${WORKDIR_PAGE_DIR}]`, summary: '本地校验后只上传白名单文件；发布需要你在应用内确认' },
  { name: 'status', usage: 'nowme status', summary: '显示关联的墙、页面与凭证是否存在（不显示凭证内容）' },
  { name: 'event', usage: 'nowme event <type>', summary: '上报 generate 等事件（只带数字 / 布尔属性）' },
] as const;

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length));
  const lines = [
    `nowme ${CLI_VERSION} — NOWMe 页面命令行（本地路线）`,
    '',
    '用法：nowme <命令> [参数]',
    '',
    '命令（脚手架阶段，尚未实现）：',
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    '',
    '选项：',
    '  -h, --help     显示帮助',
    '  -v, --version  显示版本',
    '',
    '所有命令默认输出中文的人类可读文本，--json 输出机器可读结果。凭证永远不打印完整内容。',
    '',
  ];
  return lines.join('\n');
}

/** 运行 CLI，返回退出码。 */
export async function run(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const [first] = argv;
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    io.stdout(helpText());
    return 0;
  }
  if (first === '-v' || first === '--version') {
    io.stdout(`${CLI_VERSION}\n`);
    return 0;
  }
  const command = COMMANDS.find((candidate) => candidate.name === first);
  if (command) {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout(`用法：${command.usage}\n${command.summary}\n`);
      return 0;
    }
    io.stderr(`nowme ${command.name} 尚未实现（脚手架阶段）。\n`);
    return 1;
  }
  io.stderr(`未知命令：${first}\n运行 nowme --help 查看可用命令。\n`);
  return 1;
}
