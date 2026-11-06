/**
 * CSS 分析（`<style>`、`style` 属性、SVG 表现属性中的 url()）。
 *
 * 用 postcss（容错解析器 postcss-safe-parser，与浏览器一样不会因语法错误而放弃）得到结构，
 * 用 postcss-value-parser 解析属性值；标识符、at-rule 名与字符串按 CSS 规范解码转义
 * （`u\72l(...)`、`@\69mport` 与 `url(...)`、`@import` 等价）。
 */
import type { AtRule, ChildNode, Declaration } from 'postcss';
import safeParser from 'postcss-safe-parser';
import valueParser from 'postcss-value-parser';
import { KIT_CSS_PATH } from '@nowme/contracts';
import type { PageAnalysis } from './analysis.js';
import { KIT_FONT_VAR_PREFIX, KIT_SEMANTIC_FONT_VARS } from './fonts.js';
import { HINTS } from './messages.js';
import { DYNAMIC_PLACEHOLDER, classifyRef } from './refs.js';
import { addCjkChars, clip, cssUnescape } from './text.js';

type ValueNode = valueParser.Node;

export interface CssSource {
  css: string;
  /** CSS 第 1 行在 index.html 中的行号。 */
  line: number | undefined;
  kind: 'sheet' | 'inline';
  /** 展示用位置，例如 `<style>`、`style 属性`。 */
  where: string;
}

const URL_FUNCTIONS: ReadonlySet<string> = new Set(['url', 'src']);
/** 参数中的裸字符串也是 URL 的函数。 */
const IMAGE_FUNCTIONS: ReadonlySet<string> = new Set([
  'image-set',
  '-webkit-image-set',
  'image',
  'cross-fade',
  '-webkit-cross-fade',
]);
const MOTION_PROPERTIES: ReadonlySet<string> = new Set([
  'animation',
  'animation-name',
  'animation-duration',
  'transition',
  'transition-property',
  'transition-duration',
]);
const NO_MOTION_VALUES: ReadonlySet<string> = new Set([
  'none',
  'initial',
  'unset',
  'inherit',
  'revert',
  'revert-layer',
  '0',
  '0s',
  '0ms',
  'all 0s',
  'none 0s',
]);
const SYSTEM_FONT_KEYWORDS: ReadonlySet<string> = new Set([
  'caption',
  'icon',
  'menu',
  'message-box',
  'small-caption',
  'status-bar',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);
const FONT_SIZE_KEYWORDS: ReadonlySet<string> = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'smaller',
  'larger',
]);
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)$/i;

