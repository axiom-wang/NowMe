/**
 * Kit 字体清单的辅助函数：CSS 变量名、源文件路径、下载计划、字体格式识别、zip 解包。
 *
 * `fonts.json` 中 `sourceUrl` 的约定（T1.2）：
 * - 以 `/` 结尾：一个目录，每个字重的文件从 `sourceUrl + 文件名` 下载；
 * - 以 `.zip` 结尾：一个发布压缩包，按文件名（不含目录）从包里取出每个字重的文件。
 * 两种地址都应固定到版本号（发布标签）或提交哈希，保证每次下载得到同一份文件。
 */
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import type { KitFont } from '@nowme/contracts';

/** 字体源文件的格式：TrueType / OpenType(CFF) / WOFF / WOFF2。 */
export type FontFormat = 'truetype' | 'opentype' | 'woff' | 'woff2';

/** 每款 Kit 字体对应的 CSS 变量名（contracts 1.1）：`--nm-font-<fontId>`。 */
export function fontCssVariable(fontId: string): string {
  return `--nm-font-${fontId}`;
}

/** 字重对应的源文件名；字重不在清单中时返回 null。 */
export function fontFileName(font: KitFont, weight: number): string | null {
  return font.files[String(weight)] ?? null;
}

/** 字重对应的本地源文件路径（`packages/kit/fonts/<文件名>`）。 */
export function fontFilePath(font: KitFont, weight: number, fontsDir: string): string | null {
  const file = fontFileName(font, weight);
  return file === null ? null : join(fontsDir, file);
}

export type FontSourceKind = 'directory' | 'zip';

/** `sourceUrl` 的类型（见文件头注释）；两种都不是时返回 null。 */
export function fontSourceKind(font: Pick<KitFont, 'sourceUrl'>): FontSourceKind | null {
  const path = new URL(font.sourceUrl).pathname;
  if (path.endsWith('/')) return 'directory';
  if (path.toLowerCase().endsWith('.zip')) return 'zip';
  return null;
}

export interface FontDownloadItem {
  fontId: string;
  weight: number;
  /** 本地文件名（也是在目录或压缩包中查找的文件名）。 */
  file: string;
}

/** 一次下载：目录来源每个文件一次；压缩包来源每个包一次，从中取出多个文件。 */
export interface FontDownloadJob {
  kind: FontSourceKind;
  url: string;
  items: FontDownloadItem[];
}

/** 按 `sourceUrl` 把清单展开为下载任务（同一个压缩包只下载一次）。 */
export function planFontDownloads(fonts: readonly KitFont[]): FontDownloadJob[] {
  const jobs: FontDownloadJob[] = [];
  const zipJobs = new Map<string, FontDownloadJob>();
  for (const font of fonts) {
    const kind = fontSourceKind(font);
    if (kind === null) {
      throw new Error(`字体 ${font.id} 的 sourceUrl 既不是以 / 结尾的目录，也不是 .zip 压缩包：${font.sourceUrl}`);
    }
    for (const weight of font.weights) {
      const file = fontFileName(font, weight);
      if (file === null) throw new Error(`字体 ${font.id} 缺少字重 ${weight} 的文件`);
      const item = { fontId: font.id, weight, file };
      if (kind === 'directory') {
        jobs.push({ kind, url: new URL(encodeURIComponent(file), font.sourceUrl).href, items: [item] });
        continue;
      }
      let job = zipJobs.get(font.sourceUrl);
      if (job === undefined) {
        job = { kind, url: font.sourceUrl, items: [] };
        zipJobs.set(font.sourceUrl, job);
        jobs.push(job);
      }
      job.items.push(item);
    }
  }
  return jobs;
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

/**
 * 按文件头识别字体格式：sfnt（`00 01 00 00` / `true`）、`OTTO`、`wOFF`、`wOF2`。
 * sfnt 还会检查表目录里有 `cmap` 与 `head` 表，避免把恰好以这几个字节开头的文件当成字体。
 * 不是字体（例如下载到的是 HTML 错误页）时返回 null。
 */
export function detectFontFormat(bytes: Uint8Array): FontFormat | null {
  if (bytes.length < 12) return null;
  const signature = tag(bytes, 0);
  if (signature === 'wOF2') return 'woff2';
  if (signature === 'wOFF') return 'woff';
  const isTrueType = signature === '\u0000\u0001\u0000\u0000' || signature === 'true';
  const isOpenType = signature === 'OTTO';
  if (!isTrueType && !isOpenType) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.length) return null;
  const tables = new Set<string>();
  for (let index = 0; index < numTables; index += 1) tables.add(tag(bytes, 12 + index * 16));
  if (!tables.has('cmap') || !tables.has('head')) return null;
  return isOpenType ? 'opentype' : 'truetype';
}

// ---------------------------------------------------------------------------
// zip（只读；支持 stored 与 deflate，不支持 zip64 与加密）
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 列出 zip 中的条目（读取中央目录）。 */
export function listZipEntries(zip: Uint8Array): ZipEntry[] {
  const view = viewOf(zip);
  const minEnd = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= minEnd; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到中央目录结尾）');
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('不支持 zip64 压缩包');

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error('zip 中央目录损坏');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (flags & 0x1) throw new Error('不支持加密的 zip 条目');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('不支持 zip64 压缩包');
    }
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, size, crc32: crc, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 解出一个条目的内容，并校验长度与 CRC32。 */
export function readZipEntry(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = viewOf(zip);
  const local = entry.localHeaderOffset;
  if (local + 30 > zip.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new Error(`zip 条目 ${entry.name} 的本地文件头损坏`);
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const raw = zip.subarray(start, start + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = new Uint8Array(inflateRawSync(raw));
  else throw new Error(`zip 条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}`);
  if (data.length !== entry.size) throw new Error(`zip 条目 ${entry.name} 解压后长度不对`);
  if (crc32(data) !== entry.crc32) throw new Error(`zip 条目 ${entry.name} 的 CRC32 校验失败`);
  return data;
}

/**
 * 按文件名（不含目录）取出 zip 中唯一的一个条目。
 * 跳过目录条目与 macOS 的 `__MACOSX/` 资源分支；找不到或有多个同名文件时报错。
 */
export function extractZipFile(zip: Uint8Array, fileName: string): Uint8Array {
  const matches = listZipEntries(zip).filter((entry) => {
    if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/')) return false;
    const base = entry.name.slice(entry.name.lastIndexOf('/') + 1);
    return base === fileName;
  });
  if (matches.length === 0) throw new Error(`压缩包里没有 ${fileName}`);
  if (matches.length > 1) {
    throw new Error(`压缩包里有多个 ${fileName}：${matches.map((entry) => entry.name).join('、')}`);
  }
  return readZipEntry(zip, matches[0] as ZipEntry);
}
