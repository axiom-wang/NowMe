/**
 * 渲染任务的暂存目录 `<dataDir>/jobs/<jobId>/`（contracts 13.2）：主站把已过滤的页面文件写进 `files/`，
 * worker 读出来渲染；远程预览的结果写进 `result.json` 由主站读走。任务结束即删除，worker 定期清理遗留目录。
 *
 * 只写白名单路径（`isPageUploadPath`），读回时再过滤一次；目录 0700、文件 0600。
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isPageUploadPath, RENDER_JOB_ID_PATTERN, type PageFiles } from '@nowme/contracts';
import { isSystemFile } from '@nowme/validator';

export const JOBS_DIR_NAME = 'jobs';
const FILES_DIR = 'files';
const META_FILE = 'meta.json';
const RESULT_FILE = 'result.json';

export function jobsRoot(dataDir: string): string {
  return join(dataDir, JOBS_DIR_NAME);
}

export function stagingDir(dataDir: string, jobId: string): string {
  if (!RENDER_JOB_ID_PATTERN.test(jobId)) throw new Error(`任务 ID 格式不对：${jobId}`);
  return join(jobsRoot(dataDir), jobId);
}

function safeTarget(root: string, path: string): string {
  if (!isPageUploadPath(path)) throw new Error(`不在白名单里的路径：${path}`);
  const target = resolve(root, ...path.split('/'));
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`路径越界：${path}`);
  return target;
}

/** 主站：写入暂存的页面文件与被丢弃的路径列表（报告里的 IGNORED_FILE 警告要用）。 */
export async function stageFiles(dataDir: string, jobId: string, files: PageFiles, ignored: readonly string[]): Promise<void> {
  const dir = stagingDir(dataDir, jobId);
  await mkdir(jobsRoot(dataDir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  try {
    const root = join(dir, FILES_DIR);
    await mkdir(root, { mode: 0o700 });
    for (const [path, content] of files) {
      const target = safeTarget(root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(join(dir, META_FILE), JSON.stringify({ ignored }), { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function walk(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** worker：读回暂存的页面文件（只取白名单路径）。 */
export async function readStaged(dataDir: string, jobId: string): Promise<{ files: PageFiles; ignored: string[] }> {
  const dir = stagingDir(dataDir, jobId);
  const root = join(dir, FILES_DIR);
  const files: PageFiles = new Map();
  for (const path of await walk(root)) {
    if (!isPageUploadPath(path) || isSystemFile(path)) continue;
    files.set(path, new Uint8Array(await readFile(safeTarget(root, path))));
  }
  let ignored: string[] = [];
  try {
    const meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8')) as { ignored?: unknown };
    if (Array.isArray(meta.ignored)) ignored = meta.ignored.filter((value): value is string => typeof value === 'string');
  } catch {
    ignored = [];
  }
  return { files, ignored };
}

/** worker：写入结果（先写临时文件再改名，主站不会读到一半）。 */
export async function writeResult(dataDir: string, jobId: string, value: unknown): Promise<void> {
  const dir = stagingDir(dataDir, jobId);
  const temp = join(dir, `.${RESULT_FILE}.tmp`);
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, join(dir, RESULT_FILE));
}

export async function readResult<T>(dataDir: string, jobId: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(stagingDir(dataDir, jobId), RESULT_FILE), 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function removeStaging(dataDir: string, jobId: string): Promise<void> {
  await rm(stagingDir(dataDir, jobId), { recursive: true, force: true });
}

/** 暂存目录与最后修改时间（维护任务清理遗留目录用）。 */
export async function listStaging(dataDir: string): Promise<{ jobId: string; mtimeMs: number }[]> {
  const root = jobsRoot(dataDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: { jobId: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!RENDER_JOB_ID_PATTERN.test(name)) continue;
    try {
      out.push({ jobId: name, mtimeMs: (await stat(join(root, name))).mtimeMs });
    } catch {
      // 并发删除
    }
  }
  return out;
}

/** 测试用：暂存目录里剩下的文件（相对 `<dataDir>/jobs`）。 */
export async function listStagingFiles(dataDir: string): Promise<string[]> {
  try {
    return await walk(jobsRoot(dataDir));
  } catch {
    return [];
  }
}
