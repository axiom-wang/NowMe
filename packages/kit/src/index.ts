/**
 * @nowme/kit：NOWMe Kit 的静态文件、清单与字体（contracts 0.2、1.1）。
 *
 * - 页面托管与本地预览把 `static/` 挂在 KIT_BASE_PATH（`/_nowme/kit/v1/`）下，只提供 KIT_STATIC_FILES 中的文件。
 * - `fonts.json`：Kit 字体清单（kitFontsFileSchema）；源文件由 `pnpm --filter @nowme/kit fonts:fetch` 下载到 `fonts/`（不入库）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_BASE_PATH, KIT_VERSION, kitFontsFileSchema, type KitFont } from '@nowme/contracts';
import { KIT_STATIC_FILES, type KitStaticFileName } from './catalog.js';
import { fontFilePath } from './fonts.js';

export { KIT_BASE_PATH, KIT_VERSION };
export * from './catalog.js';
export * from './fonts.js';

/** Kit 静态文件目录（`packages/kit/static/`）。本文件位于 `src/` 或 `dist/`，向上一级即包根。 */
export const KIT_STATIC_DIR = fileURLToPath(new URL('../static/', import.meta.url));
/** 字体清单文件（`packages/kit/fonts.json`）。 */
export const KIT_FONTS_FILE = fileURLToPath(new URL('../fonts.json', import.meta.url));
/** 字体源文件目录（由下载脚本获取，不入库）。 */
export const KIT_FONTS_DIR = fileURLToPath(new URL('../fonts/', import.meta.url));

/** 读取并校验 `fonts.json`。 */
export function loadKitFonts(file: string = KIT_FONTS_FILE): KitFont[] {
  const parsed = kitFontsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.fonts;
}

const STATIC_FILE_NAMES: ReadonlySet<string> = new Set(KIT_STATIC_FILES.map((file) => file.path));

/** 是否是 Kit 提供的静态文件名（例如 `nowme.css`）。页面托管只应提供这些文件。 */
export function isKitStaticFile(name: string): name is KitStaticFileName {
  return STATIC_FILE_NAMES.has(name);
}

/** Kit 静态文件的绝对路径。 */
export function kitStaticFilePath(name: KitStaticFileName): string {
  return join(KIT_STATIC_DIR, name);
}

/** 读取 Kit 静态文件内容。 */
export function readKitStaticFile(name: KitStaticFileName): Buffer {
  return readFileSync(kitStaticFilePath(name));
}

/** Kit 静态文件的 Content-Type。 */
export function kitStaticContentType(name: KitStaticFileName): string {
  const file = KIT_STATIC_FILES.find((item) => item.path === name);
  return file?.contentType ?? 'application/octet-stream';
}

/** 页面引用 Kit 文件用的根路径，例如 `/_nowme/kit/v1/nowme.css`。 */
export function kitFileUrl(name: KitStaticFileName): string {
  return `${KIT_BASE_PATH}${name}`;
}

/**
 * 把页面里的引用（`/_nowme/kit/v1/<name>`，可带 `?query` / `#hash`）解析成 Kit 文件名；
 * 不在 Kit 路径下或不是 Kit 提供的文件时返回 null。
 */
export function kitFileFromUrl(url: string): KitStaticFileName | null {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith(KIT_BASE_PATH)) return null;
  const name = path.slice(KIT_BASE_PATH.length);
  return isKitStaticFile(name) ? name : null;
}

/** 字重对应的本地字体源文件路径（`packages/kit/fonts/<文件名>`）；字重不在清单中时返回 null。 */
export function kitFontSourcePath(font: KitFont, weight: number, fontsDir: string = KIT_FONTS_DIR): string | null {
  return fontFilePath(font, weight, fontsDir);
}

/** 字体源文件是否已下载（只检查文件存在；格式检查用 detectFontFormat）。 */
export function hasKitFontSource(font: KitFont, weight: number, fontsDir: string = KIT_FONTS_DIR): boolean {
  const path = kitFontSourcePath(font, weight, fontsDir);
  return path !== null && existsSync(path);
}
