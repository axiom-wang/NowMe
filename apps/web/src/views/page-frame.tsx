/**
 * 展示用户页面的 iframe（S1、contracts 5.1、5.2）。工作区预览（T2.1）、成员页（T3.1）、公开链接（T3.2）都用它。
 *
 * - `sandbox` 只能是 PAGE_IFRAME_SANDBOX（`allow-scripts`）：永远不加 allow-same-origin、allow-top-navigation*、
 *   allow-forms、allow-popups*、allow-modals；
 * - `src` 只能来自 TicketIssuer（`<NOWME_PAGES_ORIGIN>/v/<票据>/`），票据只在授权检查通过后签发；
 * - `referrerpolicy="no-referrer"`；宽 375 的手机框；
 * - 客户端脚本 `static/page-frame.js`（布局在 `<head>` 中加载）：
 *   openLink（只认 `event.source === iframe.contentWindow`、只接受 https、确认后
 *   `window.open(url, '_blank', 'noopener,noreferrer')`）与自我导航拦截（第一次 load 之后再 load → 重置为空白页并提示）。
 *
 * 不要在别处手写展示用户页面的 iframe。
 */
import type { FC } from 'hono/jsx';
import { MOBILE_BASE_WIDTH, PAGE_IFRAME_SANDBOX, RENDER_VIEWPORT } from '@nowme/contracts';
import type { IssuedTicket } from '../services/tickets.js';
import { AiBadge } from './ai-badge.js';

/** iframe 上的标记属性（page-frame.js 只处理带这个属性的 iframe）。 */
export const PAGE_FRAME_ATTR = 'data-nm-page-frame';

export interface PageFrameProps {
  /** TicketIssuer.issue() 的结果（授权检查通过后签发）。 */
  ticket: IssuedTicket;
  /** iframe 的无障碍标题，例如“林舟的页面”。 */
  title: string;
}

export const PageFrame: FC<PageFrameProps> = ({ ticket, title }) => (
  <figure class="page-frame" data-nm-page-frame-root="">
    <div class="page-frame__phone">
      <iframe
        class="page-frame__screen"
        data-nm-page-frame=""
        src={ticket.src}
        sandbox={PAGE_IFRAME_SANDBOX}
        referrerpolicy="no-referrer"
        width={String(MOBILE_BASE_WIDTH)}
        height={String(RENDER_VIEWPORT.height)}
        title={title}
      ></iframe>
    </div>
    <p class="page-frame__ai">
      <AiBadge />
    </p>
    <div class="page-frame__blocked notice notice--warning" data-nm-page-frame-notice="" role="alert" hidden>
      <span>这个页面试图跳转，已拦截。</span>
      <button type="button" class="btn btn--ghost" data-nm-page-frame-reload="">
        重新加载页面
      </button>
    </div>
    <figcaption class="page-frame__caption muted">页面运行在独立域名的沙箱里：不能联网、不能读取你的登录状态、不能跳转本页。</figcaption>
  </figure>
);
