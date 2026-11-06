/**
 * 非安全规则的细节：HTML 基本结构、data-nm-id、动效、字体、card / manifest、cover / assets、忽略的文件。
 */
import { describe, expect, it } from 'vitest';
import {
  KIT_FONTS,
  VALID_MANIFEST,
  codes,
  gif,
  issuesOf,
  jpeg,
  makePage,
  makeSkeletonPage,
  png,
  run,
  skeleton,
  summary,
  text,
  webp,
} from './fixtures.js';
import { PageDirFiles, validatePage } from '../src/index.js';

const html = (source: string) => {
  const files = makeSkeletonPage();
  files.set('index.html', text(source));
  return run(files);
};
const declared = (fonts: { id: string; weights: number[] }[]) => ({ manifest: { ...VALID_MANIFEST, fonts, blocks: undefined } });

describe('HTML 基本结构', () => {
  it('缺 doctype / charset / viewport / lang 一起报', () => {
    const report = html('<html><head><title>x</title></head><body><p data-nm-id="a">1</p><p data-nm-id="b">2</p><p data-nm-id="c">3</p></body></html>');
    expect(codes(report)).toEqual(expect.arrayContaining(['HTML_MISSING_DOCTYPE', 'HTML_MISSING_CHARSET', 'HTML_MISSING_VIEWPORT', 'HTML_MISSING_LANG']));
    expect(issuesOf(report, 'HTML_MISSING_LANG')[0]?.severity).toBe('warning');
  });

  it('charset 不是 utf-8', () => {
    const report = html(skeleton().replace('<meta charset="utf-8">', '<meta charset="gbk">'));
    expect(issuesOf(report, 'HTML_MISSING_CHARSET')[0]?.message).toContain('gbk');
  });

  it('http-equiv Content-Type 声明 utf-8 也可以', () => {
    const report = html(skeleton().replace('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'));
    expect(codes(report)).not.toContain('HTML_MISSING_CHARSET');
  });

  it('怪异模式的 doctype 不算', () => {
    const report = html(skeleton().replace('<!doctype html>', '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">'));
    expect(codes(report)).toContain('HTML_MISSING_DOCTYPE');
  });

  it('JS_SYNTAX_ERROR 带行号，事件属性也检查', () => {
    const files = makeSkeletonPage({ script: 'const a = 1;\nconst s = "没有结束;' });
    const source = new TextDecoder().decode(files.get('index.html'));
    const issue = issuesOf(run(files), 'JS_SYNTAX_ERROR')[0];
    expect(issue?.line).toBe(source.split('\n').findIndex((line) => line.includes('没有结束')) + 1);
    expect(issue?.message).toContain('字符串缺少结束引号');
    expect(codes(run(makeSkeletonPage({ body: '<button onclick="if (">x</button>' })))).toContain('JS_SYNTAX_ERROR');
    expect(codes(run(makeSkeletonPage({ body: '<script>import x from "/_nowme/kit/v1/a.js"</script>' })))).toContain('JS_SYNTAX_ERROR');
  });

  it('事件属性里可以 return，type="module" 可以用 import 与顶层 await', () => {
    const report = run(makeSkeletonPage({ body: '<a href="#x" onclick="event.preventDefault(); return false">x</a><script type="module">import "/_nowme/kit/v1/nowme.js"; await Promise.resolve();</script>' }));
    expect(report.errors, summary(report)).toEqual([]);
  });
});

describe('data-nm-id', () => {
  it('统计、重复与格式', () => {
    const report = run(makeSkeletonPage({ body: '<div data-nm-id="hero"></div><div data-nm-id="Bad Id"></div><div data-nm-id=""></div>' }));
    expect(issuesOf(report, 'NM_ID_INVALID')).toHaveLength(2);
    expect(issuesOf(report, 'NM_ID_DUPLICATE')[0]?.message).toContain('2 次');
    expect(report.stats.blocks).toEqual(['hero', 'projects', 'teammate']);
  });

  it('<template> 里的 data-nm-id 不算页面区块', () => {
    const source = skeleton({ body: '<template><div data-nm-id="hero"></div><div data-nm-id="x-1"></div></template>' });
    const report = html(source);
    expect(codes(report)).not.toContain('NM_ID_DUPLICATE');
    expect(report.stats.blocks).toEqual(['hero', 'projects', 'teammate']);
  });

  it('NM_BLOCKS_MISMATCH 说明两边的差异', () => {
    const report = run(makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, fonts: [], blocks: ['hero', 'contact'] } }));
    const issue = issuesOf(report, 'NM_BLOCKS_MISMATCH')[0];
    expect(issue?.message).toContain('contact');
    expect(issue?.message).toContain('projects');
    expect(issue?.severity).toBe('warning');
  });
});

