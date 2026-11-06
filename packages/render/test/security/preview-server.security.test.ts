/**
 * 本地双源预览服务器的安全断言（contracts S1、S2、5.2；渲染管线与 nowme preview --serve 共用这个服务器）：
 *
 * - 外壳里的 iframe `sandbox` 恰好是 `allow-scripts`，src 指向页面源；外壳 CSP 等于 buildWebCsp；
 * - 页面文档的 CSP 与 buildPageCsp 的输出完全一致；所有响应带 PAGE_SECURITY_HEADERS、不设 cookie；
 * - 字体子集带 `Access-Control-Allow-Origin: *`；Host 头不对 → 421；路径穿越、未挂出的票据、白名单外的文件 → 404；
 * - 浏览器内：页面读不到外壳的 cookie（请求也不携带）、改不了 top.location、连不上探针服务器、拿不到 localStorage。
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KIT_CSS_PATH,
  PAGE_IFRAME_SANDBOX,
  PAGE_SECURITY_HEADERS,
  buildPageCsp,
  buildWebCsp,
  parseCsp,
} from '@nowme/contracts';
import { PreviewServer, startPreviewServer, type PublishedPage } from '../../src/index.js';
import { pageHtml, servedOf, text } from '../helpers.js';

type Element = DefaultTreeAdapterTypes.Element;

let server: PreviewServer;
let published: PublishedPage;
const FONT = text('wOF2 fake font bytes');
const PNG = text('png bytes');

beforeAll(async () => {
  server = await startPreviewServer();
  published = server.publish(servedOf(pageHtml(), { '_fonts/test-sans-400.woff2': FONT, 'assets/a.png': PNG, 'assets/sub/b.png': PNG }), { title: '测试 <标题>' });
});

afterAll(async () => {
  await server?.close();
});

function findIframes(html: string): Element[] {
  const found: Element[] = [];
  const walk = (node: DefaultTreeAdapterTypes.ParentNode) => {
    for (const child of node.childNodes) {
      if ('tagName' in child) {
        if (child.tagName === 'iframe') found.push(child);
        walk(child);
      }
    }
  };
  walk(parse(html));
  return found;
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

/** 用 node:http 发请求（可以自定义 Host 头）。 */
function raw(url: string, options: { method?: string; host?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: target.port, path: `${target.pathname}${target.search}`, method: options.method ?? 'GET', headers: { host: options.host ?? target.host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function expectSecurityHeaders(headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) expect(headers[name.toLowerCase()], name).toBe(value);
  expect(headers['set-cookie']).toBeUndefined();
}

describe('外壳（S1）', () => {
  it.each(['shellUrl', 'renderUrl'] as const)('%s：iframe 的 sandbox 恰好是 allow-scripts，src 指向页面源，没有 allow 属性', async (key) => {
    const response = await raw(published[key]);
    expect(response.status).toBe(200);
    const iframes = findIframes(response.body);
    expect(iframes).toHaveLength(1);
    const iframe = iframes[0] as Element;
    expect(attr(iframe, 'sandbox')).toBe(PAGE_IFRAME_SANDBOX);
    expect(PAGE_IFRAME_SANDBOX).toBe('allow-scripts');
    expect(attr(iframe, 'src')).toBe(published.pageUrl);
    expect(published.pageUrl.startsWith(`${server.pagesOrigin}/v/`)).toBe(true);
    expect(attr(iframe, 'allow')).toBeUndefined();
    expect(response.body).not.toMatch(/allow-same-origin|allow-top-navigation|allow-forms|allow-popups|allow-modals/);
    expect(response.headers['content-security-policy']).toBe(buildWebCsp({ pagesOrigin: server.pagesOrigin }));
    expect(response.headers['set-cookie']).toBeUndefined();
    // 标题经过转义
    expect(response.body).toContain('测试 &#60;标题&#62;');
  });

  it('外壳首页显示最近挂出的页面；外壳与页面是不同站点（localhost / 127.0.0.1）', async () => {
    const response = await raw(`${server.shellOrigin}/`);
    expect(attr(findIframes(response.body)[0] as Element, 'src')).toBe(published.pageUrl);
    expect(new URL(server.shellOrigin).hostname).toBe('localhost');
    expect(new URL(server.pagesOrigin).hostname).toBe('127.0.0.1');
  });

  it('Host 头不对 → 421；非 GET → 405；未知票据 → 404', async () => {
    expect((await raw(published.shellUrl, { host: `127.0.0.1:${server.shellPort}` })).status).toBe(421);
    expect((await raw(published.shellUrl, { method: 'POST' })).status).toBe(405);
    expect((await raw(`${server.shellOrigin}/p/unknown-ticket`)).status).toBe(404);
  });
});

describe('页面源（S2）', () => {
  it('页面文档的 CSP 与 buildPageCsp 的输出完全一致，并带全部安全头、不设 cookie', async () => {
    const expected = buildPageCsp({ pagesOrigin: server.pagesOrigin, ticket: published.ticket, frameAncestors: server.shellOrigin });
    for (const url of [published.pageUrl, `${published.pageUrl}index.html`]) {
      const response = await raw(url);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['content-security-policy']).toBe(expected);
      expect(server.pageCsp(published.ticket)).toBe(expected);
      expectSecurityHeaders(response.headers);
    }
    const csp = parseCsp(expected);
    expect(csp.get('frame-ancestors')).toEqual([server.shellOrigin]);
    expect(csp.get('sandbox')).toEqual(['allow-scripts']);
    expect(csp.get('connect-src')).toEqual(["'none'"]);
    expect(expected).not.toContain('unsafe-eval');
  });

  it('字体子集带 Access-Control-Allow-Origin: *；图片不带；都带安全头', async () => {
    const font = await raw(`${published.pageUrl}_fonts/test-sans-400.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers['access-control-allow-origin']).toBe('*');
    expect(font.headers['content-type']).toBe('font/woff2');
    expectSecurityHeaders(font.headers);
    for (const path of ['assets/a.png', 'assets/sub/b.png']) {
      const image = await raw(`${published.pageUrl}${path}`);
      expect(image.status).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.headers['access-control-allow-origin']).toBeUndefined();
      expectSecurityHeaders(image.headers);
    }
  });

  it('Kit 挂在 /_nowme/kit/v1/，带安全头；不存在的 Kit 文件 404', async () => {
    const css = await raw(`${server.pagesOrigin}${KIT_CSS_PATH}`);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expectSecurityHeaders(css.headers);
    expect((await raw(`${server.pagesOrigin}/_nowme/kit/v1/secret.js`)).status).toBe(404);
  });

  it.each([
    '/v/{t}/assets/%2e%2e/%2e%2e/etc/passwd',
    '/v/{t}/assets%2F..%2F..%2Fpackage.json',
    '/v/{t}/../other/',
    '/v/{t}/assets/../../unknown/',
    '/v/{t}/card.json',
    '/v/{t}/manifest.json',
    '/v/{t}/cover.png',
    '/v/{t}/assets/',
    '/v/{t}',
    '/v/unknown/',
    '/v/../package.json',
    '/package.json',
    '/_nowme/kit/v1/../../package.json',
    '/%ZZ',
  ])('%s → 400 / 404，且不会返回别的文件', async (path) => {
    const response = await raw(`${server.pagesOrigin}${path.replace('{t}', published.ticket)}`);
    expect([400, 404]).toContain(response.status);
    expect(response.body).not.toContain('<!doctype html>');
    expectSecurityHeaders(response.headers);
  });

  it('点段按 URL 规范归一化（与浏览器一致），只会落在本票据已挂出的文件上', async () => {
    const index = await raw(published.pageUrl);
    const viaDots = await raw(`${published.pageUrl}assets/../index.html`);
    expect(viaDots.status).toBe(200);
    expect(viaDots.body).toBe(index.body);
    expect(viaDots.headers['content-security-policy']).toBe(index.headers['content-security-policy']);
    const font = await raw(`${published.pageUrl}assets/../_fonts/test-sans-400.woff2`);
    expect(font.headers['access-control-allow-origin']).toBe('*');
  });

  it('Host 头不对 → 421（例如用 localhost 访问页面源）；非 GET → 405', async () => {
    expect((await raw(published.pageUrl, { host: `localhost:${server.pagesPort}` })).status).toBe(421);
    expect((await raw(published.pageUrl, { method: 'POST' })).status).toBe(405);
  });

  it('撤下后地址 404', async () => {
    const extra = server.publish(servedOf(pageHtml()));
    expect((await raw(extra.pageUrl)).status).toBe(200);
    server.unpublish(extra.ticket);
    expect((await raw(extra.pageUrl)).status).toBe(404);
    expect((await raw(extra.shellUrl)).status).toBe(404);
  });
});

describe('浏览器内的隔离（S1）', () => {
  let browser: Browser;
  let probe: Server;
  let probeHits = 0;
  let probeOrigin: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    probe = createServer((_req, res) => {
      probeHits += 1;
      res.end('probe');
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    probeOrigin = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => probe?.close(() => resolve()));
  });

  it('恶意页面：读不到外壳 cookie、改不了 top.location、连不上探针、没有 localStorage，外壳地址不变', async () => {
    const attack = `
const out = {};
try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked:' + e.name; }
try { out.storage = typeof localStorage.getItem('x'); } catch (e) { out.storage = 'blocked:' + e.name; }
try { top.location = ${JSON.stringify(`${server.shellOrigin}/hijacked`)}; out.top = 'allowed'; } catch (e) { out.top = 'blocked:' + e.name; }
try { out.parentCookie = parent.document.cookie; } catch (e) { out.parentCookie = 'blocked:' + e.name; }
out.origin = String(self.origin);
fetch(${JSON.stringify(`${probeOrigin}/fetch`)}).then(() => { out.fetch = 'allowed'; }, () => { out.fetch = 'blocked'; }).finally(() => {
  const img = new Image(); img.src = ${JSON.stringify(`${probeOrigin}/img`)};
  document.getElementById('out').textContent = JSON.stringify(out);
});`;
    const page = server.publish(servedOf(pageHtml({ body: '<p id="out">pending</p><section data-nm-id="a"></section>', script: attack })));
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: 'nowme_session', value: 'shell-secret', domain: 'localhost', path: '/' }]);
      const tab = await context.newPage();
      const pageRequestHeaders: Record<string, string>[] = [];
      tab.on('request', (req) => {
        if (req.url().startsWith(server.pagesOrigin)) pageRequestHeaders.push(req.headers());
      });
      await tab.goto(page.shellUrl);
      const frame = await (await tab.$('iframe'))?.contentFrame();
      expect(frame).toBeTruthy();
      await frame?.waitForFunction("document.getElementById('out') && document.getElementById('out').textContent !== 'pending'");
      const out = JSON.parse((await frame?.evaluate("document.getElementById('out').textContent")) as string) as Record<string, string>;
      expect(out.cookie).toBe('blocked:SecurityError');
      expect(out.storage).toBe('blocked:SecurityError');
      expect(out.top).toBe('blocked:SecurityError');
      expect(out.parentCookie).toBe('blocked:SecurityError');
      expect(out.origin).toBe('null');
      expect(out.fetch).toBe('blocked');
      await tab.waitForTimeout(300);
      expect(tab.url()).toBe(page.shellUrl);
      expect(probeHits).toBe(0);
      expect(pageRequestHeaders.length).toBeGreaterThan(0);
      for (const headers of pageRequestHeaders) expect(headers.cookie).toBeUndefined();
      // 外壳自己能读到 cookie（证明 cookie 确实存在）
      expect(await tab.evaluate('document.cookie')).toContain('nowme_session=shell-secret');
    } finally {
      await context.close();
      server.unpublish(page.ticket);
    }
  }, 60_000);

  it('serve 模式外壳：页面自我导航后被重置为空白页并提示', async () => {
    const page = server.publish(
      servedOf(pageHtml({ script: "if (!location.pathname.endsWith('index.html')) setTimeout(() => { location.replace(location.pathname + 'index.html'); }, 50);" })),
    );
    const context = await browser.newContext();
    try {
      const tab = await context.newPage();
      await tab.goto(page.shellUrl);
      // 外壳 CSP 不允许 eval，用 locator 等待
      await tab.locator('#nm-shell-notice').waitFor({ state: 'visible' });
      expect(await tab.textContent('#nm-shell-notice')).toContain('试图跳转');
      expect(await tab.getAttribute('iframe', 'src')).toBe('about:blank');
    } finally {
      await context.close();
      server.unpublish(page.ticket);
    }
  }, 60_000);
});
