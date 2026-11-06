/**
 * 渲染器：一个 Chromium 实例 + 一个双源预览服务器，可以反复渲染多个页面（主站提交管线与 CLI 共用）。
 *
 * 每次渲染（一个 pass）：
 * 1. 把 `served/` 挂到预览服务器的随机票据下，新建浏览器上下文（375×667、DPR 2，按需 `prefers-reduced-motion: reduce`），
 *    拦截一切不是外壳源 / 页面源的请求（页面自我导航到外部、内网地址都到不了网络）；
 * 2. 打开外壳的渲染页（iframe 在左上角，`sandbox="allow-scripts"`），等外壳 `load`（包含 iframe 的 load），
 *    超过 10 s 报 RENDER_FAILED；load 超过 3 s 报 RENDER_SLOW；
 * 3. 收集未捕获异常（RENDER_SCRIPT_ERROR）、CSP / 沙箱拦截（RENDER_CSP_VIOLATION）、`console.error`
 *    （RENDER_CONSOLE_ERROR）、被拦截的请求与自我导航（RENDER_CSP_VIOLATION）、崩溃（RENDER_FAILED）；
 * 4. 等字体就绪与短暂稳定后取渲染后文字（`innerText`，空白报 RENDER_BLANK），截首屏 375×500 → 750×1000；
 * 5. 调 `nowme.revealAll()`，把 iframe 高度调成内容高度后截整页，并按 `data-nm-id` 分块截图。
 *
 * 每一步都有超时；超时或崩溃后关闭上下文（杀掉卡死的渲染进程），浏览器可以继续用于下一次渲染，
 * 浏览器本身断开时下次渲染自动重新启动（只限渲染器自己启动的浏览器）。
 */
import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Frame,
  type LaunchOptions,
  type Page,
} from 'playwright';
import {
  COVER_CSS_HEIGHT,
  COVER_CSS_WIDTH,
  COVER_DEVICE_SCALE_FACTOR,
  RENDER_SLOW_MS,
  RENDER_TIMEOUT_MS,
  RENDER_VIEWPORT,
  type ValidationIssue,
} from '@nowme/contracts';
import { RENDER_HINTS, renderIssue, renderMessages } from './issues.js';
import { PreviewServer } from './server.js';
import { SHELL_FRAME_ID } from './shell.js';

/** 整页截图的最大高度（CSS 像素）。DPR 2 下为 16000 设备像素，低于 Chromium 的纹理上限 16384。 */
export const FULL_PAGE_MAX_CSS_HEIGHT = 8000;
/** 字体就绪之后、截图之前的稳定时间（让首屏的 JS 初始化与入场动效跑完）。 */
export const DEFAULT_SETTLE_MS = 600;
/** 关闭浏览器上下文的超时（卡死的渲染进程会被一并结束）。 */
const CONTEXT_CLOSE_TIMEOUT_MS = 5000;

export interface RendererOptions {
  /** 复用已有的浏览器（渲染器不会关闭它）。不给时由渲染器启动本机 Chromium。 */
  browser?: Browser;
  /** 渲染器自己启动浏览器时的参数。 */
  launchOptions?: LaunchOptions;
  /** 复用已有的预览服务器（渲染器不会关闭它）。不给时用随机端口启动一个。 */
  server?: PreviewServer;
  /** 渲染超时（ms），默认 RENDER_TIMEOUT_MS（10 s）：外壳 load 与之后每一步各自的上限。 */
  timeoutMs?: number;
  /** load 超过这个时长报 RENDER_SLOW，默认 RENDER_SLOW_MS（3 s）。 */
  slowMs?: number;
  /** 字体就绪后的稳定时间，默认 DEFAULT_SETTLE_MS。 */
  settleMs?: number;
}

export interface RenderPassOptions {
  /** 以 `prefers-reduced-motion: reduce` 渲染。 */
  reducedMotion?: boolean;
  /** 截首屏封面（375×500 CSS 像素 → 750×1000，未压缩的原始截图）。 */
  cover?: boolean;
  /** 截整页（先 `nowme.revealAll()`，再把 iframe 调成内容高度）。 */
  full?: boolean;
  /** 按 `data-nm-id` 分块截图（会同时调整为整页高度）。 */
  blocks?: boolean;
  /** 外壳标题（`--serve` 时显示）。 */
  title?: string;
}

export interface BlockScreenshot {
  /** `data-nm-id` 的值。 */
  id: string;
  /** 区块在整页中的位置（CSS 像素）。 */
  top: number;
  height: number;
  png: Uint8Array;
}