describe('动效与 prefers-reduced-motion', () => {
  const css = (style: string, kitCss = false) => run(makeSkeletonPage({ kitCss, style }));

  it('没引入 nowme.css 的 CSS 动效需要媒体查询', () => {
    expect(codes(css('.a { transition: transform .3s; }'))).toContain('MOTION_WITHOUT_REDUCED');
    expect(codes(css('@keyframes pop { to { opacity: 1; } }'))).toContain('MOTION_WITHOUT_REDUCED');
    expect(codes(run(makeSkeletonPage({ kitCss: false, body: '<div style="animation: pop 1s">x</div>' })))).toContain('MOTION_WITHOUT_REDUCED');
  });

  it('引入 nowme.css（link 或 @import）即视为已处理', () => {
    expect(codes(css('.a { transition: transform .3s; }', true))).not.toContain('MOTION_WITHOUT_REDUCED');
    expect(codes(css('@import "/_nowme/kit/v1/nowme.css"; .a { transition: transform .3s; }'))).not.toContain('MOTION_WITHOUT_REDUCED');
  });

  it('自己写 prefers-reduced-motion（reduce 或 no-preference，或 <style media>）', () => {
    expect(codes(css('.a { transition: transform .3s; } @media (prefers-reduced-motion: reduce) { .a { transition: none; } }'))).not.toContain('MOTION_WITHOUT_REDUCED');
    expect(codes(css('@media (prefers-reduced-motion: no-preference) { .a { animation: pop 1s; } }'))).not.toContain('MOTION_WITHOUT_REDUCED');
    const report = run(makeSkeletonPage({ kitCss: false, head: '<style media="(prefers-reduced-motion: no-preference)">.a { animation: pop 1s; }</style>' }));
    expect(codes(report)).not.toContain('MOTION_WITHOUT_REDUCED');
  });

  it('transition: none / animation: none 不算动效', () => {
    expect(codes(css('.a { transition: none; animation: none; animation-name: none; }'))).not.toContain('MOTION_WITHOUT_REDUCED');
  });

  it('脚本动效需要检查 nowme.reducedMotion 或 prefers-reduced-motion', () => {
    for (const script of [
      'function loop() { requestAnimationFrame(loop); } requestAnimationFrame(loop);',
      "document.body.animate([{ opacity: 0 }, { opacity: 1 }], 500);",
      "const ctx = document.querySelector('canvas').getContext('2d'); setInterval(() => ctx.fillRect(0, 0, 1, 1), 16);",
      'window.requestAnimationFrame(() => {});',
      'new KeyframeEffect(document.body, [], 100);',
    ]) {
      const report = run(makeSkeletonPage({ script }));
      expect(codes(report), script).toContain('MOTION_WITHOUT_REDUCED');
      expect(issuesOf(report, 'MOTION_WITHOUT_REDUCED')[0]?.hint).toContain('nowme.reducedMotion');
    }
  });

  it('有检查就不报；注释里的检查与 CSS 媒体查询不算脚本检查', () => {
    const ok = [
      'if (!nowme.reducedMotion) requestAnimationFrame(() => {});',
      "const still = matchMedia('(prefers-reduced-motion: reduce)').matches; if (!still) requestAnimationFrame(() => {});",
    ];
    for (const script of ok) expect(codes(run(makeSkeletonPage({ script }))), script).not.toContain('MOTION_WITHOUT_REDUCED');
    const comment = run(makeSkeletonPage({ script: '// nowme.reducedMotion prefers-reduced-motion\nrequestAnimationFrame(() => {});' }));
    expect(codes(comment)).toContain('MOTION_WITHOUT_REDUCED');
    const cssOnly = run(makeSkeletonPage({ style: '@media (prefers-reduced-motion: reduce) { * { animation: none; } }', script: 'requestAnimationFrame(() => {});' }));
    expect(codes(cssOnly)).toContain('MOTION_WITHOUT_REDUCED');
  });

  it('一次性的 setTimeout 与不循环的 Canvas 不算动效', () => {
    const report = run(makeSkeletonPage({ script: "const ctx = document.querySelector('canvas').getContext('2d'); ctx.fillRect(0, 0, 1, 1); setTimeout(() => {}, 300);" }));
    expect(codes(report)).not.toContain('MOTION_WITHOUT_REDUCED');
  });
});

