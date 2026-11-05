import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '@nowme/contracts';
import { createReport, emptyStats, VALIDATOR_VERSION } from '../src/index.js';

const issue = (code: ValidationIssue['code']): ValidationIssue => ({
  code,
  severity: 'warning',
  file: 'index.html',
  message: '测试',
  hint: '测试',
});

describe('createReport（占位）', () => {
  it('没有问题时 ok', () => {
    expect(createReport([])).toEqual({
      ok: true,
      errors: [],
      warnings: [],
      stats: emptyStats(),
      validatorVersion: VALIDATOR_VERSION,
    });
  });

  it('按 contracts 的级别分组，有 error 即不 ok', () => {
    const report = createReport([issue('HTML_MISSING_LANG'), issue('CREDENTIAL_LEAK')]);
    expect(report.ok).toBe(false);
    expect(report.errors.map((i) => i.code)).toEqual(['CREDENTIAL_LEAK']);
    expect(report.errors[0]?.severity).toBe('error');
    expect(report.warnings.map((i) => i.code)).toEqual(['HTML_MISSING_LANG']);
  });

  it('只有警告时 ok', () => {
    expect(createReport([issue('IGNORED_FILE')]).ok).toBe(true);
  });
});
