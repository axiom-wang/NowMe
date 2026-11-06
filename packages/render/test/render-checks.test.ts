/**
 * 渲染检查（contracts 2.3）：恶意 / 异常页面在双源沙箱中渲染时报出的 RENDER_* 问题，
 * 以及超时、卡死之后浏览器还能继续用于下一次渲染。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RENDER_SLOW_MS, RENDER_TIMEOUT_MS, severityOf } from '@nowme/contracts';
import { createRenderer, lineFromStack, type Renderer, type RenderPassResult } from '../src/index.js';
import { pageHtml, servedOf } from './helpers.js';

let renderer: Renderer;

beforeAll(async () => {
  // 超时缩短到 4 s 让死循环用例快一些；默认值见最后一个用例
  renderer = await createRenderer({ timeoutMs: 4000, settleMs: 200 });
}, 60_000);

afterAll(async () => {
  await renderer?.close();
});

const codes = (result: RenderPassResult) => result.issues.map((issue) => issue.code);
const render = (html: string) => renderer.render(servedOf(html));

describe('渲染检查', () => {
  it('合法页面：没有问题，取到渲染后文字', async () => {
    const result = await render(pageHtml({ body: '<section data-nm-id="hero"><h1>你好世界</h1><p class="nm-reveal">我们</p></section>' }));
    expect(result.issues).toEqual([]);
    expect(result.failed).toBe(false);
    expect(result.renderedText).toContain('你好世界');
    expect(result.loadMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('外部图片 → RENDER_CSP_VIOLATION（error）', async () => {
    const result = await render(pageHtml({ body: '<p>你好</p><img src="https://example.com/x.png" alt="">' }));
    const issue = result.issues.find((item) => item.code === 'RENDER_CSP_VIOLATION');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('https://example.com/x.png');
    expect(issue?.hint).toContain('assets/');
  }, 30_000);

  it('fetch → RENDER_CSP_VIOLATION（只报一次，不另报 console.error）', async () => {
    const result = await render(pageHtml({ body: '<p>你好</p>', script: "fetch('https://example.com/api').catch(() => {});" }));
    expect(codes(result).filter((code) => code === 'RENDER_CSP_VIOLATION')).toHaveLength(1);
    expect(codes(result)).not.toContain('RENDER_CONSOLE_ERROR');
  }, 30_000);

  it('抛出异常 → RENDER_SCRIPT_ERROR，带 index.html 的行号', async () => {
    const html = pageHtml({ body: '<p>你好</p>', script: "const box = document.getElementById('missing');\nbox.textContent = '你好';" });
    const result = await render(html);
    const issue = result.issues.find((item) => item.code === 'RENDER_SCRIPT_ERROR');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain("Cannot set properties of null");
    const expectedLine = html.split('\n').findIndex((line) => line.includes('box.textContent')) + 1;
    expect(issue?.line).toBe(expectedLine);
  }, 30_000);

  it('空白页 → RENDER_BLANK（warning）', async () => {
    const result = await render(pageHtml({ body: '<div data-nm-id="hero"></div><canvas></canvas>' }));
    expect(codes(result)).toEqual(['RENDER_BLANK']);
    expect(severityOf('RENDER_BLANK')).toBe('warning');
  }, 30_000);

  it('console.error → RENDER_CONSOLE_ERROR（warning）', async () => {
    const result = await render(pageHtml({ body: '<p>你好</p>', script: "console.error('出错了', 42);" }));
    const issue = result.issues.find((item) => item.code === 'RENDER_CONSOLE_ERROR');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('出错了 42');
  }, 30_000);

  it('自我导航到外部地址：被外壳的 frame-src 拦截（不出网），报 RENDER_CSP_VIOLATION', async () => {
    const result = await render(pageHtml({ body: '<p>你好</p>', script: "setTimeout(() => { location.href = 'https://example.com/phish'; }, 50);" }));
    const violation = result.issues.find((item) => item.code === 'RENDER_CSP_VIOLATION' && item.message.includes('https://example.com/'));
    expect(violation?.message).toContain('frame-src');
    expect(result.navigations).toBe(1);
    expect(codes(result)).toContain('RENDER_CSP_VIOLATION');
  }, 30_000);

  it('加载后在页面源内自我导航（换到另一个地址）→ RENDER_CSP_VIOLATION（自我导航）', async () => {
    const result = await render(
      pageHtml({ body: '<p>你好</p>', script: "if (!location.pathname.endsWith('index.html')) setTimeout(() => { location.replace(location.pathname + 'index.html'); }, 50);" }),
    );
    expect(result.navigations).toBe(1);
    expect(result.issues.find((item) => item.message.includes('自我导航'))?.code).toBe('RENDER_CSP_VIOLATION');
  }, 30_000);

  it('top.location / 弹窗 / 表单提交被沙箱拦截 → RENDER_CSP_VIOLATION', async () => {
    const result = await render(
      pageHtml({ body: '<p>你好</p>', script: "try { top.location = 'https://example.com/'; } catch (e) {}\ntry { window.open('https://example.com/'); } catch (e) {}" }),
    );
    expect(codes(result)).toContain('RENDER_CSP_VIOLATION');
    expect(result.blockedRequests).toEqual([]);
  }, 30_000);

  it(`load 超过 ${RENDER_SLOW_MS} ms → RENDER_SLOW（warning）`, async () => {
    const result = await render(pageHtml({ body: '<p>你好</p>', script: `const t = Date.now(); while (Date.now() - t < ${RENDER_SLOW_MS + 300}) {}` }));
    expect(codes(result)).toEqual(['RENDER_SLOW']);
    expect(result.loadMs).toBeGreaterThan(RENDER_SLOW_MS);
  }, 30_000);

  it('死循环 → RENDER_FAILED（超时），之后同一个渲染器还能正常渲染', async () => {
    const started = Date.now();
    const result = await render(pageHtml({ body: '<p>你好</p>', script: 'while (true) {}' }));
    expect(result.failed).toBe(true);
    expect(codes(result)).toContain('RENDER_FAILED');
    expect(result.issues.find((item) => item.code === 'RENDER_FAILED')?.message).toContain('4 秒');
    expect(Date.now() - started).toBeLessThan(15_000);
    const next = await render(pageHtml({ body: '<p>你好</p>' }));
    expect(next.issues).toEqual([]);
    expect(next.renderedText).toContain('你好');
  }, 40_000);

  it('加载完成后才卡死（定时器里的死循环）→ RENDER_FAILED，之后仍能渲染', async () => {
    const result = await renderer.render(servedOf(pageHtml({ body: '<p>你好</p>', script: "setTimeout(() => { while (true) {} }, 50);" })), { cover: true, full: true });
    expect(result.failed).toBe(true);
    expect(codes(result)).toContain('RENDER_FAILED');
    const next = await renderer.render(servedOf(pageHtml({ body: '<p>世界</p>' })), { cover: true });
    expect(next.failed).toBe(false);
    expect(next.cover?.byteLength).toBeGreaterThan(0);
  }, 40_000);

  it('默认超时是 contracts 的 10 s', async () => {
    const fresh = await createRenderer();
    try {
      expect(fresh.timeoutMs).toBe(RENDER_TIMEOUT_MS);
      expect(RENDER_TIMEOUT_MS).toBe(10_000);
    } finally {
      await fresh.close();
    }
  });
});

describe('lineFromStack', () => {
  const pageUrl = 'http://127.0.0.1:4101/v/preview-abc/';
  it('取页面文档上的第一处位置', () => {
    expect(lineFromStack(`TypeError: x\n    at foo (${pageUrl}:12:5)\n    at ${pageUrl}:20:1`, pageUrl)).toBe(12);
    expect(lineFromStack(`Error\n    at ${pageUrl}index.html:7:3`, pageUrl)).toBe(7);
    expect(lineFromStack('Error\n    at http://127.0.0.1:4101/_nowme/kit/v1/nowme.js:5:1', pageUrl)).toBeUndefined();
    expect(lineFromStack(undefined, pageUrl)).toBeUndefined();
  });
});
