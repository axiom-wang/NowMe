/**
 * `nowme preview [dir=page] [--serve] [--cover] [--json] [--port N]`（contracts 1.5、2.3、8）。
 *
 * - 跑 @nowme/render 的 buildRevision（预览模式：静态校验有错误也照样渲染，报告里保留错误）；
 * - 缺 `cover.png` 或带 `--cover` 时把 750×1000 封面写进 `page/cover.png`；
 * - 其他产物写到工作目录（page/ 的上一级）下的 `.nowme-preview/`：`cover.png`、`full.png`、
 *   `full-reduced-motion.png`、`blocks/NN-<id>.png`、`served/`、`report.json`，不写进 page/；
 * - 打印每张截图的绝对路径与渲染问题；
 * - `--serve`：在 `http://localhost:<port>`（默认 4100，页面源 127.0.0.1:<port+1>）保持预览服务器，Ctrl+C 退出。
 *   不带 `--serve` 时渲染用随机空闲端口，多个预览可以同时运行。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { DEFAULT_PREVIEW_SHELL_PORT, PAGE_CARD_FILE, PAGE_COVER_FILE, type ValidationReport } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { buildRevision, createRenderer, pngSize, startPreviewServer, type BuildRevisionResult, type PreviewServer } from '@nowme/render';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { formatBytes, formatIssues, summaryLine } from '../format.js';
import { loadPage } from '../page-dir.js';
import { PREVIEW_OUTPUT_DIR } from '../workdir.js';

export interface PreviewOutput {
  command: 'preview';
  ok: boolean;
  pageDir: string;
  outputDir: string;
  rendered: boolean;
  report: ValidationReport;
  cover: {
    /** `page/cover.png` 的路径（写入或已有时）；没有封面时为 null。 */
    pagePath: string | null;
    /** 这次写入了 `page/cover.png`。 */
    written: boolean;
    /** 封面是截图生成的（false：用的是页面自带的 cover.png）。 */
    generated: boolean;
    bytes: number | null;
    width: number | null;
    height: number | null;
    /** 量化后的颜色数；null 表示未量化。 */
    colors: number | null;
  };
  screenshots: {
    cover: string | null;
    full: string | null;
    reducedMotion: string | null;
    blocks: { id: string; path: string; top: number; height: number }[];
  };
  served: string | null;
  reportFile: string;
  fonts: BuildRevisionResult['fonts'];
  missingFontSources: BuildRevisionResult['missingFontSources'];
  openLinks: string[];
  renderedText: string;
  metrics: BuildRevisionResult['metrics'];
  serve: { url: string; shellOrigin: string; pagesOrigin: string } | null;
}

