/**
 * 本地工作目录（contracts 1.5）：`<工作目录>/page/` 是页面，`nowme.json`、`context.json`、`brief.md` 在工作目录里，
 * `nowme preview` 的产物写到 `<工作目录>/.nowme-preview/`（不写进 page/）。
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_NOWME_HOME_DIR_NAME, WORKDIR_PAGE_DIR } from '@nowme/contracts';

/** `nowme preview` 产物目录名（在工作目录下）。 */
export const PREVIEW_OUTPUT_DIR = '.nowme-preview';

/**
 * 用户执行命令时所在的目录。通过 `pnpm --dir <仓库> nowme ...` 运行时进程的 cwd 是仓库根，
 * pnpm 会把用户当时的目录放在 `INIT_CWD` 里，因此优先用它。
 */
export function userCwd(env: NodeJS.ProcessEnv, fallback: string = process.cwd()): string {
  const init = env.INIT_CWD;
  return init && isAbsolute(init) ? init : fallback;
}

/** 页面目录的绝对路径（参数缺省为 `page`，相对路径按用户目录解析）。 */
export function resolvePageDir(arg: string | undefined, cwd: string): string {
  return resolve(cwd, arg ?? WORKDIR_PAGE_DIR);
}

/** 工作目录 = 页面目录的上一级。 */
export function workDirOf(pageDir: string): string {
  return dirname(pageDir);
}

/** `~/.nowme`（`NOWME_HOME` 可改）。 */
export function nowmeHome(env: NodeJS.ProcessEnv): string {
  const home = env.NOWME_HOME;
  return home && isAbsolute(home) ? home : join(homedir(), DEFAULT_NOWME_HOME_DIR_NAME);
}
