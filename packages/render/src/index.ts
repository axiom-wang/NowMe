/**
 * @nowme/render：无头渲染（Playwright）、截图、渲染后文字提取、CSP 违规检测、字体子集化、
 * 本地双源预览服务器（contracts 0.2、2.3、3、5、8）。
 *
 * 两个调用方：
 * - 主站提交管线（T2.1）：`buildRevision({ files, kitFonts, mode: 'submit', renderer })`，输入输出都在内存中；
 *   用一个长期存在的 `createRenderer()` 复用浏览器，进程退出前 `renderer.close()`。
 * - `nowme preview`：`buildRevision({ ..., mode: 'preview' })`，`--serve` 时用 `startPreviewServer({ shellPort: 4100, pagesPort: 4101 })`。
 *
 * 渲染与预览只用 @nowme/contracts 的 buildPageCsp / PAGE_SECURITY_HEADERS / PAGE_IFRAME_SANDBOX / buildWebCsp。
 * Playwright 精确锁定 1.58.2（Chromium 构建号 1208）。
 */
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { RENDER_TIMEOUT_MS, RENDER_VIEWPORT } from '@nowme/contracts';

export { RENDER_TIMEOUT_MS, RENDER_VIEWPORT };

/** 启动无头 Chromium。调用方负责 `browser.close()`。 */
export function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, timeout: RENDER_TIMEOUT_MS * 3, ...options });
}

export {
  buildRevision,
  coverIssues,
  type BuildMode,
  type BuildRevisionInput,
  type BuildRevisionResult,
  type RevisionMetrics,
  type SubsetFontSummary,
} from './pipeline.js';
export {
  DEFAULT_SETTLE_MS,
  FULL_PAGE_MAX_CSS_HEIGHT,
  Renderer,
  createRenderer,
  lineFromStack,
  type BlockScreenshot,
  type RenderPassOptions,
  type RenderPassResult,
  type RendererOptions,
} from './renderer.js';
export {
  PREVIEW_PAGES_HOST,
  PREVIEW_SHELL_HOST,
  PreviewServer,
  startPreviewServer,
  type PreviewServerOptions,
  type PublishOptions,
  type PublishedPage,
} from './server.js';
export { SHELL_FRAME_ID, shellHtml, type ShellMode } from './shell.js';
export {
  collectSubsetText,
  directoryFontSource,
  fontFaceCss,
  fontSubsetPath,
  planFontFaces,
  subsetFontFaces,
  type FontFace,
  type FontSourceReader,
  type FontSubsetResult,
  type MissingFontSource,
  type SubsetFontFile,
} from './fonts.js';
export { buildServedFiles, fontFaceStyleTag, insertBeforeHeadEnd, readManifestFonts, type ServedBuild, type ServedBuildInput } from './served.js';
export { compressPng, pngSize, type CompressedPng } from './png.js';
export { codepointsToString, readCmapCodepoints, readNameRecords, readSfntTables, toSfnt } from './sfnt.js';
export { RENDER_HINTS, renderIssue, type RenderIssueCode } from './issues.js';
