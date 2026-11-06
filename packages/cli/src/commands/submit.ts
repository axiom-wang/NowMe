/**
 * `nowme submit [dir=page] [--json]`：本地校验 -> 只上传白名单文件 -> 打印版本与工作区链接。
 * 凭证不进上传内容、不进任何输出。发布只能由主人在应用内完成。
 */
import {
  REVISION_REQUEST_MAX_BYTES,
  WORKDIR_LINK_FILE,
  isPageUploadPath,
  type RevisionSummary,
} from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { isSystemFile, validatePage } from '@nowme/validator';
import { NetworkError, apiRequest, readApiError, type ApiResult } from '../api-client.js';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { loadCredentialStore } from '../credentials.js';
import { readWorkdirLink } from '../events.js';
import { formatBytes, formatIssues, summaryLine } from '../format.js';
import { loadPage } from '../page-dir.js';
import { fixExtraChars } from './validate.js';

/** 一次提交最多 64 个文件（contracts 8）。 */
export const SUBMIT_MAX_FILES = 64;

const PUBLISH_REMINDER = '发布需要你在应用内确认缩略卡和联系方式：请打开下面的工作区链接，确认后点发布。我（Agent）不能替你发布。';

function emit(ctx: CliContext, json: boolean, payload: Record<string, unknown>, text: string[], ok: boolean): void {
  if (json) ctx.io.stdout(`${JSON.stringify({ command: 'submit', ...payload }, null, 2)}\n`);
  else (ok ? ctx.io.stdout : ctx.io.stderr)(`${text.join('\n')}\n`);
}

export async function runSubmit(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const started = Date.now();
  const json = args.flags.get('json') === true;
  if (args.positionals.length > 1) {
    ctx.io.stderr('用法：nowme submit [dir=page] [--json]\n');
    return 1;
  }
  const { pageDir, workDir, files } = await loadPage(ctx, args.positionals[0]);
  const report = (ok: boolean, extra: Record<string, unknown> = {}) =>
    ctx.reportEvent(workDir, 'submit', { ok, durationMs: Date.now() - started, ...extra });

  // 1. 关联信息与凭证
  const link = await readWorkdirLink(workDir);
  if (!link) {
    emit(ctx, json, { ok: false, error: { code: 'NOT_LINKED' } }, [`${workDir} 里没有 ${WORKDIR_LINK_FILE}。请先用应用里生成的指令运行 nowme fetch。`], false);
    return 1;
  }
  const { store, notes } = await loadCredentialStore(ctx.env);
  for (const note of notes) ctx.io.stderr(`${note}\n`);
  const credential = store.pages[link.pageId]?.credential;
  if (!credential) {
    emit(ctx, json, { ok: false, error: { code: 'NO_CREDENTIAL' } }, ['本机没有这个页面的凭证。请在应用的创作工作区重新生成指令，再运行 nowme fetch。'], false);
    return 1;
  }

  // 2. 本地校验（与 validate 相同，含 extraChars 补全）
  const fix = await fixExtraChars(pageDir, files);
  const local = validatePage(files, { kitFonts: loadKitFonts() });
  if (!local.ok) {
    emit(
      ctx,
      json,
      { ok: false, stage: 'local-validation', pageDir, report: local },
      ['本地校验没有通过，没有上传任何内容。', summaryLine(local), '', formatIssues([...local.errors, ...local.warnings])],
      false,
    );
    await report(false, { errorCount: local.errors.length });
    return 1;
  }

  // 3. 只取白名单文件
  const upload: Record<string, string> = {};
  const skipped: string[] = [];
  const raw: Uint8Array[] = [];
  for (const [path, bytes] of files) {
    if (isSystemFile(path)) continue;
    if (!isPageUploadPath(path)) {
      skipped.push(path);
      continue;
    }
    upload[path] = Buffer.from(bytes).toString('base64');
    raw.push(bytes);
  }
  const count = Object.keys(upload).length;
  if (count > SUBMIT_MAX_FILES) {
    emit(ctx, json, { ok: false, error: { code: 'TOO_MANY_FILES', count } }, [`文件太多：${count} 个，一次最多 ${SUBMIT_MAX_FILES} 个。`], false);
    return 1;
  }
  // 凭证绝不能出现在上传内容里
  const needle = Buffer.from(credential);
  if (raw.some((bytes) => Buffer.from(bytes).includes(needle))) {
    emit(ctx, json, { ok: false, error: { code: 'CREDENTIAL_LEAK' } }, ['页面文件里出现了页面凭证，已中止上传。请删除后重试（不要把凭证写进页面）。'], false);
    return 1;
  }
  const body = JSON.stringify({ files: upload });
  const size = Buffer.byteLength(body);
  if (size > REVISION_REQUEST_MAX_BYTES) {
    emit(ctx, json, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', bytes: size } }, [`上传内容 ${formatBytes(size)}，超过 ${formatBytes(REVISION_REQUEST_MAX_BYTES)} 上限，请缩小图片。`], false);
    return 1;
  }

  // 4. 上传
  let result: ApiResult;
  try {
    result = await apiRequest(link.server, '/api/agent/revisions', { method: 'POST', credential, body });
  } catch (error) {
    const message = error instanceof NetworkError ? error.message : '请求失败';
    emit(ctx, json, { ok: false, error: { code: 'NETWORK_ERROR', message } }, [`${message}。请确认 NOWMe 应用正在运行后重试。`], false);
    await report(false);
    return 1;
  }

  const revision = (result.body as { revision?: RevisionSummary } | null)?.revision;
  if (result.status === 201 && revision) {
    const lines = [`已提交：版本 #${revision.number}（${revision.status === 'accepted' ? '已通过校验' : revision.status}）`, `上传 ${count} 个文件，${formatBytes(size)}`];
    if (fix) lines.push('已自动补全 manifest.extraChars');
    if (skipped.length > 0) lines.push(`未上传（不在白名单内）：${skipped.join('、')}`);
    if (revision.report.warnings.length > 0) lines.push('', `警告 ${revision.report.warnings.length} 个：`, formatIssues(revision.report.warnings));
    lines.push('', PUBLISH_REMINDER, `工作区：${revision.workspaceUrl}`);
    emit(ctx, json, { ok: true, revision, uploaded: Object.keys(upload), skipped, publishRequiresOwner: true }, lines, true);
    await report(true, { errorCount: 0, warningCount: revision.report.warnings.length, fileCount: count });
    return 0;
  }
  if (result.status === 422 && revision) {
    const issues = [...revision.report.errors, ...revision.report.warnings];
    emit(
      ctx,
      json,
      { ok: false, stage: 'server-validation', revision },
      [`服务器没有接受这次提交（版本 #${revision.number}，已记为 rejected；之前通过的版本和已发布的页面不受影响）。`, summaryLine(revision.report), '', formatIssues(issues), `工作区：${revision.workspaceUrl}`],
      false,
    );
    await report(false, { errorCount: revision.report.errors.length });
    return 1;
  }
  const error = readApiError(result);
  const hints: Record<number, string> = {
    401: '凭证已失效（可能在应用内断开了、重新生成过指令、退出了墙或墙已关闭）。请在创作工作区重新生成指令，再运行 nowme fetch。',
    413: '上传内容太大，请缩小图片后重试。',
    429: '今天的提交次数已达上限，请明天再试。',
  };
  emit(
    ctx,
    json,
    { ok: false, error: { ...error, status: result.status } },
    [hints[result.status] ?? `提交失败（${result.status}）。`, `服务器说明：${error.message}`],
    false,
  );
  await report(false);
  return 1;
}
