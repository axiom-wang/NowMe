/**
 * validatePage：页面静态校验（contracts 2.1、2.2）。
 *
 * 纯函数：只读传入的 PageFiles，不读文件系统、不联网、不依赖浏览器，服务端提交管线直接复用。
 * 静态校验是尽早发现问题的手段，真正的安全边界是沙箱与 CSP（contracts 5）。
 * 内部出现意外异常时直接抛出（调用方按失败处理），不会返回 ok: true。
 */
import {
  HTML_MAX_BYTES,
  MAX_CJK_FONTS,
  NM_ID_MIN_COUNT,
  NM_ID_PATTERN,
  PAGE_CARD_FILE,
  PAGE_COVER_FILE,
  PAGE_INDEX_FILE,
  PAGE_MANIFEST_FILE,
  PAGE_REQUIRED_FILES,
  countCjkFontFaces,
  isPageUploadPath,
  type PageFiles,
  type ValidateOptions,
  type ValidationReport,
} from '@nowme/contracts';
import { PageAnalysis } from './analysis.js';
import { analyzeIndexHtml } from './analyze-index.js';
import { checkAssets, checkCard, checkCover, checkManifest, isCredentialsFileName, scanCredentials, type ManifestInfo } from './files.js';
import { KitFontIndex } from './fonts.js';
import type { HtmlScanResult } from './html.js';
import { HINTS } from './messages.js';
import { skippedEntriesOf, type SkippedReason } from './page-files.js';
import { DYNAMIC_PLACEHOLDER, classifyDynamicRef, classifyRef } from './refs.js';
import { IssueCollector, createReport, emptyStats } from './report.js';
import { isSystemFile } from './system-files.js';
import { clip, decodeUtf8, listPreview, sortChars } from './text.js';

/** 超过这个体积不再做深入分析（只报 HTML_TOO_LARGE），避免服务端被超大文件拖慢。 */
export const HTML_ANALYSIS_MAX_BYTES = HTML_MAX_BYTES * 4;

const SKIPPED_MESSAGES: Record<SkippedReason, string> = {
  symlink: '是符号链接，校验和提交都不会读取它',
  special: '不是普通文件（设备、管道或套接字），已跳过',
  'too-large': '太大，读取时已跳过',
  'too-deep': '所在目录层级太深，读取时已跳过',
  'too-many': '之后的文件太多，读取时已跳过',
  unreadable: '无法读取，已跳过',
};

