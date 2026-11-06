/**
 * 渲染测试的夹具：随仓库提交的小测试字体（不依赖 Kit 字体下载）、页面构造工具、Kit 字体可用性检查。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { KitFont, PageFiles } from '@nowme/contracts';
import { KIT_FONTS_DIR, kitFontSourcePath, loadKitFonts } from '@nowme/kit';

/** 测试字体所在目录（NotoSansSC-Regular-test-subset.otf，OFL-1.1，见同目录 OFL.txt）。 */
export const TEST_FONTS_DIR = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url));

/**
 * 测试字体清单：一款“中文字体”，family 用一个本机不可能装有的名字，
 * 这样字体没加载成功时页面一定会回退到别的字体（浏览器测试能发现）。
 * 字表：ASCII + “你好世界这是一个测试页面渲染字体子集未用到额外的我们，。！”。
 */
export const TEST_FONT: KitFont = {
  id: 'test-sans',
  family: 'Nowme Test Sans',
  cjk: true,
  weights: [400],
  license: 'OFL-1.1',
  sourceUrl: 'https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/SubsetOTF/SC/',
  files: { '400': 'NotoSansSC-Regular-test-subset.otf' },
};
export const TEST_KIT_FONTS: KitFont[] = [TEST_FONT];

const encoder = new TextEncoder();
export const text = (value: string): Uint8Array => encoder.encode(value);
export const json = (value: unknown): Uint8Array => text(`${JSON.stringify(value, null, 2)}\n`);
export const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());

export const CARD = {
  schemaVersion: 1,
  displayName: '测试',
  tagline: '一个测试页面',
  hooks: [
    { id: 'hello', kind: 'can-help', text: '你好世界', opener: '你好！' },
    { id: 'world', kind: 'looking-for', text: '测试页面', opener: '你好呀' },
  ],
};

export function manifest(fonts: { id: string; weights: number[] }[] = [], extraChars = '', blocks?: string[]) {
  return {
    schemaVersion: 1,
    sceneType: 'general',
    kitVersion: '1',
    motionLevel: 'calm',
    fonts,
    extraChars,
    ...(blocks ? { blocks } : {}),
    generator: { agent: 'test' },
  };
}

/** 一个完整的页面骨架；`body`、`head`、`script` 可替换。默认引入 Kit，带 3 个 data-nm-id。 */
export function pageHtml(parts: { head?: string; body?: string; script?: string; style?: string } = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>测试</title>
<link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">
<style>
body { margin: 0; }
${parts.style ?? ''}
</style>
${parts.head ?? ''}
</head>
<body>
${parts.body ?? '<section data-nm-id="hero"><h1>你好</h1></section>\n<section data-nm-id="about"><p>世界</p></section>\n<section data-nm-id="more"><p>测试</p></section>'}
<script src="/_nowme/kit/v1/nowme.js"></script>
<script>
${parts.script ?? ''}
</script>
</body>
</html>
`;
}

export function makeFiles(html: string, extra: { manifest?: unknown; files?: Record<string, Uint8Array> } = {}): PageFiles {
  const files: PageFiles = new Map();
  files.set('index.html', text(html));
  files.set('card.json', json(CARD));
  files.set('manifest.json', json(extra.manifest ?? manifest()));
  for (const [path, bytes] of Object.entries(extra.files ?? {})) files.set(path, bytes);
  return files;
}

/** served/ 映射：只有 index.html（渲染检查测试用，不需要字体）。 */
export function servedOf(html: string, extra: Record<string, Uint8Array> = {}): Map<string, Uint8Array> {
  return new Map([['index.html', text(html)], ...Object.entries(extra)]);
}

/** Kit 字体（已下载时）。 */
export const KIT_FONTS = loadKitFonts();

/** 这些字体字重的源文件是否都已下载（`pnpm --filter @nowme/kit fonts:fetch`）。 */
export function kitFontsAvailable(fonts: readonly { id: string; weights: readonly number[] }[]): boolean {
  return fonts.every((declared) => {
    const font = KIT_FONTS.find((item) => item.id === declared.id);
    if (!font) return false;
    return declared.weights.every((weight) => {
      const path = kitFontSourcePath(font, weight, KIT_FONTS_DIR);
      return path !== null && existsSync(path);
    });
  });
}

export const KIT_FONTS_MISSING_REASON = 'Kit 字体源文件未下载：先运行 pnpm --filter @nowme/kit fonts:fetch';
