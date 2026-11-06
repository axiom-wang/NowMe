/**
 * FORBIDDEN_ELEMENT（contracts 2.2）。
 */
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, makeSkeletonPage, run, summary } from '../fixtures.js';

const body = (html: string) => run(makeSkeletonPage({ body: html }));
const head = (html: string) => run(makeSkeletonPage({ head: html }));

describe('禁止的元素', () => {
  const ELEMENTS = [
    '<form><button>提交</button></form>',
    '<iframe srcdoc="<p>x</p>"></iframe>',
    '<object></object>',
    '<embed type="image/png">',
    '<portal></portal>',
    '<fencedframe></fencedframe>',
    '<IFRAME></IFRAME>',
  ];
  it.each(ELEMENTS)('%s', (html) => {
    const report = body(html);
    expect(codes(report), summary(report)).toContain('FORBIDDEN_ELEMENT');
    expect(issuesOf(report, 'FORBIDDEN_ELEMENT')[0]?.hint.length).toBeGreaterThan(10);
  });

  it('<frameset> / <frame>（整页用 frameset 代替 body 时浏览器才会创建它们）', () => {
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><frameset><frame src="assets/a.png"></frameset></html>';
    const files = makeSkeletonPage();
    files.set('index.html', new TextEncoder().encode(html));
    const found = issuesOf(run(files), 'FORBIDDEN_ELEMENT').map((issue) => issue.message).join('\n');
    expect(found).toContain('<frameset>');
    expect(found).toContain('<frame>');
  });

  it('<base>', () => {
    expect(codes(head('<base href="/">'))).toContain('FORBIDDEN_ELEMENT');
  });

  it('<meta http-equiv="refresh">（大小写不限）', () => {
    expect(codes(head('<meta http-equiv="refresh" content="0;url=https://evil.example">'))).toContain('FORBIDDEN_ELEMENT');
    expect(codes(head('<meta http-equiv="Refresh" content="5">'))).toContain('FORBIDDEN_ELEMENT');
  });

  it('<link> 除了指向 Kit 的 rel=stylesheet 一律禁止', () => {
    for (const html of [
      '<link rel="icon" href="assets/a.png">',
      '<link rel="preload" href="/_nowme/kit/v1/nowme.css" as="style">',
      '<link rel="prefetch" href="https://evil.example/x">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      '<link rel="stylesheet" href="assets/style.css">',
      '<link rel="alternate stylesheet" href="/_nowme/kit/v1/nowme.css">',
      '<link rel="stylesheet" href="_nowme/kit/v1/nowme.css">',
      '<link rel="modulepreload" href="/_nowme/kit/v1/nowme.js">',
    ]) {
      expect(codes(head(html)), html).toContain('FORBIDDEN_ELEMENT');
    }
  });

  it('<script src> 只能指向 Kit', () => {
    for (const html of [
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<script src="assets/app.js"></script>',
      '<script src="/app.js"></script>',
      '<script src="data:text/javascript,alert(1)"></script>',
      '<svg><script href="https://cdn.example.com/lib.js"></script></svg>',
    ]) {
      expect(codes(body(html)), html).toContain('FORBIDDEN_ELEMENT');
    }
  });

  it('importmap / speculationrules', () => {
    expect(codes(body('<script type="importmap">{"imports": {}}</script>'))).toContain('FORBIDDEN_ELEMENT');
    expect(codes(body('<script type="speculationrules">{"prefetch": []}</script>'))).toContain('FORBIDDEN_ELEMENT');
  });
});

describe('不误报', () => {
  it('Kit 样式与脚本、注释、转义文本、普通字符串', () => {
    const report = run(
      makeSkeletonPage({
        head: '<link rel="stylesheet" href="/_nowme/kit/v1/extra.css"><meta http-equiv="X-UA-Compatible" content="IE=edge">',
        body: [
          '<!-- <iframe src="https://example.com"></iframe> <form> -->',
          '<p>&lt;iframe&gt; 和 &lt;form&gt; 在这里不能用</p>',
          '<div class="form">不是表单</div>',
          '<script type="module" src="/_nowme/kit/v1/widgets.js"></script>',
        ].join('\n'),
        script: "const tip = '<iframe> 和 <form> 只是文字'; document.querySelector('p').textContent = tip;",
      }),
    );
    expect(codes(report), summary(report)).not.toContain('FORBIDDEN_ELEMENT');
    expect(report.errors, summary(report)).toEqual([]);
  });
});
