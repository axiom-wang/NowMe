/**
 * 读取页面目录（validate / preview 共用）。
 */
import { stat } from 'node:fs/promises';
import { readPageDir, type PageDirFiles } from '@nowme/validator/node';
import type { CliContext } from './context.js';
import { resolvePageDir, workDirOf } from './workdir.js';

export interface LoadedPage {
  pageDir: string;
  workDir: string;
  files: PageDirFiles;
}

/** 解析并读取页面目录；目录不存在时抛出中文错误。 */
export async function loadPage(ctx: CliContext, dirArg: string | undefined): Promise<LoadedPage> {
  const pageDir = resolvePageDir(dirArg, ctx.cwd);
  let isDirectory = false;
  try {
    isDirectory = (await stat(pageDir)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new Error(`找不到页面目录：${pageDir}\n（相对路径按你执行命令时所在的目录 ${ctx.cwd} 解析；不写目录时默认是 page）`);
  }
  return { pageDir, workDir: workDirOf(pageDir), files: await readPageDir(pageDir) };
}
