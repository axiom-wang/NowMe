/**
 * 报告组装：问题收集（去重、同类限量）、排序、按 contracts 的级别分组。
 */
import {
  PAGE_CARD_FILE,
  PAGE_COVER_FILE,
  PAGE_INDEX_FILE,
  PAGE_MANIFEST_FILE,
  severityOf,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationReport,
  type ValidationStats,
} from '@nowme/contracts';

/** 校验器版本，写进每份报告。规则有实质变化时递增。 */
export const VALIDATOR_VERSION = '0.1.0';

export function emptyStats(): ValidationStats {
  return {
    indexHtmlBytes: 0,
    assetBytes: 0,
    assetCount: 0,
    blocks: [],
    fontsUsed: [],
    cjkFontCount: 0,
    scriptOnlyChars: '',
    ignoredFiles: [],
  };
}

/**
 * 把问题列表组装成报告：按错误码的级别分到 errors / warnings（以 contracts 的级别为准），
 * 没有 error 即 ok。
 */
export function createReport(issues: readonly ValidationIssue[], stats: ValidationStats = emptyStats()): ValidationReport {
  const normalized = issues.map((issue) => ({ ...issue, severity: severityOf(issue.code) }));
  const errors = normalized.filter((issue) => issue.severity === 'error');
  const warnings = normalized.filter((issue) => issue.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings, stats, validatorVersion: VALIDATOR_VERSION };
}

/** 同一文件同一错误码最多列出的条数，多出的合并成一条摘要（防止报告过长）。 */
export const MAX_ISSUES_PER_CODE_AND_FILE = 30;

export class IssueCollector {
  private readonly issues: ValidationIssue[] = [];
  private readonly seen = new Set<string>();
  private readonly counts = new Map<string, number>();
  private readonly overflow = new Map<string, { code: ValidationIssueCode; file: string; count: number; hint: string }>();

  /**
   * 记录一个问题。`dedupeKey` 相同（默认按 码 + 文件 + 行 + message）的只记一次。
   */
  add(code: ValidationIssueCode, file: string, line: number | undefined, message: string, hint: string, dedupeKey?: string): void {
    const key = `${code}\u0000${file}\u0000${line ?? ''}\u0000${dedupeKey ?? message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const bucket = `${code}\u0000${file}`;
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);
    if (count > MAX_ISSUES_PER_CODE_AND_FILE) {
      const entry = this.overflow.get(bucket) ?? { code, file, count: 0, hint };
      entry.count += 1;
      this.overflow.set(bucket, entry);
      return;
    }
    const issue: ValidationIssue = { code, severity: severityOf(code), file, message, hint };
    if (line !== undefined && Number.isFinite(line) && line >= 1) issue.line = Math.floor(line);
    this.issues.push(issue);
  }

  has(code: ValidationIssueCode): boolean {
    return this.issues.some((issue) => issue.code === code);
  }

  /** 按文件、行号排序后的全部问题（含超量摘要）。 */
  list(): ValidationIssue[] {
    const all = [...this.issues];
    for (const entry of this.overflow.values()) {
      all.push({
        code: entry.code,
        severity: severityOf(entry.code),
        file: entry.file,
        message: `还有 ${entry.count} 处同类问题未逐条列出`,
        hint: entry.hint,
      });
    }
    return all
      .map((issue, index) => ({ issue, index }))
      .sort((a, b) => {
        const fileOrder = fileRank(a.issue.file) - fileRank(b.issue.file);
        if (fileOrder !== 0) return fileOrder;
        if (a.issue.file !== b.issue.file) return a.issue.file < b.issue.file ? -1 : 1;
        const lineA = a.issue.line ?? Number.MAX_SAFE_INTEGER;
        const lineB = b.issue.line ?? Number.MAX_SAFE_INTEGER;
        if (lineA !== lineB) return lineA - lineB;
        return a.index - b.index;
      })
      .map(({ issue }) => issue);
  }
}

function fileRank(file: string): number {
  switch (file) {
    case PAGE_INDEX_FILE:
      return 0;
    case PAGE_CARD_FILE:
      return 1;
    case PAGE_MANIFEST_FILE:
      return 2;
    case PAGE_COVER_FILE:
      return 3;
    default:
      return file.startsWith('assets/') || file === 'assets' ? 4 : 5;
  }
}
