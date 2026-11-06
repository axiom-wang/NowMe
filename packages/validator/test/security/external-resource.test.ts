/**
 * EXTERNAL_RESOURCE（contracts 1.1、2.2）：页面只能引用 assets/<file>、Kit 根路径、data:image/*、#...、blob:。
 */
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, jpeg, makeSkeletonPage, png, run, summary } from '../fixtures.js';

const body = (html: string, files: Record<string, Uint8Array | string | null> = {}) => run(makeSkeletonPage({ body: html }, { files }));
const style = (css: string, files: Record<string, Uint8Array | string | null> = {}) => run(makeSkeletonPage({ style: css }, { files }));

describe('资源属性', () => {
  const ATTRS: [string, string][] = [
    ['img src', '<img src="https://cdn.example.com/a.png" alt="">'],
    ['img srcset', '<img srcset="https://cdn.example.com/a.png 2x" alt="">'],
    ['source srcset', '<picture><source srcset="//cdn.example.com/a.webp"><img src="assets/a.png" alt=""></picture>'],
    ['video poster', '<video poster="https://cdn.example.com/p.jpg"></video>'],
    ['audio src', '<audio src="https://cdn.example.com/a.mp3"></audio>'],
    ['body background', '<table background="https://cdn.example.com/bg.png"><tr><td>x</td></tr></table>'],
    ['svg image xlink:href', '<svg><image xlink:href="https://cdn.example.com/a.png"/></svg>'],
    ['input type=image src', '<input type="image" src="https://cdn.example.com/a.png" alt="x">'],
    ['button formaction', '<button formaction="https://evil.example/collect">x</button>'],
    ['track src', '<video><track src="https://cdn.example.com/t.vtt"></video>'],
  ];
  it.each(ATTRS)('%s', (_label, html) => {
    const report = body(html, { 'assets/a.png': png(1, 1) });
    expect(codes(report), summary(report)).toContain('EXTERNAL_RESOURCE');
  });

  it('object data / form action / iframe src 同时报 FORBIDDEN_ELEMENT 与 EXTERNAL_RESOURCE', () => {
    for (const html of [
      '<object data="https://evil.example/x.swf"></object>',
      '<form action="https://evil.example/collect"></form>',
      '<iframe src="https://evil.example"></iframe>',
    ]) {
      const report = body(html);
      expect(codes(report), html).toContain('FORBIDDEN_ELEMENT');
      expect(codes(report), html).toContain('EXTERNAL_RESOURCE');
    }
  });

  const SCHEMES = ['http://example.com/a.png', 'https://example.com/a.png', '//example.com/a.png', 'ws://example.com/a', 'wss://example.com/a', 'file:///etc/passwd', 'ftp://example.com/a.png', 'about:blank'];
  it.each(SCHEMES)('协议 %s', (url) => {
    expect(codes(body(`<img src="${url}" alt="">`))).toContain('EXTERNAL_RESOURCE');
  });

  it('javascript: 地址', () => {
    const report = body('<img src="javascript:alert(1)" alt="">');
    expect(issuesOf(report, 'EXTERNAL_RESOURCE')[0]?.message).toContain('javascript:');
  });

  it('白名单外的相对路径：message 说清楚只能引用 assets/ 或 Kit', () => {
    for (const url of ['img/x.png', '../assets/x.png', '/assets/x.png', 'x.png', '/_nowme/other/x.css', 'cover.png']) {
      const report = body(`<img src="${url}" alt="">`);
      const issue = issuesOf(report, 'EXTERNAL_RESOURCE')[0];
      expect(issue, url).toBeDefined();
      expect(issue?.message).toContain('只能引用 assets/');
      expect(issue?.message).toContain('Kit');
      expect(issue?.hint).toContain('assets/');
    }
  });

  it('data: 只允许图片；字体 data URI 报 FONT_FACE_FORBIDDEN', () => {
    expect(codes(body('<img src="data:text/html,&lt;script&gt;" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="data:,hello" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style('.a { background: url(data:font/woff2;base64,AAAA); }'))).toContain('FONT_FACE_FORBIDDEN');
    expect(codes(style('.a { background: url("data:application/x-font-ttf;base64,AAAA"); }'))).toContain('FONT_FACE_FORBIDDEN');
  });

  it('报告带行号', () => {
    const files = makeSkeletonPage({ body: '<p>前面</p>\n<img src="https://cdn.example.com/a.png" alt="">' });
    const html = new TextDecoder().decode(files.get('index.html'));
    const expected = html.split('\n').findIndex((line) => line.includes('cdn.example.com')) + 1;
    expect(issuesOf(run(files), 'EXTERNAL_RESOURCE')[0]?.line).toBe(expected);
  });
});

describe('CSS', () => {
  const CSS: [string, string][] = [
    ['url() 无引号', '.a { background: url(https://cdn.example.com/a.png); }'],
    ['url() 双引号', '.a { background: url("https://cdn.example.com/a.png"); }'],
    ['image-set 字符串', '.a { background-image: image-set("https://cdn.example.com/a.png" 1x); }'],
    ['-webkit-image-set url()', '.a { background-image: -webkit-image-set(url(//cdn.example.com/a.png) 1x); }'],
    ['cursor', '.a { cursor: url(https://cdn.example.com/c.cur), auto; }'],
    ['自定义属性里的 url()', ':root { --bg: url(https://cdn.example.com/a.png); }'],
    ['@media 里的规则', '@media (min-width: 600px) { .a { background: url(https://cdn.example.com/a.png); } }'],
    ['嵌套规则', '.a { .b { background: url(https://cdn.example.com/a.png); } }'],
    ['没闭合的块（浏览器仍会应用）', '.a { background: url(https://cdn.example.com/a.png)'],
  ];
  it.each(CSS)('%s', (_label, css) => {
    expect(codes(style(css))).toContain('EXTERNAL_RESOURCE');
  });

  it('@namespace 的 URL 不是资源引用', () => {
    const report = style('@namespace svg url(http://www.w3.org/2000/svg);');
    expect(codes(report), summary(report)).not.toContain('EXTERNAL_RESOURCE');
  });

  it('注释里的 url() 不算', () => {
    const report = style('/* .a { background: url(https://cdn.example.com/a.png); } */');
    expect(report.errors, summary(report)).toEqual([]);
  });
});

describe('不误报', () => {
  it('assets/x.png 与 ./assets/x.png 等价，引用存在的文件不报', () => {
    const report = body('<img src="assets/a.png" alt=""><img src="./assets/a.png" alt=""><img src="assets/./a.png" alt="">', { 'assets/a.png': png(1, 1) });
    expect(report.errors, summary(report)).toEqual([]);
  });

  it('Kit 根路径、data:image、#、blob:、空 src', () => {
    const report = body(
      [
        '<img src="/_nowme/kit/v1/icons/star.png" alt="">',
        '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" alt="">',
        '<img srcset="data:image/png;base64,iVBORw0KGgo= 1x, assets/a.png 2x" alt="">',
        '<svg><use href="#icon"/></svg>',
        '<img src="blob:http://127.0.0.1/abc" alt="">',
        '<img src="" alt="">',
      ].join('\n'),
      { 'assets/a.png': png(1, 1) },
    );
    expect(report.errors, summary(report)).toEqual([]);
  });

  it('CSS 里的 Kit / assets / data:image / #filter', () => {
    const report = style(
      [
        '@import "/_nowme/kit/v1/extra.css";',
        '.a { background: url(assets/a.png), url("data:image/png;base64,AAAA"); filter: url(#blur); }',
        '.b { background-image: image-set("assets/a.png" 1x, "assets/b.jpg" 2x); }',
      ].join('\n'),
      { 'assets/a.png': png(1, 1), 'assets/b.jpg': jpeg() },
    );
    expect(report.errors, summary(report)).toEqual([]);
  });

  it('正文、注释、非资源属性里的地址不报', () => {
    const report = body(
      [
        '<p>我的博客是 https://ayou.dev ，欢迎来看</p>',
        '<!-- <img src="https://cdn.example.com/a.png"> -->',
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
        '<blockquote cite="https://example.com/quote">一句话</blockquote>',
        '<div data-src="https://example.com/x.png" title="https://example.com">x</div>',
        '<p>&lt;img src="https://cdn.example.com/a.png"&gt;</p>',
      ].join('\n'),
    );
    expect(codes(report), summary(report)).not.toContain('EXTERNAL_RESOURCE');
    expect(report.errors, summary(report)).toEqual([]);
  });

  it('模块脚本 import Kit 文件不报', () => {
    const report = body(`<script type="module">import '/_nowme/kit/v1/nowme.js';</script>`);
    expect(codes(report), summary(report)).not.toContain('EXTERNAL_RESOURCE');
  });
});
