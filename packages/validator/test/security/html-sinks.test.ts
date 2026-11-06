/**
 * 脚本写入 innerHTML / insertAdjacentHTML / document.write 等注入点的 HTML：
 * 静态部分按同样的规则检查；无法确定的动态部分不误报（只看静态前缀）。
 */
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, makeSkeletonPage, png, run, summary } from '../fixtures.js';

const script = (code: string) => run(makeSkeletonPage({ script: code }));

describe('注入点里的 HTML', () => {
  it('动态的 src / href / data-nm-href / 事件参数 / 样式不误报', () => {
    const report = run(
      makeSkeletonPage(
        {
          script: [
            "const list = document.querySelector('section');",
            "const photos = [{ file: 'p-1.png', url: 'https://github.com/ayou' }];",
            'for (const p of photos) {',
            `  list.innerHTML += '<img src="assets/' + p.file + '" alt="">';`,
            '  list.insertAdjacentHTML(\'beforeend\', `<button data-nm-href="${p.url}" onclick="pick(${p.file.length})">去看看</button>`);',
            '  list.innerHTML += `<a href="${p.anchor}">锚点</a><img src="${p.src}" alt=""><b style="width: ${p.w}px; font-family: ${p.font}">x</b>`;',
            '  list.innerHTML = photos.map((x) => `<img src="assets/${x.file}" alt="">`).join("");',
            '}',
            'function pick(n) { return n; }',
          ].join('\n'),
        },
        { files: { 'assets/p-1.png': png(1, 1) } },
      ),
    );
    expect(report.errors, summary(report)).toEqual([]);
    expect(codes(report), summary(report)).not.toContain('ASSET_UNUSED');
    expect(codes(report), summary(report)).not.toContain('FONT_NOT_IN_KIT');
  });

  it('静态前缀已经是外部地址或 http: 时照常报', () => {
    const report = script(
      [
        'el.innerHTML = `<img src="https://${location.hash}.example.com/a.png">`;',
        'el.innerHTML = `<a href="https://github.com/${location.hash}">x</a>`;',
        'el.innerHTML = `<b data-nm-href="http://${location.hash}">x</b>`;',
        'el.innerHTML = `<img src="//${location.hash}/x.png">`;',
      ].join('\n'),
    );
    expect(codes(report)).toEqual(expect.arrayContaining(['EXTERNAL_RESOURCE', 'FORBIDDEN_LINK_HREF', 'INSECURE_OPEN_LINK']));
    expect(issuesOf(report, 'EXTERNAL_RESOURCE')).toHaveLength(2);
  });

  it('注入的事件属性里的禁用 API、注入的样式里的外部 url()', () => {
    expect(codes(script(`el.outerHTML = '<div onmouseover="navigator.sendBeacon(1)"></div>';`))).toContain('FORBIDDEN_API');
    expect(codes(script(`el.innerHTML = '<style>.a { background: url(https://evil.example/x.png) }</style>';`))).toContain('EXTERNAL_RESOURCE');
    expect(codes(script(`document.body.insertAdjacentHTML('afterbegin', '<form></form>');`))).toContain('FORBIDDEN_ELEMENT');
  });

  it('只是文字的 HTML 字符串（textContent）不当作注入点', () => {
    const report = script(`el.textContent = '<iframe src="https://evil.example"></iframe>';`);
    expect(codes(report)).not.toContain('FORBIDDEN_ELEMENT');
    expect(report.errors, summary(report)).toEqual([]);
  });
});
