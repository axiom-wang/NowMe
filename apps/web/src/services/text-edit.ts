/**
 * 直接改文字（contracts 22.1、22.2）：从页面 `index.html` 里取出可改的文字，按主人的修改替换回去。纯函数。
 *
 * - 取字：parse5 解析（带源码位置），只走 `<body>` 里的元素，跳过脚本、样式等原样文本元素与 `<template>`；
 *   只取文本节点，全是空白的跳过。按最近的 `data-nm-id` 祖先分组。
 * - 替换：按源码位置只替换文本节点的内容，前后空白保留，`& < >` 转义——输入只能成为文字。
 * - 兜底（S16）：替换后重新解析，元素、属性与脚本 / 样式内容必须与原来完全一致，否则整次拒绝。
 */
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { TEXT_EDIT_LIMITS } from '@nowme/contracts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;

/** 内容不是可见文字、或者按原样文本解析的元素：里面的文字不列出来，也不能改。 */
const SKIP_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'xmp', 'plaintext', 'noembed', 'noframes', 'iframe', 'title']);

const LEADING_SPACE = /^[\t\n\f\r ]*/;
const TRAILING_SPACE = /[\t\n\f\r ]*$/;
/** 控制字符与双向文字控制符（看不见、容易拿来捣乱）。保留换行，另行处理。 */
const STRIPPED_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g;

export interface TextSegment {
  /** 在这一页里的序号（表单字段 `t_<index>`）。 */
  index: number;
  /** 最近的 `data-nm-id` 祖先；没有时为 null（界面归入“其他”）。 */
  block: string | null;
  /** 去掉前后空白、实体已解码的文字。 */
  text: string;
  /** 原文里有换行（界面用多行输入框，保存时保留换行）。 */
  multiline: boolean;
}

interface Located extends TextSegment {
  start: number;
  end: number;
  rawLead: string;
  rawTrail: string;
}

export interface ExtractedText {
  segments: TextSegment[];
  /** 超过 `TEXT_EDIT_LIMITS.segments` 段，后面的没有列出。 */
  truncated: boolean;
}

export type ApplyTextEditsResult =
  | { ok: true; html: string; changed: string[] }
  | { ok: false; error: 'unchanged' | 'too-long' | 'unsafe'; index?: number };

