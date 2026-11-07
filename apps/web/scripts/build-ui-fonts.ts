/**
 * 主站界面字体：`pnpm --filter @nowme/web fonts:build`
 *
 * 从 Kit 字体源文件（`packages/kit/fonts/`，先运行 `pnpm --filter @nowme/kit fonts:fetch`）生成主站用的 WOFF2 子集，
 * 写到 `static/`（提交进仓库，主站启动不依赖 Kit 字体源）：
 *
 * - `font-display.woff2`：得意黑（Smiley Sans，OFL-1.1），只用于界面里**写死的**标题文字。
 *   取字范围 = `src/` 下所有 .tsx 源码里出现的汉字与全角标点 + ASCII。改了界面文案（新增了汉字）要重新运行本脚本，
 *   否则新字会回退到系统字体。昵称、墙名等用户内容不要用 `.display` 字体。
 * - `font-grotesk-500.woff2`、`font-grotesk-700.woff2`：Space Grotesk（OFL-1.1），ASCII 与少量符号，用于数字、拉丁字母标题。
 * - `font-mono-500.woff2`：JetBrains Mono（OFL-1.1），ASCII，用于指令、验证码、联系方式。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKitFonts } from '@nowme/kit';
import { directoryFontSource, subsetFontFaces } from '@nowme/render';

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const SRC_DIR = join(PACKAGE_DIR, 'src');
const STATIC_DIR = join(PACKAGE_DIR, 'static');

const ASCII = Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCodePoint(0x20 + index)).join('');
const LATIN_EXTRA = '·—–“”‘’…→←↗×✓•';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

function displayText(): string {
  const chars = new Set<string>(ASCII + LATIN_EXTRA);
  for (const file of sourceFiles(SRC_DIR)) {
    for (const char of readFileSync(file, 'utf8')) {
      if (/[\p{Script=Han}　-〿＀-￯]/u.test(char)) chars.add(char);
    }
  }
  return [...chars].sort().join('');
}

const kitFonts = loadKitFonts();
function face(id: string, weight: number) {
  const font = kitFonts.find((item) => item.id === id);
  if (!font) throw new Error(`Kit 字体清单里没有 ${id}`);
  return { font, weight };
}

const jobs: { file: string; id: string; weight: number; text: string }[] = [
  { file: 'font-display.woff2', id: 'smiley-sans', weight: 400, text: displayText() },
  { file: 'font-grotesk-500.woff2', id: 'space-grotesk', weight: 500, text: ASCII + LATIN_EXTRA },
  { file: 'font-grotesk-700.woff2', id: 'space-grotesk', weight: 700, text: ASCII + LATIN_EXTRA },
  { file: 'font-mono-500.woff2', id: 'jetbrains-mono', weight: 500, text: ASCII + LATIN_EXTRA },
];

for (const job of jobs) {
  const result = await subsetFontFaces([face(job.id, job.weight)], job.text, directoryFontSource());
  if (result.missingSources.length > 0) {
    console.error(`缺少字体源文件 ${job.id} ${job.weight}。先运行：pnpm --filter @nowme/kit fonts:fetch`);
    process.exit(1);
  }
  const file = result.files[0]!;
  writeFileSync(join(STATIC_DIR, job.file), file.woff2);
  console.log(`${job.file}：${file.charCount} 个字，${(file.woff2.byteLength / 1024).toFixed(1)} KB`);
}
