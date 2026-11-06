/**
 * buildRevision：页面文件（内存）→ 校验报告 + `served/` + 封面 + 截图 + 渲染后文字（contracts 2、3、8）。
 *
 * 主站提交管线（T2.1，mode: 'submit'）与 `nowme preview`（mode: 'preview'）共用：
 *
 * 1. 静态校验 `validatePage(files, { kitFonts })`。`submit` 模式下有 error 直接返回（不渲染，服务端判 rejected）；
 *    `preview` 模式下照样渲染，帮主人和 Agent 看到问题，报告里保留错误。
 * 2. 字体子集化：取字范围 = index.html 源码全部字符 + `manifest.extraChars`（第一次渲染前）。
 * 3. 渲染（见 renderer.ts）：普通一次，按需再以减少动效渲染一次。
 * 4. 渲染后文字里如果有子集没覆盖、而源字体有的字（例如脚本算出来的字、text-transform、CSS 计数器），
 *    就把渲染后文字并入取字范围重新生成子集，并重新渲染一次，保证截图与提交后一致。
 * 5. 封面：页面自带合格的 cover.png 且没有要求重新生成时用它，否则用首屏截图，压缩到 ≤ 600 KB 并用校验器的 COVER 检查自检。
 * 6. 合并静态问题与 RENDER_* 问题为最终报告。
 */
import { COVER_MAX_BYTES, PAGE_COVER_FILE, type KitFont, type PageFiles, type ValidationIssue, type ValidationReport } from '@nowme/contracts';
import { createReport, validatePage } from '@nowme/validator';
import { directoryFontSource, type FontSourceReader, type MissingFontSource } from './fonts.js';
import { compressPng } from './png.js';
import { Renderer, type BlockScreenshot, type RenderPassResult, type RendererOptions } from './renderer.js';
import { buildServedFiles, type ServedBuild } from './served.js';
import { readCmapCodepoints, toSfnt } from './sfnt.js';

export type BuildMode = 'submit' | 'preview';

export interface BuildRevisionInput {
  /** page/ 内的文件（相对路径 → 内容），与 validatePage 的输入相同。 */
  files: PageFiles;
  /** Kit 字体清单（`loadKitFonts()`；服务端可用 AgentContext 中同一份）。 */
  kitFonts: KitFont[];
  /** 默认 `submit`：静态校验有 error 时不渲染。`preview`：照样渲染。 */
  mode?: BuildMode;
  /** 复用的渲染器；不给时临时创建一个并在结束时关闭。 */
  renderer?: Renderer;
  /** 临时创建渲染器时的参数。 */
  rendererOptions?: RendererOptions;
  /** 字体源文件：目录（默认 `packages/kit/fonts/`）或自定义读取函数。 */
  fontSource?: string | FontSourceReader;
  /**
   * 字体源文件缺失时：`error` 抛错（服务端：配置问题，不应该悄悄回退）；`skip` 跳过该字体并在结果里列出
   * （本地预览：提示运行 `pnpm --filter @nowme/kit fonts:fetch`）。默认 submit → error，preview → skip。
   */
  missingFontSource?: 'error' | 'skip';
  /** 即使页面自带 cover.png 也用截图重新生成封面（`nowme preview --cover`）。 */
  forceCover?: boolean;
  /** 额外截一张 `prefers-reduced-motion: reduce` 的整页图。默认 preview → true，submit → false。 */
  reducedMotionScreenshot?: boolean;
  /** 按 `data-nm-id` 分块截图。默认 preview → true，submit → false。 */
  blockScreenshots?: boolean;
  /** 外壳标题（`--serve` 时显示）。 */
  title?: string;
}

export interface SubsetFontSummary {
  fontId: string;
  family: string;
  weight: number;
  cjk: boolean;
  /** `served/` 中的路径，例如 `_fonts/lxgw-wenkai-400.woff2`。 */
  path: string;
  bytes: number;
  /** 子集中的字符数。 */
  charCount: number;
  /** 需要但源字体也没有的汉字（会回退到系统字体）。 */
  unsupportedChars: string;
}

export interface RevisionMetrics {
  /** 普通渲染的 load 耗时（ms）；没渲染或超时为 null。 */
  loadMs: number | null;
  /** 整个 buildRevision 的耗时（ms）。 */
  totalMs: number;
  /** 渲染次数（含减少动效渲染、补字后的重新渲染）。 */
  renderPasses: number;
  /** 渲染后发现新字、重新生成了子集。 */
  resubset: boolean;
  /** 子集取字范围的字符数。 */
  subsetChars: number;
  /** 全部子集字体的字节数。 */
  fontBytes: number;
  contentHeight: number | null;
  fullHeight: number | null;
  truncated: boolean;
  coverBytes: number | null;
  /** 封面被量化后的颜色数；null 表示未量化。 */
  coverColors: number | null;
}

