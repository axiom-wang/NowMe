/**
 * @nowme/validator：页面静态校验（contracts 2）。纯函数，不碰浏览器、不碰网络，服务端复用。
 *
 * 占位（T0.2）：校验规则、validatePage、computeExtraChars、readPageDir 由 T1.1 实现。
 * 这里只提供报告的组装工具，保证报告结构与 contracts 2.1 一致。
 */
import {
  severityOf,
  type ValidationIssue,
  type ValidationReport,
  type ValidationStats,
} from '@nowme/contracts';

export const VALIDATOR_VERSION = '0.0.0';

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
