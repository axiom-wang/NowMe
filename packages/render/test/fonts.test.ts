/**
 * 字体子集化与 served/ 组装（不需要浏览器）。
 * 主要用例用随仓库提交的测试字体，全新克隆、未下载 Kit 字体时也能运行；依赖 Kit 字体的用例在字体缺失时跳过。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildServedFiles,
  collectSubsetText,
  directoryFontSource,
  fontFaceCss,
  fontSubsetPath,
  insertBeforeHeadEnd,
  planFontFaces,
  readCmapCodepoints,
  readNameRecords,
  readSfntTables,
  subsetFontFaces,
  toSfnt,
} from '../src/index.js';
import {
  KIT_FONTS,
  KIT_FONTS_MISSING_REASON,
  TEST_FONT,
  TEST_FONTS_DIR,
  TEST_KIT_FONTS,
  decode,
  kitFontsAvailable,
  makeFiles,
  manifest,
  pageHtml,
  text,
} from './helpers.js';

const readTestFont = directoryFontSource(TEST_FONTS_DIR);
const has = (codes: Set<number>, char: string) => codes.has(char.codePointAt(0) as number);

async function subsetCodepoints(woff2: Uint8Array): Promise<Set<number>> {
  expect(String.fromCharCode(...woff2.subarray(0, 4))).toBe('wOF2');
  return readCmapCodepoints(await toSfnt(woff2));
}

describe('测试夹具字体', () => {
  it('是带 OFL 授权信息的 OpenType 字体，字表很小', () => {
    const bytes = new Uint8Array(readFileSync(join(TEST_FONTS_DIR, TEST_FONT.files['400'] as string)));
    expect(bytes.byteLength).toBeLessThan(100 * 1024);
    expect(readSfntTables(bytes).has('CFF ')).toBe(true);
    const names = readNameRecords(bytes);
    expect(names.get(13)).toContain('SIL Open Font License');
    expect(names.get(0)).toContain('Adobe');
    const codes = readCmapCodepoints(bytes);
    for (const char of '你好世界未字额A z~') expect(has(codes, char), char).toBe(true);
    expect(has(codes, '鹅')).toBe(false);
    expect(readFileSync(join(TEST_FONTS_DIR, 'OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});

describe('collectSubsetText', () => {
  it('源码 + 渲染后文字 + extraChars 的并集，去重、按码点排序、去掉控制字符（保留空格）', () => {
    const result = collectSubsetText({ html: '<p>好 你\n</p>', renderedText: ['世界\t', 'AB'], extraChars: '额好' });
    expect(result).toBe(' /<>ABp世你好界额');
  });
});

describe('planFontFaces', () => {
  it('按声明展开字重；跳过清单外的 id 与字重、重复项', () => {
    const faces = planFontFaces(
      [
        { id: 'test-sans', weights: [400, 700, 400] },
        { id: 'nope', weights: [400] },
      ],
      TEST_KIT_FONTS,
    );
    expect(faces.map((face) => `${face.font.id}:${face.weight}`)).toEqual(['test-sans:400']);
  });
});

describe('subsetFontFaces（测试字体，无需下载）', () => {
  it('WOFF2 子集包含需要的字，不包含没用到的字；路径为 _fonts/<id>-<weight>.woff2', async () => {
    const result = await subsetFontFaces([{ font: TEST_FONT, weight: 400 }], '你好世界 Hi!', readTestFont);
    expect(result.missingSources).toEqual([]);
    const [file] = result.files;
    expect(file?.path).toBe('_fonts/test-sans-400.woff2');
    expect(fontSubsetPath('test-sans', 400)).toBe(file?.path);
    const codes = await subsetCodepoints(file?.woff2 as Uint8Array);
    for (const char of '你好世界 Hi!') expect(has(codes, char), char).toBe(true);
    for (const char of '未字额Z') expect(has(codes, char), char).toBe(false);
    expect(file?.charCount).toBe(codes.size);
    expect(file?.unsupportedChars).toBe('');
  });

  it('源字体没有的汉字记为 unsupportedChars（会回退到系统字体）', async () => {
    const result = await subsetFontFaces([{ font: TEST_FONT, weight: 400 }], '你好鹅', readTestFont);
    expect(result.files[0]?.unsupportedChars).toBe('鹅');
  });

  it('源文件缺失时列入 missingSources，不抛错', async () => {
    const result = await subsetFontFaces([{ font: TEST_FONT, weight: 400 }], '你好', directoryFontSource(join(TEST_FONTS_DIR, 'missing')));
    expect(result.files).toEqual([]);
    expect(result.missingSources).toEqual([{ fontId: 'test-sans', weight: 400, file: 'NotoSansSC-Regular-test-subset.otf' }]);
  });
});

describe('insertBeforeHeadEnd', () => {
  const style = '<style data-nowme-fonts>X</style>';

  it('插在真正的 </head> 前，不会误中脚本字符串里的 </head>', () => {
    const html = '<!doctype html><html><head><script>var s = "</head>";</script><title>t</title></head><body>b</body></html>';
    const out = insertBeforeHeadEnd(html, style);
    expect(out).toBe(html.replace('<title>t</title></head>', `<title>t</title>${style}</head>`));
  });

  it('省略 </head> 时插在 head 最后一个子节点之后；没有 head 时插在 body 前', () => {
    expect(insertBeforeHeadEnd('<!doctype html><meta charset="utf-8"><title>t</title><p>正文</p>', style)).toBe(
      `<!doctype html><meta charset="utf-8"><title>t</title>${style}<p>正文</p>`,
    );
    expect(insertBeforeHeadEnd('<!doctype html><p>正文</p>', style)).toBe(`<!doctype html>${style}<p>正文</p>`);
  });

  it('@font-face 规则不含换行：注入后页面其他内容的行号不变', () => {
    const css = fontFaceCss([
      { family: 'A', weight: 400, path: '_fonts/a-400.woff2' },
      { family: 'B', weight: 700, path: '_fonts/b-700.woff2' },
    ]);
    expect(css).not.toContain('\n');
    expect(css).toBe(
      '@font-face{font-family:"A";src:url("_fonts/a-400.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}' +
        '@font-face{font-family:"B";src:url("_fonts/b-700.woff2") format("woff2");font-weight:700;font-style:normal;font-display:swap}',
    );
  });
});

describe('buildServedFiles', () => {
  it('served/index.html 在 </head> 前注入相对路径的 @font-face；_fonts 子集、assets 原样复制；系统文件与其他文件不进 served/', async () => {
    const html = pageHtml({ style: 'body { font-family: "Nowme Test Sans", sans-serif; }', body: '<section data-nm-id="hero"><h1>你好世界</h1></section>' });
    const png = text('not really a png');
    const files = makeFiles(html, {
      manifest: manifest([{ id: 'test-sans', weights: [400] }], '额'),
      files: { 'assets/a.png': png, 'assets/.DS_Store': text('x'), 'brief.md': text('# 私密'), 'cover.png': png },
    });
    const build = await buildServedFiles({ files, kitFonts: TEST_KIT_FONTS, readFontSource: readTestFont });
    expect([...build.served.keys()].sort()).toEqual(['_fonts/test-sans-400.woff2', 'assets/a.png', 'index.html']);
    expect(build.served.get('assets/a.png')).toBe(png);
    const served = decode(build.served.get('index.html'));
    const injected =
      '<style data-nowme-fonts>@font-face{font-family:"Nowme Test Sans";src:url("_fonts/test-sans-400.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}</style></head>';
    expect(served).toContain(injected);
    expect(served.replace('<style data-nowme-fonts>', '').replace(/@font-face\{[^}]*\}<\/style>/, '')).toBe(html);
    expect(served.split('\n').length).toBe(html.split('\n').length);
    // 取字范围：源码全部字符 + extraChars（“额”只在 manifest 里）
    const codes = await subsetCodepoints(build.served.get('_fonts/test-sans-400.woff2') as Uint8Array);
    for (const char of '你好世界测试额') expect(has(codes, char), char).toBe(true);
    expect(has(codes, '未')).toBe(false);
    expect(build.subsetText).toContain('额');
  });

  it('没有声明字体时不注入；manifest 不合法时当作没有字体', async () => {
    const html = pageHtml();
    for (const manifestBytes of [text('{ 不是 JSON'), text(JSON.stringify(manifest()))]) {
      const files = makeFiles(html);
      files.set('manifest.json', manifestBytes);
      const build = await buildServedFiles({ files, kitFonts: TEST_KIT_FONTS, readFontSource: readTestFont });
      expect(decode(build.served.get('index.html'))).toBe(html);
      expect(build.fonts.files).toEqual([]);
    }
  });

  it('没有 index.html 时 served/ 为空', async () => {
    const files = makeFiles('');
    files.delete('index.html');
    const build = await buildServedFiles({ files, kitFonts: TEST_KIT_FONTS, readFontSource: readTestFont });
    expect(build.served.size).toBe(0);
  });
});

describe('Kit 字体子集化（需要已下载的 Kit 字体）', () => {
  const declared = [{ id: 'lxgw-wenkai', weights: [400] }, { id: 'inter', weights: [400] }];
  it.skipIf(!kitFontsAvailable(declared))(`中文与西文字体都能子集化，包含用到的字、不包含没用到的字（${KIT_FONTS_MISSING_REASON}）`, async () => {
    const faces = planFontFaces(declared, KIT_FONTS);
    const result = await subsetFontFaces(faces, '霞鹜文楷 Hello', directoryFontSource());
    expect(result.files.map((file) => file.path)).toEqual(['_fonts/lxgw-wenkai-400.woff2', '_fonts/inter-400.woff2']);
    const wenkai = await subsetCodepoints(result.files[0]?.woff2 as Uint8Array);
    for (const char of '霞鹜文楷Hello') expect(has(wenkai, char), char).toBe(true);
    expect(has(wenkai, '龙')).toBe(false);
    expect(result.files[0]?.woff2.byteLength).toBeLessThan(60 * 1024);
    const inter = await subsetCodepoints(result.files[1]?.woff2 as Uint8Array);
    expect(has(inter, 'H')).toBe(true);
    expect(has(inter, 'Q')).toBe(false);
  });
});
