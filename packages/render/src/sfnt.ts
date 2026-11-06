/**
 * 最小的 sfnt（TrueType / OpenType）读取：表目录、`cmap`（字符 → 字形）、`name`（版权、授权、family）。
 *
 * 用途：子集化之后检查“需要的字都在子集里”（contracts 8：渲染后文字里的每个字都必须在子集内），
 * 以及测试里验证 WOFF2 子集的字符集合。WOFF2 先用 `woff2ToSfnt` 解压。
 */
import { fontverter } from './font-libs.js';

export interface SfntTable {
  tag: string;
  offset: number;
  length: number;
}

function tagAt(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 读取 sfnt 表目录。不是 sfnt（`00 01 00 00` / `true` / `OTTO`）时抛错。 */
export function readSfntTables(bytes: Uint8Array): Map<string, SfntTable> {
  if (bytes.byteLength < 12) throw new Error('字体文件太短');
  const view = viewOf(bytes);
  const signature = tagAt(view, 0);
  if (signature !== '\u0000\u0001\u0000\u0000' && signature !== 'true' && signature !== 'OTTO') {
    throw new Error(`不是 sfnt 字体（文件头 ${JSON.stringify(signature)}）`);
  }
  const numTables = view.getUint16(4);
  if (12 + numTables * 16 > bytes.byteLength) throw new Error('字体表目录损坏');
  const tables = new Map<string, SfntTable>();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tag = tagAt(view, record);
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > bytes.byteLength) throw new Error(`字体表 ${tag} 超出文件范围`);
    tables.set(tag, { tag, offset, length });
  }
  return tables;
}

function requireTable(bytes: Uint8Array, tag: string): SfntTable {
  const table = readSfntTables(bytes).get(tag);
  if (!table) throw new Error(`字体缺少 ${tag} 表`);
  return table;
}

/**
 * `cmap` 中映射到非 0 字形的全部码点。优先读 Unicode 全范围子表（格式 12），
 * 否则读 BMP 子表（格式 4）。
 */
export function readCmapCodepoints(bytes: Uint8Array): Set<number> {
  const table = requireTable(bytes, 'cmap');
  const view = viewOf(bytes);
  const base = table.offset;
  const count = view.getUint16(base + 2);
  let format12: number | null = null;
  let format4: number | null = null;
  for (let index = 0; index < count; index += 1) {
    const record = base + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = base + view.getUint32(record + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || offset + 2 > base + table.length) continue;
    const format = view.getUint16(offset);
    if (format === 12 && format12 === null) format12 = offset;
    if (format === 4 && format4 === null) format4 = offset;
  }
  const codepoints = new Set<number>();
  if (format12 !== null) {
    const groups = view.getUint32(format12 + 12);
    for (let index = 0; index < groups; index += 1) {
      const group = format12 + 16 + index * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const glyph = view.getUint32(group + 8);
      for (let code = start; code <= end; code += 1) if (glyph + (code - start) !== 0) codepoints.add(code);
    }
    return codepoints;
  }
  if (format4 !== null) {
    const segCount = view.getUint16(format4 + 6) / 2;
    const endCodes = format4 + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let segment = 0; segment < segCount; segment += 1) {
      const end = view.getUint16(endCodes + segment * 2);
      const start = view.getUint16(startCodes + segment * 2);
      const delta = view.getInt16(idDeltas + segment * 2);
      const rangeOffsetPosition = idRangeOffsets + segment * 2;
      const rangeOffset = view.getUint16(rangeOffsetPosition);
      for (let code = start; code <= end && code !== 0xffff; code += 1) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const glyphPosition = rangeOffsetPosition + rangeOffset + (code - start) * 2;
          glyph = view.getUint16(glyphPosition);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) codepoints.add(code);
      }
    }
    return codepoints;
  }
  throw new Error('字体没有可读的 Unicode cmap 子表（格式 4 / 12）');
}

/** `name` 表中 Windows Unicode（3, 1）或 Unicode 平台（0, *）的记录：nameID → 文本。 */
export function readNameRecords(bytes: Uint8Array): Map<number, string> {
  const table = requireTable(bytes, 'name');
  const view = viewOf(bytes);
  const base = table.offset;
  const count = view.getUint16(base + 2);
  const strings = base + view.getUint16(base + 4);
  const names = new Map<number, string>();
  for (let index = 0; index < count; index += 1) {
    const record = base + 6 + index * 12;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const nameId = view.getUint16(record + 6);
    const length = view.getUint16(record + 8);
    const offset = strings + view.getUint16(record + 10);
    if (!(platform === 0 || (platform === 3 && encoding === 1))) continue;
    if (names.has(nameId)) continue;
    let text = '';
    for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(view.getUint16(offset + i));
    names.set(nameId, text);
  }
  return names;
}

/** WOFF2 → sfnt（wasm 解压）。已经是 sfnt 时原样返回。 */
export async function toSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await fontverter.convert(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 'sfnt');
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** 码点集合 → 字符串（按码点排序）。 */
export function codepointsToString(codepoints: Iterable<number>): string {
  return [...codepoints].sort((a, b) => a - b).map((code) => String.fromCodePoint(code)).join('');
}
