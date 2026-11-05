/**
 * @nowme/kit：NOWMe Kit 的静态文件与字体清单（contracts 0.2、1.1）。
 *
 * 占位（T0.2）：`static/nowme.css`、`static/nowme.js` 与 `fonts.json` 的内容由 T1.2 实现。
 * 页面托管把 `static/` 挂在 KIT_BASE_PATH（`/_nowme/kit/v1/`）下。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KIT_BASE_PATH, KIT_VERSION, kitFontsFileSchema, type KitFont } from '@nowme/contracts';

export { KIT_BASE_PATH, KIT_VERSION };

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