/** 内联 style 的快速预筛：不含这些片段的声明与资源、字体、动效无关。 */
const INLINE_RELEVANT = /[\\@]|url|image|src\s*\(|font|anim|transition|var\s*\(|fade/i;

export function analyzeCss(source: CssSource, a: PageAnalysis): void {
  if (source.kind === 'inline' && !INLINE_RELEVANT.test(source.css)) return;
  const root = safeParser(source.css);
  const lineOf = (node: { source?: { start?: { line: number } } }): number | undefined =>
    source.line === undefined ? undefined : source.line + (node.source?.start?.line ?? 1) - 1;

  root.walk((node: ChildNode) => {
    if (node.type === 'atrule') analyzeAtRule(node, lineOf(node), source, a);
    else if (node.type === 'decl') analyzeDeclaration(node, lineOf(node), source, a);
  });
}

function stripVendor(name: string): string {
  return name.replace(/^-(?:webkit|moz|ms|o)-/, '');
}

/** 标识符里可以续接的部分（含转义）。 */
const IDENT_CONTINUATION = /^(?:[A-Za-z0-9_-]|\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[^\n\r\f0-9a-fA-F])+/;

function analyzeAtRule(rule: AtRule, line: number | undefined, source: CssSource, a: PageAnalysis): void {
  // postcss 遇到转义会把 at-rule 名截断（`@\69mport "x"` → name 为空、params 为 `\69mport "x"`），这里接回去
  let rawName = rule.name;
  let rawParams = rule.params;
  if ((rule.raws.afterName ?? '') === '' && rawParams.startsWith('\\')) {
    const rest = IDENT_CONTINUATION.exec(rawParams)?.[0] ?? '';
    rawName += rest;
    rawParams = rawParams.slice(rest.length);
  }
  const name = stripVendor(cssUnescape(rawName).toLowerCase());
  const params = cssUnescape(rawParams);
  switch (name) {
    case 'font-face':
      a.issues.add(
        'FONT_FACE_FORBIDDEN',
        a.file,
        line,
        `${source.where} 中写了 @font-face：页面不能自带字体`,
        HINTS.fontFace,
      );
      return;
    case 'import': {
      const first = valueParser(rawParams).nodes.find((node) => node.type === 'string' || node.type === 'function');
      let target: string | null = null;
      if (first?.type === 'string') target = cssUnescape(first.value);
      else if (first?.type === 'function' && URL_FUNCTIONS.has(cssUnescape(first.value).toLowerCase())) target = urlContent(first);
      if (target === null) {
        // 无法识别的 @import：保守处理，当作外部引用
        a.refs.push({ raw: params.trim(), line, where: '@import', source: 'css-import' });
        return;
      }
      a.refs.push({ raw: target, line, where: '@import', source: 'css-import' });
      const info = classifyRef(target);
      if (info.kind === 'kit' && info.kitPath === KIT_CSS_PATH) a.kitCssIncluded = true;
      return;
    }
    case 'keyframes':
      a.noteCssMotion(line, `@keyframes ${clip(params.trim(), 30)}`);
      return;
    case 'media':
      if (params.toLowerCase().includes('prefers-reduced-motion')) a.cssReducedMotionQuery = true;
      return;
    default:
      return;
  }
}

function analyzeDeclaration(decl: Declaration, line: number | undefined, source: CssSource, a: PageAnalysis): void {
  const rawProp = cssUnescape(decl.prop);
  const isCustom = rawProp.startsWith('--');
  const prop = isCustom ? rawProp : stripVendor(rawProp.toLowerCase());
  const value = decl.value;
  const parsed = valueParser(value);
  const fontContext = prop === 'font-family' || prop === 'font';

  visitValue(parsed.nodes, { prop, line, source, a, fontContext });

  if (MOTION_PROPERTIES.has(prop)) {
    const normalized = cssUnescape(value).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!NO_MOTION_VALUES.has(normalized)) a.noteCssMotion(line, `${prop}: ${clip(normalized, 40)}`);
  }

  if (prop === 'font-family') {
    reportFamilies(familyList(parsed.nodes), line, a);
  } else if (prop === 'font') {
    const families = fontShorthandFamilies(parsed.nodes);
    if (families !== null) reportFamilies(families, line, a);
    else for (const font of a.kit.findFamiliesIn(cssUnescape(value))) a.useFont(font.id, line);
  } else if (isCustom) {
    // 自定义属性里可能先存了 family 名（`--title: "LXGW WenKai", serif`），只登记 Kit 字体
    for (const font of a.kit.findFamiliesIn(cssUnescape(value))) a.useFont(font.id, line);
  }
}

interface ValueContext {
  prop: string;
  line: number | undefined;
  source: CssSource;
  a: PageAnalysis;
  fontContext: boolean;
}

function visitValue(nodes: readonly ValueNode[], ctx: ValueContext): void {
  for (const node of nodes) {
    if (node.type === 'function') {
      const name = cssUnescape(node.value).toLowerCase();
      if (URL_FUNCTIONS.has(name)) {
        ctx.a.refs.push({ raw: urlContent(node), line: ctx.line, where: `${ctx.source.where} 的 url()`, source: 'css' });
        continue;
      }
      if (IMAGE_FUNCTIONS.has(name)) {
        for (const child of node.nodes) {
          if (child.type === 'string') {
            ctx.a.refs.push({ raw: cssUnescape(child.value), line: ctx.line, where: `${ctx.source.where} 的 ${name}()`, source: 'css' });
          }
        }
      }
      if (name === 'var') {
        const first = node.nodes.find((child) => child.type === 'word');
        if (first) handleVar(cssUnescape(first.value), ctx);
      }
      visitValue(node.nodes, ctx);
    } else if (node.type === 'string') {
      if (ctx.prop === 'content' || ctx.prop === 'quotes') addCjkChars(cssUnescape(node.value), ctx.a.staticChars);
    }
  }
}

function handleVar(name: string, ctx: ValueContext): void {
  if (!name.startsWith(KIT_FONT_VAR_PREFIX)) return;
  const id = name.slice(KIT_FONT_VAR_PREFIX.length);
  if (ctx.a.kit.byId.has(id)) {
    ctx.a.useFont(id, ctx.line);
  } else if (ctx.fontContext && !KIT_SEMANTIC_FONT_VARS.has(id)) {
    ctx.a.issues.add(
      'FONT_NOT_IN_KIT',
      ctx.a.file,
      ctx.line,
      `var(${clip(name, 50)}) 不是 Kit 字体变量（Kit 清单里没有字体 ${clip(id, 40)}），会回退到系统字体`,
      HINTS.fontNotInKit,
    );
  }
}

/** url() / src() 的内容：引号字符串取其内容，否则取原文（去掉首尾空白），并解码转义。 */
export function urlContent(node: valueParser.FunctionNode): string {
  const str = node.nodes.find((child) => child.type === 'string');
  if (str) return cssUnescape(str.value);
  return cssUnescape(valueParser.stringify(node.nodes).trim());
}

type Family = { name: string } | { variable: true };

/** `font-family` 值 → family 列表（逗号分隔；字符串或若干标识符；含 var() 的项跳过）。 */
export function familyList(nodes: readonly ValueNode[]): Family[] {
  const families: Family[] = [];
  let current: ValueNode[] = [];
  const flush = () => {
    const parts = current.filter((node) => node.type !== 'space' && node.type !== 'comment');
    current = [];
    if (parts.length === 0) return;
    if (parts.some((node) => node.type === 'function')) {
      families.push({ variable: true });
      return;
    }
    const strings = parts.filter((node) => node.type === 'string');
    if (strings.length === 1 && parts.length === 1) {
      families.push({ name: cssUnescape(strings[0]?.value ?? '') });
      return;
    }
    families.push({ name: parts.map((node) => cssUnescape(node.value)).join(' ') });
  };
  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') flush();
    else current.push(node);
  }
  flush();
  return families;
}