function readDisplayName(files: ReadonlyMap<string, Uint8Array>): string | undefined {
  const bytes = files.get(PAGE_CARD_FILE);
  if (!bytes) return undefined;
  try {
    const card = JSON.parse(new TextDecoder().decode(bytes)) as { displayName?: unknown };
    return typeof card.displayName === 'string' ? card.displayName.slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

async function writeOutputs(outDir: string, result: BuildRevisionResult): Promise<PreviewOutput['screenshots'] & { served: string | null }> {
  await mkdir(outDir, { recursive: true });
  // 只清理本命令自己生成的文件
  for (const name of ['served', 'blocks', 'cover.png', 'full.png', 'full-reduced-motion.png', 'report.json']) {
    await rm(join(outDir, name), { recursive: true, force: true });
  }
  const screenshots: PreviewOutput['screenshots'] & { served: string | null } = {
    cover: null,
    full: null,
    reducedMotion: null,
    blocks: [],
    served: null,
  };
  if (result.cover) {
    screenshots.cover = join(outDir, 'cover.png');
    await writeFile(screenshots.cover, result.cover);
  }
  if (result.fullScreenshot) {
    screenshots.full = join(outDir, 'full.png');
    await writeFile(screenshots.full, result.fullScreenshot);
  }
  if (result.reducedMotionScreenshot) {
    screenshots.reducedMotion = join(outDir, 'full-reduced-motion.png');
    await writeFile(screenshots.reducedMotion, result.reducedMotionScreenshot);
  }
  if (result.blockScreenshots.length > 0) {
    await mkdir(join(outDir, 'blocks'), { recursive: true });
    let index = 0;
    for (const block of result.blockScreenshots) {
      index += 1;
      const safeId = block.id.replace(/[^a-z0-9-]/gi, '_').slice(0, 40);
      const path = join(outDir, 'blocks', `${String(index).padStart(2, '0')}-${safeId}.png`);
      await writeFile(path, block.png);
      screenshots.blocks.push({ id: block.id, path, top: block.top, height: block.height });
    }
  }
  if (result.served.size > 0) {
    screenshots.served = join(outDir, 'served');
    for (const [path, bytes] of result.served) {
      const target = join(screenshots.served, ...path.split('/'));
      if (!isInside(target, screenshots.served)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  return screenshots;
}

function humanOutput(output: PreviewOutput): string {
  const lines = [`nowme preview：${output.pageDir}`];
  const m = output.metrics;
  if (output.rendered) {
    lines.push(
      `渲染：load ${m.loadMs === null ? '超时' : `${m.loadMs} ms`}，共渲染 ${m.renderPasses} 次${m.resubset ? '（渲染后补了字体子集）' : ''}，用时 ${(m.totalMs / 1000).toFixed(1)} s`,
    );
  } else {
    lines.push('没有渲染：缺少 index.html');
  }
  lines.push(summaryLine(output.report), '');
  const issues = [...output.report.errors, ...output.report.warnings];
  if (issues.length > 0) lines.push(formatIssues(issues));

  if (output.fonts.length > 0) {
    lines.push('字体子集（与提交后一致）：');
    for (const font of output.fonts) {
      const unsupported = font.unsupportedChars ? `；字体本身没有：${font.unsupportedChars}（会用系统字体显示）` : '';
      lines.push(`  ${font.fontId} ${font.weight}  ${formatBytes(font.bytes)}（${font.charCount} 个字符）${unsupported}`);
    }
  }
  if (output.missingFontSources.length > 0) {
    const list = output.missingFontSources.map((item) => `${item.fontId} ${item.weight}`).join('、');
    lines.push(`注意：本机缺少 Kit 字体源文件（${list}），预览中这些字体回退为系统字体。在 NOWMe 仓库运行 pnpm --filter @nowme/kit fonts:fetch 下载后重新预览。`);
  }
  if (output.fonts.length > 0 || output.missingFontSources.length > 0) lines.push('');

  const cover = output.cover;
  if (cover.written && cover.pagePath) {
    lines.push(`封面：已写入 ${cover.pagePath}（${cover.width}×${cover.height}，${formatBytes(cover.bytes ?? 0)}${cover.colors ? `，已量化为 ${cover.colors} 色` : ''}）`);
  } else if (cover.pagePath && !cover.generated) {
    lines.push(`封面：使用页面自带的 ${cover.pagePath}（要按当前页面重新生成，加 --cover）`);
  } else if (cover.generated) {
    lines.push(`封面：页面自带的 cover.png 不合格，没有覆盖它；新截的封面在 ${output.screenshots.cover}。删掉 page/cover.png 或加 --cover 重新生成`);
  } else {
    lines.push('封面：没有生成（渲染失败）');
  }
  const shots = output.screenshots;
  lines.push('截图（请逐张打开查看）：');
  if (shots.cover) lines.push(`  封面（首屏 375×500）      ${shots.cover}`);
  if (shots.full) lines.push(`  整页                      ${shots.full}${m.truncated ? '（页面太长，已截断）' : ''}`);
  if (shots.reducedMotion) lines.push(`  整页（减少动态效果）      ${shots.reducedMotion}`);
  for (const block of shots.blocks) lines.push(`  区块 ${block.id.padEnd(20)} ${block.path}`);
  if (!shots.cover && !shots.full && shots.blocks.length === 0) lines.push('  （没有截图）');
  lines.push(`报告：${output.reportFile}`);
  if (output.openLinks.length > 0) lines.push(`页面请求打开的外链（预览只记录，不打开）：${output.openLinks.join('、')}`);
  return `${lines.join('\n')}\n`;
}

export async function runPreview(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const started = Date.now();
  const json = args.flags.get('json') === true;
  const serve = args.flags.get('serve') === true;
  const forceCover = args.flags.get('cover') === true;
  const port = args.flags.get('port');
  if (args.positionals.length > 1) {
    ctx.io.stderr('用法：nowme preview [dir=page] [--serve] [--cover] [--json] [--port N]\n');
    return 1;
  }
  if (port !== undefined && (typeof port !== 'number' || port < 1 || port > 65534)) {
    ctx.io.stderr('--port 应为 1–65534 之间的整数（页面源使用 port+1）\n');
    return 1;
  }
  if (port !== undefined && !serve) {
    ctx.io.stderr('--port 只在 --serve 时使用\n');
    return 1;
  }

  const { pageDir, workDir, files } = await loadPage(ctx, args.positionals[0]);
  const outDir = join(workDir, PREVIEW_OUTPUT_DIR);
  if (isInside(outDir, pageDir)) throw new Error(`预览产物目录 ${outDir} 在页面目录里面：请换一个页面目录`);
  const kitFonts = loadKitFonts();
  const hadCover = files.has(PAGE_COVER_FILE);

  let server: PreviewServer | null = null;
  if (serve) {
    const shellPort = typeof port === 'number' ? port : DEFAULT_PREVIEW_SHELL_PORT;
    server = await startPreviewServer({ shellPort, pagesPort: shellPort + 1 });
  }
  try {
    const title = readDisplayName(files);
    const renderer = await createRenderer(server ? { server } : {});
    let result: BuildRevisionResult;
    try {
      // --cover：旧的 cover.png 马上会被覆盖，校验时就当它不存在（不报旧封面的 COVER_INVALID）
      const input = forceCover ? new Map([...files].filter(([path]) => path !== PAGE_COVER_FILE)) : files;
      result = await buildRevision({ files: input, kitFonts, mode: 'preview', renderer, forceCover, title });
    } finally {
      await renderer.close();
    }

    let coverWritten = false;
    const pageCoverPath = join(pageDir, PAGE_COVER_FILE);
    if ((!hadCover || forceCover) && result.coverGenerated && result.cover) {
      await writeFile(pageCoverPath, result.cover);
      coverWritten = true;
    }
    const written = await writeOutputs(outDir, result);
    const size = result.cover ? pngSize(result.cover) : null;
    const reportFile = join(outDir, 'report.json');
    let serveInfo: PreviewOutput['serve'] = null;
    if (server && result.served.size > 0) {
      server.publish(result.served, { title });
      serveInfo = { url: `${server.shellOrigin}/`, shellOrigin: server.shellOrigin, pagesOrigin: server.pagesOrigin };
    }
    const output: PreviewOutput = {
      command: 'preview',
      ok: result.report.ok,
      pageDir,
      outputDir: outDir,
      rendered: result.rendered,
      report: result.report,
      cover: {
        pagePath: coverWritten || hadCover ? pageCoverPath : null,
        written: coverWritten,
        generated: result.coverGenerated,
        bytes: result.cover?.byteLength ?? null,
        width: size?.width ?? null,
        height: size?.height ?? null,
        colors: result.metrics.coverColors,
      },
      screenshots: { cover: written.cover, full: written.full, reducedMotion: written.reducedMotion, blocks: written.blocks },
      served: written.served,
      reportFile,
      fonts: result.fonts,
      missingFontSources: result.missingFontSources,
      openLinks: result.openLinks,
      renderedText: result.renderedText,
      metrics: result.metrics,
      serve: serveInfo,
    };
    await writeFile(reportFile, `${JSON.stringify(output, null, 2)}\n`);

    if (json) ctx.io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    else ctx.io.stdout(humanOutput(output));

    await ctx.reportEvent(workDir, 'preview', {
      ok: result.report.ok,
      errorCount: result.report.errors.length,
      warningCount: result.report.warnings.length,
      renderErrorCount: result.report.errors.filter((issue) => issue.code.startsWith('RENDER_')).length,
      coverGenerated: result.coverGenerated,
      durationMs: Date.now() - started,
    });

    if (server && serveInfo) {
      // --json 时提示写到 stderr，保持 stdout 是一个完整的 JSON
      const say = json ? ctx.io.stderr : ctx.io.stdout;
      say(`\n预览服务器已启动：在浏览器打开 ${serveInfo.url}\n（页面源 ${serveInfo.pagesOrigin}，与平台一样运行在沙箱 iframe 中；按 Ctrl+C 退出）\n`);
      await ctx.untilInterrupted();
      say('预览服务器已关闭\n');
    }
    return result.report.ok ? 0 : 1;
  } finally {
    await server?.close();
  }
}
