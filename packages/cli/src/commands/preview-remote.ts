/**
 * `nowme preview --remote`（随 Skill 包分发的单文件 CLI 里就是 `nowme preview`）：contracts 1.5、4.1。
 *
 * 真实用户的机器上没有 Playwright 和浏览器：把页面的白名单文件发到 `POST /api/agent/previews`，
 * 由 NOWMe 服务端用与提交相同的沙箱渲染管线截图后返回。服务端什么都不存（不生成版本）。
 *
 * - 产物与本地 preview 写在同样的位置：`<工作目录>/.nowme-preview/` 下的 `cover.png`、`full.png`、
 *   `full-reduced-motion.png`、`blocks/NN-<id>.png`、`report.json`，不写进 page/；
 * - 缺 `cover.png` 或带 `--cover` 时把封面写进 `page/cover.png`；
 * - 需要先 `nowme fetch`（用页面凭证认证）；凭证不进上传内容、不进任何输出。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  PAGE_COVER_FILE,
  REVISION_REQUEST_MAX_BYTES,
  WORKDIR_LINK_FILE,
  isPageUploadPath,
  type RemotePreviewResponse,
  type ValidationReport,
} from '@nowme/contracts';
import { isSystemFile } from '@nowme/validator';
import { NetworkError, apiRequest, readApiError, type ApiResult } from '../api-client.js';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { loadCredentialStore } from '../credentials.js';
import { readWorkdirLink } from '../events.js';
import { formatBytes, formatIssues, summaryLine } from '../format.js';
import { loadPage } from '../page-dir.js';
import { PREVIEW_OUTPUT_DIR } from '../workdir.js';

/** 一次最多上传的文件数（与 submit 相同）。 */
const MAX_FILES = 64;