describe('字体', () => {
  const page = (style: string, fonts: { id: string; weights: number[] }[] = [], parts: Parameters<typeof makeSkeletonPage>[0] = {}) =>
    run(makeSkeletonPage({ ...parts, style }, declared(fonts)));

  it('var(--nm-font-<id>) 与 family 名（引号、大小写、无引号多词）都映射回字体 id', () => {
    const report = page('h1 { font-family: var(--nm-font-noto-serif-sc); } p { font-family: lxgw wenkai, serif; } b { font-family: "INTER"; }');
    expect(report.stats.fontsUsed).toEqual(['inter', 'lxgw-wenkai', 'noto-serif-sc']);
    expect(issuesOf(report, 'FONT_UNDECLARED').map((issue) => issue.message).join()).toContain('noto-serif-sc');
    expect(issuesOf(report, 'FONT_UNDECLARED')).toHaveLength(3);
  });

  it('font 简写、自定义属性、脚本字符串（Canvas）、SVG font-family 属性', () => {
    expect(page('h1 { font: italic 700 24px/1.2 "Noto Serif SC", serif; }').stats.fontsUsed).toEqual(['noto-serif-sc']);
    expect(page(':root { --title: "LXGW WenKai", serif; } h1 { font-family: var(--title); }').stats.fontsUsed).toEqual(['lxgw-wenkai']);
    expect(page('', [], { script: "canvas.getContext('2d').font = 'bold 20px \"Noto Serif SC\"';" }).stats.fontsUsed).toEqual(['noto-serif-sc']);
    expect(page('', [], { script: "el.style.fontFamily = 'var(--nm-font-inter)';" }).stats.fontsUsed).toEqual(['inter']);
    expect(page('', [], { body: '<svg><text font-family="LXGW WenKai">字</text></svg>' }).stats.fontsUsed).toEqual(['lxgw-wenkai']);
  });

  it('Kit 语义变量与系统字体栈不算清单字体，也不报警告', () => {
    const report = page('body { font-family: var(--nm-font-sans); } code { font: 14px var(--nm-font-mono); } h1 { font-family: Georgia, "Times New Roman", "Songti SC", SimSun, serif; } pre { font-family: Menlo, Consolas, "Courier New", monospace; } .ui { font: caption; }');
    expect(report.stats.fontsUsed).toEqual([]);
    expect(report.warnings, summary(report)).toEqual([]);
  });

  it('不认识的 --nm-font-<x> 在 font-family 里报警告，别处的 --nm-font-* 变量不管', () => {
    const report = page('h1 { font-family: var(--nm-font-comic), serif; } p { font-size: var(--nm-font-size-lg); }');
    const issues = issuesOf(report, 'FONT_NOT_IN_KIT');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('--nm-font-comic');
  });

  it('同一个不认识的字体名只报一次', () => {
    const report = page('h1 { font-family: "My Font"; } h2 { font-family: "my font", serif; }');
    expect(issuesOf(report, 'FONT_NOT_IN_KIT')).toHaveLength(1);
  });

  it('FONT_UNKNOWN：id 不在清单、字重不支持', () => {
    const report = run(makeSkeletonPage({}, declared([{ id: 'comic-sans', weights: [400] }, { id: 'lxgw-wenkai', weights: [400, 300] }])));
    const messages = issuesOf(report, 'FONT_UNKNOWN').map((issue) => issue.message);
    expect(messages).toHaveLength(2);
    expect(messages.join()).toContain('comic-sans');
    expect(messages.join()).toContain('300');
  });

  it('FONT_TOO_MANY_CJK 按字重计数，西文字体不算', () => {
    const report = run(makeSkeletonPage({}, declared([{ id: 'noto-serif-sc', weights: [400, 700, 900] }, { id: 'inter', weights: [400, 700] }])));
    expect(report.stats.cjkFontCount).toBe(3);
    expect(codes(report)).toContain('FONT_TOO_MANY_CJK');
  });

  it('manifest 不合法时仍按宽松读取检查字体', () => {
    const report = run(makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, blocks: undefined, motionLevel: 'wild', fonts: [{ id: 'nope', weights: [400] }] } }));
    expect(codes(report)).toEqual(expect.arrayContaining(['MANIFEST_INVALID', 'FONT_UNKNOWN']));
  });

  it('FONT_FACE_FORBIDDEN：转义的 @font-face、脚本里的 FontFace 与 @font-face 字符串', () => {
    // CSS 转义 \\61 后的空格结束十六进制序列（\\61ce 会被当成 U+61CE）
    expect(codes(page('@font-f\\61 ce { font-family: x; }'))).toContain('FONT_FACE_FORBIDDEN');
    expect(codes(page('', [], { script: "new FontFace('x', 'url(assets/x.woff2)');" }))).toContain('FONT_FACE_FORBIDDEN');
    expect(codes(page('', [], { script: "style.textContent = '@font-face { font-family: x }';" }))).toContain('FONT_FACE_FORBIDDEN');
  });
});

