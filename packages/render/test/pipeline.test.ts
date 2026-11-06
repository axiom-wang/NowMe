/**
 * buildRevision 全流程（测试字体随仓库提交，不需要下载 Kit 字体）：
 * 静态校验 → 字体子集 → 双源沙箱渲染 → 渲染后补字 → 封面 / 整页 / 减少动效 / 分块截图 → 合并报告。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COVER_HEIGHT, COVER_MAX_BYTES, COVER_WIDTH } from '@nowme/contracts';
import { validatePage } from '@nowme/validator';
import { buildRevision, coverIssues, createRenderer, directoryFontSource, pngSize, readCmapCodepoints, toSfnt, type Renderer } from '../src/index.js';
import { TEST_FONTS_DIR, TEST_KIT_FONTS, decode, makeFiles, manifest, pageHtml, text } from './helpers.js';

let renderer: Renderer;
beforeAll(async () => {
  renderer = await createRenderer();
}, 60_000);
afterAll(async () => {
  await renderer?.close();
});

const fontSource = TEST_FONTS_DIR;
const has = (codes: Set<number>, char: string) => codes.has(char.codePointAt(0) as number);

/**
 * 合法页面：正文用测试字体；脚本用码点算出“字”（源码里没有这个字），渲染后才出现，
 * 用来验证“渲染后文字”并入子集；脚本在字体加载完成后写出 FONT-OK / FONT-MISSING。
 * 注意：页面源码里不能出现“未”和“字”。
 */
const VALID_HTML = pageHtml({
  style: 'body { font-family: "Nowme Test Sans", sans-serif; } .tall { height: 900px; }',
  body: `<section data-nm-id="hero"><h1>你好世界</h1><p>这是一个测试页面</p></section>
<section data-nm-id="about" class="tall"><p id="generated"></p><p id="font-state">...</p></section>
<section data-nm-id="more"><p class="nm-reveal">我们</p></section>`,
  script: `document.getElementById('generated').textContent = String.fromCodePoint(0x5b57) + '体';
document.fonts.ready.then(() => {
  const loaded = Array.from(document.fonts).some((face) => face.family.replace(/"/g, '') === 'Nowme Test Sans' && face.status === 'loaded');
  document.getElementById('font-state').textContent = loaded ? 'FONT-OK' : 'FONT-MISSING';
});`,
});

