import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_IFRAME_SANDBOX } from '@nowme/contracts';
import { createPagesApp } from '../../src/app.js';
import { REV_A, makeConfig, makeFixture, write } from '../helpers.js';

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<style>@font-face{font-family:TestFont;src:url(_fonts/test-400.woff2) format("woff2");}
body{font-family:TestFont,sans-serif}</style></head><body>hello
<script>
(async () => {
  const r = {};
  try { await fetch(location.href); r.fetch = 'ok'; } catch (e) { r.fetch = 'blocked'; }
  try { localStorage.setItem('a', '1'); r.localStorage = 'ok'; } catch (e) { r.localStorage = 'blocked'; }
  try { document.cookie = 'x=1'; r.cookie = document.cookie === '' ? 'blocked' : 'ok'; } catch (e) { r.cookie = 'blocked'; }
  try {
    await document.fonts.load('16px TestFont');
    r.font = document.fonts.check('16px TestFont') ? 'loaded' : 'not-loaded';
    r.fontStatuses = [...document.fonts].map((f) => f.status);
  } catch (e) { r.font = 'error'; }
  parent.postMessage({ nowmeResult: r }, '*');
})();
</script></body></html>`;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('浏览器：沙箱 iframe 中的页面能力', () => {
  let browser: Browser;
  let shell: Server;
  let pages: ReturnType<typeof serve>;
  let shellUrl = '';

  beforeAll(async () => {
    const { dataDir, ticket } = makeFixture({ html: PAGE_HTML });
    write(dataDir, REV_A, 'served/index.html', PAGE_HTML);
    const pagesPort = await freePort();
    const webPort = await freePort();
    const pagesOrigin = `http://127.0.0.1:${pagesPort}`;
    const webOrigin = `http://localhost:${webPort}`;
    const app = createPagesApp(makeConfig(dataDir, { pagesOrigin, webOrigin }), { log: () => {} });
    pages = serve({ fetch: app.fetch, port: pagesPort, hostname: '127.0.0.1' });
    const src = `${pagesOrigin}/v/${ticket(REV_A)}/`;
    shell = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>shell</title>
<iframe sandbox="${PAGE_IFRAME_SANDBOX}" src="${src}"></iframe>
<script>addEventListener('message', (e) => { if (e.data && e.data.nowmeResult) window.__result = e.data.nowmeResult; });</script>`);
    });
    await new Promise<void>((resolve) => shell.listen(webPort, 'localhost', resolve));
    shellUrl = `${webOrigin}/`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    shell?.close();
    pages?.close();
  });

  it('fetch、localStorage、cookie 写入均失败，字体能加载', async () => {
    const page = await browser.newPage();
    await page.goto(shellUrl);
    await page.waitForFunction(() => (globalThis as unknown as { __result?: unknown }).__result, null, { timeout: 15000 });
    const result = await page.evaluate(() => (globalThis as unknown as { __result: Record<string, unknown> }).__result);
    expect(result).toMatchObject({ fetch: 'blocked', localStorage: 'blocked', cookie: 'blocked', font: 'loaded' });
    expect(await page.context().cookies()).toEqual([]);
    await page.close();
  }, 30000);
});
