/**
 * Kit 自己也运行在页面 CSP 与沙箱下（contracts 2.2 FORBIDDEN_API、5.1）。
 * 静态扫描 nowme.js（包括注释，宁可严格），确认没有联网、存储、跳转顶层、动态执行代码的 API；
 * 扫描 nowme.css，确认不引用外部资源。
 */
import { describe, expect, it } from 'vitest';
import { OPEN_LINK_MESSAGE_TYPE } from '@nowme/contracts';
import { KIT_CSS_SOURCE, KIT_JS_SOURCE, loadKit } from '../helpers/kit-window.js';

/** contracts 2.2 FORBIDDEN_API 的全部条目（另加 setInterval 字符串形式与裸 top）。 */
const FORBIDDEN_API: readonly [label: string, pattern: RegExp][] = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['sendBeacon', /sendBeacon/],
  ['RTCPeerConnection', /RTCPeerConnection/],
  ['WebTransport', /WebTransport/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['indexedDB', /indexedDB/i],
  ['caches.', /\bcaches\s*\./],
  ['document.cookie', /document\s*\.\s*cookie/],
  ['cookieStore', /cookieStore/],
  ['window.open', /window\s*\.\s*open\b/],
  ['window.top', /window\s*\.\s*top\b/],
  ['top.location', /\btop\s*\.\s*location/],
  ['parent.location', /parent\s*\.\s*location/],
  ['location.href =', /location\s*\.\s*href\s*=/],
  ['location.assign', /location\s*\.\s*assign/],
  ['location.replace', /location\s*\.\s*replace/],
  ['serviceWorker', /serviceWorker/],
  ['importScripts', /importScripts/],
  ['new Worker', /new\s+Worker/],
  ['new SharedWorker', /new\s+SharedWorker/],
  ['import(', /\bimport\s*\(/],
  ['eval(', /\beval\s*\(/],
  ['new Function', /new\s+Function/],
  ['setTimeout("..."', /setTimeout\s*\(\s*['"`]/],
  ['setInterval("..."', /setInterval\s*\(\s*['"`]/],
  ['getUserMedia', /getUserMedia/],
  ['geolocation', /geolocation/],
  ['bare top', /(^|[^.\w$])top\s*[.[]/m],
  ['location', /\blocation\b/],
  ['cookie', /cookie/i],
];

describe('nowme.js 不使用页面禁用的 API', () => {
  it.each(FORBIDDEN_API)('不含 %s', (_label, pattern) => {
    expect(KIT_JS_SOURCE).not.toMatch(pattern);
  });

  it('唯一的跨窗口通信是向 parent 发送 nowme:open-link', () => {
    const calls = KIT_JS_SOURCE.match(/postMessage\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(KIT_JS_SOURCE).toMatch(/win\.parent\.postMessage\(\{ type: OPEN_LINK_TYPE, url: url \}, '\*'\)/);
    expect(KIT_JS_SOURCE).toContain(`const OPEN_LINK_TYPE = '${OPEN_LINK_MESSAGE_TYPE}'`);
    expect(KIT_JS_SOURCE).not.toMatch(/addEventListener\(\s*['"]message['"]/);
  });

  it('不改写 innerHTML / outerHTML，也不用 document.write（避免把文字当成标记执行）', () => {
    expect(KIT_JS_SOURCE).not.toMatch(/\.(inner|outer)HTML\s*=/);
    expect(KIT_JS_SOURCE).not.toMatch(/insertAdjacentHTML|document\s*\.\s*write/);
  });

  it('不加载任何外部脚本或资源', () => {
    expect(KIT_JS_SOURCE).not.toMatch(/createElement\(\s*['"](script|iframe|link|img|form|a)['"]/);
    expect(KIT_JS_SOURCE).not.toMatch(/\.src\s*=/);
  });
});

describe('openLink 只放行 https（contracts 5.1）', () => {
  it.each(['http://example.com/', 'javascript:alert(document.domain)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'blob:https://example.com/x', '  javascript:alert(1)'])(
    '拒绝 %s',
    async (url) => {
      const kit = loadKit({ html: `<div id="x" data-nm-href="${url.replace(/"/g, '&quot;')}">x</div>` });
      expect(kit.nowme.openLink(url)).toBe(false);
      kit.doc.getElementById('x')?.click();
      expect(kit.messages).toHaveLength(0);
      await kit.close();
    },
  );
});

describe('nowme.css 不引用外部资源', () => {
  const css = KIT_CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

  it('没有 @import 与 @font-face', () => {
    expect(css).not.toMatch(/@import|@font-face/i);
  });

  it('url() 只用 data:image/svg+xml 内联图', () => {
    const quoted = [...css.matchAll(/url\(\s*"([^"]*)"\s*\)/g)].map((match) => match[1] ?? '');
    const rest = css.replace(/url\(\s*"[^"]*"\s*\)/g, '');
    const unquoted = [...rest.matchAll(/url\(([^)]*)\)/g)].map((match) => (match[1] ?? '').trim());
    const urls = [...quoted, ...unquoted];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('data:image/svg+xml,'), url).toBe(true);
  });

  it('内联 SVG 里没有脚本、外部引用或事件属性', () => {
    for (const match of css.matchAll(/url\("data:image\/svg\+xml,([^"]*)"\)/g)) {
      const svg = decodeURIComponent(match[1] ?? '');
      expect(svg).not.toMatch(/<script|href=|on[a-z]+=|<foreignObject/i);
      const urls = [...svg.matchAll(/url\(([^)]*)\)/g)].map((item) => item[1]);
      for (const url of urls) expect(url?.startsWith('#'), url).toBe(true);
    }
  });
});
