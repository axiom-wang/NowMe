/**
 * 最小的 ZIP 写入器（数据导出用，contracts 14）：在内存里拼出一个标准 ZIP（无 ZIP64、无加密），
 * 文件名用 UTF-8（通用标志位 11）。每个文件按需 deflate：压缩后更小才用，否则原样存（图片本身已压缩）。
 * 调用方负责控制总大小（远小于 4 GiB）。
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** `/` 分隔的相对路径，不以 `/` 开头，不含 `..`。 */
  path: string;
  data: Uint8Array;
}

const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** MS-DOS 时间与日期（ZIP 头里的格式，精度 2 秒；按 UTC 写）。 */
function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function isSafeZipPath(path: string): boolean {
  if (path.length === 0 || path.length > 400 || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f]/.test(part));
}

export function buildZip(entries: readonly ZipEntry[], modified: Date): Uint8Array {
  const { time, day } = dosDateTime(modified);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isSafeZipPath(entry.path)) throw new Error(`ZIP 路径不安全：${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`ZIP 路径重复：${entry.path}`);
    seen.add(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const deflated = raw.byteLength > 64 ? deflateRawSync(raw) : null;
    const useDeflate = deflated !== null && deflated.byteLength < raw.byteLength;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}
