/**
 * @nowme/render：无头渲染（Playwright）、截图、渲染后文字提取、CSP 违规检测、字体子集化、
 * 本地双源预览服务器（contracts 0.2、2.3）。
 *
 * 占位（T0.2）：只提供启动 Chromium 的入口；渲染管线由 T1.3 实现。
 * 渲染与预览必须使用 @nowme/contracts 的 buildPageCsp / PAGE_SECURITY_HEADERS / PAGE_IFRAME_SANDBOX。
 *
 * Playwright 精确锁定 1.58.2（Chromium 构建号 1208）。
 */
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { RENDER_TIMEOUT_MS, RENDER_VIEWPORT } from '@nowme/contracts';

export { RENDER_TIMEOUT_MS, RENDER_VIEWPORT };

/** 启动无头 Chromium。调用方负责 `browser.close()`。 */
export function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: true, timeout: RENDER_TIMEOUT_MS * 3, ...options });
}