describe('card.json / manifest.json', () => {
  it('JSON 语法错误给出行号', () => {
    const report = run(makePage({ files: { 'card.json': '{\n  "schemaVersion": 1,\n}' } }));
    const issue = issuesOf(report, 'CARD_INVALID')[0];
    expect(issue?.line).toBe(3);
    expect(issue?.message).toContain('不是合法的 JSON');
  });

  it('字段问题翻译成中文并带路径', () => {
    const report = run(makePage({ card: { schemaVersion: 1, displayName: '阿柚', hooks: [{ id: 'A', text: '好', opener: 'x', extra: 1 }, { id: 'b', text: '你好', opener: 'y' }], foo: 1 } }));
    const messages = issuesOf(report, 'CARD_INVALID').map((issue) => issue.message).join('\n');
    expect(messages).toContain('card.json 的 tagline：缺少这个必填字段');
    expect(messages).toContain('hooks[0].id');
    expect(messages).toContain('hooks[0]：有不允许的字段：extra');
    expect(messages).toContain('有不允许的字段：foo');
    expect(messages).not.toMatch(/Invalid input|Unrecognized key/);
  });

  it('manifest 的枚举值与必填字段', () => {
    const { extraChars: _omit, ...withoutExtra } = VALID_MANIFEST;
    const report = run(makePage({ manifest: { ...withoutExtra, sceneType: 'party' }, rawManifest: true }));
    const messages = issuesOf(report, 'MANIFEST_INVALID').map((issue) => issue.message).join('\n');
    expect(messages).toContain('sceneType：取值不对');
    expect(messages).toContain('extraChars：缺少这个必填字段');
  });

  it('非 UTF-8', () => {
    const report = run(makePage({ files: { 'manifest.json': new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) } }));
    expect(issuesOf(report, 'MANIFEST_INVALID')[0]?.message).toContain('UTF-8');
  });
});

