/**
 * 组装 `served/`（contracts 3 的 `revisions/<id>/served/` 布局）：
 *
 * - `served/index.html`：原页面，在 `</head>` 前注入子集字体的 `<style>@font-face{...}</style>`；
 * - `served/assets/...`：原样复制（系统文件除外）；
 * - `served/_fonts/<fontId>-<weight>.woff2`：字体子集。
 */
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { PAGE_ASSETS_DIR, PAGE_INDEX_FILE, PAGE_MANIFEST_FILE, isSafeRelativePath, type KitFont, type PageFiles } from '@nowme/contracts';
import { isSystemFile } from '@nowme/validator';
import { collectSubsetText, fontFaceCss, planFontFaces, subsetFontFaces, type FontSourceReader, type FontSubsetResult } from './fonts.js';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** 宽松读取 manifest 里与子集化有关的字段（manifest 不合法时尽量取，取不到就当没有字体）。 */
export function readManifestFonts(bytes: Uint8Array | undefined): { fonts: { id: string; weights: number[] }[]; extraChars: string } {
  const empty = { fonts: [], extraChars: '' };
  if (!bytes) return empty;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return empty;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  const fonts: { id: string; weights: number[] }[] = [];
  if (Array.isArray(record.fonts)) {
    for (const font of record.fonts as unknown[]) {
      if (typeof font !== 'object' || font === null) continue;
      const { id, weights } = font as Record<string, unknown>;
      if (typeof id !== 'string' || !Array.isArray(weights)) continue;
      fonts.push({ id, weights: weights.filter((weight): weight is number => typeof weight === 'number') });
    }
  }
  return { fonts, extraChars: typeof record.extraChars === 'string' ? record.extraChars : '' };
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

/**
 * 在 `</head>` 前插入一段 HTML（用 parse5 定位真正的 head 结束位置，不会误中脚本字符串里的 `</head>`）。
 * 省略了 `</head>` 时插在 head 最后一个子节点之后；完全没有 head 内容时插在 `<body>` 之前或文档开头。
 */
export function insertBeforeHeadEnd(html: string, snippet: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'html');
  const head = root?.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'head');
  const body = root?.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'body');
  let offset: number | undefined;
  const headLocation = head?.sourceCodeLocation;
  if (headLocation?.endTag) {
    offset = headLocation.endTag.startOffset;
  } else if (head) {
    const located = head.childNodes.filter((node) => node.sourceCodeLocation);
    const last = located[located.length - 1];
    offset = last?.sourceCodeLocation?.endOffset ?? headLocation?.startTag?.endOffset ?? headLocation?.endOffset;
  }
  if (offset === undefined) offset = body?.sourceCodeLocation?.startOffset;
  if (offset === undefined) {
    const doctype = document.childNodes.find((node) => node.nodeName === '#documentType');
    offset = doctype?.sourceCodeLocation?.endOffset ?? 0;
  }
  return `${html.slice(0, offset)}${snippet}${html.slice(offset)}`;
}

/** 注入的 `<style>`：带 `data-nowme-fonts` 标记，便于识别；单行，不改变页面其他内容的行号。 */
export function fontFaceStyleTag(css: string): string {
  return `<style data-nowme-fonts>${css.replace(/[\r\n]+/g, '')}</style>`;
}

export interface ServedBuildInput {
  files: PageFiles;
  kitFonts: readonly KitFont[];
  /** 渲染后文字（各次渲染的 innerText）；第一次渲染之前为空。 */
  renderedText?: readonly string[];
  readFontSource: FontSourceReader;
}

export interface ServedBuild {
  /** `served/` 下的文件（相对路径 → 内容）。没有 index.html 时为空。 */
  served: Map<string, Uint8Array>;
  fonts: FontSubsetResult;
  /** 子集取字范围（排序后的字符串）。 */
  subsetText: string;
}

/** 生成 `served/`：字体子集 + 注入 `@font-face` 的 index.html + assets。 */
export async function buildServedFiles(input: ServedBuildInput): Promise<ServedBuild> {
  const served = new Map<string, Uint8Array>();
  const indexBytes = input.files.get(PAGE_INDEX_FILE);
  if (!indexBytes) return { served, fonts: { files: [], missingSources: [] }, subsetText: '' };
  const html = decoder.decode(indexBytes);
  const manifest = readManifestFonts(input.files.get(PAGE_MANIFEST_FILE));
  const subsetText = collectSubsetText({ html, renderedText: input.renderedText, extraChars: manifest.extraChars });
  const faces = planFontFaces(manifest.fonts, input.kitFonts);
  const fonts = await subsetFontFaces(faces, subsetText, input.readFontSource);

  const servedHtml = fonts.files.length > 0 ? insertBeforeHeadEnd(html, fontFaceStyleTag(fontFaceCss(fonts.files))) : html;
  served.set(PAGE_INDEX_FILE, encoder.encode(servedHtml));
  for (const [path, bytes] of input.files) {
    if (!path.startsWith(`${PAGE_ASSETS_DIR}/`) || !isSafeRelativePath(path) || isSystemFile(path)) continue;
    served.set(path, bytes);
  }
  for (const file of fonts.files) served.set(file.path, file.woff2);
  return { served, fonts, subsetText };
}