export interface RemotePreviewOutput {
  command: 'preview';
  remote: true;
  ok: boolean;
  pageDir: string;
  outputDir: string;
  rendered: boolean;
  report: ValidationReport;
  cover: { pagePath: string | null; written: boolean };
  screenshots: {
    cover: string | null;
    full: string | null;
    reducedMotion: string | null;
    blocks: { id: string; path: string; top: number; height: number }[];
  };
  reportFile: string;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function fail(ctx: CliContext, json: boolean, error: Record<string, unknown>, lines: string[]): number {
  if (json) ctx.io.stdout(`${JSON.stringify({ command: 'preview', remote: true, ok: false, error }, null, 2)}\n`);
  else ctx.io.stderr(`${lines.join('\n')}\n`);
  return 1;
}

const png = (base64: string): Buffer => Buffer.from(base64, 'base64');

async function writeOutputs(outDir: string, body: RemotePreviewResponse): Promise<RemotePreviewOutput['screenshots']> {
  await mkdir(outDir, { recursive: true });
  // 只清理本命令自己生成的文件（与本地 preview 相同）
  for (const name of ['served', 'blocks', 'cover.png', 'full.png', 'full-reduced-motion.png', 'report.json']) {
    await rm(join(outDir, name), { recursive: true, force: true });
  }
  const shots: RemotePreviewOutput['screenshots'] = { cover: null, full: null, reducedMotion: null, blocks: [] };
  if (body.cover) {
    shots.cover = join(outDir, 'cover.png');
    await writeFile(shots.cover, png(body.cover));
  }
  if (body.full) {
    shots.full = join(outDir, 'full.png');
    await writeFile(shots.full, png(body.full));
  }
  if (body.reducedMotion) {
    shots.reducedMotion = join(outDir, 'full-reduced-motion.png');
    await writeFile(shots.reducedMotion, png(body.reducedMotion));
  }
  if (body.blocks.length > 0) {
    await mkdir(join(outDir, 'blocks'), { recursive: true });
    let index = 0;
    for (const block of body.blocks) {
      index += 1;
      const safeId = String(block.id).replace(/[^a-z0-9-]/gi, '_').slice(0, 40);
      const path = join(outDir, 'blocks', `${String(index).padStart(2, '0')}-${safeId}.png`);
      await writeFile(path, png(block.png));
      shots.blocks.push({ id: block.id, path, top: block.top, height: block.height });
    }
  }
  return shots;
}

function isPreviewResponse(value: unknown): value is RemotePreviewResponse {
  const v = value as Partial<RemotePreviewResponse> | null;
  return typeof v === 'object' && v !== null && typeof v.report === 'object' && v.report !== null && Array.isArray(v.blocks);
}

function humanOutput(output: RemotePreviewOutput): string {
  const lines = [`nowme preview（服务端渲染）：${output.pageDir}`];
  if (!output.rendered) lines.push('没有渲染：缺少 index.html');
  lines.push(summaryLine(output.report), '');
  const issues = [...output.report.errors, ...output.report.warnings];
  if (issues.length > 0) lines.push(formatIssues(issues));
  if (output.cover.written && output.cover.pagePath) lines.push(`封面：已写入 ${output.cover.pagePath}`);
  else if (output.cover.pagePath) lines.push(`封面：使用页面自带的 ${output.cover.pagePath}（要按当前页面重新生成，加 --cover）`);
  else lines.push('封面：没有生成（渲染失败）');
  const shots = output.screenshots;
  lines.push('截图（请逐张打开查看）：');
  if (shots.cover) lines.push(`  封面（首屏 375×500）      ${shots.cover}`);
  if (shots.full) lines.push(`  整页                      ${shots.full}`);
  if (shots.reducedMotion) lines.push(`  整页（减少动态效果）      ${shots.reducedMotion}`);
  for (const block of shots.blocks) lines.push(`  区块 ${block.id.padEnd(20)} ${block.path}`);
  if (!shots.cover && !shots.full && shots.blocks.length === 0) lines.push('  （没有截图）');
  lines.push(`报告：${output.reportFile}`, '服务端没有保存这次预览，也没有生成版本；满意后运行 nowme submit 提交。');
  return `${lines.join('\n')}\n`;
}

export async function runRemotePreview(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const started = Date.now();
  const json = args.flags.get('json') === true;
  const forceCover = args.flags.get('cover') === true;
  if (args.positionals.length > 1) {
    ctx.io.stderr('用法：nowme preview [dir=page] [--cover] [--json]\n');
    return 1;
  }
  const { pageDir, workDir, files } = await loadPage(ctx, args.positionals[0]);
  const outDir = join(workDir, PREVIEW_OUTPUT_DIR);
  if (isInside(outDir, pageDir)) throw new Error(`预览产物目录 ${outDir} 在页面目录里面：请换一个页面目录`);

  // 1. 关联信息与凭证（服务端渲染需要页面凭证）
  const link = await readWorkdirLink(workDir);
  if (!link) {
    return fail(ctx, json, { code: 'NOT_LINKED' }, [`${workDir} 里没有 ${WORKDIR_LINK_FILE}。服务端预览需要先用应用里生成的指令运行 nowme fetch。`]);
  }
  const { store, notes } = await loadCredentialStore(ctx.env);
  for (const note of notes) ctx.io.stderr(`${note}\n`);
  const credential = store.pages[link.pageId]?.credential;
  if (!credential) {
    return fail(ctx, json, { code: 'NO_CREDENTIAL' }, ['本机没有这个页面的凭证。请在应用的创作工作区重新生成指令，再运行 nowme fetch。']);
  }

  // 2. 只取白名单文件；--cover 时旧封面马上会被覆盖，不上传
  const hadCover = files.has(PAGE_COVER_FILE);
  const upload: Record<string, string> = {};
  const needle = Buffer.from(credential);
  for (const [path, bytes] of files) {
    if (isSystemFile(path) || !isPageUploadPath(path)) continue;
    if (forceCover && path === PAGE_COVER_FILE) continue;
    // 凭证绝不能出现在上传内容里
    if (Buffer.from(bytes).includes(needle)) {
      return fail(ctx, json, { code: 'CREDENTIAL_LEAK' }, ['页面文件里出现了页面凭证，已中止预览。请删除后重试（不要把凭证写进页面）。']);
    }
    upload[path] = Buffer.from(bytes).toString('base64');
  }
  const count = Object.keys(upload).length;
  if (count > MAX_FILES) return fail(ctx, json, { code: 'TOO_MANY_FILES', count }, [`文件太多：${count} 个，一次最多 ${MAX_FILES} 个。`]);
  const body = JSON.stringify({ files: upload });
  const size = Buffer.byteLength(body);
  if (size > REVISION_REQUEST_MAX_BYTES) {
    return fail(ctx, json, { code: 'PAYLOAD_TOO_LARGE', bytes: size }, [
      `上传内容 ${formatBytes(size)}，超过 ${formatBytes(REVISION_REQUEST_MAX_BYTES)} 上限，请缩小图片。`,
    ]);
  }

  // 3. 服务端渲染（可能要十几秒）
  let result: ApiResult;
  try {
    result = await apiRequest(link.server, '/api/agent/previews', { method: 'POST', credential, body, timeoutMs: 120_000 });
  } catch (error) {
    const message = error instanceof NetworkError ? error.message : '请求失败';
    await ctx.reportEvent(workDir, 'preview', { ok: false, remote: true, durationMs: Date.now() - started });
    return fail(ctx, json, { code: 'NETWORK_ERROR', message }, [`${message}。请确认能访问 NOWMe（${link.server}）后重试。`]);
  }
  if (result.status !== 200 || !isPreviewResponse(result.body)) {
    const error = readApiError(result);
    const hints: Record<number, string> = {
      401: '凭证已失效（可能在应用内断开了、重新生成过指令、退出了墙或墙已关闭）。请在创作工作区重新生成指令，再运行 nowme fetch。',
      413: '上传内容太大，请缩小图片后重试。',
      429: '今天的预览次数已达上限，请稍后再试；也可以直接 nowme submit，在工作区里预览。',
    };
    await ctx.reportEvent(workDir, 'preview', { ok: false, remote: true, durationMs: Date.now() - started });
    return fail(ctx, json, { ...error, status: result.status }, [hints[result.status] ?? `服务端预览失败（${result.status}）。`, `服务器说明：${error.message}`]);
  }
  const preview = result.body;

  // 4. 写产物与封面
  let coverWritten = false;
  const pageCoverPath = join(pageDir, PAGE_COVER_FILE);
  if ((!hadCover || forceCover) && preview.cover) {
    await writeFile(pageCoverPath, png(preview.cover));
    coverWritten = true;
  }
  const screenshots = await writeOutputs(outDir, preview);
  const reportFile = join(outDir, 'report.json');
  const output: RemotePreviewOutput = {
    command: 'preview',
    remote: true,
    ok: preview.report.ok,
    pageDir,
    outputDir: outDir,
    rendered: preview.rendered,
    report: preview.report,
    cover: { pagePath: coverWritten || hadCover ? pageCoverPath : null, written: coverWritten },
    screenshots,
    reportFile,
  };
  await writeFile(reportFile, `${JSON.stringify(output, null, 2)}\n`);
  if (json) ctx.io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  else ctx.io.stdout(humanOutput(output));

  await ctx.reportEvent(workDir, 'preview', {
    ok: preview.report.ok,
    remote: true,
    errorCount: preview.report.errors.length,
    warningCount: preview.report.warnings.length,
    durationMs: Date.now() - started,
  });
  return preview.report.ok ? 0 : 1;
}
