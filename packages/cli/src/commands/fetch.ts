/**
 * `nowme fetch <wallId> <token> [--server URL] [--json]`：用一次性 token 换凭证，写 nowme.json、context.json、凭证。
 * `nowme fetch [--json]`：已有凭证时刷新 context.json。
 */
import { stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import {
  PAGE_INDEX_FILE,
  WORKDIR_CONTEXT_FILE,
  WORKDIR_LINK_FILE,
  WORKDIR_PAGE_DIR,
  type AgentContext,
  type ExchangeResponse,
} from '@nowme/contracts';
import { NetworkError, apiRequest, normalizeServer, readApiError, type ApiResult } from '../api-client.js';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { loadCredentialStore, saveCredential } from '../credentials.js';
import { readWorkdirLink } from '../events.js';
import { writeFileAtomic } from '../fs-util.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 当前目录是否在 page/ 里面（避免把 nowme.json、context.json 写进 page/）。 */
export async function isInsidePageDir(cwd: string): Promise<boolean> {
  let dir = cwd;
  for (;;) {
    if (basename(dir) === WORKDIR_PAGE_DIR) {
      if (dir === cwd) return true;
      const parent = dirname(dir);
      if ((await exists(join(parent, WORKDIR_LINK_FILE))) || (await exists(join(dir, PAGE_INDEX_FILE)))) return true;
    }
    const up = dirname(dir);
    if (up === dir || dir.split(sep).length <= 1) return false;
    dir = up;
  }
}

function isContext(value: unknown): value is AgentContext {
  const v = value as Partial<AgentContext> | null;
  return typeof v === 'object' && v !== null && typeof v.wall?.name === 'string' && typeof v.page?.id === 'string';
}

function describeContext(context: AgentContext): string[] {
  const lines = [`墙：${context.wall.name}`, `场景：${context.wall.sceneType}`];
  if (context.wall.description) lines.push(`简介：${context.wall.description}`);
  lines.push(`组织者的话：${context.wall.organizerNote ?? '（没有留言）'}`);
  lines.push(`这一页已有 ${context.page.revisionCount} 个版本`);
  return lines;
}

export async function runFetch(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const json = args.flags.get('json') === true;
  const { positionals } = args;
  if (positionals.length !== 0 && positionals.length !== 2) {
    ctx.io.stderr('用法：nowme fetch <wallId> <token> [--server URL]（或不带参数刷新）\n');
    return 1;
  }
  if (await isInsidePageDir(ctx.cwd)) {
    ctx.io.stderr(
      `不能在 page/ 目录里运行 nowme fetch（${ctx.cwd}）。\nnowme.json 和 context.json 属于工作目录，不属于页面。请回到 page/ 的上一级目录再运行。\n`,
    );
    return 1;
  }
  const started = Date.now();
  return positionals.length === 2
    ? exchange(ctx, args, json, started)
    : refresh(ctx, json, started);
}

function failWith(ctx: CliContext, json: boolean, command: string, error: { code: string; message: string }, hint: string, status?: number): number {
  if (json) ctx.io.stdout(`${JSON.stringify({ command, ok: false, error: { ...error, status: status ?? null }, hint }, null, 2)}\n`);
  else ctx.io.stderr(`${error.message ? `服务器说明：${error.message}\n` : ''}${hint}\n`);
  return 1;
}

function networkFail(ctx: CliContext, json: boolean, command: string, error: unknown): number {
  const message = error instanceof NetworkError ? error.message : '请求失败';
  const hint = `${message}。请确认 NOWMe 应用正在运行、--server 地址正确，稍后重试。`;
  if (json) ctx.io.stdout(`${JSON.stringify({ command, ok: false, error: { code: 'NETWORK_ERROR', message }, hint }, null, 2)}\n`);
  else ctx.io.stderr(`${hint}\n`);
  return 1;
}

async function exchange(ctx: CliContext, args: ParsedArgs, json: boolean, started: number): Promise<number> {
  const [wallId, token] = args.positionals as [string, string];
  let server: string;
  try {
    server = normalizeServer(args.flags.get('server') as string | undefined);
  } catch (error) {
    ctx.io.stderr(`${(error as Error).message}\n`);
    return 1;
  }
  let result: ApiResult;
  try {
    result = await apiRequest(server, '/api/agent/exchange', { method: 'POST', body: { wallId, token } });
  } catch (error) {
    return networkFail(ctx, json, 'fetch', error);
  }
  const body = result.body as Partial<ExchangeResponse> | null;
  if (result.status !== 200 || !body || typeof body.credential !== 'string' || typeof body.page?.id !== 'string' || !isContext(body.context)) {
    const error = readApiError(result);
    if (result.status === 401) {
      return failWith(ctx, json, 'fetch', error, 'token 已用过、过期或不属于这面墙，请在应用的创作工作区重新生成指令。', 401);
    }
    return failWith(ctx, json, 'fetch', error, `换取凭证失败（${result.status}）。`, result.status);
  }
  const pageId = body.page.id;
  const notes = await saveCredential(ctx.env, pageId, {
    server,
    wallId,
    credential: body.credential,
    createdAt: new Date().toISOString(),
  });
  await writeFileAtomic(join(ctx.cwd, WORKDIR_LINK_FILE), `${JSON.stringify({ server, wallId, pageId }, null, 2)}\n`);
  await writeFileAtomic(join(ctx.cwd, WORKDIR_CONTEXT_FILE), `${JSON.stringify(body.context, null, 2)}\n`);
  for (const note of notes) ctx.io.stderr(`${note}\n`);
  await ctx.reportEvent(ctx.cwd, 'fetch', { ok: true, durationMs: Date.now() - started });
  printSuccess(ctx, json, false, body.context, { server, wallId, pageId });
  return 0;
}

function printSuccess(ctx: CliContext, json: boolean, refreshed: boolean, context: AgentContext, link: { server: string; wallId: string; pageId: string }): void {
  if (json) {
    ctx.io.stdout(
      `${JSON.stringify({ command: 'fetch', refreshed, ok: true, workDir: ctx.cwd, ...link, credentialSaved: true, wall: context.wall, page: context.page }, null, 2)}\n`,
    );
    return;
  }
  const lines = [
    refreshed ? `nowme fetch：已刷新 ${WORKDIR_CONTEXT_FILE}` : `nowme fetch：已连接，工作目录 ${ctx.cwd}`,
    ...describeContext(context),
    '',
    '下一步：',
    `  1. 读场景指南 scenes/${context.wall.sceneType}.json（以及 ${WORKDIR_CONTEXT_FILE}）`,
    '  2. 开始采访主人，按 SKILL.md 的步骤收集 brief',
  ];
  ctx.io.stdout(`${lines.join('\n')}\n`);
}

async function refresh(ctx: CliContext, json: boolean, started: number): Promise<number> {
  const link = await readWorkdirLink(ctx.cwd);
  if (!link) {
    ctx.io.stderr(`当前目录 ${ctx.cwd} 没有 ${WORKDIR_LINK_FILE}。请先用应用里生成的指令运行 nowme fetch <wallId> <token> --server <url>。\n`);
    return 1;
  }
  const { store, notes } = await loadCredentialStore(ctx.env);
  for (const note of notes) ctx.io.stderr(`${note}\n`);
  const entry = store.pages[link.pageId];
  if (!entry?.credential) {
    ctx.io.stderr('本机没有这个页面的凭证。请在应用的创作工作区重新生成指令，再运行 nowme fetch <wallId> <token> --server <url>。\n');
    return 1;
  }
  let result: ApiResult;
  try {
    result = await apiRequest(link.server, '/api/agent/context', { method: 'GET', credential: entry.credential });
  } catch (error) {
    return networkFail(ctx, json, 'fetch', error);
  }
  if (result.status !== 200 || !isContext(result.body)) {
    const error = readApiError(result);
    if (result.status === 401) {
      return failWith(
        ctx,
        json,
        'fetch',
        error,
        '凭证已失效。可能原因：在应用内断开了连接、重新生成过指令、退出了这面墙、或墙已关闭。请在应用的创作工作区重新生成指令，再运行 nowme fetch <wallId> <token> --server <url>。',
        401,
      );
    }
    return failWith(ctx, json, 'fetch', error, `刷新失败（${result.status}）。`, result.status);
  }
  await writeFileAtomic(join(ctx.cwd, WORKDIR_CONTEXT_FILE), `${JSON.stringify(result.body, null, 2)}\n`);
  await ctx.reportEvent(ctx.cwd, 'fetch', { ok: true, durationMs: Date.now() - started });
  printSuccess(ctx, json, true, result.body, link);
  return 0;
}