describe('buildRevision（preview 模式）', () => {
  it('合法页面：0 个问题；字体子集含渲染后才出现的字、不含没用到的字；字体在沙箱里真的加载了；封面合规', async () => {
    expect(VALID_HTML).not.toContain('未');
    expect(VALID_HTML).not.toContain('字');
    const files = makeFiles(VALID_HTML, { manifest: manifest([{ id: 'test-sans', weights: [400] }], '体', ['hero', 'about', 'more']) });
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource });

    expect([...result.report.errors, ...result.report.warnings]).toEqual([]);
    expect(result.report.ok).toBe(true);
    expect(result.rendered).toBe(true);
    expect(result.renderedText).toContain('你好世界');
    expect(result.renderedText).toContain('字体');
    expect(result.renderedText).toContain('FONT-OK');
    expect(result.metrics.resubset).toBe(true);
    expect(result.metrics.renderPasses).toBe(4);

    // served/：注入相对路径的 @font-face；子集包含页面用到的字与渲染后才出现的“字”，不包含“未”
    const served = decode(result.served.get('index.html'));
    expect(served).toContain('src:url("_fonts/test-sans-400.woff2") format("woff2")');
    expect(served.indexOf('<style data-nowme-fonts>')).toBeLessThan(served.indexOf('</head>'));
    const woff2 = result.served.get('_fonts/test-sans-400.woff2') as Uint8Array;
    const codes = readCmapCodepoints(await toSfnt(woff2));
    for (const char of '你好世界这是一个测试页面我们字体FONT-OK') expect(has(codes, char), char).toBe(true);
    expect(has(codes, '未')).toBe(false);
    expect(result.fonts).toEqual([
      expect.objectContaining({ fontId: 'test-sans', weight: 400, path: '_fonts/test-sans-400.woff2', bytes: woff2.byteLength, unsupportedChars: '' }),
    ]);

    // 封面：750×1000、≤ 600 KB、通过校验器的 COVER 检查
    expect(result.coverGenerated).toBe(true);
    const cover = result.cover as Uint8Array;
    expect(pngSize(cover)).toEqual({ width: COVER_WIDTH, height: COVER_HEIGHT });
    expect(cover.byteLength).toBeLessThanOrEqual(COVER_MAX_BYTES);
    expect(coverIssues(cover)).toEqual([]);
    const withCover = new Map(files);
    withCover.set('cover.png', cover);
    expect(validatePage(withCover, { kitFonts: TEST_KIT_FONTS }).errors).toEqual([]);

    // 整页（内容高度）、减少动效整页、分块截图
    const full = pngSize(result.fullScreenshot as Uint8Array);
    expect(full?.width).toBe(750);
    expect(full?.height).toBe((result.metrics.fullHeight ?? 0) * 2);
    expect(result.metrics.fullHeight).toBeGreaterThan(1000);
    expect(pngSize(result.reducedMotionScreenshot as Uint8Array)?.width).toBe(750);
    expect(result.blockScreenshots.map((block) => block.id)).toEqual(['hero', 'about', 'more']);
    for (const block of result.blockScreenshots) expect(pngSize(block.png)?.height).toBe(block.height * 2);
  }, 90_000);

  it('页面自带合格的 cover.png 时沿用；forceCover 时重新截图', async () => {
    const files = makeFiles(pageHtml());
    const first = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource, reducedMotionScreenshot: false, blockScreenshots: false });
    const cover = first.cover as Uint8Array;
    files.set('cover.png', cover);
    const reuse = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource, reducedMotionScreenshot: false, blockScreenshots: false });
    expect(reuse.coverGenerated).toBe(false);
    expect(reuse.cover).toBe(cover);
    const forced = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource, forceCover: true, reducedMotionScreenshot: false, blockScreenshots: false });
    expect(forced.coverGenerated).toBe(true);
    expect(forced.cover).not.toBe(cover);
  }, 60_000);

  it('静态校验有错误时预览照样渲染：报告同时含静态错误与 RENDER_* 问题', async () => {
    const files = makeFiles(pageHtml({ body: '<p>你好</p><img src="https://example.com/a.png" alt="">' }));
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource, blockScreenshots: false });
    expect(result.rendered).toBe(true);
    const codes = result.report.errors.map((issue) => issue.code);
    expect(codes).toContain('EXTERNAL_RESOURCE');
    expect(codes).toContain('RENDER_CSP_VIOLATION');
    expect(result.report.ok).toBe(false);
    expect(result.staticReport.errors.map((issue) => issue.code)).not.toContain('RENDER_CSP_VIOLATION');
    expect(result.cover).not.toBeNull();
  }, 60_000);

  it('减少动效时才出现的问题带“（减少动态效果时）”前缀', async () => {
    const files = makeFiles(pageHtml({ body: '<p>你好</p>', script: "if (matchMedia('(prefers-reduced-motion: reduce)').matches) console.error('静态模式出错');" }));
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource, blockScreenshots: false });
    const issue = result.report.warnings.find((item) => item.code === 'RENDER_CONSOLE_ERROR');
    expect(issue?.message.startsWith('（减少动态效果时）')).toBe(true);
  }, 60_000);

  it('preview 模式下字体源文件缺失：跳过并列出，不抛错', async () => {
    const files = makeFiles(pageHtml(), { manifest: manifest([{ id: 'test-sans', weights: [400] }]) });
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', renderer, fontSource: `${TEST_FONTS_DIR}/missing`, reducedMotionScreenshot: false, blockScreenshots: false });
    expect(result.missingFontSources).toEqual([{ fontId: 'test-sans', weight: 400, file: 'NotoSansSC-Regular-test-subset.otf' }]);
    expect(result.fonts).toEqual([]);
    expect(decode(result.served.get('index.html'))).not.toContain('@font-face');
  }, 60_000);
});

describe('buildRevision（submit 模式，主站提交管线）', () => {
  it('静态校验有错误：不渲染，直接返回静态报告', async () => {
    const files = makeFiles(pageHtml({ script: "fetch('https://example.com');" }));
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, renderer, fontSource });
    expect(result.rendered).toBe(false);
    expect(result.report).toBe(result.staticReport);
    expect(result.report.errors.map((issue) => issue.code)).toContain('FORBIDDEN_API');
    expect(result.served.size).toBe(0);
    expect(result.cover).toBeNull();
  });

  it('合法页面：默认不截减少动效图与分块图；字体源缺失时抛错（服务器配置问题）', async () => {
    const files = makeFiles(pageHtml(), { manifest: manifest([{ id: 'test-sans', weights: [400] }]) });
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, renderer, fontSource: directoryFontSource(TEST_FONTS_DIR) });
    expect(result.report.ok).toBe(true);
    expect(result.rendered).toBe(true);
    expect(result.reducedMotionScreenshot).toBeNull();
    expect(result.blockScreenshots).toEqual([]);
    expect(result.fullScreenshot).not.toBeNull();
    expect([...result.served.keys()].sort()).toEqual(['_fonts/test-sans-400.woff2', 'index.html']);
    await expect(buildRevision({ files, kitFonts: TEST_KIT_FONTS, renderer, fontSource: `${TEST_FONTS_DIR}/missing` })).rejects.toThrow('fonts:fetch');
  }, 60_000);

  it('渲染错误让报告不通过（服务端存为 rejected）', async () => {
    const files = makeFiles(pageHtml({ script: "document.getElementById('nope').remove();" }));
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, renderer, fontSource });
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.map((issue) => issue.code)).toEqual(['RENDER_SCRIPT_ERROR']);
  }, 60_000);

  it('不传 renderer 时临时创建并关闭', async () => {
    const files = makeFiles(pageHtml());
    files.set('assets/a.png', text('x'));
    const result = await buildRevision({ files, kitFonts: TEST_KIT_FONTS, mode: 'preview', fontSource, reducedMotionScreenshot: false, blockScreenshots: false });
    expect(result.rendered).toBe(true);
    expect(result.served.has('assets/a.png')).toBe(true);
  }, 60_000);
});
