import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import {
  buildPageCsp,
  DEFAULT_PAGES_ORIGIN,
  DEFAULT_WEB_ORIGIN,
  PAGE_SECURITY_HEADERS,
} from '@nowme/contracts';
import { launchChromium, RENDER_VIEWPORT } from '../src/index.js';

describe('Playwright 冒烟测试（本机 Chromium）', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Linux 默认关闭 WebBluetooth，连对应的 Permissions-Policy 名字也不识别。
    // 在测试中开启该能力，才能验证响应头确实禁止它；生产响应头不变。
    // Chromium: services/network/public/cpp/permissions_policy/permissions_policy_features.json5
    browser = await launchChromium({ args: ['--enable-blink-features=WebBluetooth'] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('打开 data: 页面并读取标题', async () => {
    const page = await browser.newPage({ viewport: RENDER_VIEWPORT });
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>NOWMe 冒烟</title><p>你好</p>')}`);
    expect(await page.title()).toBe('NOWMe 冒烟');
    expect(await page.textContent('p')).toBe('你好');
    await page.close();
  });

  it('Chromium 接受 contracts 的页面 CSP 与安全头：内联脚本可运行，eval 与网络请求被拦截，无控制台报错', async () => {
    const ticket = 'smoke-ticket';
    const url = `${DEFAULT_PAGES_ORIGIN}/v/${ticket}/`;
    const page = await browser.newPage();
    const consoleMessages: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push(message.text());
    });
    const requested: string[] = [];
    await page.route('**/*', async (route) => {
      requested.push(route.request().url());
      if (route.request().url() !== url) return route.abort();
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: {
          ...PAGE_SECURITY_HEADERS,
          'Content-Security-Policy': buildPageCsp({
            pagesOrigin: DEFAULT_PAGES_ORIGIN,
            ticket,
            frameAncestors: DEFAULT_WEB_ORIGIN,
          }),
        },
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>csp</title></head><body>
<p id="out">未运行</p>
<script>
  const results = { inline: true, origin: window.origin };
  window.addEventListener('securitypolicyviolation', (e) => {
    (window.__violations ||= []).push(e.violatedDirective);
  });
  try { eval('1'); results.eval = 'allowed'; } catch { results.eval = 'blocked'; }
  try { localStorage.getItem('x'); results.storage = 'allowed'; } catch { results.storage = 'blocked'; }
  document.getElementById('out').textContent = JSON.stringify(results);
</script></body></html>`,
      });
    });
    await page.goto(url);
    const results = JSON.parse((await page.textContent('#out')) ?? '{}');
    expect(results.inline).toBe(true);
    expect(results.eval).toBe('blocked');
    // CSP sandbox allow-scripts（无 allow-same-origin）：文档是不透明源，拿不到 localStorage
    expect(results.origin).toBe('null');
    expect(results.storage).toBe('blocked');
    expect(await page.evaluate(() => {
      const policy = (globalThis as unknown as { document: { featurePolicy: { allowsFeature(feature: string): boolean } } }).document.featurePolicy;
      return policy.allowsFeature('bluetooth');
    })).toBe(false);

    const fetchResult = await page.evaluate(async () => {
      try {
        await fetch('http://127.0.0.1:4000/probe');
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });
    expect(fetchResult).toBe('blocked');
    expect(requested).toEqual([url]);
    // 允许出现 CSP 违规本身的报告（“Refused to … Content Security Policy …”），
    // 但不允许出现响应头解析错误：未知的 Permissions-Policy 特性名、未知 / 重复的 CSP 指令等。
    const headerErrors = consoleMessages.filter((text) => /Permissions-Policy|Content-Security-Policy/.test(text));
    expect(headerErrors).toEqual([]);
    await page.close();
  });
});
