/**
 * 版本文件布局（contracts 3）：`<dataDir>/revisions/<id>/`
 *
 * ```
 * original/          提交的原文件（只有白名单路径）
 * served/index.html  注入字体 @font-face 后的版本（页面托管只提供 served/）
 * served/assets/...  图片
 * served/_fonts/<fontId>-<weight>.woff2
 * cover.png          封面（750×1000）
 * render/full.png    整页截图
 * ```
 *
 * 先写到同级的临时目录再整体改名，页面托管不会看到写了一半的版本。只有 accepted 版本写文件。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { dataPaths, isSafeRelativePath, REVISION_ID_PATTERN } from '@nowme/contracts';

export interface RevisionFiles {
  original: ReadonlyMap<string, Uint8Array>;
  served: ReadonlyMap<string, Uint8Array>;
  cover: Uint8Array | null;
  fullScreenshot: Uint8Array | null;
}

export const REVISION_ORIGINAL_DIR = 'original';
export const REVISION_SERVED_DIR = 'served';
export const REVISION_COVER_FILE = 'cover.png';
export const REVISION_FULL_SCREENSHOT = 'render/full.png';

function assertRevisionId(revisionId: string): void {
  if (!REVISION_ID_PATTERN.test(revisionId)) throw new Error(`revisionId 格式不对：${revisionId}`);
}

/** `root` 下的相对路径（`/` 分隔），拒绝穿越。 */
function safeJoin(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) throw new Error(`不安全的路径：${relative}`);
  const target = resolve(root, ...relative.split('/'));
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`路径越界：${relative}`);
  return target;
}

async function writeTree(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [path, content] of files) {
    const target = safeJoin(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
}

/** 版本目录 `<dataDir>/revisions/<id>`。 */
export function revisionDir(dataDir: string, revisionId: string): string {
  assertRevisionId(revisionId);
  return dataPaths(dataDir).revision(revisionId);
}

export async function writeRevisionFiles(dataDir: string, revisionId: string, files: RevisionFiles): Promise<string> {
  const finalDir = revisionDir(dataDir, revisionId);
  const parent = dirname(finalDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.tmp-${revisionId}-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(temp);
    await writeTree(join(temp, REVISION_ORIGINAL_DIR), files.original);
    await mkdir(join(temp, REVISION_SERVED_DIR), { recursive: true });
    await writeTree(join(temp, REVISION_SERVED_DIR), files.served);
    if (files.cover) await writeFile(join(temp, REVISION_COVER_FILE), files.cover);
    if (files.fullScreenshot) {
      await mkdir(join(temp, 'render'), { recursive: true });
      await writeFile(join(temp, ...REVISION_FULL_SCREENSHOT.split('/')), files.fullScreenshot);
    }
    await rename(temp, finalDir);
    return finalDir;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

/** 删除版本目录（数据库写入失败时回滚；T3.2 删除页面时也用它）。 */
export async function removeRevisionFiles(dataDir: string, revisionId: string): Promise<void> {
  await rm(revisionDir(dataDir, revisionId), { recursive: true, force: true });
}

/**
 * 删除页面（T3.2）：逐个删除这些版本的目录（不存在的跳过）。不会因为某一个失败而停下，
 * 返回删除失败的版本 ID（调用方记日志；数据库里这些版本已是墓碑，不会再签发票据）。
 */
export async function removeAllRevisionFiles(dataDir: string, revisionIds: readonly string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of revisionIds) {
    try {
      await removeRevisionFiles(dataDir, id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}
