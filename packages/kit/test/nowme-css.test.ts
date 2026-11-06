import { describe, expect, it } from 'vitest';
import {
  fontCssVariable,
  KIT_COMPONENTS,
  KIT_CSS_VARIABLES,
  KIT_FONT_ROLE_VARIABLES,
  KIT_SYSTEM_FONT_VARIABLES,
  KIT_THEMES,
  loadKitFonts,
} from '../src/index.js';
import { KIT_CSS_SOURCE } from './helpers/kit-window.js';

const css = KIT_CSS_SOURCE;
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const fonts = loadKitFonts();

/** 取出从 start 开始的 `{ ... }` 块（含嵌套）。 */
function blockAt(source: string, start: number): string {
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error('括号不匹配');
}

/** 顶层的 url(...) 参数（引号内的内联 SVG 里的 url(#id) 不算）。 */
function cssUrls(source: string): string[] {
  const quoted = [...source.matchAll(/url\(\s*"([^"]*)"\s*\)/g)].map((match) => match[1] ?? '');
  const rest = source.replace(/url\(\s*"[^"]*"\s*\)/g, '');
  const unquoted = [...rest.matchAll(/url\(([^)]*)\)/g)].map((match) => (match[1] ?? '').trim());
  return [...quoted, ...unquoted];
}

/** :root 中声明的变量 → 值。 */
function rootVariables(): Map<string, string> {
  const rootStart = withoutComments.indexOf(':root');
  const body = blockAt(withoutComments, rootStart);
  const variables = new Map<string, string>();
  for (const match of body.matchAll(/(--nm-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    variables.set(match[1] as string, (match[2] as string).trim());
  }
  return variables;
}

describe('nowme.css：减少动效（contracts 1.1）', () => {
  it('含全局规则：prefers-reduced-motion: reduce 时关闭所有元素与伪元素的 animation 与 transition', () => {
    const start = withoutComments.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    expect(start).toBeGreaterThan(-1);
    const block = blockAt(withoutComments, start);
    const universal = block.match(/\*\s*,\s*\*::before\s*,\s*\*::after\s*\{([^}]*)\}/);
    expect(universal).not.toBeNull();
    const declarations = universal?.[1] ?? '';
    expect(declarations).toMatch(/animation\s*:\s*none\s*!important/);
    expect(declarations).toMatch(/transition\s*:\s*none\s*!important/);
  });

  it('减少动效时 .nm-reveal 的内容直接可见', () => {
    const start = withoutComments.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    const block = blockAt(withoutComments, start);
    expect(block).toMatch(/\.nm-reveal\s*\{[^}]*opacity\s*:\s*1\s*!important/);
  });

  it('每个 animation 用到的 nm- 关键帧都有定义', () => {
    const defined = new Set([...withoutComments.matchAll(/@keyframes\s+([a-z0-9-]+)/g)].map((match) => match[1]));
    const used = new Set<string>();
    for (const match of withoutComments.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
      for (const token of (match[1] as string).split(/[\s,]+/)) if (token.startsWith('nm-')) used.add(token);
    }
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });
});

describe('nowme.css：字体（contracts 1.1）', () => {
  it('不写 @font-face，也不内联字体', () => {
    expect(css).not.toMatch(/@font-face/i);
    expect(css).not.toMatch(/data:\s*(font|application\/(x-)?font)/i);
    expect(css).not.toMatch(/\.(woff2?|ttf|otf)\b/i);
  });

  it('清单中每款字体都有 --nm-font-<id>，值以该字体的 family 名开头，后面是系统回退', () => {
    const variables = rootVariables();
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      const value = variables.get(fontCssVariable(font.id));
      expect(value, font.id).toBeDefined();
      expect(value?.startsWith(`"${font.family}",`), `${font.id}: ${value}`).toBe(true);
      expect(value).toMatch(/(serif|sans-serif|monospace)$/);
    }
  });

  it('没有多余的 --nm-font-<id>（每个都对应清单里的字体、系统字体栈或角色变量）', () => {
    const allowed = new Set<string>([
      ...fonts.map((font) => fontCssVariable(font.id)),
      ...KIT_SYSTEM_FONT_VARIABLES,
      ...KIT_FONT_ROLE_VARIABLES,
    ]);
    for (const name of rootVariables().keys()) {
      if (name.startsWith('--nm-font-')) expect(allowed.has(name), name).toBe(true);
    }
  });

  it('--nm-font-sans / serif / mono 只指向系统字体栈，不引用清单字体', () => {
    const variables = rootVariables();
    for (const name of KIT_SYSTEM_FONT_VARIABLES) {
      const value = variables.get(name) ?? '';
      expect(value.length, name).toBeGreaterThan(0);
      expect(value).not.toMatch(/var\(/);
      for (const font of fonts) expect(value.includes(font.family), `${name} 引用了 ${font.family}`).toBe(false);
    }
  });

  it('角色变量默认指向系统字体栈', () => {
    const variables = rootVariables();
    for (const name of KIT_FONT_ROLE_VARIABLES) {
      expect(variables.get(name), name).toMatch(/^var\(--nm-font-(sans|serif|mono|body)\)$/);
    }
  });

  it(':root 之外的规则不使用清单字体（组件只用角色变量，校验器才能准确统计页面用了哪些字体）', () => {
    const rootStart = withoutComments.indexOf(':root');
    const rootBody = blockAt(withoutComments, rootStart);
    const rest = withoutComments.replace(rootBody, '');
    for (const font of fonts) {
      expect(rest.includes(fontCssVariable(font.id)), font.id).toBe(false);
      expect(rest.includes(`"${font.family}"`), font.family).toBe(false);
    }
  });
});

describe('nowme.css：变量、主题与组件', () => {
  it('声明了清单中的全部设计变量', () => {
    const variables = rootVariables();
    for (const group of Object.values(KIT_CSS_VARIABLES)) {
      for (const name of group) expect(variables.has(name), name).toBe(true);
    }
  });

  it('每个主题类都存在，并设置全部颜色变量', () => {
    expect(KIT_THEMES.length).toBeGreaterThanOrEqual(6);
    for (const theme of KIT_THEMES) {
      const start = withoutComments.indexOf(`.${theme.className} {`);
      expect(start, theme.className).toBeGreaterThan(-1);
      const body = blockAt(withoutComments, start);
      for (const name of KIT_CSS_VARIABLES.color) expect(body.includes(`${name}:`), `${theme.className} ${name}`).toBe(true);
    }
  });

  it('清单中的组件类与子类都在 nowme.css 中', () => {
    const classes = new Set([...withoutComments.matchAll(/\.(nm-[a-z0-9_-]+)/g)].map((match) => match[1]));
    for (const component of KIT_COMPONENTS) {
      if (component.className !== null) expect(classes.has(component.className), component.className).toBe(true);
      for (const part of component.parts ?? []) {
        expect(classes.has(part), `${component.id}: ${part}`).toBe(true);
      }
    }
  });

  it('至少 10 个现成组件（不含版式与文字类）', () => {
    const components = KIT_COMPONENTS.filter((item) => item.kind !== 'layout' && item.kind !== 'type');
    expect(components.length).toBeGreaterThanOrEqual(10);
  });

  it('不引用外部资源：没有 @import，url() 只有 data: 内联图', () => {
    expect(withoutComments).not.toMatch(/@import/i);
    for (const url of cssUrls(withoutComments)) {
      expect(url.startsWith('data:image/svg+xml,'), url).toBe(true);
    }
    const stripped = withoutComments.replace(/url\("data:image\/svg\+xml[^"]*"\)/g, 'url()');
    expect(stripped).not.toMatch(/https?:|\/\/|expression\(|javascript:/i);
  });

  it('generated content 不含中文（CSS 里的字不会进字体子集）', () => {
    for (const match of withoutComments.matchAll(/content\s*:\s*([^;]+);/g)) {
      expect(match[1], match[1]).not.toMatch(/[　-〿㐀-鿿＀-￯]/);
    }
  });
});