export interface RenderPassResult {
  reducedMotion: boolean;
  /** 只含 RENDER_* 问题。 */
  issues: ValidationIssue[];
  /** 出现 RENDER_FAILED（超时、崩溃、内部错误）。 */
  failed: boolean;
  /** 外壳 load（含 iframe load）耗时；超时为 null。 */
  loadMs: number | null;
  durationMs: number;
  /** iframe 内 `document.body.innerText`。 */
  renderedText: string;
  cover: Uint8Array | null;
  full: Uint8Array | null;
  blocks: BlockScreenshot[];
  /** 内容高度与整页截图高度（CSS 像素）；没截整页时为 null。 */
  contentHeight: number | null;
  fullHeight: number | null;
  /** 内容高于 FULL_PAGE_MAX_CSS_HEIGHT，整页截图被截断。 */
  truncated: boolean;
  /** 被拦截的请求（外壳源、页面源以外的地址）。 */
  blockedRequests: { url: string; navigation: boolean }[];
  /** 首次加载之后 iframe 又触发 load 的次数（自我导航）。 */
  navigations: number;
  /** 页面通过 nowme.openLink 请求打开的地址（外壳只记录，不打开）。 */
  openLinks: string[];
}

class RenderAbort extends Error {}

/** 给 promise 加超时；超时抛 RenderAbort（并吞掉原 promise 之后的拒绝）。 */
function within<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new RenderAbort('timeout'));
    }, ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 从异常栈里取页面文档的行号（`.../v/<ticket>/:12:34` 或 `.../index.html:12:34`）。 */
