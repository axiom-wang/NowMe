/**
 * 原子写入：先写同目录临时文件（带权限），再 rename 覆盖。
 */
import { randomBytes } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(path: string, text: string, mode = 0o644): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
