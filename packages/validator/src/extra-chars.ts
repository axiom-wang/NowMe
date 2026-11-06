/**
 * computeExtraChars：`nowme validate` 自动补全 manifest.extraChars 用。
 */
import { HTML_MAX_BYTES, PAGE_INDEX_FILE, PAGE_MANIFEST_FILE, type PageFiles } from '@nowme/contracts';
import { PageAnalysis } from './analysis.js';
import { analyzeIndexHtml } from './analyze-index.js';
import { peekManifest } from './files.js';
import { KitFontIndex } from './fonts.js';
import { IssueCollector } from './report.js';
import { decodeUtf8, sortChars } from './text.js';

/**
 * 返回应写入 manifest.extraChars 的字符串：脚本字符串（以及 JSON 数据块）里出现、
 * 静态文本里没有的中文字符，与已有 extraChars 合并（去掉空白），去重并按码点排序。
 */
export function computeExtraChars(files: PageFiles): string {
  const existing = Array.from(peekManifest(files.get(PAGE_MANIFEST_FILE))?.extraChars ?? '').filter((char) => !/\s/u.test(char));
  const html = files.get(PAGE_INDEX_FILE);
  if (!html || html.byteLength > HTML_MAX_BYTES * 4) return sortChars(existing);
  const a = new PageAnalysis(new IssueCollector(), new KitFontIndex([]));
  analyzeIndexHtml(decodeUtf8(html), a);
  const scriptOnly = [...a.scriptChars].filter((char) => !a.staticChars.has(char));
  return sortChars([...existing, ...scriptOnly]);
}