export interface BuildRevisionResult {
  /** 最终报告：静态问题 + RENDER_* 问题；`ok` 为没有任何 error。 */
  report: ValidationReport;
  /** 只有静态校验的报告。 */
  staticReport: ValidationReport;
  /** 是否渲染过（submit 模式静态校验失败、没有 index.html 时为 false）。 */
  rendered: boolean;
  /** `served/` 布局（contracts 3）：`index.html`（已注入 @font-face）、`assets/...`、`_fonts/...`。 */
  served: Map<string, Uint8Array>;
  /** 封面 PNG（750×1000，≤ 600 KB）；渲染失败且页面没有自带封面时为 null。 */
  cover: Uint8Array | null;
  /** 封面是截图生成的（false 表示用的是页面自带的 cover.png）。 */
  coverGenerated: boolean;
  /** 整页截图（`revisions/<id>/render/full.png`）。 */
  fullScreenshot: Uint8Array | null;
  /** `prefers-reduced-motion: reduce` 下的整页截图。 */
  reducedMotionScreenshot: Uint8Array | null;
  blockScreenshots: BlockScreenshot[];
  /** 渲染后文字（普通渲染的 innerText），供内容审核与存档。 */
  renderedText: string;
  fonts: SubsetFontSummary[];
  /** 源文件缺失、被跳过的字体（只在 missingFontSource: 'skip' 时出现）。 */
  missingFontSources: MissingFontSource[];
  /** 页面通过 nowme.openLink 请求打开的地址。 */
  openLinks: string[];
  metrics: RevisionMetrics;
}

function emptyResult(staticReport: ValidationReport, started: number): BuildRevisionResult {
  return {
    report: staticReport,
    staticReport,
    rendered: false,
    served: new Map(),
    cover: null,
    coverGenerated: false,
    fullScreenshot: null,
    reducedMotionScreenshot: null,
    blockScreenshots: [],
    renderedText: '',
    fonts: [],
    missingFontSources: [],
    openLinks: [],
    metrics: {
      loadMs: null,
      totalMs: Date.now() - started,
      renderPasses: 0,
      resubset: false,
      subsetChars: 0,
      fontBytes: 0,
      contentHeight: null,
      fullHeight: null,
      truncated: false,
      coverBytes: null,
      coverColors: null,
    },
  };
}

/** 生成的封面是否通过校验器的 COVER 检查（PNG、750×1000、≤ 600 KB）。 */
export function coverIssues(cover: Uint8Array): ValidationIssue[] {
  return validatePage(new Map([[PAGE_COVER_FILE, cover]])).errors.filter((issue) => issue.code === 'COVER_INVALID');
}

/** 子集里缺少、而某个声明字体的源文件里有的字（需要重新生成子集）。 */
async function missingCoverage(build: ServedBuild, renderedText: readonly string[], readSource: FontSourceReader, kitFonts: readonly KitFont[]): Promise<boolean> {
  const covered = new Set<number>();
  for (const char of build.subsetText) covered.add(char.codePointAt(0) as number);
  const fresh = new Set<number>();
  for (const text of renderedText) {
    for (const char of text) {
      const code = char.codePointAt(0) as number;
      if (code >= 0x20 && !covered.has(code)) fresh.add(code);
    }
  }
  if (fresh.size === 0) return false;
  for (const file of build.fonts.files) {
    const font = kitFonts.find((item) => item.id === file.fontId);
    if (!font) continue;
    const source = await readSource(font, file.weight);
    if (source === null) continue;
    const available = readCmapCodepoints(await toSfnt(source));
    for (const code of fresh) if (available.has(code)) return true;
  }
  return false;
}

function mergeIssues(passes: readonly RenderPassResult[]): ValidationIssue[] {
  const keys = new Set<string>();
  const merged: ValidationIssue[] = [];
  for (const pass of passes) {
    for (const issue of pass.issues) {
      const key = `${issue.code}\u0000${issue.message}`;
      if (keys.has(key)) continue;
      keys.add(key);
      merged.push(pass.reducedMotion ? { ...issue, message: `（减少动态效果时）${issue.message}` } : issue);
    }
  }
  return merged;
}

/**
 * 见文件头。`renderer` 不给时临时创建并在结束时关闭。
 * 页面问题都写进报告；只有环境问题（浏览器无法启动、submit 模式下字体源文件缺失）才抛错。
 */
