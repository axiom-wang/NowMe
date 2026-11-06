/**
 * @nowme/validator/node：读取本地 page/ 目录（node 辅助，CLI 使用）。
 *
 * - 系统文件（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`，任意层级）直接跳过，不读也不记录；
 * - 不跟随任何符号链接（包括指向目录内的），符号链接、设备、管道等特殊文件跳过并记录，
 *   validatePage 会把它们报成 IGNORED_FILE 警告；
 * - 打开文件时带 O_NOFOLLOW，防止检查与读取之间被替换成符号链接；
 * - 限制目录深度、文件数与单个文件大小，避免误把大目录当成 page/。
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PageDirFiles, type SkippedReason } from './page-files.js';
import { isSystemFileName } from './system-files.js';

export * from './index.js';
export { PageDirFiles, type SkippedEntry, type SkippedReason } from './page-files.js';

/** 目录最大深度（page/ 下第几层）：assets/ 只允许一层子目录，这里留出余量。 */
export const READ_MAX_DEPTH = 6;
export const READ_MAX_FILES = 500;
/** 超过这个大小的文件不读入内存（远超任何允许的上限）。 */
export const READ_MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function readPageDir(dir: string): Promise<PageDirFiles> {
  const root = await realpath(dir);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`不是目录：${dir}`);
  const files = new PageDirFiles();
  let count = 0;
  const skip = (path: string, reason: SkippedReason) => files.skipped.push({ path, reason });

  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const entry of entries) {
      // .DS_Store、Thumbs.db、desktop.ini、._*：不读、不记录（contracts 1.4）
      if (isSystemFileName(entry.name)) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(absDir, entry.name);
      if (entry.isSymbolicLink()) {
        skip(rel, 'symlink');
      } else if (entry.isDirectory()) {
        if (depth + 1 >= READ_MAX_DEPTH) skip(rel, 'too-deep');
        else await walk(abs, rel, depth + 1);
      } else if (entry.isFile()) {
        if (count >= READ_MAX_FILES) {
          skip(rel, 'too-many');
          continue;
        }
        const read = await readRegularFile(abs);
        if (typeof read === 'string') skip(rel, read);
        else {
          files.set(rel, read);
          count += 1;
        }
      } else {
        skip(rel, 'special');
      }
    }
  };

  await walk(root, '', 0);
  return files;
}

async function readRegularFile(path: string): Promise<Uint8Array | SkippedReason> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'symlink' : 'unreadable';
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return 'special';
    if (stat.size > READ_MAX_FILE_BYTES) return 'too-large';
    const buffer = await handle.readFile();
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return 'unreadable';
  } finally {
    await handle.close();
  }
}