describe('cover.png 与 assets/', () => {
  it('cover.png：不是 PNG、尺寸不对、太大', () => {
    expect(issuesOf(run(makePage({ files: { 'cover.png': jpeg() } })), 'COVER_INVALID')[0]?.message).toContain('不是有效的 PNG');
    expect(issuesOf(run(makePage({ files: { 'cover.png': png(750, 999) } })), 'COVER_INVALID')[0]?.message).toContain('750×999');
    const big = new Uint8Array(600 * 1024 + 1);
    big.set(png(750, 1000));
    expect(issuesOf(run(makePage({ files: { 'cover.png': big } })), 'COVER_INVALID')[0]?.message).toContain('600 KB');
    expect(codes(run(makePage({ files: { 'cover.png': null } })))).not.toContain('COVER_INVALID');
  });

  it('魔数必须与扩展名一致（HTML 伪装成图片、PNG 改名成 .jpg）', () => {
    const report = run(
      makeSkeletonPage(
        { body: '<img src="assets/a.png" alt=""><img src="assets/b.jpg" alt=""><img src="assets/c.gif" alt=""><img src="assets/d.webp" alt="">' },
        { files: { 'assets/a.png': '<!doctype html><script>alert(1)</script>', 'assets/b.jpg': png(1, 1), 'assets/c.gif': gif(), 'assets/d.webp': webp() } },
      ),
    );
    const messages = issuesOf(report, 'ASSET_TYPE_FORBIDDEN').map((issue) => `${issue.file} ${issue.message}`);
    expect(messages).toHaveLength(2);
    expect(messages.join()).toContain('assets/a.png 的内容不是图片');
    expect(messages.join()).toContain('实际内容是 PNG');
  });

  it('不允许的类型：SVG、字体、HTML、脚本', () => {
    for (const name of ['assets/icon.svg', 'assets/font.woff2', 'assets/page.html', 'assets/app.js', 'assets/noext']) {
      const report = run(makeSkeletonPage({}, { files: { [name]: 'x' } }));
      expect(issuesOf(report, 'ASSET_TYPE_FORBIDDEN')[0]?.file, name).toBe(name);
    }
    expect(issuesOf(run(makeSkeletonPage({}, { files: { 'assets/icon.svg': '<svg/>' } })), 'ASSET_TYPE_FORBIDDEN')[0]?.hint).toContain('SVG 请直接内联');
  });

  it('文件名与目录层数', () => {
    for (const name of ['assets/Photo.png', 'assets/.hidden.png', 'assets/a b.png', 'assets/a/b/c.png', 'assets/-x.png']) {
      const report = run(makeSkeletonPage({}, { files: { [name]: png(1, 1) } }));
      expect(codes(report), name).toContain('ASSET_NAME_INVALID');
    }
  });

  it('合计体积上限', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i += 1) {
      const bytes = new Uint8Array(1.9 * 1024 * 1024);
      bytes.set(png(1, 1));
      files[`assets/p${i}.png`] = bytes;
    }
    const report = run(makeSkeletonPage({ body: Object.keys(files).map((path) => `<img src="${path}" alt="">`).join('') }, { files }));
    expect(issuesOf(report, 'ASSET_TOO_LARGE').map((issue) => issue.file)).toEqual(['assets/']);
  });

  it('ASSET_MISSING 带行号，CSS url() 与 srcset 里的引用也检查', () => {
    const report = run(makeSkeletonPage({ style: '.a { background: url(assets/bg.png); }', body: '<img srcset="assets/x-2x.png 2x" alt="">' }));
    expect(issuesOf(report, 'ASSET_MISSING').map((issue) => issue.message).join()).toMatch(/assets\/bg\.png[\s\S]*assets\/x-2x\.png|assets\/x-2x\.png[\s\S]*assets\/bg\.png/);
    expect(issuesOf(report, 'ASSET_MISSING').every((issue) => typeof issue.line === 'number')).toBe(true);
  });

  it('ASSET_UNUSED：被脚本字符串、data-* 属性引用的不算未使用', () => {
    const report = run(
      makeSkeletonPage(
        { body: '<div data-src="assets/lazy.png"></div>', script: "const photos = ['assets/a.jpg']; const tpl = `assets/b-${1}.png`;" },
        { files: { 'assets/lazy.png': png(1, 1), 'assets/a.jpg': jpeg(), 'assets/b-1.png': png(1, 1), 'assets/unused.png': png(1, 1) } },
      ),
    );
    expect(issuesOf(report, 'ASSET_UNUSED').map((issue) => issue.file)).toEqual(['assets/unused.png']);
  });
});

describe('IGNORED_FILE 与跳过的条目', () => {
  it('白名单外的文件列进 stats.ignoredFiles', () => {
    const report = run(makePage({ files: { 'brief.md': '#', 'draft/old.html': '<p>', '.DS_Store': 'x', 'Index.html': 'x' } }));
    expect(report.stats.ignoredFiles.sort()).toEqual(['.DS_Store', 'Index.html', 'brief.md', 'draft/old.html']);
    expect(issuesOf(report, 'IGNORED_FILE')).toHaveLength(4);
    expect(report.ok).toBe(true);
  });

  it('readPageDir 跳过的符号链接报 IGNORED_FILE', () => {
    const files = new PageDirFiles(makePage());
    files.skipped.push({ path: 'assets/link.png', reason: 'symlink' });
    const report = validatePage(files, { kitFonts: KIT_FONTS });
    const issue = issuesOf(report, 'IGNORED_FILE')[0];
    expect(issue?.message).toContain('符号链接');
    expect(report.stats.ignoredFiles).toEqual(['assets/link.png']);
  });
});