export async function buildRevision(input: BuildRevisionInput): Promise<BuildRevisionResult> {
  const started = Date.now();
  const mode = input.mode ?? 'submit';
  const staticReport = validatePage(input.files, { kitFonts: input.kitFonts });
  const result = emptyResult(staticReport, started);
  if (mode === 'submit' && !staticReport.ok) return result;
  if (!input.files.has('index.html')) return result;

  const readSource = typeof input.fontSource === 'function' ? input.fontSource : directoryFontSource(input.fontSource);
  const missingPolicy = input.missingFontSource ?? (mode === 'submit' ? 'error' : 'skip');
  const wantReduced = input.reducedMotionScreenshot ?? mode === 'preview';
  const wantBlocks = input.blockScreenshots ?? mode === 'preview';

  const renderer = input.renderer ?? (await Renderer.create(input.rendererOptions));
  try {
    const build = async (renderedText: readonly string[]): Promise<ServedBuild> => {
      const served = await buildServedFiles({ files: input.files, kitFonts: input.kitFonts, renderedText, readFontSource: readSource });
      if (missingPolicy === 'error' && served.fonts.missingSources.length > 0) {
        const list = served.fonts.missingSources.map((item) => `${item.fontId} ${item.weight}（${item.file ?? '?'}）`).join('、');
        throw new Error(`Kit 字体源文件缺失：${list}。运行 pnpm --filter @nowme/kit fonts:fetch 下载`);
      }
      return served;
    };
    const renderAll = async (served: ServedBuild): Promise<RenderPassResult[]> => {
      const normal = await renderer.render(served.served, { cover: true, full: true, blocks: wantBlocks, title: input.title });
      if (!wantReduced || normal.failed) return [normal];
      const reduced = await renderer.render(served.served, { reducedMotion: true, full: true, title: input.title });
      return [normal, reduced];
    };

    let served = await build([]);
    let passes = await renderAll(served);
    let renderPasses = passes.length;
    let resubset = false;
    const texts = passes.map((pass) => pass.renderedText);
    if (!passes.some((pass) => pass.failed) && (await missingCoverage(served, texts, readSource, input.kitFonts))) {
      served = await build(texts);
      passes = await renderAll(served);
      renderPasses += passes.length;
      resubset = true;
    }

    const [normal, reduced] = passes as [RenderPassResult, RenderPassResult | undefined];
    const existingCover = input.files.get(PAGE_COVER_FILE);
    const existingCoverOk = existingCover !== undefined && !staticReport.errors.some((issue) => issue.code === 'COVER_INVALID');
    let cover: Uint8Array | null = null;
    let coverGenerated = false;
    let coverColors: number | null = null;
    if (existingCover && existingCoverOk && !input.forceCover) {
      cover = existingCover;
    } else if (normal.cover) {
      const compressed = compressPng(normal.cover, COVER_MAX_BYTES);
      const problems = coverIssues(compressed.png);
      if (problems.length > 0) throw new Error(`生成的封面没有通过校验：${problems.map((issue) => issue.message).join('；')}`);
      cover = compressed.png;
      coverColors = compressed.colors;
      coverGenerated = true;
    }

    const report = createReport([...staticReport.errors, ...staticReport.warnings, ...mergeIssues(passes)], staticReport.stats);
    result.report = report;
    result.rendered = true;
    result.served = served.served;
    result.cover = cover;
    result.coverGenerated = coverGenerated;
    result.fullScreenshot = normal.full;
    result.reducedMotionScreenshot = reduced?.full ?? null;
    result.blockScreenshots = normal.blocks;
    result.renderedText = normal.renderedText;
    result.fonts = served.fonts.files.map((file) => ({
      fontId: file.fontId,
      family: file.family,
      weight: file.weight,
      cjk: file.cjk,
      path: file.path,
      bytes: file.woff2.byteLength,
      charCount: file.charCount,
      unsupportedChars: file.unsupportedChars,
    }));
    result.missingFontSources = served.fonts.missingSources;
    result.openLinks = [...new Set(passes.flatMap((pass) => pass.openLinks))];
    result.metrics = {
      loadMs: normal.loadMs,
      totalMs: Date.now() - started,
      renderPasses,
      resubset,
      subsetChars: Array.from(served.subsetText).length,
      fontBytes: result.fonts.reduce((sum, font) => sum + font.bytes, 0),
      contentHeight: normal.contentHeight,
      fullHeight: normal.fullHeight,
      truncated: normal.truncated,
      coverBytes: cover?.byteLength ?? null,
      coverColors,
    };
    return result;
  } finally {
    if (!input.renderer) await renderer.close();
  }
}