export function validatePage(input: PageFiles, opts: ValidateOptions = {}): ValidationReport {
  const kit = new KitFontIndex(opts.kitFonts ?? []);
  const issues = new IssueCollector();
  const stats = emptyStats();
  // 系统文件（.DS_Store、Thumbs.db、desktop.ini、._*）当作不存在：不报任何问题，也不计入 ignoredFiles（contracts 1.4）
  const files = withoutSystemFiles(input);

  // 读取目录时跳过的条目（符号链接等）
  for (const entry of skippedEntriesOf(input).filter((item) => !isSystemFile(item.path))) {
    issues.add('IGNORED_FILE', entry.path, undefined, `${entry.path} ${SKIPPED_MESSAGES[entry.reason]}`, entry.reason === 'symlink' ? HINTS.symlink : HINTS.ignoredFile);
    stats.ignoredFiles.push(entry.path);
    if (isCredentialsFileName(entry.path)) {
      issues.add('CREDENTIAL_LEAK', entry.path, undefined, `page/ 中有名为 ${entry.path} 的文件（凭证文件）`, HINTS.credentialLeak);
    }
  }

  // 必需文件、白名单、凭证
  for (const name of PAGE_REQUIRED_FILES) {
    if (!files.has(name)) issues.add('MISSING_FILE', name, undefined, `缺少必需文件 ${name}`, missingFileHint(name));
  }
  const uploadPaths: string[] = [];
  for (const [path, bytes] of files) {
    if (isPageUploadPath(path)) {
      uploadPaths.push(path);
    } else {
      stats.ignoredFiles.push(path);
      issues.add('IGNORED_FILE', path, undefined, `${clip(path)} 不在提交白名单中，提交时不会上传`, HINTS.ignoredFile);
    }
    if (isCredentialsFileName(path)) {
      issues.add('CREDENTIAL_LEAK', path, undefined, `page/ 中有名为 ${clip(path)} 的文件（凭证文件）`, HINTS.credentialLeak);
    }
    scanCredentials(path, bytes, issues);
  }

  const card = files.get(PAGE_CARD_FILE);
  if (card) checkCard(card, issues);
  const manifestBytes = files.get(PAGE_MANIFEST_FILE);
  const manifest = manifestBytes ? checkManifest(manifestBytes, issues) : null;
  const cover = files.get(PAGE_COVER_FILE);
  if (cover) checkCover(cover, issues);

  const assets = checkAssets(files, uploadPaths, issues);
  stats.assetCount = assets.paths.length;
  stats.assetBytes = assets.bytes;

  if (manifest) checkManifestFonts(manifest, kit, opts, issues, stats);

  const html = files.get(PAGE_INDEX_FILE);
  if (html) {
    stats.indexHtmlBytes = html.byteLength;
    const tooLarge = html.byteLength > HTML_MAX_BYTES;
    const skipAnalysis = html.byteLength > HTML_ANALYSIS_MAX_BYTES;
    if (tooLarge) {
      issues.add(
        'HTML_TOO_LARGE',
        PAGE_INDEX_FILE,
        undefined,
        `index.html 有 ${(html.byteLength / 1024).toFixed(1)} KB，超过上限 ${HTML_MAX_BYTES / 1024} KB（${HTML_MAX_BYTES} 字节）${skipAnalysis ? '，文件过大，未做其他检查' : ''}`,
        '把大图从 base64 内联改为 assets/ 下的文件引用；删掉没用到的 CSS / JS；不要内联字体',
      );
    }
    if (!skipAnalysis) {
      const a = new PageAnalysis(issues, kit);
      const scan = analyzeIndexHtml(decodeUtf8(html), a);
      checkHtmlBasics(scan, issues);
      checkRefs(a, files, assets.clean);
      checkNmIds(a, manifest, issues, stats);
      checkMotion(a, issues);
      stats.fontsUsed = [...a.fontsUsed.keys()].sort();
      if (manifest) checkFontsDeclared(a, manifest, issues);
      const scriptOnly = [...a.scriptChars].filter((char) => !a.staticChars.has(char));
      stats.scriptOnlyChars = sortChars(scriptOnly);
      if (manifest) {
        const extra = new Set(Array.from(manifest.extraChars));
        const missing = Array.from(stats.scriptOnlyChars).filter((char) => !extra.has(char));
        if (missing.length > 0) {
          issues.add(
            'EXTRA_CHARS_MISSING',
            PAGE_MANIFEST_FILE,
            undefined,
            `脚本里有 ${missing.length} 个中文字符不在静态文本或 manifest.extraChars 中：${clip(missing.join(''), 40)}`,
            HINTS.extraChars,
          );
        }
      }
    }
  }

  return createReport(issues.list(), stats);
}

function withoutSystemFiles(files: PageFiles): PageFiles {
  if (![...files.keys()].some(isSystemFile)) return files;
  return new Map([...files].filter(([path]) => !isSystemFile(path)));
}

function missingFileHint(name: string): string {
  switch (name) {
    case PAGE_INDEX_FILE:
      return '在 page/ 下创建 index.html：自包含的单文件页面，HTML / CSS / JS 都内联';
    case PAGE_CARD_FILE:
      return '创建 card.json：{ "schemaVersion": 1, "displayName": "…", "tagline": "…", "hooks": [2–3 个 { "id", "text", "opener" }] }';
    default:
      return '创建 manifest.json：{ "schemaVersion": 1, "sceneType": "…", "kitVersion": "1", "motionLevel": "medium", "fonts": [], "extraChars": "" }';
  }
}

function checkHtmlBasics(scan: HtmlScanResult, issues: IssueCollector): void {
  const file = PAGE_INDEX_FILE;
  if (!scan.doctype) {
    issues.add('HTML_MISSING_DOCTYPE', file, 1, 'index.html 缺少 <!doctype html>（浏览器会进入怪异模式）', '在文件第一行写 <!doctype html>');
  }
  const charset = scan.charset;
  if (charset === null) {
    issues.add('HTML_MISSING_CHARSET', file, undefined, 'index.html 缺少 <meta charset="utf-8">', '在 <head> 的最前面加 <meta charset="utf-8">');
  } else if (!['utf-8', 'utf8'].includes(charset.value.toLowerCase())) {
    issues.add('HTML_MISSING_CHARSET', file, charset.line, `页面声明的字符集是 “${clip(charset.value, 30)}”，应为 utf-8`, '改成 <meta charset="utf-8">，并用 UTF-8 保存文件');
  }
  const viewportHint = '在 <head> 里加 <meta name="viewport" content="width=device-width, initial-scale=1">';
  if (scan.viewport === null) {
    issues.add('HTML_MISSING_VIEWPORT', file, undefined, 'index.html 缺少移动端 <meta name="viewport">', viewportHint);
  } else {
    const width = scan.viewport.content
      .split(/[,;]/)
      .map((part) => part.split('=').map((piece) => piece.trim().toLowerCase()))
      .find(([key]) => key === 'width')?.[1];
    if (width !== 'device-width') {
      issues.add('HTML_MISSING_VIEWPORT', file, scan.viewport.line, 'viewport 没有设置 width=device-width', viewportHint);
    }
  }
  if (!scan.lang) {
    issues.add('HTML_MISSING_LANG', file, undefined, '<html> 没有 lang 属性', '写成 <html lang="zh-CN">');
  }
}

