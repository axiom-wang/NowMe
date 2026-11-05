import { describe, expect, it } from 'vitest';
import { CLI_VERSION, COMMANDS, run } from '../src/index.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describe('nowme CLI（占位）', () => {
  it.each([[[]], [['--help']], [['-h']], [['help']]])('%j 打印帮助，退出码 0', async (argv) => {
    const io = capture();
    expect(await run(argv, io.io)).toBe(0);
    const help = io.stdout();
    expect(help).toContain('用法：nowme <命令>');
    for (const command of COMMANDS) expect(help).toContain(command.usage);
    expect(io.stderr()).toBe('');
  });

  it('列出 contracts 1.5 的全部命令', () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(['fetch', 'validate', 'preview', 'submit', 'status', 'event']);
  });

  it('--version', async () => {
    const io = capture();
    expect(await run(['--version'], io.io)).toBe(0);
    expect(io.stdout().trim()).toBe(CLI_VERSION);
  });

  it('尚未实现的命令退出码 1；命令帮助退出码 0', async () => {
    const io = capture();
    expect(await run(['validate'], io.io)).toBe(1);
    expect(io.stderr()).toContain('尚未实现');
    const help = capture();
    expect(await run(['validate', '--help'], help.io)).toBe(0);
    expect(help.stdout()).toContain('nowme validate');
  });

  it('未知命令退出码 1', async () => {
    const io = capture();
    expect(await run(['publish'], io.io)).toBe(1);
    expect(io.stderr()).toContain('未知命令');
  });
});
