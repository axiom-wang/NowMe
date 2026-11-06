/**
 * 合法示例页：0 error、0 warning；统计正确；validatePage 是纯函数。
 */
import { describe, expect, it } from 'vitest';
import { KIT_FONTS, VALID_HTML, makePage, run, summary } from './fixtures.js';
import { VALIDATOR_VERSION, validatePage } from '../src/index.js';

describe('合法示例页', () => {
  it('没有任何问题', () => {
    const report = run(makePage());
    expect(report.errors, summary(report)).toEqual([]);
    expect(report.warnings, summary(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.validatorVersion).toBe(VALIDATOR_VERSION);
  });

  it('统计信息', () => {
    const files = makePage();
    const { stats } = run(files);
    expect(stats.indexHtmlBytes).toBe(new TextEncoder().encode(VALID_HTML).byteLength);
    expect(stats.assetCount).toBe(5);
    expect(stats.assetBytes).toBe([...files].filter(([path]) => path.startsWith('assets/')).reduce((sum, [, bytes]) => sum + bytes.byteLength, 0));
    expect(stats.blocks).toEqual(['hero', 'projects', 'teammate']);
    expect(stats.fontsUsed).toEqual(['inter', 'lxgw-wenkai']);
    expect(stats.cjkFontCount).toBe(1);
    expect(stats.ignoredFiles).toEqual([]);
    // 脚本字符串与 JSON 数据块里的字，且不在静态文本中（“设计”“队友”等在正文里出现过的不算）
    expect(stats.scriptOnlyChars).toBe('一亮代写到吧夜天师快来熬码计设起');
  });

  it('纯函数：不修改输入，重复调用结果相同', () => {
    const files = makePage();
    const snapshot = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    const first = validatePage(files, { kitFonts: KIT_FONTS });
    const second = validatePage(files, { kitFonts: KIT_FONTS });
    expect(second).toEqual(first);
    expect([...files.keys()]).toEqual([...snapshot.keys()]);
    for (const [path, bytes] of files) expect(bytes).toEqual(snapshot.get(path));
  });

  it('kitFonts 默认为空数组：清单字体都算不认识', () => {
    const report = validatePage(makePage());
    expect(report.errors.map((issue) => issue.code)).toEqual(['FONT_UNKNOWN', 'FONT_UNKNOWN']);
    expect(report.warnings.map((issue) => issue.code)).toContain('FONT_NOT_IN_KIT');
    expect(report.stats.fontsUsed).toEqual([]);
  });

  it('空输入不抛异常，报缺少必需文件', () => {
    const report = validatePage(new Map());
    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.file).sort()).toEqual(['card.json', 'index.html', 'manifest.json']);
  });
});
