/**
 * 重新生成测试夹具字体 `NotoSansSC-Regular-test-subset.otf`（只在需要改字表时手动运行）：
 *
 *   pnpm --filter @nowme/kit fonts:fetch   # 先下载 Kit 字体源文件
 *   pnpm exec tsx --conditions=source packages/render/test/fixtures/fonts/make-test-font.ts
 *
 * 来源：Noto Sans SC Regular（Kit 清单中的 noto-sans-sc，notofonts/noto-cjk 523d033），SIL Open Font License 1.1，
 * 版权与授权见同目录 OFL.txt（name 表中的版权、授权记录也保留在字体里）。Noto Sans SC 没有保留字体名，
 * 子集化后的修改版沿用原名是允许的。字表很小（ASCII + 下面这些汉字），让子集化测试在全新克隆、
 * 没有下载 Kit 字体时也能运行。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { subsetFont } from '../../../src/font-libs.js';

/** 夹具字体里的汉字与标点（测试页面只用其中一部分，“未”等字故意不用）。 */
const TEST_FONT_CJK = '你好世界这是一个测试页面渲染字体子集未用到额外的我们，。！';

const ascii = Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)).join('');
const source = fileURLToPath(new URL('../../../../kit/fonts/NotoSansSC-Regular.otf', import.meta.url));
const target = fileURLToPath(new URL('./NotoSansSC-Regular-test-subset.otf', import.meta.url));

const subset = await subsetFont(readFileSync(source), ascii + TEST_FONT_CJK, {
  targetFormat: 'sfnt',
  preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14],
});
writeFileSync(target, subset);
console.log(`${target}: ${subset.byteLength} 字节`);
