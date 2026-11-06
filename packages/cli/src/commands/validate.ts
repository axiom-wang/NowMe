/**
 * `nowme validate [dir=page] [--json] [--no-fix]`（contracts 1.5、2）。
 *
 * - 用 Kit 字体清单做静态校验；
 * - 默认先用 computeExtraChars 补全 manifest.extraChars 并写回（只改这一个字段的值，其余文本保持原样）；
 * - 中文输出按文件分组、每条带修复指引；`--json` 输出机器可读结果；
 * - 有 error 时退出码 1。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PAGE_MANIFEST_FILE, type ValidationReport } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { computeExtraChars, validatePage } from '@nowme/validator';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { formatIssues, summaryLine } from '../format.js';
import { replaceTopLevelString } from '../manifest-edit.js';
import { loadPage } from '../page-dir.js';
import type { PageDirFiles } from '@nowme/validator/node';

export interface ExtraCharsFix {
  before: string;
  after: string;
  /** 新增的字（按码点排序）。 */
  added: string;
}

export interface ValidateOutput {
  command: 'validate';
  ok: boolean;
  pageDir: string;
  /** 自动补全了 extraChars 时的变化；没有变化或带 --no-fix 时为 null。 */
  fixed: { extraChars: ExtraCharsFix } | null;
  report: ValidationReport;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * 用 computeExtraChars 补全 manifest.extraChars；有变化时写回文件并更新 files。
 * manifest 缺失、不是合法 JSON、没有 extraChars 字符串字段时不动（校验报告会指出问题）。
 */
export async function fixExtraChars(pageDir: string, files: PageDirFiles): Promise<ExtraCharsFix | null> {
  const bytes = files.get(PAGE_MANIFEST_FILE);
  if (!bytes) return null;
  let text: string;
  let manifest: unknown;
  try {
    text = decoder.decode(bytes);
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null;
  const before = (manifest as Record<string, unknown>).extraChars;
  if (typeof before !== 'string') return null;
  const after = computeExtraChars(files);
  if (after === before) return null;
  // TextDecoder 已去掉 BOM；替换失败（例如有重复键）时退回到 2 空格缩进整体重写
  const next =
    replaceTopLevelString(text, 'extraChars', after) ??
    `${JSON.stringify({ ...(manifest as Record<string, unknown>), extraChars: after }, null, 2)}\n`;
  await writeFile(join(pageDir, PAGE_MANIFEST_FILE), next, 'utf8');
  files.set(PAGE_MANIFEST_FILE, new TextEncoder().encode(next));
  const beforeSet = new Set(Array.from(before));
  const added = Array.from(after).filter((char) => !beforeSet.has(char)).join('');
  return { before, after, added };
}

export async function runValidate(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const started = Date.now();
  const json = args.flags.get('json') === true;
  const noFix = args.flags.get('no-fix') === true;
  if (args.positionals.length > 1) {
    ctx.io.stderr('用法：nowme validate [dir=page] [--json] [--no-fix]\n');
    return 1;
  }
  const { pageDir, workDir, files } = await loadPage(ctx, args.positionals[0]);
  const kitFonts = loadKitFonts();
  const fix = noFix ? null : await fixExtraChars(pageDir, files);
  const report = validatePage(files, { kitFonts });
  const output: ValidateOutput = { command: 'validate', ok: report.ok, pageDir, fixed: fix ? { extraChars: fix } : null, report };

  if (json) {
    ctx.io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    const lines = [`nowme validate：${pageDir}`];
    if (fix) {
      lines.push(
        fix.added.length > 0
          ? `已自动补全 manifest.extraChars：新增 ${Array.from(fix.added).length} 个字（${fix.added}）`
          : '已整理 manifest.extraChars（去重、去空白、排序）',
      );
    }
    lines.push(summaryLine(report), '');
    const issues = [...report.errors, ...report.warnings];
    if (issues.length > 0) lines.push(formatIssues(issues));
    ctx.io.stdout(`${lines.join('\n')}\n`);
  }

  await ctx.reportEvent(workDir, 'validate', {
    ok: report.ok,
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    durationMs: Date.now() - started,
  });
  return report.ok ? 0 : 1;
}
