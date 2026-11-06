/**
 * `nowme status [--json]`：工作目录、关联的墙与页面、凭证是否存在（不显示内容）。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKDIR_CONTEXT_FILE, WORKDIR_LINK_FILE, WORKDIR_PAGE_DIR } from '@nowme/contracts';
import type { ParsedArgs } from '../args.js';
import type { CliContext } from '../context.js';
import { loadCredentialStore } from '../credentials.js';
import { readWorkdirLink } from '../events.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runStatus(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const json = args.flags.get('json') === true;
  if (args.positionals.length > 0) {
    ctx.io.stderr('用法：nowme status [--json]\n');
    return 1;
  }
  const link = await readWorkdirLink(ctx.cwd);
  const { store, notes } = await loadCredentialStore(ctx.env);
  for (const note of notes) ctx.io.stderr(`${note}\n`);
  const credential = link ? Boolean(store.pages[link.pageId]?.credential) : false;
  const pageDirExists = await exists(join(ctx.cwd, WORKDIR_PAGE_DIR));
  const contextExists = await exists(join(ctx.cwd, WORKDIR_CONTEXT_FILE));
  if (json) {
    ctx.io.stdout(`${JSON.stringify({ command: 'status', workDir: ctx.cwd, linked: link !== null, link, credential, pageDirExists, contextExists }, null, 2)}\n`);
    return 0;
  }
  const lines = [`工作目录：${ctx.cwd}`];
  if (link) {
    lines.push(`服务器：${link.server}`, `墙：${link.wallId}`, `页面：${link.pageId}`);
    lines.push(`凭证：${credential ? '已保存在本机' : '没有（请重新生成指令并 nowme fetch）'}`);
  } else {
    lines.push(`尚未关联：当前目录没有 ${WORKDIR_LINK_FILE}，请用应用里的指令运行 nowme fetch <wallId> <token> --server <url>`);
  }
  lines.push(`${WORKDIR_CONTEXT_FILE}：${contextExists ? '有' : '没有'}`, `${WORKDIR_PAGE_DIR}/：${pageDirExists ? '有' : '没有'}`);
  ctx.io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
