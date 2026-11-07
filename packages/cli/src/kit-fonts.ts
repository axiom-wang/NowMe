/**
 * 校验用的 Kit 字体清单。
 *
 * - 源码方式：读仓库里的 `packages/kit/fonts.json`（`loadKitFonts()`）；
 * - 随 Skill 包分发的单文件 CLI：包里没有 fonts.json，改用 `nowme fetch` 写下的 `context.json` 里的
 *   `kit.fonts`（就是服务端校验时用的那一份）。没有 context.json 时提示先运行 nowme fetch。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kitFontSchema, WORKDIR_CONTEXT_FILE, type KitFont } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { IS_BUNDLED } from './build-info.js';

export class KitFontsUnavailableError extends Error {}

/** 读 `<workDir>/context.json` 的 `kit.fonts`；没有或格式不对时返回 null。 */
export async function readContextKitFonts(workDir: string): Promise<KitFont[] | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(workDir, WORKDIR_CONTEXT_FILE), 'utf8'));
  } catch {
    return null;
  }
  const fonts = (raw as { kit?: { fonts?: unknown } } | null)?.kit?.fonts;
  if (!Array.isArray(fonts)) return null;
  const parsed = kitFontSchema.array().safeParse(fonts);
  return parsed.success ? parsed.data : null;
}

export async function resolveKitFonts(workDir: string, options: { bundled?: boolean } = {}): Promise<KitFont[]> {
  const bundled = options.bundled ?? IS_BUNDLED;
  if (!bundled) return loadKitFonts();
  const fonts = await readContextKitFonts(workDir);
  if (fonts) return fonts;
  throw new KitFontsUnavailableError(
    `${workDir} 里没有可用的 ${WORKDIR_CONTEXT_FILE}（校验需要其中的 Kit 字体清单）。请先在这个工作目录里运行 nowme fetch <wallId> <token> --server <url>。`,
  );
}