export function lineFromStack(stack: string | undefined, pageUrl: string): number | undefined {
  if (!stack) return undefined;
  const escaped = pageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?:index\\.html)?:(\\d+):\\d+`);
  const match = pattern.exec(stack);
  return match ? Number(match[1]) : undefined;
}

const CSP_PRIMARY = /violates the following Content Security Policy directive|Refused to [^\n]* because it violates the following Content Security Policy/i;
const CSP_ANY = /Content Security Policy/i;
const SANDBOX_BLOCK = /sandboxed|Unsafe attempt to initiate navigation/i;
const SANDBOX_MODAL = /allow-modals/i;
const BLOCKED_BY_CLIENT = /ERR_BLOCKED_BY_CLIENT/;

// iframe / 外壳里执行的脚本（字符串形式：本包的 tsconfig 不含 DOM 类型）。
const SCRIPT_FONTS_READY = 'document.fonts ? document.fonts.ready.then(() => document.fonts.size) : 0';
const SCRIPT_INNER_TEXT = "document.body ? document.body.innerText : ''";
const SCRIPT_REVEAL_ALL = "(() => { const n = window.nowme; if (n && typeof n.revealAll === 'function') n.revealAll(); return true; })()";
const SCRIPT_CONTENT_HEIGHT =
  'Math.ceil(Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0))';
const SCRIPT_BLOCK_RECTS = `Array.from(document.querySelectorAll('[data-nm-id]')).map((el) => {
  const rect = el.getBoundingClientRect();
  return { id: el.getAttribute('data-nm-id') || '', top: rect.top + window.scrollY, height: rect.height };
})`;
const SCRIPT_SHELL_STATE =
  "(() => { const s = window.__nowmeShell; return s ? { loads: s.loads, navigations: s.navigations, openLinks: s.openLinks.slice(0, 20) } : null; })()";
const scriptSetFrameHeight = (height: number) =>
  `(() => { const f = document.getElementById(${JSON.stringify(SHELL_FRAME_ID)}); if (f) { f.style.height = '${height}px'; f.height = '${height}'; } return true; })()`;
const SCRIPT_NEXT_FRAME = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';

export class Renderer {
  private browser: Browser | null;
  private readonly ownsBrowser: boolean;
  private readonly ownsServer: boolean;
  private closed = false;
  readonly timeoutMs: number;
  readonly slowMs: number;
  readonly settleMs: number;

  private constructor(
    readonly server: PreviewServer,
    browser: Browser | null,
    private readonly options: RendererOptions,
  ) {
    this.browser = browser;
    this.ownsBrowser = options.browser === undefined;
    this.ownsServer = options.server === undefined;
    this.timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
    this.slowMs = options.slowMs ?? RENDER_SLOW_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  }

  /** 创建渲染器（启动预览服务器；浏览器在第一次渲染时才启动）。用完调用 `close()`。 */
  static async create(options: RendererOptions = {}): Promise<Renderer> {
    const server = options.server ?? (await PreviewServer.start());
    return new Renderer(server, options.browser ?? null, options);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('渲染器已关闭');
    if (this.browser?.isConnected()) return this.browser;
    if (!this.ownsBrowser) throw new Error('传入的浏览器已断开');
    this.browser = await chromium.launch({ headless: true, timeout: RENDER_TIMEOUT_MS * 3, ...this.options.launchOptions });
    return this.browser;
  }

  /** 浏览器卡死时丢弃它，下次渲染重新启动。 */
  private discardBrowser(): void {
    if (!this.ownsBrowser || !this.browser) return;
    const stale = this.browser;
    this.browser = null;
    void stale.close().catch(() => undefined);
  }

  /** 渲染一次（见文件头）。不会抛出页面相关的错误：问题都记在返回的 issues 里。 */
  async render(served: ReadonlyMap<string, Uint8Array>, options: RenderPassOptions = {}): Promise<RenderPassResult> {
    const started = Date.now();
    const reducedMotion = options.reducedMotion ?? false;
    const result: RenderPassResult = {
      reducedMotion,
      issues: [],
      failed: false,
      loadMs: null,
      durationMs: 0,
      renderedText: '',
      cover: null,
      full: null,
      blocks: [],
      contentHeight: null,
      fullHeight: null,
      truncated: false,
      blockedRequests: [],
      navigations: 0,
      openLinks: [],
    };
    const issues = result.issues;
    const seen = new Set<string>();
    const add = (issue: ValidationIssue) => {
      const key = `${issue.code}\u0000${issue.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push(issue);
    };
    const fail = (message: string, hint: string) => {
      if (result.failed) return;
      result.failed = true;
      add(renderIssue('RENDER_FAILED', message, hint));
    };

    const browser = await this.ensureBrowser();
    const published = this.server.publish(served, { title: options.title });
    const { shellOrigin, pagesOrigin } = this.server;
    let context: BrowserContext | null = null;
    let crashed = false;
    const secondaryCsp: string[] = [];
    let primaryCsp = 0;

    const step = <T>(promise: Promise<T>): Promise<T> =>
      within(promise, this.timeoutMs, () => fail(renderMessages.timeout(this.timeoutMs), RENDER_HINTS.timeout));

    try {
      context = await browser.newContext({
        viewport: { ...RENDER_VIEWPORT },
        deviceScaleFactor: COVER_DEVICE_SCALE_FACTOR,
        reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
        colorScheme: 'light',
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        acceptDownloads: false,
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (url.startsWith(`${shellOrigin}/`) || url.startsWith(`${pagesOrigin}/`)) return route.continue();
        result.blockedRequests.push({ url, navigation: request.isNavigationRequest() });
        return route.abort('blockedbyclient');
      });
      const page: Page = await context.newPage();
      page.on('pageerror', (error) => {
        add(renderIssue('RENDER_SCRIPT_ERROR', renderMessages.scriptError(error.message || String(error)), RENDER_HINTS.script, lineFromStack(error.stack, published.pageUrl)));
      });
      page.on('console', (message: ConsoleMessage) => {
        if (message.type() !== 'error') return;
        const location = message.location();
        if (location.url && !location.url.startsWith(`${pagesOrigin}/`)) return;
        const text = message.text();
        const line = location.lineNumber > 0 ? location.lineNumber + 1 : undefined;
        if (BLOCKED_BY_CLIENT.test(text)) return;
        if (CSP_PRIMARY.test(text)) {
          primaryCsp += 1;
          add(renderIssue('RENDER_CSP_VIOLATION', renderMessages.cspViolation(text), RENDER_HINTS.csp, line));
        } else if (CSP_ANY.test(text)) {
          secondaryCsp.push(text);
        } else if (SANDBOX_BLOCK.test(text) && !SANDBOX_MODAL.test(text)) {
          add(renderIssue('RENDER_CSP_VIOLATION', renderMessages.cspViolation(text), RENDER_HINTS.csp, line));
        } else {
          add(renderIssue('RENDER_CONSOLE_ERROR', renderMessages.consoleError(text), RENDER_HINTS.console, line));
        }
      });
      page.on('crash', () => {
        crashed = true;
        fail(renderMessages.crash(), RENDER_HINTS.crash);
      });

      const loadStarted = Date.now();
      try {
        await page.goto(published.renderUrl, { waitUntil: 'load', timeout: this.timeoutMs });
      } catch (error) {
        if (crashed) throw new RenderAbort('crash');
        if (error instanceof playwrightErrors.TimeoutError) {
          fail(renderMessages.timeout(this.timeoutMs), RENDER_HINTS.timeout);
          throw new RenderAbort('timeout');
        }
        throw error;
      }
      result.loadMs = Date.now() - loadStarted;
      if (result.loadMs > this.slowMs) add(renderIssue('RENDER_SLOW', renderMessages.slow(result.loadMs), RENDER_HINTS.slow));

      const frameElement = await step(page.$(`#${SHELL_FRAME_ID}`));
      const frame: Frame | null = frameElement ? await step(frameElement.contentFrame()) : null;
      if (!frame) throw new Error('外壳里找不到页面 iframe');

      await step(frame.evaluate(SCRIPT_FONTS_READY));
      await step(page.waitForTimeout(this.settleMs));
      result.renderedText = String(await step(frame.evaluate(SCRIPT_INNER_TEXT)));

      if (options.cover) {
        result.cover = await step(
          page.screenshot({
            clip: { x: 0, y: 0, width: COVER_CSS_WIDTH, height: COVER_CSS_HEIGHT },
            animations: 'disabled',
            caret: 'hide',
            scale: 'device',
            timeout: this.timeoutMs,
          }),
        );
      }

      if (options.full || options.blocks) {
        await step(frame.evaluate(SCRIPT_REVEAL_ALL));
        // 调整 iframe 高度会改变 vh：重复几次直到高度稳定（Kit 的 nm-hero 有 760px 上限，通常两次就稳定）
        let height: number = RENDER_VIEWPORT.height;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const content = Number(await step(frame.evaluate(SCRIPT_CONTENT_HEIGHT)));
          result.contentHeight = content;
          const target = Math.min(Math.max(content, RENDER_VIEWPORT.height), FULL_PAGE_MAX_CSS_HEIGHT);
          if (target === height && attempt > 0) break;
          height = target;
          await step(page.setViewportSize({ width: RENDER_VIEWPORT.width, height }));
          await step(page.evaluate(scriptSetFrameHeight(height)));
          await step(frame.evaluate(SCRIPT_NEXT_FRAME));
        }
        result.fullHeight = height;
        result.truncated = (result.contentHeight ?? 0) > FULL_PAGE_MAX_CSS_HEIGHT;
        // 新进入视口的 nm-reveal 等由 IntersectionObserver 触发的效果
        await step(frame.evaluate(SCRIPT_REVEAL_ALL));
        await step(page.waitForTimeout(300));
        if (options.full) {
          result.full = await step(page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device', timeout: this.timeoutMs }));
        }
        if (options.blocks) {
          const rects = (await step(frame.evaluate(SCRIPT_BLOCK_RECTS))) as { id: string; top: number; height: number }[];
          for (const rect of rects) {
            const top = Math.max(0, Math.floor(rect.top));
            const bottom = Math.min(height, Math.ceil(rect.top + rect.height));
            if (!rect.id || bottom - top < 1) continue;
            const png = await step(
              page.screenshot({
                clip: { x: 0, y: top, width: RENDER_VIEWPORT.width, height: bottom - top },
                animations: 'disabled',
                caret: 'hide',
                scale: 'device',
                timeout: this.timeoutMs,
              }),
            );
            result.blocks.push({ id: rect.id, top, height: bottom - top, png });
          }
        }
      }

      const shell = (await step(page.evaluate(SCRIPT_SHELL_STATE))) as { loads: number; navigations: number; openLinks: string[] } | null;
      if (shell) {
        result.navigations = shell.navigations;
        result.openLinks = shell.openLinks;
      }
    } catch (error) {
      if (!(error instanceof RenderAbort)) {
        if (crashed) fail(renderMessages.crash(), RENDER_HINTS.crash);
        else fail(renderMessages.failed(error instanceof Error ? error.message : String(error)), RENDER_HINTS.failed);
      }
    } finally {
      if (context) {
        const closing = context.close();
        let hung = false;
        await within(closing, CONTEXT_CLOSE_TIMEOUT_MS, () => {
          hung = true;
        }).catch(() => undefined);
        if (hung) this.discardBrowser();
      }
      this.server.unpublish(published.ticket);
    }

    if (primaryCsp === 0) {
      for (const text of secondaryCsp) add(renderIssue('RENDER_CSP_VIOLATION', renderMessages.cspViolation(text), RENDER_HINTS.csp));
    }
    const blockedSeen = new Set<string>();
    for (const blocked of result.blockedRequests) {
      if (blockedSeen.has(blocked.url)) continue;
      blockedSeen.add(blocked.url);
      add(renderIssue('RENDER_CSP_VIOLATION', renderMessages.blockedRequest(blocked.url, blocked.navigation), blocked.navigation ? RENDER_HINTS.navigation : RENDER_HINTS.csp));
    }
    if (result.navigations > 0) add(renderIssue('RENDER_CSP_VIOLATION', renderMessages.selfNavigation(result.navigations), RENDER_HINTS.navigation));
    if (!result.failed && result.renderedText.trim() === '') add(renderIssue('RENDER_BLANK', renderMessages.blank(), RENDER_HINTS.blank));
    result.durationMs = Date.now() - started;
    return result;
  }

  /** 关闭渲染器自己启动的浏览器与服务器（传入的不关闭）。可以重复调用。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const browser = this.browser;
    this.browser = null;
    if (this.ownsBrowser && browser) await browser.close().catch(() => undefined);
    if (this.ownsServer) await this.server.close();
  }
}

/** 创建渲染器（`Renderer.create` 的简写）。 */
export function createRenderer(options: RendererOptions = {}): Promise<Renderer> {
  return Renderer.create(options);
}
