/**
 * 版本与运行方式（contracts 1.5、4.5）。
 *
 * - 源码方式（`pnpm nowme`、`tsx`）与 `dist/`：不知道 Skill 版本，`BUNDLED_SKILL_VERSION` 为 null；
 * - 随 Skill 包分发的单文件 `scripts/nowme.mjs`：打包时用 esbuild 的 `define` 把 `__NOWME_SKILL_VERSION__`
 *   替换成 Skill 版本字符串（见 bundle.ts）。
 */

/** CLI 版本。 */
export const CLI_VERSION = '0.1.0';

declare const __NOWME_SKILL_VERSION__: string | undefined;

/** 随 Skill 包分发时的 Skill 版本；源码方式运行时为 null。 */
export const BUNDLED_SKILL_VERSION: string | null =
  typeof __NOWME_SKILL_VERSION__ === 'string' ? __NOWME_SKILL_VERSION__ : null;

/** 是否是随 Skill 包分发的单文件 CLI（没有 Playwright，preview 走服务端渲染）。 */
export const IS_BUNDLED = BUNDLED_SKILL_VERSION !== null;

/** `nowme --version` 的输出。 */
export function versionLine(): string {
  return BUNDLED_SKILL_VERSION ? `nowme ${CLI_VERSION} · NOWMe Skill ${BUNDLED_SKILL_VERSION}` : `nowme ${CLI_VERSION}（源码方式运行）`;
}
