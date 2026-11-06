/**
 * 极简参数解析：位置参数 + `--flag` / `--key value` / `--key=value`，`--` 之后全部当位置参数。
 */

export type FlagType = 'boolean' | 'string' | 'number';

export interface FlagSpec {
  /** 不含 `--`，例如 `json`、`no-fix`、`port`。 */
  name: string;
  type: FlagType;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | number | boolean>;
}

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParseResult {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const positionals: string[] = [];
  const flags = new Map<string, string | number | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '--') {
      if (arg.startsWith('-') && arg.length > 1) return { ok: false, error: `未知选项：${arg}` };
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const spec = byName.get(name);
    if (!spec) return { ok: false, error: `未知选项：--${name}` };
    if (spec.type === 'boolean') {
      if (eq >= 0) return { ok: false, error: `--${name} 不接受取值` };
      flags.set(name, true);
      continue;
    }
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === '') return { ok: false, error: `--${name} 需要一个取值` };
    if (spec.type === 'number') {
      const number = Number(value);
      if (!Number.isInteger(number)) return { ok: false, error: `--${name} 应为整数：${value}` };
      flags.set(name, number);
    } else {
      flags.set(name, value);
    }
  }
  return { ok: true, args: { positionals, flags } };
}
