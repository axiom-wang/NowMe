/**
 * 下载 Kit 字体源文件到 `packages/kit/fonts/`（不入库）。
 *
 *   pnpm --filter @nowme/kit fonts:fetch            # 已存在且能识别为字体的文件跳过
 *   pnpm --filter @nowme/kit fonts:fetch --force    # 全部重新下载
 *   pnpm --filter @nowme/kit fonts:fetch --only inter,lxgw-wenkai
 *
 * 每个文件先写到 `<文件名>.part`，确认文件头是字体（sfnt / OTTO / wOFF / wOF2）后再改名，
 * 所以中途失败不会留下半个字体文件；可以反复执行。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectFontFormat,
  extractZipFile,
  KIT_FONTS_DIR,
  loadKitFonts,
  planFontDownloads,
  type FontDownloadItem,
  type FontDownloadJob,
} from '../src/index.js';

const ATTEMPTS = 3;
const TIMEOUT_MS = 5 * 60 * 1000;

interface Options {
  force: boolean;
  only: Set<string> | null;
  dir: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { force: false, only: null, dir: KIT_FONTS_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') options.force = true;
    else if (arg === '--only') options.only = new Set((argv[(index += 1)] ?? '').split(',').filter(Boolean));
    else if (arg === '--dir') options.dir = argv[(index += 1)] ?? options.dir;
    else if (arg === '--') continue;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function isValidFontFile(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return detectFontFormat(new Uint8Array(await readFile(path))) !== null;
}

async function download(url: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) {
        console.warn(`  第 ${attempt} 次下载失败（${String(error)}），稍后重试：${url}`);
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  throw new Error(`下载失败：${url}（${String(lastError)}）`);
}

async function saveFont(dir: string, item: FontDownloadItem, bytes: Uint8Array): Promise<string> {
  const format = detectFontFormat(bytes);
  if (format === null) {
    throw new Error(`${item.file} 不是可识别的字体文件（文件头不是 sfnt / OTTO / wOFF / wOF2）`);
  }
  const target = join(dir, item.file);
  const partial = `${target}.part`;
  await writeFile(partial, bytes);
  await rename(partial, target);
  return format;
}

interface Result {
  item: FontDownloadItem;
  status: 'skipped' | 'downloaded' | 'failed';
  detail: string;
}

async function runJob(job: FontDownloadJob, options: Options): Promise<Result[]> {
  const pending: FontDownloadItem[] = [];
  const results: Result[] = [];
  for (const item of job.items) {
    if (!options.force && (await isValidFontFile(join(options.dir, item.file)))) {
      results.push({ item, status: 'skipped', detail: '已存在' });
    } else {
      pending.push(item);
    }
  }
  if (pending.length === 0) return results;

  try {
    console.log(`下载 ${job.url}`);
    const bytes = await download(job.url);
    for (const item of pending) {
      try {
        const fontBytes = job.kind === 'zip' ? extractZipFile(bytes, item.file) : bytes;
        const format = await saveFont(options.dir, item, fontBytes);
        results.push({ item, status: 'downloaded', detail: `${format}，${formatBytes(fontBytes.length)}` });
      } catch (error) {
        results.push({ item, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const item of pending) results.push({ item, status: 'failed', detail });
  }
  return results;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const fonts = loadKitFonts().filter((font) => options.only === null || options.only.has(font.id));
  if (options.only !== null && fonts.length !== options.only.size) {
    throw new Error(`--only 中有不在 fonts.json 里的字体：${[...options.only].join(', ')}`);
  }
  await mkdir(options.dir, { recursive: true });

  // 一次最多并行两个下载，避免同时拉取几个上百 MB 的文件。
  const jobs = planFontDownloads(fonts);
  const results: Result[] = [];
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      results.push(...(await runJob(job, options)));
    }
  });
  await Promise.all(workers);

  // 清理残留的 .part（例如上次被中断）
  for (const result of results) {
    await rm(join(options.dir, `${result.item.file}.part`), { force: true });
  }

  results.sort((a, b) => a.item.fontId.localeCompare(b.item.fontId) || a.item.weight - b.item.weight);
  const label = { skipped: '跳过', downloaded: '已下载', failed: '失败' } as const;
  console.log('');
  for (const { item, status, detail } of results) {
    console.log(`${label[status]}  ${item.fontId} ${item.weight}  ${item.file}  ${detail}`);
  }
  const failed = results.filter((result) => result.status === 'failed').length;
  console.log('');
  console.log(
    failed === 0
      ? `完成：${results.length} 个字体文件都在 ${options.dir}`
      : `有 ${failed} 个字体文件没能下载，请检查网络后重新运行（已下载的会跳过）`,
  );
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
