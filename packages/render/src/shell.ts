/**
 * 预览外壳（`http://localhost:<port>`）：模拟主站展示用户页面的方式（contracts 5、5.1、5.2）。
 *
 * - iframe 只有 `sandbox="allow-scripts"`（PAGE_IFRAME_SANDBOX），宽 375；
 * - 外壳自己的 CSP 用 buildWebCsp（frame-src 只允许预览页面源，script-src 'self'），脚本与样式都是外部文件；
 * - `shell.js` 监听 `nowme:open-link`（只认 iframe 发来的 https 地址，确认后 noopener 打开）；
 *   iframe 第一次加载之后再次触发 `load` 即视为自我导航：`serve` 模式下立即重置为空白页并提示，
 *   `render` 模式下只计数（渲染管线读取 `window.__nowmeShell` 报告）。
 */
import { OPEN_LINK_MESSAGE_TYPE, PAGE_IFRAME_SANDBOX, RENDER_VIEWPORT } from '@nowme/contracts';

export type ShellMode = 'render' | 'serve';

export const SHELL_ASSET_PREFIX = '/_shell/';
export const SHELL_FRAME_ID = 'nm-page';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface ShellPageInput {
  mode: ShellMode;
  /** iframe 的 src：`<pagesOrigin>/v/<ticket>/`。 */
  pageUrl: string;
  title?: string;
}

/** 外壳 HTML。 */
export function shellHtml({ mode, pageUrl, title }: ShellPageInput): string {
  const frame = `<iframe id="${SHELL_FRAME_ID}" src="${escapeHtml(pageUrl)}" sandbox="${PAGE_IFRAME_SANDBOX}" width="${RENDER_VIEWPORT.width}" height="${RENDER_VIEWPORT.height}" title="${escapeHtml(title ?? '用户页面')}" referrerpolicy="no-referrer"></iframe>`;
  const head = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title ? `${title} · NOWMe 本地预览` : 'NOWMe 本地预览')}</title>
<link rel="stylesheet" href="${SHELL_ASSET_PREFIX}shell.css">
<script src="${SHELL_ASSET_PREFIX}shell.js" defer></script>
</head>`;
  if (mode === 'render') {
    return `${head}
<body class="nm-shell nm-shell--render" data-mode="render">
${frame}
</body>
</html>
`;
  }
  return `${head}
<body class="nm-shell nm-shell--serve" data-mode="serve">
<header class="nm-shell__bar">
  <strong>NOWMe 本地预览</strong>
  <span>页面运行在沙箱 iframe 中（sandbox="${PAGE_IFRAME_SANDBOX}"，与平台展示时一致），宽 ${RENDER_VIEWPORT.width}px</span>
  <button type="button" id="nm-shell-reload">重新加载页面</button>
</header>
<p class="nm-shell__notice" id="nm-shell-notice" hidden></p>
<main class="nm-shell__stage">
${frame}
</main>
</body>
</html>
`;
}

/** 没有正在预览的页面时的首页。 */
export function shellIndexHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NOWMe 本地预览</title>
<link rel="stylesheet" href="${SHELL_ASSET_PREFIX}shell.css">
</head>
<body class="nm-shell nm-shell--serve">
<p class="nm-shell__notice">现在没有正在预览的页面。运行 <code>nowme preview page --serve</code> 后刷新这里。</p>
</body>
</html>
`;
}

export const SHELL_CSS = `
html, body { margin: 0; padding: 0; }
.nm-shell--render { background: #fff; }
.nm-shell--render iframe { display: block; border: 0; margin: 0; width: ${RENDER_VIEWPORT.width}px; }
.nm-shell--serve { min-height: 100vh; background: #e9e7e2; color: #222; font: 14px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.nm-shell__bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; background: #222; color: #eee; }
.nm-shell__bar span { color: #aaa; font-size: 12px; }
.nm-shell__bar button { margin-left: auto; font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid #555; background: #333; color: #eee; cursor: pointer; }
.nm-shell__notice { margin: 16px auto 0; max-width: 520px; padding: 10px 14px; border-radius: 8px; background: #fff3cd; color: #6b4e00; }
.nm-shell__stage { display: flex; justify-content: center; padding: 24px 16px 48px; }
.nm-shell--serve iframe { display: block; width: ${RENDER_VIEWPORT.width}px; height: min(812px, calc(100vh - 140px)); min-height: 560px; border: 0; border-radius: 18px; background: #fff; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.18); }
`;

/** 外壳脚本（外部文件，满足外壳 CSP 的 script-src 'self'）。 */
export const SHELL_JS = `(() => {
  'use strict';
  const frame = document.getElementById('${SHELL_FRAME_ID}');
  if (!frame) return;
  const mode = document.body.dataset.mode;
  const pageUrl = frame.getAttribute('src');
  const state = { loads: 0, navigations: 0, openLinks: [] };
  Object.defineProperty(window, '__nowmeShell', { value: state });
  const notice = document.getElementById('nm-shell-notice');
  const show = (text) => {
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = false;
  };
  let blocked = false;
  frame.addEventListener('load', () => {
    if (blocked) return;
    state.loads += 1;
    if (state.loads === 1) return;
    // 第一次加载之后再次 load：页面自我导航（contracts 5.2）
    state.navigations += 1;
    if (mode !== 'serve') return;
    blocked = true;
    frame.src = 'about:blank';
    show('这个页面试图跳转，已拦截。点“重新加载页面”再看一次。');
  });
  const reload = document.getElementById('nm-shell-reload');
  if (reload) {
    reload.addEventListener('click', () => {
      blocked = false;
      state.loads = 0;
      if (notice) notice.hidden = true;
      frame.src = pageUrl;
    });
  }
  // nowme.openLink（contracts 5.1）
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== ${JSON.stringify(OPEN_LINK_MESSAGE_TYPE)} || typeof data.url !== 'string') return;
    let url;
    try {
      url = new URL(data.url);
    } catch {
      return;
    }
    if (url.protocol !== 'https:') return;
    state.openLinks.push(url.href);
    if (mode !== 'serve') return;
    if (window.confirm('页面想打开外部链接：\\n' + url.hostname + '\\n\\n要打开吗？')) {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    }
  });
})();
`;
