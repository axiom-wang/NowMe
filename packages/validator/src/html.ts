/**
 * HTML 扫描（parse5：与浏览器一致的 HTML 标准解析，属性里的字符实体已解码、`<template>` 内容、
 * SVG / MathML 外来内容都按浏览器的方式处理；注释不会被当成元素）。
 *
 * 扫描收集：脚本（交给 js.ts）、样式（交给 css.ts）、资源引用、禁止的元素、外链、data-nm-id、
 * 静态文本中的中文字符；并检查 doctype / charset / viewport / lang。
 */
import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { KIT_CSS_PATH } from '@nowme/contracts';
import type { PageAnalysis } from './analysis.js';
import type { CssSource } from './css.js';
import type { ScriptSource } from './js.js';
import { HINTS, forbiddenElementHint } from './messages.js';
import { DYNAMIC_IDENTIFIER, DYNAMIC_PLACEHOLDER, classifyDynamicRef, classifyRef, isHttpsUrl, parseSrcset } from './refs.js';
import { addCjkChars, clip } from './text.js';

type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Template = DefaultTreeAdapterTypes.Template;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** contracts 2.2 FORBIDDEN_ELEMENT（另加已废弃的 applet / frameset 与新的 fencedframe）。 */
const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  'form',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'portal',
  'fencedframe',
]);

/** 资源属性（contracts 2.2 EXTERNAL_RESOURCE，另加浏览器同样会请求的 lowsrc / dynsrc / codebase / archive / manifest / icon）。 */
const RESOURCE_ATTRS: ReadonlySet<string> = new Set([
  'src',
  'href',
  'xlink:href',
  'poster',
  'background',
  'data',
  'action',
  'formaction',
  'lowsrc',
  'dynsrc',
  'codebase',
  'archive',
  'manifest',
  'icon',
]);

/** SVG 表现属性里可以写 url(...)。 */
const SVG_URL_ATTRS: ReadonlySet<string> = new Set([
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'marker-start',
  'marker-mid',
  'marker-end',
  'cursor',
]);

/** 会以页面字体显示的属性文字。 */
const STATIC_TEXT_ATTRS: ReadonlySet<string> = new Set(['alt', 'placeholder', 'value', 'label']);
/** 这些元素里的文字不是页面上显示的静态文本。 */
const NON_RENDERED_TEXT_PARENTS: ReadonlySet<string> = new Set(['script', 'style', 'title', 'noscript', 'template']);

/** HTML 标准的 JavaScript MIME 类型（essence match）。 */
const JS_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

export type ScriptKind = 'classic' | 'module' | 'data' | 'forbidden';

/** HTML 标准 “prepare the script element” 的类型判断。 */
export function scriptKindOf(type: string | undefined, language: string | undefined): ScriptKind {
  let value = type;
  if (value === undefined) {
    if (language === undefined || language === '') return 'classic';
    value = `text/${language}`;
  }
  const essence = (value.split(';')[0] ?? '').trim().toLowerCase();
  if (essence === '' || JS_MIME_TYPES.has(essence)) return 'classic';
  if (essence === 'module') return 'module';
  if (essence === 'importmap' || essence === 'speculationrules') return 'forbidden';
  return 'data';
}

export interface HtmlScanResult {
  scripts: ScriptSource[];
  styles: CssSource[];
  doctype: boolean;
  charset: { value: string; line: number | undefined } | null;
  viewport: { content: string; line: number | undefined } | null;
  lang: string | null;
}

/**
 * - `document`：主文档；
 * - `template`：`<template>` 内容（克隆后会执行脚本、加载资源；但不算页面区块）；
 * - `inert`：`<noscript>` 的内容（启用脚本时浏览器不解析，这里仍检查资源与元素，宁可多报）；
 * - `sink`：脚本写入 innerHTML 等注入点的静态 HTML。
 */
type Mode = 'document' | 'template' | 'inert' | 'sink';

interface WalkContext {
  mode: Mode;
  /** 本片段第 1 行在 index.html 中的行号。 */
  lineBase: number | undefined;
  /** 附加在 message 后的位置说明。 */
  suffix: string;
}

interface Attr {
  name: string;
  value: string;
  line: number | undefined;
}

export class HtmlScanner {
  private result: HtmlScanResult = { scripts: [], styles: [], doctype: false, charset: null, viewport: null, lang: null };

  constructor(private readonly a: PageAnalysis) {}

