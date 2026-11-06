/**
 * @nowme/validator：页面静态校验（contracts 2）。
 *
 * - `validatePage(files, { kitFonts })`：纯函数，不碰文件系统、浏览器与网络，服务端提交管线直接复用；
 * - `computeExtraChars(files)`：`nowme validate` 自动补全 manifest.extraChars；
 * - `readPageDir(dir)`：读取本地 page/ 目录（node 辅助；实现在 `@nowme/validator/node`，
 *   这里按需动态加载，因此本入口不静态依赖 node:fs）。
 */
import type { PageDirFiles } from './page-files.js';

export { VALIDATOR_VERSION, createReport, emptyStats } from './report.js';
export { validatePage } from './validate.js';
export { computeExtraChars } from './extra-chars.js';
export { isSystemFile, isSystemFileName } from './system-files.js';
export { PageDirFiles, skippedEntriesOf, type SkippedEntry, type SkippedReason } from './page-files.js';
export type { PageFiles, ValidateOptions, ValidationIssue, ValidationReport, ValidationStats } from '@nowme/contracts';

/** 读取本地 page/ 目录为 PageFiles（不跟随符号链接；跳过的条目会在校验报告里给出 IGNORED_FILE 警告）。 */
export async function readPageDir(dir: string): Promise<PageDirFiles> {
  const node = await import('./node.js');
  return node.readPageDir(dir);
}
