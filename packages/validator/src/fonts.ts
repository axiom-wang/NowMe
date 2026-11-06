/**
 * 字体：Kit 字体清单索引、family 名归类（Kit / 通用族名 / 常见系统字体 / 未知）。
 */
import type { KitFont } from '@nowme/contracts';

/** Kit 字体变量前缀：`--nm-font-<fontId>`（contracts 1.1）。 */
export const KIT_FONT_VAR_PREFIX = '--nm-font-';
/**
 * Kit 的语义变量（`--nm-font-sans/serif/mono`）与角色变量（`--nm-font-body/display/code/hand`）：
 * 默认只指向系统字体栈，不引用清单字体，校验器把它们视为已知（不报 FONT_NOT_IN_KIT）。
 * 页面把角色变量改成清单字体时（`--nm-font-display: var(--nm-font-lxgw-wenkai)` 或写 family 名），
 * 赋值里的清单字体照常计入 fontsUsed（contracts 1.1）。与 @nowme/kit 的
 * KIT_SYSTEM_FONT_VARIABLES / KIT_FONT_ROLE_VARIABLES 一致（校验器不依赖 kit 包，这里单独列出）。
 */
export const KIT_SEMANTIC_FONT_VARS: ReadonlySet<string> = new Set(['sans', 'serif', 'mono', 'body', 'display', 'code', 'hand']);

/** CSS 通用族名与全局关键字。 */
const GENERIC_FAMILIES = [
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'kai',
  'khmer-mul',
  'nastaliq',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
];

/** 常见系统字体（不在 Kit 清单里也不报 FONT_NOT_IN_KIT）。比较时不区分大小写。 */
const SYSTEM_FAMILIES = [
  // 中文
  'PingFang SC',
  'PingFang TC',
  'PingFang HK',
  'Hiragino Sans GB',
  'Hiragino Sans',
  'Hiragino Kaku Gothic ProN',
  'Hiragino Mincho ProN',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'Microsoft JhengHei',
  'Noto Sans CJK SC',
  'Noto Sans CJK TC',
  'Noto Sans CJK JP',
  'Noto Serif CJK SC',
  'Noto Serif CJK TC',
  'Noto Sans SC',
  'Noto Serif SC',
  'Source Han Sans SC',
  'Source Han Sans CN',
  'Source Han Serif SC',
  'Source Han Serif CN',
  'Songti SC',
  'Songti TC',
  'STSong',
  'STHeiti',
  'STKaiti',
  'STFangsong',
  'STXihei',
  'Heiti SC',
  'Heiti TC',
  'Kaiti SC',
  'SimSun',
  'NSimSun',
  'SimHei',
  'KaiTi',
  'FangSong',
  'WenQuanYi Micro Hei',
  'WenQuanYi Zen Hei',
  'HarmonyOS Sans SC',
  'MiSans',
  // 西文与系统界面
  '-apple-system',
  'BlinkMacSystemFont',
  'SF Pro',
  'SF Pro Text',
  'SF Pro Display',
  'SF Mono',
  'SF Compact',
  'New York',
  'Segoe UI',
  'Segoe UI Variable',
  'Roboto',
  'Ubuntu',
  'Cantarell',
  'Oxygen',
  'Fira Sans',
  'Droid Sans',
  'Helvetica Neue',
  'Helvetica',
  'Arial',
  'Arial Black',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Lucida Grande',
  'Lucida Sans Unicode',
  'Georgia',
  'Times New Roman',
  'Times',
  'Palatino',
  'Palatino Linotype',
  'Book Antiqua',
  'Baskerville',
  'Didot',
  'Optima',
  'Futura',
  'Gill Sans',
  'Avenir',
  'Avenir Next',
  'Menlo',
  'Monaco',
  'Consolas',
  'Courier New',
  'Courier',
  'Lucida Console',
  'Liberation Mono',
  'DejaVu Sans Mono',
  'DejaVu Sans',
  'Noto Sans',
  'Noto Serif',
  'Noto Sans Mono',
  // 表情
  'Apple Color Emoji',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Noto Color Emoji',
];

export function normalizeFamily(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const GENERIC_SET: ReadonlySet<string> = new Set(GENERIC_FAMILIES);
const SYSTEM_SET: ReadonlySet<string> = new Set(SYSTEM_FAMILIES.map(normalizeFamily));

export type FamilyClass = { kind: 'kit'; font: KitFont } | { kind: 'generic' } | { kind: 'system' } | { kind: 'unknown' };

export class KitFontIndex {
  readonly byId = new Map<string, KitFont>();
  readonly byFamily = new Map<string, KitFont>();
  /** 小写 family 名列表（在脚本字符串里查找用）。 */
  readonly families: { lower: string; font: KitFont }[] = [];

  constructor(fonts: readonly KitFont[]) {
    for (const font of fonts) {
      this.byId.set(font.id, font);
      const lower = normalizeFamily(font.family);
      this.byFamily.set(lower, font);
      this.families.push({ lower, font });
    }
  }

  classify(family: string): FamilyClass {
    const key = normalizeFamily(family);
    const font = this.byFamily.get(key);
    if (font) return { kind: 'kit', font };
    if (GENERIC_SET.has(key)) return { kind: 'generic' };
    if (SYSTEM_SET.has(key)) return { kind: 'system' };
    return { kind: 'unknown' };
  }

  /** 在任意文本中查找出现的 Kit family 名（不区分大小写，按词边界）。 */
  findFamiliesIn(text: string): KitFont[] {
    if (this.families.length === 0) return [];
    const lower = text.toLowerCase();
    const found: KitFont[] = [];
    for (const { lower: family, font } of this.families) {
      let index = lower.indexOf(family);
      while (index >= 0) {
        const before = lower[index - 1];
        const after = lower[index + family.length];
        if (!isWordChar(before) && !isWordChar(after)) {
          found.push(font);
          break;
        }
        index = lower.indexOf(family, index + 1);
      }
    }
    return found;
  }
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9_-]/.test(ch);
}

/** 在文本中查找 `--nm-font-<id>`，返回 id（不含语义变量）。 */
export function findKitFontVars(text: string): string[] {
  const ids: string[] = [];
  const pattern = /--nm-font-([a-z][a-z0-9-]*)/g;
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined && !KIT_SEMANTIC_FONT_VARS.has(id)) ids.push(id);
  }
  return ids;
}
