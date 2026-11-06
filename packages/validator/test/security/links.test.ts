/**
 * 外链（contracts 1.1、5.1）：`<a href>` 只能是 `#...`；外部链接只能通过 data-nm-href 或 nowme.openLink，且只允许 https:。
 */
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, makeSkeletonPage, run, summary } from '../fixtures.js';

const body = (html: string) => run(makeSkeletonPage({ body: html }));
const script = (code: string) => run(makeSkeletonPage({ script: code }));

describe('FORBIDDEN_LINK_HREF', () => {
  const LINKS = [
    '<a href="https://github.com/ayou">GitHub</a>',
    '<a href="http://example.com">x</a>',
    '<a href="//example.com">x</a>',
    '<a href="mailto:me@example.com">x</a>',
    '<a href="javascript:void(0)">x</a>',
    '<a href="assets/a.png">x</a>',
    '<a href="other.html">x</a>',
    '<a href="">x</a>',
    '<map name="m"><area href="https://example.com" alt="x"></map>',
    '<svg><a href="https://example.com"><text>x</text></a></svg>',
  ];
  it.each(LINKS)('%s', (html) => {
    const report = body(html);
    expect(codes(report), summary(report)).toContain('FORBIDDEN_LINK_HREF');
  });

  it('hint 给出 data-nm-href 与 nowme.openLink 的写法', () => {
    const issue = issuesOf(body('<a href="https://github.com/ayou">GitHub</a>'), 'FORBIDDEN_LINK_HREF')[0];
    expect(issue?.hint).toContain('data-nm-href="https://');
    expect(issue?.hint).toContain('nowme.openLink(');
    expect(issue?.message).toContain('https://github.com/ayou');
  });

  it('页内锚点与 data-nm-href 不报', () => {
    const report = body('<a href="#projects">项目</a> <a href=" #top ">顶部</a> <a href="#">无</a> <a data-nm-href="https://github.com/ayou">GitHub</a> <a>无链接</a>');
    expect(report.errors, summary(report)).toEqual([]);
  });
});

describe('INSECURE_OPEN_LINK', () => {
  it('data-nm-href 不是 https:', () => {
    for (const url of ['http://example.com', 'javascript:alert(1)', '//example.com', '/page', 'example.com', '', 'ftp://example.com']) {
      const report = body(`<button data-nm-href="${url}">x</button>`);
      expect(codes(report), url).toContain('INSECURE_OPEN_LINK');
    }
  });

  it('nowme.openLink 的字面量参数不是 https:', () => {
    for (const call of [
      "nowme.openLink('http://example.com');",
      'nowme.openLink(`http://example.com/${location.hash}`);',
      "nowme.openLink('http://' + 'example.com');",
      "const url = 'http://example.com'; nowme.openLink(url);",
      "window.nowme.openLink('javascript:alert(1)');",
      "nowme.openLink('//example.com');",
    ]) {
      expect(codes(script(call)), call).toContain('INSECURE_OPEN_LINK');
    }
  });

  it("setAttribute('data-nm-href', ...) 与 dataset.nmHref 也检查", () => {
    expect(codes(script("document.body.setAttribute('data-nm-href', 'http://example.com');"))).toContain('INSECURE_OPEN_LINK');
    expect(codes(script("document.body.dataset.nmHref = 'http://example.com';"))).toContain('INSECURE_OPEN_LINK');
  });

  it('https: 地址（大小写不限）、动态参数不报', () => {
    const report = run(
      makeSkeletonPage({
        body: '<button data-nm-href="https://github.com/ayou">a</button><button data-nm-href="HTTPS://EXAMPLE.COM/A">b</button>',
        script: [
          "nowme.openLink('https://ayou.dev/blog');",
          "const user = 'ayou'; nowme.openLink(`https://github.com/${user}`);",
          "nowme.openLink('https://github.com/' + location.hash.slice(1));",
          'function go(url) { nowme.openLink(url); }',
          "document.body.setAttribute('data-nm-href', 'https://example.com');",
        ].join('\n'),
      }),
    );
    expect(codes(report), summary(report)).not.toContain('INSECURE_OPEN_LINK');
    expect(codes(report), summary(report)).not.toContain('EXTERNAL_URL_IN_SCRIPT');
    expect(report.errors, summary(report)).toEqual([]);
  });
});

describe('EXTERNAL_URL_IN_SCRIPT（警告）', () => {
  it('普通字符串里的 http(s):// 报警告，不影响 ok', () => {
    for (const code of ["const api = 'https://api.example.com/v1';", 'img.src = `HTTPS://cdn.example.com/a.png`;', "const u = 'http://example.com';"]) {
      const report = script(code);
      expect(codes(report), code).toContain('EXTERNAL_URL_IN_SCRIPT');
      expect(issuesOf(report, 'EXTERNAL_URL_IN_SCRIPT')[0]?.severity).toBe('warning');
      expect(report.ok).toBe(true);
    }
  });

  it('openLink 参数、XML 命名空间、data-nm-href HTML 片段、注释不报', () => {
    const report = script(
      [
        "nowme.openLink('https://ayou.dev');",
        "const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');",
        `document.body.insertAdjacentHTML('beforeend', '<svg xmlns="http://www.w3.org/2000/svg"></svg><a data-nm-href="https://github.com/ayou">GitHub</a>');`,
        '// https://example.com 只是注释',
      ].join('\n'),
    );
    expect(codes(report), summary(report)).not.toContain('EXTERNAL_URL_IN_SCRIPT');
    expect(report.errors, summary(report)).toEqual([]);
  });
});
