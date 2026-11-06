/**
 * 没有类型声明的字体库（CommonJS），在这里给出本包用到的部分的类型：
 * - subset-font：harfbuzz（wasm）子集化，调用在模块内部串行执行；
 * - fontverter：sfnt / WOFF / WOFF2 互转（WOFF2 用 wawoff2 wasm）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type FontFormatName = 'sfnt' | 'truetype' | 'woff' | 'woff2';

export interface SubsetFontOptions {
  /** 输出格式；`sfnt` / `truetype` 为未压缩的 TTF / OTF。 */
  targetFormat?: FontFormatName;
  /** 额外保留的 name 表记录（harfbuzz 默认只保留 0–6）。 */
  preserveNameIds?: number[];
  /** 只保留这些 OpenType 特性；默认保留全部（相当于 `--layout-features=*`，竖排 vert 等都在）。 */
  keepFeatures?: string[];
  noLayoutClosure?: boolean;
}

export type SubsetFont = (font: Buffer, text: string, options?: SubsetFontOptions) => Promise<Buffer>;

export interface Fontverter {
  convert(font: Buffer, toFormat: FontFormatName, fromFormat?: FontFormatName): Promise<Buffer>;
  detectFormat(font: Buffer): 'sfnt' | 'woff' | 'woff2';
}

export const subsetFont = require('subset-font') as SubsetFont;
export const fontverter = require('fontverter') as Fontverter;
