/**
 * 浏览器测试：工作区里的沙箱 iframe（views/page-frame.tsx + static/page-frame.js）。
 * 主站与页面托管都以真实 HTTP 服务运行在两个站点（localhost / 127.0.0.1）。
 *
 * - 5.2：页面脚本把 iframe 导航到别处 → 主站检测到第二次 load，重置为空白页并提示“已拦截”；主站 URL 不变；
 * - 5.1：openLink 只认来自页面 iframe 的 https 地址，确认框显示目标域名，确认后
 *   `window.open(url, '_blank', 'noopener,noreferrer')`；http 地址、别的来源的消息一律忽略；
 * - 主站页面在主站 CSP 下没有任何 CSP 违规（不用内联脚本 / 样式）。
 *
 * 测试页面绕过提交管线直接写进版本目录（这些页面会被校验器拒绝，正是要验证运行时防线）。
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { chromium, type Browser, type Page as BrowserPage } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId, PAGE_IFRAME_SANDBOX, SESSION_COOKIE_NAME } from '@nowme/contracts';
import { createPagesApp } from '@nowme/pages-host';
import { writeRevisionFiles } from '../../src/services/revision-storage.js';
import { publishPage, publishedMember } from '../wall-helpers.js';
import { createClock, createTestWeb, login, seedWall, TEST_SECRET, type TestSession, type TestWeb } from '../helpers.js';
import type { Page } from '../../src/db/pages.js';
import type { Wall } from '../../src/db/walls.js';

/** 浏览器里的 window（本包的 tsconfig 不含 DOM 类型）。 */
interface BrowserWindow {
  __opened: unknown[];
  __violations?: string[];
  __loads?: number;
  __frame?: unknown;
  open: (...args: unknown[]) => unknown;
  postMessage: (message: unknown, targetOrigin: string) => void;
  document: {
    addEventListener(type: 'securitypolicyviolation', listener: (event: { violatedDirective: string; blockedURI: string }) => void): void;
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const doc = (body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

const SELF_NAVIGATE = doc(`<p>我要跳走</p><script>
setTimeout(function () { location.href = location.href.replace(/\\/$/, '/index.html'); }, 300);
</script>`);

const OPEN_LINKS = doc(`<p>外链</p><script>
setTimeout(function () {
  parent.postMessage({ type: 'nowme:open-link', url: 'http://insecure.example/' }, '*');
  parent.postMessage({ type: 'nowme:open-link', url: 'javascript:alert(1)' }, '*');
  parent.postMessage({ type: 'other', url: 'https://other.example/' }, '*');
  parent.postMessage({ type: 'nowme:open-link', url: 'https://example.com/hello?x=1' }, '*');
}, 200);
</script>`);

describe('浏览器：工作区沙箱 iframe（contracts 5.1、5.2）', () => {
  let t: TestWeb;
  let owner: TestSession;
  let wall: Wall;
  let page: Page;
  let member: ReturnType<typeof seedWall>;
  let browser: Browser;
  let webServer: ReturnType<typeof serve>;
  let pagesServer: ReturnType<typeof serve>;

  async function addRevision(html: string): Promise<string> {
    const id = generateId('rev');
    await writeRevisionFiles(t.dataDir, id, {
      original: new Map([['index.html', Buffer.from(html)]]),
      served: new Map([['index.html', Buffer.from(html)]]),
      cover: null,
      fullScreenshot: null,
    });
    t.repos.revisions.insert({
      id,
      pageId: page.id,
      source: 'local-agent',
      credentialId: null,
      status: 'accepted',
      report: { ok: true, errors: [], warnings: [], stats: {} as never, validatorVersion: 'test' },
      cardJson: null,
      manifestJson: null,
      renderedText: null,
      renderJson: null,
      createdAt: t.clock.now().toISOString(),
    });
    return id;
  }

  async function openSite(path: string): Promise<{ tab: BrowserPage; violations: string[]; dialogs: string[] }> {
    const context = await browser.newContext();
    await context.addCookies([{ name: SESSION_COOKIE_NAME, value: owner.token, domain: 'localhost', path: '/' }]);
    // 只允许访问两个本地源，外部地址一律拦下
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === t.config.webOrigin || url.origin === t.config.pagesOrigin ? route.continue() : route.abort();
    });
    const tab = await context.newPage();
    await tab.addInitScript(() => {
      const win = globalThis as unknown as BrowserWindow;
      const opened: unknown[] = [];
      Object.defineProperty(win, '__opened', { value: opened });
      win.open = (...args: unknown[]) => {
        opened.push(args);
        return null;
      };
      win.document.addEventListener('securitypolicyviolation', (event) => {
        (win.__violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const dialogs: string[] = [];
    tab.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    await tab.goto(`${t.config.webOrigin}${path}`);
    const violations = await tab.evaluate(() => (globalThis as unknown as BrowserWindow).__violations ?? []);
    return { tab, violations, dialogs };
  }

  async function openWorkspace(revisionId: string): Promise<{ tab: BrowserPage; violations: string[]; dialogs: string[] }> {
    return openSite(`/w/${wall.id}/me?rev=${revisionId}`);
  }

  beforeAll(async () => {
    const webPort = await freePort();
    const pagesPort = await freePort();
    // 用真实时钟：浏览器里的票据要在当前时间有效
    t = createTestWeb({
      clock: createClock(new Date()),
      env: { NOWME_WEB_ORIGIN: `http://localhost:${webPort}`, NOWME_PAGES_ORIGIN: `http://127.0.0.1:${pagesPort}` },
    });
    owner = await login(t, 'owner@example.com', '林舟');
    member = seedWall(t, owner.userId);
    ({ wall, page } = member);
    webServer = serve({ fetch: t.web.fetch, port: webPort, hostname: '127.0.0.1' });
    const pagesApp = createPagesApp({ ...t.config, ticketSecret: TEST_SECRET }, { log: () => {} });
    pagesServer = serve({ fetch: pagesApp.fetch, port: pagesPort, hostname: '127.0.0.1' });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    webServer?.close();
    pagesServer?.close();
    await t?.close();
  });

  it('页面自我导航：iframe 被重置为空白页并提示“已拦截”，主站 URL 不变', async () => {
    const revisionId = await addRevision(SELF_NAVIGATE);
    const { tab, violations } = await openWorkspace(revisionId);
    const frame = tab.locator('iframe[data-nm-page-frame]');
    await expect.poll(() => frame.getAttribute('src'), { timeout: 10_000 }).toBe('about:blank');
    await expect.poll(() => tab.locator('[data-nm-page-frame-notice]').isVisible()).toBe(true);
    expect(await tab.locator('[data-nm-page-frame-notice]').textContent()).toContain('这个页面试图跳转，已拦截');
    expect(tab.url()).toBe(`${t.config.webOrigin}/w/${wall.id}/me?rev=${revisionId}`);
    expect(violations).toEqual([]);

    // “重新加载页面”恢复原地址（之后它会再次跳走、再次被拦截）
    await tab.locator('[data-nm-page-frame-reload]').click();
    await expect.poll(() => frame.getAttribute('src')).toMatch(new RegExp(`^${t.config.pagesOrigin}/v/`));
    await expect.poll(() => frame.getAttribute('src'), { timeout: 10_000 }).toBe('about:blank');
    await tab.context().close();
  }, 60_000);

  it('openLink：只处理来自页面 iframe 的 https 地址，确认框显示域名，noopener 打开；其余忽略', async () => {
    const revisionId = await addRevision(OPEN_LINKS);
    const { tab, dialogs, violations } = await openWorkspace(revisionId);
    await expect.poll(() => tab.evaluate(() => (globalThis as unknown as BrowserWindow).__opened.length), { timeout: 10_000 }).toBe(1);
    expect(await tab.evaluate(() => (globalThis as unknown as BrowserWindow).__opened)).toEqual([
      ['https://example.com/hello?x=1', '_blank', 'noopener,noreferrer'],
    ]);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain('example.com');

    // 主站自己（不是页面 iframe）发来的消息被忽略
    await tab.evaluate(() => (globalThis as unknown as BrowserWindow).postMessage({ type: 'nowme:open-link', url: 'https://evil.example/' }, '*'));
    await tab.waitForTimeout(300);
    expect(dialogs).toHaveLength(1);
    expect(await tab.evaluate(() => (globalThis as unknown as BrowserWindow).__opened.length)).toBe(1);
    // 页面没有跳转，iframe 没有被重置
    expect(await tab.locator('iframe[data-nm-page-frame]').getAttribute('src')).toMatch(new RegExp(`^${t.config.pagesOrigin}/v/`));
    expect(violations).toEqual([]);
    await tab.context().close();
  }, 60_000);

  it('展示模式：进入不重建 iframe；连播切换保留严格 sandbox，Esc 退出并跟随当前页', async () => {
    const first = publishPage(t, member, '林舟');
    const second = publishedMember(t, wall, { name: '第二位' });
    const { tab, dialogs, violations } = await openSite(`/w/${wall.id}/p/${first.page.id}`);
    const root = tab.locator('[data-nm-page-frame-root]');
    const frame = tab.locator('iframe[data-nm-page-frame]');
    await expect.poll(() => frame.getAttribute('src')).toMatch(new RegExp(`^${t.config.pagesOrigin}/v/`));
    const beforeSrc = (await frame.getAttribute('src'))!;

    await tab.evaluate(() => {
      const win = globalThis as unknown as BrowserWindow & {
        document: { querySelector(selector: string): { addEventListener(type: string, listener: () => void): void } | null };
      };
      win.__loads = 0;
      const element = win.document.querySelector('iframe[data-nm-page-frame]')!;
      win.__frame = element;
      element.addEventListener('load', () => {
        win.__loads = (win.__loads ?? 0) + 1;
      });
    });

    await tab.locator('[data-nm-stage-open]').click();
    await expect.poll(() => root.getAttribute('class')).toContain('page-frame--stage');
    expect(await tab.evaluate(() => {
      const win = globalThis as unknown as BrowserWindow & {
        document: { querySelector(selector: string): unknown };
      };
      return win.document.querySelector('iframe[data-nm-page-frame]') === win.__frame;
    })).toBe(true);
    expect(await frame.getAttribute('src')).toBe(beforeSrc);
    expect(await frame.getAttribute('sandbox')).toBe(PAGE_IFRAME_SANDBOX);
    expect(await frame.evaluate((element) => element.hasAttribute('allow'))).toBe(false);
    expect(await frame.evaluate((element) => element.clientWidth)).toBe(375);
    await tab.waitForTimeout(400);
    expect(await tab.evaluate(() => (globalThis as unknown as BrowserWindow).__loads)).toBe(0);

    // 展示模式里页面发起的 openLink 仍然要确认后才打开
    const child = tab.frames().find((candidate) => candidate !== tab.mainFrame())!;
    await child.evaluate(() => {
      (globalThis as unknown as { parent: { postMessage(message: unknown, targetOrigin: string): void } }).parent.postMessage(
        { type: 'nowme:open-link', url: 'https://example.com/stage' },
        '*',
      );
    });
    await expect.poll(() => tab.evaluate(() => (globalThis as unknown as BrowserWindow).__opened.length)).toBe(1);
    expect(dialogs.at(-1)).toContain('example.com');

    // Linux Chromium 可能在原生 confirm 弹窗时退出全屏，重新进入后再验证连播。
    if (!(await root.getAttribute('class'))?.includes('page-frame--stage')) {
      await tab.locator('[data-nm-stage-open]').click();
      await expect.poll(() => root.getAttribute('class')).toContain('page-frame--stage');
    }

    // 下一位：换一个新 iframe，沙箱不变，位置更新
    // 全屏时 Playwright 的命中测试不可用，直接触发按钮的 click。
    await tab.locator('[data-nm-stage-next-button]').evaluate((button) => (button as unknown as { click(): void }).click());
    await expect.poll(() => root.getAttribute('data-nm-stage-page')).toBe(second.page.id);
    await expect.poll(() => frame.getAttribute('src')).toMatch(new RegExp(`^${t.config.pagesOrigin}/v/`));
    expect(await frame.getAttribute('src')).not.toBe(beforeSrc);
    expect(await frame.getAttribute('sandbox')).toBe(PAGE_IFRAME_SANDBOX);
    expect(await tab.locator('[data-nm-stage-position]').textContent()).toBe('2 / 2');
    const switchedName = await tab.locator('[data-nm-stage-name]').textContent();
    expect(await root.getAttribute('aria-label')).toBe(`${switchedName}的展示模式`);
    expect(await root.getAttribute('aria-label')).not.toContain('林舟');

    // 连播切换后的新 iframe 仍然拦截自我导航
    const switched = tab.frames().find((candidate) => candidate !== tab.mainFrame())!;
    await switched.evaluate(() => {
      const win = globalThis as unknown as { location: { href: string } };
      win.location.href = win.location.href.replace(/\/?$/, '/index.html');
    });
    await expect.poll(() => frame.getAttribute('src'), { timeout: 10_000 }).toBe('about:blank');

    // Esc 退出展示模式，并跟随到当前正在看的那一页
    await tab.keyboard.press('Escape');
    await expect.poll(() => root.getAttribute('class')).not.toContain('page-frame--stage');
    await expect.poll(() => tab.url()).toContain(`/p/${second.page.id}`);
    expect(violations).toEqual([]);
    await tab.context().close();
  }, 60_000);
});