  scanDocument(html: string): HtmlScanResult {
    const document = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: true });
    const doctype = document.childNodes.find((node) => node.nodeName === '#documentType');
    this.result.doctype =
      doctype !== undefined && 'name' in doctype && doctype.name.toLowerCase() === 'html' && document.mode === 'no-quirks';
    this.walk(document.childNodes, { mode: 'document', lineBase: 1, suffix: '' });
    return this.result;
  }

  /** 检查注入点里的 HTML，返回其中新发现的脚本与样式。 */
  scanSink(html: string, line: number | undefined, where: string): { scripts: ScriptSource[]; styles: CssSource[] } {
    const saved = this.result;
    this.result = { scripts: [], styles: [], doctype: false, charset: null, viewport: null, lang: null };
    try {
      const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
      this.walk(fragment.childNodes, { mode: 'sink', lineBase: line, suffix: `（${where}）` });
      return { scripts: this.result.scripts, styles: this.result.styles };
    } finally {
      this.result = saved;
    }
  }

  private line(local: number | undefined, ctx: WalkContext): number | undefined {
    if (ctx.lineBase === undefined) return undefined;
    if (ctx.mode === 'sink') return ctx.lineBase;
    return local === undefined ? undefined : ctx.lineBase + local - 1;
  }

  /** 迭代遍历（不递归，深层嵌套的 HTML 不会爆栈）。 */
  private walk(roots: readonly ChildNode[], rootCtx: WalkContext): void {
    const stack: { node: ChildNode; ctx: WalkContext }[] = [];
    const pushChildren = (nodes: readonly ChildNode[], ctx: WalkContext) => {
      for (let i = nodes.length - 1; i >= 0; i -= 1) stack.push({ node: nodes[i] as ChildNode, ctx });
    };
    pushChildren(roots, rootCtx);
    while (stack.length > 0) {
      const { node, ctx } = stack.pop() as { node: ChildNode; ctx: WalkContext };
      if (node.nodeName === '#text') {
        if ((ctx.mode === 'document' || ctx.mode === 'template') && 'value' in node) {
          const parent = node.parentNode;
          const parentTag = parent && 'tagName' in parent ? parent.tagName.toLowerCase() : '';
          if (!NON_RENDERED_TEXT_PARENTS.has(parentTag)) addCjkChars(node.value, this.a.staticChars);
        }
        continue;
      }
      if (!('tagName' in node)) continue;
      const children = this.element(node, ctx);
      if (children) pushChildren(children.nodes, children.ctx);
      if (node.tagName === 'template' && 'content' in node) {
        const content = (node as Template).content;
        const mode: Mode = ctx.mode === 'document' ? 'template' : ctx.mode;
        pushChildren(content.childNodes, { ...ctx, mode });
      }
    }
  }

  private issue(code: Parameters<PageAnalysis['issues']['add']>[0], line: number | undefined, message: string, hint: string, ctx: WalkContext): void {
    this.a.issues.add(code, this.a.file, line, `${message}${ctx.suffix}`, hint);
  }

  /** 处理一个元素，返回需要继续遍历的子节点。 */
  private element(el: Element, ctx: WalkContext): { nodes: ChildNode[]; ctx: WalkContext } | null {
    const tag = el.tagName.toLowerCase();
    const loc = el.sourceCodeLocation ?? undefined;
    const line = this.line(loc?.startLine, ctx);
    const attrs: Attr[] = el.attrs.map((attr) => {
      const name = (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
      const attrLoc = loc?.attrs?.[name] ?? loc?.attrs?.[attr.name];
      return { name, value: attr.value, line: attrLoc ? this.line(attrLoc.startLine, ctx) : line };
    });
    const get = (name: string) => attrs.find((attr) => attr.name === name);
    const isSvg = el.namespaceURI === SVG_NS;

    if (FORBIDDEN_TAGS.has(tag)) {
      this.issue('FORBIDDEN_ELEMENT', line, `不允许使用 <${tag}>`, forbiddenElementHint(tag), ctx);
    }

    switch (tag) {
      case 'html':
        if (ctx.mode === 'document' && this.result.lang === null) this.result.lang = get('lang')?.value.trim() ?? '';
        break;
      case 'meta':
        this.meta(get, line, ctx);
        break;
      case 'link':
        this.link(get, line, ctx);
        break;
      default:
        break;
    }

    this.attributes(tag, attrs, ctx);

    if (tag === 'script') {
      this.script(el, get, isSvg, line, ctx);
      return this.elementChildren(el, ctx);
    }
    if (tag === 'style') {
      const { text, textLine } = this.directText(el, ctx);
      const media = get('media')?.value ?? '';
      if (media.toLowerCase().includes('prefers-reduced-motion')) this.a.cssReducedMotionQuery = true;
      if (text.trim() !== '') this.result.styles.push({ css: text, line: textLine ?? line, kind: 'sheet', where: `<style>${ctx.suffix}` });
      return this.elementChildren(el, ctx);
    }
    if (tag === 'noscript' && el.childNodes.length === 1 && el.childNodes[0]?.nodeName === '#text') {
      // 启用脚本时 noscript 的内容是原始文本；按禁用脚本的方式再解析一次，检查其中的资源与元素
      const textNode = el.childNodes[0];
      const textLine = textNode && 'sourceCodeLocation' in textNode ? textNode.sourceCodeLocation?.startLine : undefined;
      const fragment = parseFragment('value' in textNode ? textNode.value : '', { sourceCodeLocationInfo: true, scriptingEnabled: false });
      return { nodes: fragment.childNodes, ctx: { mode: 'inert', lineBase: this.line(textLine, ctx), suffix: ctx.suffix } };
    }
    return { nodes: el.childNodes, ctx };
  }

  /** script / style 只继续遍历元素子节点（SVG 外来内容里可能出现），文字作为代码处理。 */
  private elementChildren(el: Element, ctx: WalkContext): { nodes: ChildNode[]; ctx: WalkContext } | null {
    const nodes = el.childNodes.filter((child) => 'tagName' in child);
    return nodes.length > 0 ? { nodes, ctx } : null;
  }

  /** 元素的直接文本子节点（HTML 标准 “child text content”）。 */
  private directText(el: Element, ctx: WalkContext): { text: string; textLine: number | undefined } {
    let text = '';
    let textLine: number | undefined;
    for (const child of el.childNodes) {
      if (child.nodeName !== '#text' || !('value' in child)) continue;
      if (textLine === undefined && 'sourceCodeLocation' in child) textLine = this.line(child.sourceCodeLocation?.startLine, ctx);
      text += child.value;
    }
    return { text, textLine };
  }

  private meta(get: (name: string) => Attr | undefined, line: number | undefined, ctx: WalkContext): void {
    const httpEquiv = get('http-equiv')?.value.trim().toLowerCase();
    if (httpEquiv === 'refresh') {
      this.issue('FORBIDDEN_ELEMENT', line, '不允许使用 <meta http-equiv="refresh">（自动跳转 / 刷新）', forbiddenElementHint('meta'), ctx);
    }
    if (ctx.mode !== 'document') return;
    const charset = get('charset');
    if (charset && this.result.charset === null) this.result.charset = { value: charset.value.trim(), line };
    if (httpEquiv === 'content-type' && this.result.charset === null) {
      const match = /charset\s*=\s*["']?([^"';\s]+)/i.exec(get('content')?.value ?? '');
      this.result.charset = { value: match?.[1] ?? '', line };
    }
    if (get('name')?.value.trim().toLowerCase() === 'viewport' && this.result.viewport === null) {
      this.result.viewport = { content: get('content')?.value ?? '', line };
    }
  }

  private link(get: (name: string) => Attr | undefined, line: number | undefined, ctx: WalkContext): void {
    const rel = (get('rel')?.value ?? '')
      .toLowerCase()
      .split(/[\t\n\f\r ]+/)
      .filter((token) => token !== '');
    const href = get('href')?.value;
    const info = href === undefined ? null : classifyRef(href);
    if (rel.length === 1 && rel[0] === 'stylesheet' && info?.kind === 'kit') {
      if (info.kitPath === KIT_CSS_PATH && ctx.mode === 'document') this.a.kitCssIncluded = true;
      return;
    }
    const message =
      rel.includes('stylesheet') && href !== undefined
        ? `<link rel="stylesheet" href="${clip(href)}"> 不是 Kit 样式：<link> 只能引入 Kit 的样式表`
        : `不允许使用 <link rel="${clip(rel.join(' '), 40)}">：<link> 只能引入 Kit 的样式表`;
    this.issue('FORBIDDEN_ELEMENT', line, message, forbiddenElementHint('link'), ctx);
  }

  private script(
    el: Element,
    get: (name: string) => Attr | undefined,
    isSvg: boolean,
    line: number | undefined,
    ctx: WalkContext,
  ): void {
    const src = isSvg ? (get('href') ?? get('xlink:href') ?? get('src')) : get('src');
    if (src !== undefined) {
      if (classifyRef(src.value).kind !== 'kit') {
        this.issue(
          'FORBIDDEN_ELEMENT',
          src.line,
          `<script src="${clip(src.value)}"> 不允许：外部脚本只能是 Kit（/_nowme/kit/v1/ 下的文件）`,
          forbiddenElementHint('script'),
          ctx,
        );
      }
      return; // 有 src 时浏览器忽略内联内容
    }
    const typeAttr = get('type')?.value;
    const kind = scriptKindOf(typeAttr, get('language')?.value);
    const { text, textLine } = this.directText(el, ctx);
    if (kind === 'forbidden') {
      this.issue('FORBIDDEN_ELEMENT', line, `不允许使用 <script type="${clip(typeAttr ?? '', 30)}">`, forbiddenElementHint('importmap'), ctx);
      return;
    }
    if (kind === 'data') {
      // JSON 等数据块：不按 JS 检查，但其中的文字可能由脚本渲染
      addCjkChars(text, this.a.scriptChars);
      this.a.noteLooseAssetText(text);
      return;
    }
    if (ctx.mode === 'inert' || text.trim() === '') return;
    this.result.scripts.push({
      code: text,
      line: textLine ?? line,
      kind,
      where: `${kind === 'module' ? '<script type="module">' : '<script>'}${ctx.suffix}`,
    });
  }

  private attributes(tag: string, attrs: readonly Attr[], ctx: WalkContext): void {
    const a = this.a;
    const rendered = ctx.mode === 'document' || ctx.mode === 'template';
    for (const attr of attrs) {
      const { name, value, line } = attr;
      const dynamic = value.includes(DYNAMIC_PLACEHOLDER);
      if (/^on[a-z]+$/.test(name)) {
        if (ctx.mode !== 'inert' && value.trim() !== '') {
          this.result.scripts.push({
            code: dynamic ? value.replaceAll(DYNAMIC_PLACEHOLDER, DYNAMIC_IDENTIFIER) : value,
            line,
            kind: 'handler',
            where: `${name} 事件属性${ctx.suffix}`,
            approximate: ctx.mode === 'sink',
          });
        }
        continue;
      }
      if (name === 'style') {
        if (value.trim() !== '') this.result.styles.push({ css: value, line, kind: 'inline', where: `style 属性${ctx.suffix}` });
        continue;
      }
      if (name === 'data-nm-id') {
        if (ctx.mode === 'document') a.nmIds.push({ value, line });
        continue;
      }
      if (name === 'data-nm-href') {
        if (dynamic) {
          const prefix = value.split(DYNAMIC_PLACEHOLDER)[0]?.trim() ?? '';
          const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(prefix)?.[1]?.toLowerCase();
          if ((scheme !== undefined && scheme !== 'https') || prefix.startsWith('/')) {
            this.issue('INSECURE_OPEN_LINK', line, `data-nm-href="${clip(prefix)}…" 不是 https: 地址`, HINTS.insecureLink, ctx);
          }
          continue;
        }
        if (!isHttpsUrl(value)) {
          this.issue('INSECURE_OPEN_LINK', line, `data-nm-href="${clip(value)}" 不是 https: 地址`, HINTS.insecureLink, ctx);
        }
        continue;
      }
      if ((name === 'href' || name === 'xlink:href') && (tag === 'a' || tag === 'area')) {
        a.noteLooseAssetText(value.split(DYNAMIC_PLACEHOLDER)[0] ?? '');
        const info = dynamic ? classifyDynamicRef(value) : classifyRef(value);
        if (info !== null && info.kind !== 'fragment') {
          this.issue('FORBIDDEN_LINK_HREF', line, `<${tag} href="${clip(info.value)}"> 不是页内锚点（#...）`, HINTS.linkHref, ctx);
        }
        continue;
      }
      if (name === 'srcset' || name === 'imagesrcset') {
        for (const url of parseSrcset(value)) a.refs.push({ raw: url, line, where: `<${tag} ${name}>${ctx.suffix}`, source: 'attr' });
        continue;
      }
      if (name === 'ping') {
        for (const url of value.split(/[\t\n\f\r ]+/)) {
          if (url !== '') a.refs.push({ raw: url, line, where: `<${tag} ping>${ctx.suffix}`, source: 'attr' });
        }
        continue;
      }
      if (RESOURCE_ATTRS.has(name)) {
        a.refs.push({ raw: value, line, where: `<${tag} ${name}>${ctx.suffix}`, source: 'attr' });
        continue;
      }
      if ((tag === 'animate' || tag === 'set') && ['to', 'from', 'by', 'values'].includes(name)) {
        const target = attrs.find((other) => other.name === 'attributename')?.value.trim().toLowerCase();
        if (target === 'href' || target === 'xlink:href' || target === 'src') {
          for (const part of value.split(';')) {
            if (part.trim() !== '') a.refs.push({ raw: part, line, where: `<${tag} ${name}>${ctx.suffix}`, source: 'attr' });
          }
          continue;
        }
      }
      if (SVG_URL_ATTRS.has(name) && /url\s*\(/i.test(value)) {
        this.result.styles.push({ css: `${name}:${value}`, line, kind: 'inline', where: `${name} 属性${ctx.suffix}` });
      } else if (name === 'font-family') {
        this.result.styles.push({ css: `font-family:${value}`, line, kind: 'inline', where: `font-family 属性${ctx.suffix}` });
      }
      if (value.includes('assets/')) a.noteLooseAssetText(value);
      if (rendered && STATIC_TEXT_ATTRS.has(name)) addCjkChars(value, a.staticChars);
    }
  }
}
