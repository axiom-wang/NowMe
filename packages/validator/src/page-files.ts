/**
 * `readPageDir` 的返回类型：普通的 PageFiles（Map），另外记下读取时跳过的条目
 * （符号链接、特殊文件、过大的文件等），`validatePage` 会把它们报成 IGNORED_FILE 警告。
 * 本文件不依赖 node:fs，纯函数入口可以安全引用。
 */
import type { PageFiles } from '@nowme/contracts';

export type SkippedReason = 'symlink' | 'special' | 'too-large' | 'too-deep' | 'too-many' | 'unreadable';

export interface SkippedEntry {
  /** page/ 内的相对路径，用 "/" 分隔。 */
  path: string;
  reason: SkippedReason;
}

export class PageDirFiles extends Map<string, Uint8Array> implements PageFiles {
  readonly skipped: SkippedEntry[] = [];
}

export function skippedEntriesOf(files: PageFiles): readonly SkippedEntry[] {
  return files instanceof PageDirFiles ? files.skipped : [];
}