function checkRefs(a: PageAnalysis, files: PageFiles, cleanAssets: ReadonlySet<string>): void {
  const used = new Set<string>();
  const file = a.file;
  for (const ref of a.refs) {
    let info = classifyRef(ref.raw);
    if (ref.raw.includes(DYNAMIC_PLACEHOLDER)) {
      // 脚本拼出的地址：只按静态前缀判断；assets/ 前缀只用来判断“是否被引用”
      const dynamic = classifyDynamicRef(ref.raw);
      a.noteLooseAssetText(ref.raw.split(DYNAMIC_PLACEHOLDER)[0] ?? '');
      if (dynamic === null || dynamic.kind === 'fragment') continue;
      info = dynamic;
    }
    const shown = clip(info.value);
    if (ref.source === 'js-import' && info.kind !== 'kit') {
      a.issues.add('EXTERNAL_RESOURCE', file, ref.line, `${ref.where} 了 “${shown}”：模块脚本只能 import Kit 文件`, HINTS.outsideResource);
      continue;
    }
    switch (info.kind) {
      case 'empty':
      case 'fragment':
      case 'blob':
      case 'data-image':
      case 'kit':
        break;
      case 'data-font':
        a.issues.add('FONT_FACE_FORBIDDEN', file, ref.line, `${ref.where} 内联了字体 data URI（${clip(info.mime ?? '', 40)}）`, HINTS.fontFace);
        break;
      case 'data-other':
        a.issues.add('EXTERNAL_RESOURCE', file, ref.line, `${ref.where} 引用了 data:${clip(info.mime ?? '', 40)}：只允许 data:image/* 图片`, HINTS.dataUri);
        break;
      case 'external':
        if (info.scheme === 'javascript') {
          a.issues.add('EXTERNAL_RESOURCE', file, ref.line, `${ref.where} 用了 javascript: 地址`, HINTS.javascriptUrl);
        } else {
          a.issues.add('EXTERNAL_RESOURCE', file, ref.line, `${ref.where} 引用了外部地址 “${shown}”：页面不能加载外部资源`, HINTS.externalResource);
        }
        break;
      case 'outside':
        a.issues.add(
          'EXTERNAL_RESOURCE',
          file,
          ref.line,
          `${ref.where} 引用了 “${shown}”：只能引用 assets/ 下的文件或 Kit（/_nowme/kit/v1/）`,
          HINTS.outsideResource,
        );
        break;
      case 'asset': {
        const path = info.assetPath as string;
        used.add(path);
        if (!files.has(path)) {
          a.issues.add('ASSET_MISSING', file, ref.line, `${ref.where} 引用的 ${clip(path)} 不存在`, HINTS.assetMissing);
        }
        break;
      }
    }
  }
  const prefixes = [...a.looseAssetPrefixes];
  for (const path of cleanAssets) {
    if (used.has(path) || a.looseAssetExact.has(path)) continue;
    if (prefixes.some((prefix) => path.startsWith(prefix))) continue;
    a.issues.add('ASSET_UNUSED', path, undefined, `${path} 没有被页面引用`, HINTS.assetUnused);
  }
}

