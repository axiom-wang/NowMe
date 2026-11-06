/**
 * FORBIDDEN_API（contracts 2.2）：脚本（含 on* 事件属性、type="module"）中的禁用 API。
 * 静态检查用 AST，注释与普通字符串不算；真正的边界是 CSP（connect-src 'none'、无 'unsafe-eval'）与沙箱。
 */
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, makeSkeletonPage, run, summary } from '../fixtures.js';

const withScript = (script: string) => run(makeSkeletonPage({ script }));

/** contracts 2.2 表中列出的每一项（示例写法）。 */
const LISTED: [string, string][] = [
  ['fetch(', "fetch('/api/data');"],
  ['XMLHttpRequest', 'const xhr = new XMLHttpRequest();'],
  ['WebSocket', "new WebSocket('wss://example.com');"],
  ['EventSource', "new EventSource('/stream');"],
  ['sendBeacon', "navigator.sendBeacon('/log', 'x');"],
  ['RTCPeerConnection', 'const pc = new RTCPeerConnection();'],
  ['WebTransport', "new WebTransport('https://example.com');"],
  ['localStorage', "localStorage.setItem('k', 'v');"],
  ['sessionStorage', "sessionStorage.getItem('k');"],
  ['indexedDB', "indexedDB.open('db');"],
  ['caches.', "caches.open('v1');"],
  ['document.cookie', "document.cookie = 'a=1';"],
  ['cookieStore', "cookieStore.get('a');"],
  ['window.open', "window.open('https://example.com');"],
  ['window.top', 'const t = window.top;'],
  ['top.location', "top.location = 'https://example.com';"],
  ['parent.location', 'parent.location.reload();'],
  ['location.href =', "location.href = 'https://example.com';"],
  ['location.assign', "location.assign('https://example.com');"],
  ['location.replace', "location.replace('https://example.com');"],
  ['serviceWorker', "navigator.serviceWorker.register('/sw.js');"],
  ['importScripts', "importScripts('x.js');"],
  ['new Worker', "new Worker('w.js');"],
  ['new SharedWorker', "new SharedWorker('w.js');"],
  ['动态 import(', "import('/x.js').then(() => {});"],
  ['eval(', "eval('1 + 1');"],
  ['new Function', "new Function('return 1')();"],
  ['setTimeout("..."', "setTimeout(\"alert('hi')\", 100);"],
  ['getUserMedia', 'navigator.mediaDevices.getUserMedia({ video: true });'],
  ['geolocation', 'navigator.geolocation.getCurrentPosition(() => {});'],
];

describe('FORBIDDEN_API：contracts 列出的每一项都报', () => {
  it.each(LISTED)('%s', (_label, script) => {
    const report = withScript(script);
    expect(codes(report), summary(report)).toContain('FORBIDDEN_API');
    const issue = issuesOf(report, 'FORBIDDEN_API')[0];
    expect(issue?.severity).toBe('error');
    expect(issue?.line).toBeGreaterThan(1);
    expect(issue?.hint.length).toBeGreaterThan(10);
  });
});

describe('FORBIDDEN_API：不同的脚本位置', () => {
  it('on* 事件属性', () => {
    const report = run(makeSkeletonPage({ body: `<button onclick="fetch('/x')">点我</button>` }));
    expect(codes(report)).toContain('FORBIDDEN_API');
    expect(issuesOf(report, 'FORBIDDEN_API')[0]?.message).toContain('onclick');
  });

  it('SVG 里的事件属性', () => {
    const report = run(makeSkeletonPage({ body: `<svg><circle r="3" onload="localStorage.clear()"/></svg>` }));
    expect(codes(report)).toContain('FORBIDDEN_API');
  });

  it('type="module" 的脚本', () => {
    const report = run(makeSkeletonPage({ body: `<script type="module">await fetch('/x');</script>` }));
    expect(codes(report)).toContain('FORBIDDEN_API');
  });

  it('type="text/javascript" 与 language="javascript" 的脚本按 JS 检查', () => {
    expect(codes(run(makeSkeletonPage({ body: `<script type="text/javascript; charset=utf-8">fetch('/x')</script>` })))).toContain('FORBIDDEN_API');
    expect(codes(run(makeSkeletonPage({ body: `<script language="javascript">fetch('/x')</script>` })))).toContain('FORBIDDEN_API');
  });

  it('SVG 里的 <script>（内容中的字符实体会被解码执行）', () => {
    const report = run(makeSkeletonPage({ body: `<svg><script>fetch&#40;'/x')</script></svg>` }));
    expect(codes(report)).toContain('FORBIDDEN_API');
  });

  it('<template> 里的脚本（克隆后会执行）', () => {
    const report = run(makeSkeletonPage({ body: `<template><script>localStorage.x = 1</script></template>` }));
    expect(codes(report)).toContain('FORBIDDEN_API');
  });

  it('报告给出行号', () => {
    const report = withScript(`const a = 1;\nconst b = 2;\nlocalStorage.setItem('k', 'v');`);
    const issue = issuesOf(report, 'FORBIDDEN_API')[0];
    const html = new TextDecoder().decode(makeSkeletonPage({ script: `const a = 1;\nconst b = 2;\nlocalStorage.setItem('k', 'v');` }).get('index.html'));
    const expected = html.split('\n').findIndex((line) => line.includes('localStorage.setItem')) + 1;
    expect(issue?.line).toBe(expected);
  });
});

describe('FORBIDDEN_API：不误报', () => {
  const CLEAN: [string, string][] = [
    ['注释里的 fetch(', "// fetch('/api')\n/* localStorage.setItem('a', 1); eval('x') */"],
    ['普通字符串里的 API 名', "const tip = '不要用 fetch( 和 localStorage，也不要 eval(';"],
    ['自己对象上的 fetch 方法', 'const store = { fetch() { return 1; } }; store.fetch();'],
    ['自己声明的顶层函数 fetch / open', 'function fetch() { return 1; } fetch(); function open(card) { return card; } open(1);'],
    ['局部变量 / 参数 top、parent、open', 'function layout(top, parent) { return top + parent.offsetTop; } const rect = { top: 1 }; rect.top; const details = { open: true }; details.open = false;'],
    ['location.hash 与读取 location', "location.hash = '#projects'; const q = location.search; const here = location.href;"],
    ['函数形式的 setTimeout / setInterval', 'setTimeout(() => {}, 100); const id = setInterval(function () {}, 1000); clearInterval(id);'],
    ['字符串的 replace 与 Object.assign', "'abc'.replace('a', 'b'); Object.assign({}, { a: 1 });"],
    ['自己的 Worker 类名与方法名', 'class MyWorker {} new MyWorker(); const job = { open() {} }; job.open();'],
    ['类方法里的 self 局部别名', 'class A { open() {} run() { const self = this; self.open(); } } new A().run();'],
    ['常见的安全 API', "window.addEventListener('scroll', () => {}); window.matchMedia('(min-width: 600px)'); window.scrollTo(0, 0); document.title = '你好'; navigator.userAgent; parent.postMessage({}, '*');"],
    ['in 运算符的特性检测字符串', "const has = 'localStorage' in window;"],
    ['JSON 数据块里的文字', ''],
  ];

  it.each(CLEAN)('%s', (label, script) => {
    const files =
      label === 'JSON 数据块里的文字'
        ? makeSkeletonPage({ body: `<script type="application/json">{"tip": "fetch('/x') localStorage eval("}</script>` })
        : makeSkeletonPage({ script });
    const report = run(files);
    expect(codes(report), summary(report)).not.toContain('FORBIDDEN_API');
    expect(report.errors, summary(report)).toEqual([]);
  });
});