/**
 * `font` 简写中的 family 列表：`[style] [variant] [weight] [stretch] size[/line-height] family, ...`。
 * 无法确定（含 var()、找不到字号）时返回 null。
 */
export function fontShorthandFamilies(nodes: readonly ValueNode[]): Family[] | null {
  const commaIndex = nodes.findIndex((node) => node.type === 'div' && node.value === ',');
  const first = (commaIndex >= 0 ? nodes.slice(0, commaIndex) : nodes).filter(
    (node) => node.type !== 'space' && node.type !== 'comment',
  );
  if (first.length === 1 && first[0]?.type === 'word' && SYSTEM_FONT_KEYWORDS.has(first[0].value.toLowerCase())) return [];
  if (first.some((node) => node.type === 'function' && cssUnescape(node.value).toLowerCase() === 'var')) return null;
  let sizeIndex = -1;
  for (let i = 0; i < first.length; i += 1) {
    const node = first[i] as ValueNode;
    if (node.type === 'word' && (LENGTH.test(node.value) || FONT_SIZE_KEYWORDS.has(node.value.toLowerCase()))) {
      sizeIndex = i;
      break;
    }
    if (node.type === 'function') {
      sizeIndex = i;
      break;
    }
  }
  if (sizeIndex < 0) return null;
  let familyStart = sizeIndex + 1;
  if (first[familyStart]?.type === 'div' && first[familyStart]?.value === '/') familyStart += 2;
  const head = first.slice(familyStart);
  const rest = commaIndex >= 0 ? nodes.slice(commaIndex) : [];
  return familyList([...head, ...rest]);
}

function reportFamilies(families: readonly Family[], line: number | undefined, a: PageAnalysis): void {
  for (const family of families) {
    if ('variable' in family) continue;
    const name = family.name.trim();
    if (name === '' || name.includes(DYNAMIC_PLACEHOLDER)) continue;
    const cls = a.kit.classify(name);
    if (cls.kind === 'kit') {
      a.useFont(cls.font.id, line);
    } else if (cls.kind === 'unknown' && !a.unknownFamilies.has(name.toLowerCase())) {
      a.unknownFamilies.add(name.toLowerCase());
      a.issues.add(
        'FONT_NOT_IN_KIT',
        a.file,
        line,
        `字体 “${clip(name, 40)}” 不在 Kit 字体清单里，也不是通用族名或常见系统字体，会回退到系统字体`,
        HINTS.fontNotInKit,
      );
    }
  }
}
