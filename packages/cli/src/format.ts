/**
 * 中文的人类可读输出：问题按文件分组，每条带位置、说明与修复指引。
 */
import {
  PAGE_CARD_FILE,
  PAGE_COVER_FILE,
  PAGE_INDEX_FILE,
  PAGE_MANIFEST_FILE,
  type ValidationIssue,
  type ValidationReport,
} from '@nowme/contracts';

const FILE_ORDER = [PAGE_INDEX_FILE, PAGE_CARD_FILE, PAGE_MANIFEST_FILE, PAGE_COVER_FILE];

function fileRank(file: string): number {
  const index = FILE_ORDER.indexOf(file);
  if (index >= 0) return index;
  return file.startsWith('assets/') ? FILE_ORDER.length : FILE_ORDER.length + 1;
}

/** 按文件分组（固定顺序：index.html、card.json、manifest.json、cover.png、assets/、其他），组内错误在前、按行号。 */
export function groupIssues(issues: readonly ValidationIssue[]): [file: string, issues: ValidationIssue[]][] {
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const list = groups.get(issue.file) ?? [];
    list.push(issue);
    groups.set(issue.file, list);
  }
  const severity = (issue: ValidationIssue) => (issue.severity === 'error' ? 0 : 1);
  return [...groups.entries()]
    .sort(([a], [b]) => fileRank(a) - fileRank(b) || a.localeCompare(b))
    .map(([file, list]) => [file, [...list].sort((x, y) => severity(x) - severity(y) || (x.line ?? 0) - (y.line ?? 0))]);
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  const lines: string[] = [];
  for (const [file, list] of groupIssues(issues)) {
    lines.push(file);
    for (const issue of list) {
      const label = issue.severity === 'error' ? '[错误]' : '[警告]';
      const where = issue.line === undefined ? '' : ` 第 ${issue.line} 行`;
      lines.push(`  ${label} ${issue.code}${where}：${issue.message}`);
      lines.push(`         修复：${issue.hint}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function summaryLine(report: ValidationReport): string {
  const errors = report.errors.length;
  const warnings = report.warnings.length;
  if (errors === 0 && warnings === 0) return '结果：通过，没有错误和警告';
  if (errors === 0) return `结果：通过，${warnings} 个警告（建议看一遍）`;
  return `结果：${errors} 个错误，${warnings} 个警告（请按“修复”逐条处理后重新运行）`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