function attr(element: Element, name: string): string | null {
  return element.attrs.find((a) => a.name === name && !a.namespace)?.value ?? null;
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function locate(html: string): { segments: Located[]; truncated: boolean } {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const htmlElement = document.childNodes.find(isElement);
  const body = htmlElement?.childNodes.find((node): node is Element => isElement(node) && node.tagName === 'body');
  const segments: Located[] = [];
  let truncated = false;
  let lastEnd = -1;

  const visit = (node: Node, block: string | null): void => {
    if (truncated) return;
    if (node.nodeName === '#text') {
      const text = node as TextNode;
      const loc = text.sourceCodeLocation;
      const value = text.value;
      const lead = LEADING_SPACE.exec(value)![0].length;
      const trail = TRAILING_SPACE.exec(value.slice(lead))![0].length;
      const core = value.slice(lead, value.length - trail);
      if (!core || !loc) return;
      // 解析器补出来的、位置重叠或倒退的文本（例如表格里被挪走的文字）不列出：替换位置不可靠
      if (loc.startOffset < lastEnd || loc.endOffset <= loc.startOffset) return;
      const raw = html.slice(loc.startOffset, loc.endOffset);
      if (raw.includes('<')) return;
      if (segments.length >= TEXT_EDIT_LIMITS.segments) {
        truncated = true;
        return;
      }
      const rawLead = LEADING_SPACE.exec(raw)![0];
      const rawTrail = TRAILING_SPACE.exec(raw.slice(rawLead.length))![0];
      segments.push({ index: segments.length, block, text: core, multiline: core.includes('\n'), start: loc.startOffset, end: loc.endOffset, rawLead, rawTrail });
      lastEnd = loc.endOffset;
      return;
    }
    if (!isElement(node) || SKIP_TAGS.has(node.tagName)) return;
    const own = attr(node, 'data-nm-id');
    for (const child of node.childNodes) visit(child, own ?? block);
  };

  if (body) visit(body, null);
  return { segments, truncated };
}

export function extractTextSegments(html: string): ExtractedText {
  const { segments, truncated } = locate(html);
  return { segments: segments.map(({ index, block, text, multiline }) => ({ index, block, text, multiline })), truncated };
}

/** 表单里提交的一段文字：去控制字符，统一换行；原文没有换行时换行合并为空格；去掉前后空白。 */
export function normalizeSegmentInput(value: string, multiline: boolean): string {
  const unified = value.replace(/\r\n?/g, '\n').replace(STRIPPED_CHARS, '');
  return (multiline ? unified : unified.replace(/\n+/g, ' ')).trim();
}

function normalizeOriginal(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 元素、属性、脚本与样式内容的“指纹”：直接改文字前后必须相同。 */
export function markupSignature(html: string): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (isElement(node)) {
      parts.push(`<${node.namespaceURI}|${node.tagName}|${JSON.stringify(node.attrs.map((a) => [a.namespace ?? '', a.prefix ?? '', a.name, a.value]))}`);
      if (SKIP_TAGS.has(node.tagName)) {
        // 原样文本元素与 template 的全部内容都必须不变
        parts.push(JSON.stringify(collectText(node)));
      }
      const content = (node as DefaultTreeAdapterTypes.Template).content;
      for (const child of node.childNodes) visit(child);
      if (content) for (const child of content.childNodes) visit(child);
      parts.push('>');
    } else if (node.nodeName === '#comment') {
      parts.push(`!${(node as DefaultTreeAdapterTypes.CommentNode).data}`);
    } else if (node.nodeName === '#documentType') {
      parts.push(`doctype|${(node as DefaultTreeAdapterTypes.DocumentType).name}`);
    } else if ('childNodes' in node) {
      for (const child of (node as DefaultTreeAdapterTypes.ParentNode).childNodes) visit(child);
    }
  };
  visit(parse(html));
  return parts.join('\n');
}

function collectText(node: Node): string {
  if (node.nodeName === '#text') return (node as TextNode).value;
  const children = 'childNodes' in node ? (node as DefaultTreeAdapterTypes.ParentNode).childNodes : [];
  const content = isElement(node) ? (node as DefaultTreeAdapterTypes.Template).content : undefined;
  return [...children, ...(content?.childNodes ?? [])].map(collectText).join('');
}

/**
 * 按序号替换文字。`edits` 里不认识的序号忽略；和原文相同的段不算改动。
 * 一段都没变 → `unchanged`；有一段超长 → `too-long`；替换后标记有任何变化 → `unsafe`（不应发生，兜底）。
 */
export function applyTextEdits(html: string, edits: ReadonlyMap<number, string>): ApplyTextEditsResult {
  const { segments } = locate(html);
  const replacements: { start: number; end: number; raw: string }[] = [];
  const changed: string[] = [];
  for (const segment of segments) {
    const submitted = edits.get(segment.index);
    if (submitted === undefined) continue;
    const next = normalizeSegmentInput(submitted, segment.multiline);
    if (next === normalizeOriginal(segment.text)) continue;
    if ([...next].length > TEXT_EDIT_LIMITS.segment) return { ok: false, error: 'too-long', index: segment.index };
    replacements.push({ start: segment.start, end: segment.end, raw: segment.rawLead + escapeText(next) + segment.rawTrail });
    if (next) changed.push(next);
  }
  if (replacements.length === 0) return { ok: false, error: 'unchanged' };
  let out = '';
  let cursor = 0;
  for (const r of replacements) {
    out += html.slice(cursor, r.start) + r.raw;
    cursor = r.end;
  }
  out += html.slice(cursor);
  if (markupSignature(out) !== markupSignature(html)) return { ok: false, error: 'unsafe' };
  return { ok: true, html: out, changed };
}
