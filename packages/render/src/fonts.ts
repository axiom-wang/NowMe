/**
 * 字体子集化（contracts 1.1、3、8；page-generation 5.4）。
 *
 * - 取字范围：`index.html` 源码中出现的全部字符（含属性和脚本）+ 渲染后文字 + `manifest.extraChars`；
 * - 对 `manifest.fonts` 声明的每个字体 / 字重，用 Kit 字体源文件（`packages/kit/fonts/`）生成 WOFF2 子集，
 *   放在 `served/_fonts/<fontId>-<weight>.woff2`；
 * - 生成后读回子集的 cmap 自检：源字体有的、需要的字必须都在子集里，否则抛错（不会悄悄缺字）。
 *
 * 子集化用 harfbuzz（subset-font，wasm），WOFF2 压缩用 wawoff2（fontverter，wasm），都是纯 JS / wasm。
 */
import { readFile } from 'node:fs/promises';
import { fontverter, subsetFont } from './font-libs.js';
import { PAGE_FONTS_DIR, type KitFont } from '@nowme/contracts';
import { KIT_FONTS_DIR, kitFontSourcePath } from '@nowme/kit';
import { codepointsToString, readCmapCodepoints, toSfnt } from './sfnt.js';

/** 一个要生成子集的字体字重。 */
export interface FontFace {
  font: KitFont;
  weight: number;
}

/** 子集文件在 `served/` 中的相对路径：`_fonts/<fontId>-<weight>.woff2`。 */
export function fontSubsetPath(fontId: string, weight: number): string {
  return `${PAGE_FONTS_DIR}/${fontId}-${weight}.woff2`;
}

/**
 * `manifest.fonts` → 要生成子集的字体字重（按声明顺序）。不在 Kit 清单里的 id 与字重跳过
 * （静态校验另报 FONT_UNKNOWN）。
 */
export function planFontFaces(manifestFonts: readonly { id: string; weights: readonly number[] }[], kitFonts: readonly KitFont[]): FontFace[] {
  const faces: FontFace[] = [];
  const seen = new Set<string>();
  for (const declared of manifestFonts) {
    const font = kitFonts.find((item) => item.id === declared.id);
    if (!font) continue;
    for (const weight of declared.weights) {
      const key = `${font.id}:${weight}`;
      if (!font.weights.includes(weight) || seen.has(key)) continue;
      seen.add(key);
      faces.push({ font, weight });
    }
  }
  return faces;
}

/** 不需要字形的码点：C0 / C1 控制字符、换行等（空格保留）。 */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/**
 * 子集取字范围（contracts 8）：各部分文字的码点并集（去掉控制字符），按码点排序。
 */
export function collectSubsetText(parts: { html: string; renderedText?: readonly string[]; extraChars?: string }): string {
  const codes = new Set<number>();
  const add = (text: string) => {
    for (const char of text) {
      const code = char.codePointAt(0) as number;
      if (!isControl(code)) codes.add(code);
    }
  };
  add(parts.html);
  for (const text of parts.renderedText ?? []) add(text);
  add(parts.extraChars ?? '');
  return codepointsToString(codes);
}

/** 读取字体源文件；不存在时返回 null。 */
export type FontSourceReader = (font: KitFont, weight: number) => Promise<Uint8Array | null>;

/** 从目录读取 Kit 字体源文件（默认 `packages/kit/fonts/`）。 */
export function directoryFontSource(fontsDir: string = KIT_FONTS_DIR): FontSourceReader {
  return async (font, weight) => {
    const path = kitFontSourcePath(font, weight, fontsDir);
    if (path === null) return null;
    try {
      const buffer = await readFile(path);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
}

export interface SubsetFontFile {
  fontId: string;
  family: string;
  weight: number;
  cjk: boolean;
  /** `served/` 中的相对路径，例如 `_fonts/lxgw-wenkai-400.woff2`。 */
  path: string;
  /** WOFF2 内容。 */
  woff2: Uint8Array;
  /** 子集 cmap 中的字符数。 */
  charCount: number;
  /** 需要、但源字体本身也没有的汉字（这些字会回退到系统字体）。只对中文字体统计。 */
  unsupportedChars: string;
}

export interface MissingFontSource {
  fontId: string;
  weight: number;
  /** 期望的源文件名（`fonts.json` 的 files）。 */
  file: string | null;
}

export interface FontSubsetResult {
  files: SubsetFontFile[];
  /** 源文件缺失（未运行 `pnpm --filter @nowme/kit fonts:fetch`）的字体字重。 */
  missingSources: MissingFontSource[];
}

/** 子集化过程中保留的 name 记录：版权、family、字重、版本、PostScript 名、授权说明与地址。 */
const PRESERVED_NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14];

const HAN = /\p{Script=Han}/u;

/**
 * 为每个字体字重生成 WOFF2 子集。生成后读回 cmap 自检：`text` 中源字体有的字必须都在子集里。
 */
export async function subsetFontFaces(faces: readonly FontFace[], text: string, readSource: FontSourceReader): Promise<FontSubsetResult> {
  const files: SubsetFontFile[] = [];
  const missingSources: MissingFontSource[] = [];
  const wanted = new Set<number>();
  for (const char of text) wanted.add(char.codePointAt(0) as number);

  for (const { font, weight } of faces) {
    const source = await readSource(font, weight);
    if (source === null) {
      missingSources.push({ fontId: font.id, weight, file: font.files[String(weight)] ?? null });
      continue;
    }
    const sourceSfnt = await toSfnt(source);
    const available = readCmapCodepoints(sourceSfnt);
    const sfnt = await subsetFont(Buffer.from(sourceSfnt.buffer, sourceSfnt.byteOffset, sourceSfnt.byteLength), text, {
      targetFormat: 'sfnt',
      preserveNameIds: PRESERVED_NAME_IDS,
    });
    const subsetCodes = readCmapCodepoints(new Uint8Array(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength));
    const lost: number[] = [];
    const unsupported: number[] = [];
    for (const code of wanted) {
      if (available.has(code)) {
        if (!subsetCodes.has(code)) lost.push(code);
      } else if (font.cjk && HAN.test(String.fromCodePoint(code))) {
        unsupported.push(code);
      }
    }
    if (lost.length > 0) {
      throw new Error(`字体子集 ${font.id} ${weight} 缺少源字体中有的字：${codepointsToString(lost.slice(0, 20))}`);
    }
    const woff2 = await fontverter.convert(sfnt, 'woff2', 'sfnt');
    files.push({
      fontId: font.id,
      family: font.family,
      weight,
      cjk: font.cjk,
      path: fontSubsetPath(font.id, weight),
      woff2: new Uint8Array(woff2.buffer, woff2.byteOffset, woff2.byteLength),
      charCount: subsetCodes.size,
      unsupportedChars: codepointsToString(unsupported),
    });
  }
  return { files, missingSources };
}

/**
 * 子集字体的 `@font-face` 规则。`src` 用相对路径 `_fonts/...`（相对 `/v/<ticket>/`，落在 CSP 的 font-src 内）。
 * family 名由 schema 保证只含 ASCII 字母、数字、空格、连字符，可以直接放进引号。
 * 输出不含换行：注入到 index.html 后不改变其他内容的行号（渲染报错的行号仍对应源文件）。
 */
export function fontFaceCss(files: readonly Pick<SubsetFontFile, 'family' | 'weight' | 'path'>[]): string {
  return files
    .map(
      (file) =>
        `@font-face{font-family:"${file.family}";src:url("${file.path}") format("woff2");font-weight:${file.weight};font-style:normal;font-display:swap}`,
    )
    .join('');
}
