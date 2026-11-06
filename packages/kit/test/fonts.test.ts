import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { KIT_FONT_LICENSES, kitFontsFileSchema, MAX_CJK_FONTS } from '@nowme/contracts';
import {
  detectFontFormat,
  extractZipFile,
  fontCssVariable,
  fontSourceKind,
  KIT_FONTS_DIR,
  KIT_FONTS_FILE,
  kitFontSourcePath,
  listZipEntries,
  loadKitFonts,
  planFontDownloads,
} from '../src/index.js';

const fonts = loadKitFonts();

describe('fonts.json', () => {
  it('通过 kitFontsFileSchema', () => {
    const raw: unknown = JSON.parse(readFileSync(KIT_FONTS_FILE, 'utf8'));
    expect(kitFontsFileSchema.safeParse(raw).success).toBe(true);
  });

  it('中文 3–4 款、西文 3–4 款', () => {
    const cjk = fonts.filter((font) => font.cjk).length;
    const latin = fonts.length - cjk;
    expect(cjk).toBeGreaterThanOrEqual(3);
    expect(cjk).toBeLessThanOrEqual(4);
    expect(latin).toBeGreaterThanOrEqual(3);
    expect(latin).toBeLessThanOrEqual(4);
  });

  it('全部是允许子集化与网页分发的开源授权', () => {
    for (const font of fonts) expect(KIT_FONT_LICENSES).toContain(font.license);
  });

  it('每款中文字体至少有一个字重能单独使用（预算 ≤ 2）', () => {
    for (const font of fonts.filter((item) => item.cjk)) expect(font.weights.length).toBeGreaterThanOrEqual(1);
    expect(MAX_CJK_FONTS).toBe(2);
  });

  it('来源固定到版本（发布标签或提交哈希），且是目录或 zip', () => {
    for (const font of fonts) {
      expect(fontSourceKind(font), font.id).not.toBeNull();
      const url = font.sourceUrl;
      const pinned = /\/releases\/download\/v?\d/.test(url) || /\/[0-9a-f]{40}\//.test(url);
      expect(pinned, `${font.id}: ${url}`).toBe(true);
    }
  });

  it('源文件名在清单内唯一（都下载到同一个目录）', () => {
    const names = fonts.flatMap((font) => Object.values(font.files));
    expect(new Set(names).size).toBe(names.length);
  });

  it('只用静态字重文件，不用可变字体', () => {
    for (const font of fonts) {
      for (const file of Object.values(font.files)) expect(file, font.id).not.toMatch(/\[|Variable|VF/);
    }
  });

  it('font id 可以直接拼成 CSS 变量名', () => {
    for (const font of fonts) expect(fontCssVariable(font.id)).toMatch(/^--nm-font-[a-z][a-z0-9-]*$/);
  });
});

describe('下载计划', () => {
  it('目录来源每个字重一个任务，URL = sourceUrl + 文件名；同一个 zip 只下载一次', () => {
    const jobs = planFontDownloads(fonts);
    const files = jobs.flatMap((job) => job.items.map((item) => item.file));
    expect(files.length).toBe(fonts.reduce((sum, font) => sum + font.weights.length, 0));
    const zipUrls = jobs.filter((job) => job.kind === 'zip').map((job) => job.url);
    expect(new Set(zipUrls).size).toBe(zipUrls.length);
    for (const job of jobs.filter((item) => item.kind === 'directory')) {
      const [item] = job.items;
      const font = fonts.find((candidate) => candidate.id === item?.fontId);
      expect(job.url).toBe(`${font?.sourceUrl}${item?.file}`);
    }
  });

  it('sourceUrl 既不是目录也不是 zip 时报错', () => {
    const [first] = fonts;
    if (first === undefined) throw new Error('fonts.json 为空');
    expect(() => planFontDownloads([{ ...first, sourceUrl: 'https://example.com/font.ttf' }])).toThrow(/sourceUrl/);
  });
});

describe('detectFontFormat', () => {
  function sfnt(signature: number[], tables: string[]): Uint8Array {
    const bytes = new Uint8Array(12 + tables.length * 16);
    bytes.set(signature, 0);
    new DataView(bytes.buffer).setUint16(4, tables.length);
    tables.forEach((name, index) => {
      for (let char = 0; char < 4; char += 1) bytes[12 + index * 16 + char] = name.charCodeAt(char);
    });
    return bytes;
  }

  it('识别 TrueType、OpenType(CFF)、WOFF、WOFF2', () => {
    expect(detectFontFormat(sfnt([0, 1, 0, 0], ['cmap', 'glyf', 'head']))).toBe('truetype');
    expect(detectFontFormat(sfnt([0x4f, 0x54, 0x54, 0x4f], ['CFF ', 'cmap', 'head']))).toBe('opentype');
    expect(detectFontFormat(new TextEncoder().encode('wOFF' + '\0'.repeat(40)))).toBe('woff');
    expect(detectFontFormat(new TextEncoder().encode('wOF2' + '\0'.repeat(40)))).toBe('woff2');
  });

  it('拒绝 HTML 错误页、空文件、缺少关键表的 sfnt', () => {
    expect(detectFontFormat(new TextEncoder().encode('<!doctype html><title>404</title>'))).toBeNull();
    expect(detectFontFormat(new Uint8Array())).toBeNull();
    expect(detectFontFormat(sfnt([0, 1, 0, 0], ['glyf']))).toBeNull();
    expect(detectFontFormat(sfnt([0, 1, 0, 0], []))).toBeNull();
  });

  const downloaded = fonts.flatMap((font) =>
    font.weights.map((weight) => ({ font, weight, path: kitFontSourcePath(font, weight) as string })),
  );
  const missing = downloaded.filter((item) => !existsSync(item.path));

  it.skipIf(missing.length === downloaded.length)('已下载的字体源文件都能被识别为字体', () => {
    for (const { font, weight, path } of downloaded) {
      if (!existsSync(path)) continue;
      expect(detectFontFormat(new Uint8Array(readFileSync(path))), `${font.id} ${weight}`).not.toBeNull();
    }
  });

  it.skipIf(missing.length > 0)('全部字体源文件都已下载（未运行 fonts:fetch 时跳过）', () => {
    expect(missing.map((item) => item.path)).toEqual([]);
    expect(existsSync(join(KIT_FONTS_DIR, '.gitignore'))).toBe(true);
  });
});

describe('zip 解包', () => {
  /** 构造一个最小的 zip（deflate 与 stored 各一个条目）。 */
  function makeZip(entries: { name: string; data: Uint8Array; method: 0 | 8 }[]): Uint8Array {
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = new TextEncoder().encode(entry.name);
      const body = entry.method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
      const crc = crc32(entry.data);
      const local = new Uint8Array(30 + name.length + body.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(8, entry.method, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, entry.data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      local.set(body, 30 + name.length);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(10, entry.method, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, entry.data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    }
    const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + centralSize + end.length);
    let cursor = 0;
    for (const part of [...locals, ...centrals, end]) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }

  const fontBytes = new TextEncoder().encode('wOF2 pretend font '.repeat(50));
  const zip = makeZip([
    { name: 'pkg/', data: new Uint8Array(), method: 0 },
    { name: 'pkg/extras/ttf/Demo-Regular.ttf', data: fontBytes, method: 8 },
    { name: 'pkg/README.txt', data: new TextEncoder().encode('hello'), method: 0 },
    { name: '__MACOSX/pkg/extras/ttf/Demo-Regular.ttf', data: new TextEncoder().encode('fork'), method: 0 },
    { name: 'pkg/a/Dup.ttf', data: fontBytes, method: 0 },
    { name: 'pkg/b/Dup.ttf', data: fontBytes, method: 0 },
  ]);

  it('列出条目并按文件名取出（忽略目录与 __MACOSX）', () => {
    expect(listZipEntries(zip).map((entry) => entry.name)).toContain('pkg/extras/ttf/Demo-Regular.ttf');
    expect(extractZipFile(zip, 'Demo-Regular.ttf')).toEqual(fontBytes);
    expect(new TextDecoder().decode(extractZipFile(zip, 'README.txt'))).toBe('hello');
  });

  it('找不到或有重名文件时报错', () => {
    expect(() => extractZipFile(zip, 'Missing.ttf')).toThrow(/没有/);
    expect(() => extractZipFile(zip, 'Dup.ttf')).toThrow(/多个/);
  });

  it('CRC 不对或不是 zip 时报错', () => {
    const broken = zip.slice();
    const entry = listZipEntries(broken).find((item) => item.name === 'pkg/README.txt');
    if (entry === undefined) throw new Error('缺少条目');
    const dataStart = entry.localHeaderOffset + 30 + 'pkg/README.txt'.length;
    broken[dataStart] = (broken[dataStart] ?? 0) ^ 0xff;
    expect(() => extractZipFile(broken, 'README.txt')).toThrow(/CRC32/);
    expect(() => listZipEntries(new TextEncoder().encode('not a zip at all, definitely not'))).toThrow(/不是 zip/);
  });
});