function checkNmIds(a: PageAnalysis, manifest: ManifestInfo | null, issues: IssueCollector, stats: ValidationReport['stats']): void {
  const file = a.file;
  const lines = new Map<string, (number | undefined)[]>();
  for (const { value, line } of a.nmIds) {
    if (!NM_ID_PATTERN.test(value)) {
      issues.add('NM_ID_INVALID', file, line, `data-nm-id="${clip(value, 50)}" 格式不对`, HINTS.nmIdFormat);
      continue;
    }
    const list = lines.get(value) ?? [];
    list.push(line);
    lines.set(value, list);
  }
  for (const [value, list] of lines) {
    if (list.length > 1) {
      const where = list.filter((line) => line !== undefined).map((line) => `第 ${line} 行`);
      issues.add(
        'NM_ID_DUPLICATE',
        file,
        list[1],
        `data-nm-id="${value}" 出现了 ${list.length} 次${where.length > 0 ? `（${where.join('、')}）` : ''}`,
        HINTS.nmIdDuplicate,
      );
    }
  }
  stats.blocks = [...lines.keys()];
  if (lines.size < NM_ID_MIN_COUNT) {
    issues.add('NM_ID_TOO_FEW', file, undefined, `页面只有 ${lines.size} 个有效的 data-nm-id，至少需要 ${NM_ID_MIN_COUNT} 个`, HINTS.nmIdTooFew);
  }
  if (manifest?.blocks) {
    const page = new Set(stats.blocks);
    const declared = new Set(manifest.blocks);
    const missingInPage = [...declared].filter((id) => !page.has(id));
    const missingInManifest = [...page].filter((id) => !declared.has(id));
    if (missingInPage.length > 0 || missingInManifest.length > 0) {
      const parts: string[] = [];
      if (missingInPage.length > 0) parts.push(`页面里没有 ${listPreview(missingInPage)}`);
      if (missingInManifest.length > 0) parts.push(`manifest.blocks 没有列出 ${listPreview(missingInManifest)}`);
      issues.add('NM_BLOCKS_MISMATCH', PAGE_MANIFEST_FILE, undefined, `manifest.blocks 与页面的 data-nm-id 不一致：${parts.join('；')}`, HINTS.blocksMismatch);
    }
  }
}

function checkMotion(a: PageAnalysis, issues: IssueCollector): void {
  const file = a.file;
  if (a.cssMotion && !a.kitCssIncluded && !a.cssReducedMotionQuery) {
    issues.add(
      'MOTION_WITHOUT_REDUCED',
      file,
      a.cssMotion.line,
      `页面用了 CSS 动效（${a.cssMotion.what}），但没有引入 nowme.css，也没有 prefers-reduced-motion 媒体查询`,
      HINTS.cssMotion,
    );
  }
  let scriptMotion = a.scriptMotion;
  if (scriptMotion === null && a.canvasLine !== null && a.intervalLine !== null) {
    scriptMotion = { line: a.intervalLine, what: 'Canvas + setInterval 循环' };
  }
  if (scriptMotion && !a.scriptReducedMotionCheck) {
    issues.add(
      'MOTION_WITHOUT_REDUCED',
      file,
      scriptMotion.line,
      `脚本动效（${scriptMotion.what}）没有检查减少动效设置（nowme.reducedMotion 或 prefers-reduced-motion）`,
      HINTS.scriptMotion,
    );
  }
}

function checkManifestFonts(
  manifest: ManifestInfo,
  kit: KitFontIndex,
  opts: ValidateOptions,
  issues: IssueCollector,
  stats: ValidationReport['stats'],
): void {
  const file = PAGE_MANIFEST_FILE;
  const available = [...kit.byId.keys()];
  for (const font of manifest.fonts) {
    const kitFont = kit.byId.get(font.id);
    if (!kitFont) {
      issues.add(
        'FONT_UNKNOWN',
        file,
        undefined,
        `manifest.fonts 中的字体 ${clip(font.id, 40)} 不在 Kit 字体清单里${available.length > 0 ? `（可用：${listPreview(available, 10)}）` : '（当前 Kit 字体清单为空）'}`,
        HINTS.fontUnknown,
      );
      continue;
    }
    const unsupported = font.weights.filter((weight) => !kitFont.weights.includes(weight));
    if (unsupported.length > 0) {
      issues.add(
        'FONT_UNKNOWN',
        file,
        undefined,
        `字体 ${font.id} 没有字重 ${unsupported.join('、')}（可用：${kitFont.weights.join('、')}）`,
        HINTS.fontUnknown,
      );
    }
  }
  stats.cjkFontCount = countCjkFontFaces(manifest.fonts, opts.kitFonts ?? []);
  if (stats.cjkFontCount > MAX_CJK_FONTS) {
    issues.add(
      'FONT_TOO_MANY_CJK',
      file,
      undefined,
      `manifest.fonts 声明了 ${stats.cjkFontCount} 款中文字体字重（每个字重计 1 款），上限 ${MAX_CJK_FONTS} 款`,
      HINTS.fontTooManyCjk,
    );
  }
}

function checkFontsDeclared(a: PageAnalysis, manifest: ManifestInfo, issues: IssueCollector): void {
  const declared = new Set(manifest.fonts.map((font) => font.id));
  for (const [id, line] of a.fontsUsed) {
    if (declared.has(id)) continue;
    const family = a.kit.byId.get(id)?.family ?? id;
    issues.add(
      'FONT_UNDECLARED',
      a.file,
      line,
      `页面用了 Kit 字体 ${id}（${family}），但 manifest.fonts 没有声明`,
      `在 manifest.json 的 fonts 里加上 { "id": "${id}", "weights": [400] }（按实际用到的字重填写）`,
    );
  }
}
