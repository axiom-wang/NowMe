/**
 * 把 CLI 打成随 Skill 包分发的单文件 `scripts/nowme.mjs`（contracts 1.5、4.5）。由 `@nowme/skill` 打包时调用。
 *
 * - 入口 bundle-entry.ts：不含 `@nowme/render` / Playwright（preview 走服务端渲染）；
 * - 按 `source` 条件解析工作区包（直接打 TS 源码，不需要先 build）；
 * - `__NOWME_SKILL_VERSION__` 替换成 Skill 版本；
 * - 依赖里有 CommonJS 模块（postcss 等）会 `require` Node 内置模块，ESM 产物里用 createRequire 补一个 `require`。
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const BUNDLE_ENTRY = fileURLToPath(new URL('./bundle-entry.ts', import.meta.url));

export interface BundleCliResult {
  bytes: number;
  /** 打进产物的输入文件（相对仓库的路径），供测试检查没有带进 Playwright。 */
  inputs: string[];
}

export async function bundleCli(outFile: string, options: { skillVersion: string }): Promise<BundleCliResult> {
  const result = await build({
    entryPoints: [BUNDLE_ENTRY],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    conditions: ['source'],
    define: { __NOWME_SKILL_VERSION__: JSON.stringify(options.skillVersion) },
    banner: {
      js: "import { createRequire as __nowmeCreateRequire } from 'node:module';\nconst require = __nowmeCreateRequire(import.meta.url);",
    },
    // 可读性优先于体积：只去空白，保留标识符，出错时堆栈还能看懂
    minifyWhitespace: true,
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
  });
  const output = Object.values(result.metafile.outputs)[0];
  return { bytes: output?.bytes ?? 0, inputs: Object.keys(result.metafile.inputs) };
}
