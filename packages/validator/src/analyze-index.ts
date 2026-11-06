/**
 * index.html 的完整分析：HTML 扫描 → CSS 分析 → 脚本分析（脚本里的 HTML 注入点再回到 HTML 扫描）。
 */
import type { PageAnalysis } from './analysis.js';
import { analyzeCss } from './css.js';
import { HtmlScanner, type HtmlScanResult } from './html.js';
import { analyzeScripts } from './js.js';

export function analyzeIndexHtml(html: string, a: PageAnalysis): HtmlScanResult {
  const scanner = new HtmlScanner(a);
  const result = scanner.scanDocument(html);
  for (const style of result.styles) analyzeCss(style, a);
  analyzeScripts(result.scripts, a, (fragment, line, where) => {
    const extra = scanner.scanSink(fragment, line, where);
    for (const style of extra.styles) analyzeCss(style, a);
    return extra.scripts;
  });
  return result;
}
