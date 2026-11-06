/**
 * 操作系统自动生成的文件（contracts 1.4）：`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`（macOS AppleDouble），
 * 在 page/ 的任意目录层级一律忽略：readPageDir 不读，validatePage 不报任何问题（包括 IGNORED_FILE），
 * 提交时不上传。比较时不区分大小写（Windows 的文件名不区分大小写）。
 */
const SYSTEM_FILE_NAMES: ReadonlySet<string> = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/** 文件名（不含目录）是否是系统文件。 */
export function isSystemFileName(name: string): boolean {
  return name.startsWith('._') || SYSTEM_FILE_NAMES.has(name.toLowerCase());
}

/** page/ 内的相对路径（`/` 分隔）的最后一段是否是系统文件。 */
export function isSystemFile(path: string): boolean {
  return isSystemFileName(path.slice(path.lastIndexOf('/') + 1));
}
