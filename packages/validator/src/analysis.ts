/**
 * index.html 分析过程中收集的事实。HTML、CSS、JS 三个分析器都往这里写，
 * 最后由 validate.ts 做跨文件检查（资源是否存在、字体是否声明、额外字符等）。
 */
import { PAGE_INDEX_FILE } from '@nowme/contracts';
import { KitFontIndex } from './fonts.js';
import { DYNAMIC_PLACEHOLDER } from './refs.js';
import { IssueCollector } from './report.js';

/** 一处资源引用（HTML 属性、srcset、CSS url() / @import、模块 import）。 */
export interface RefUse {
  raw: string;
  line: number | undefined;
  /** 展示用的位置描述，例如 `<img src>`、`CSS url()`。 */
  where: string;
  source: 'attr' | 'css' | 'css-import' | 'js-import';
}

export interface MotionUse {
  line: number | undefined;
  what: string;
}

export class PageAnalysis {
  readonly file = PAGE_INDEX_FILE;
  readonly refs: RefUse[] = [];
  /** 脚本字符串与其他非资源属性中出现的 assets/ 路径（只用于判断“是否被引用”）。 */
  readonly looseAssetExact = new Set<string>();
  readonly looseAssetPrefixes = new Set<string>();

  kitCssIncluded = false;
  cssMotion: MotionUse | null = null;
  cssReducedMotionQuery = false;
  scriptMotion: MotionUse | null = null;
  scriptReducedMotionCheck = false;
  canvasLine: number | undefined | null = null;
  intervalLine: number | undefined | null = null;

  /** 用到的 Kit 字体 id → 首次出现的行。 */
  readonly fontsUsed = new Map<string, number | undefined>();

  readonly staticChars = new Set<string>();
  readonly scriptChars = new Set<string>();

  readonly nmIds: { value: string; line: number | undefined }[] = [];
  /** 已报过 FONT_NOT_IN_KIT 的 family（小写），同一个名字只报一次。 */
  readonly unknownFamilies = new Set<string>();

  constructor(
    readonly issues: IssueCollector,
    readonly kit: KitFontIndex,
  ) {}

  useFont(id: string, line: number | undefined): void {
    if (!this.fontsUsed.has(id)) this.fontsUsed.set(id, line);
  }

  noteCssMotion(line: number | undefined, what: string): void {
    if (this.cssMotion === null) this.cssMotion = { line, what };
  }

  noteScriptMotion(line: number | undefined, what: string): void {
    if (this.scriptMotion === null) this.scriptMotion = { line, what };
  }

  /** 在任意文本里登记 assets/ 路径（精确或前缀）。 */
  noteLooseAssetText(text: string): void {
    if (!text.includes('assets/')) return;
    const pattern = /(?:\.\/)?(assets\/[A-Za-z0-9._\-/%]*)/g;
    for (const match of text.matchAll(pattern)) {
      const path = match[1];
      if (path === undefined) continue;
      const end = (match.index ?? 0) + match[0].length;
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        // 保留原样
      }
      this.looseAssetExact.add(decoded);
      // 字符串在 assets/ 路径处结束：可能是拼接的前缀（`'assets/photo-' + i + '.jpg'`）
      if (end === text.length || text[end] === DYNAMIC_PLACEHOLDER) this.looseAssetPrefixes.add(decoded);
    }
  }
}
