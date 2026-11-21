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

/** iframe 上的标记属性（page-frame.js 只处理带这个属性的 iframe）。 */
export const PAGE_FRAME_ATTR = 'data-nm-page-frame';

export interface PageFrameStage {
  wallId: string;
  pageId: string;
  prevId: string | null;
  nextId: string | null;
  position: number;
  total: number;
  name: string;
  tagline: string;
}

export interface PageFrameProps {
  /** TicketIssuer.issue() 的结果（授权检查通过后签发）。 */
  ticket: IssuedTicket;
  /** iframe 的无障碍标题，例如“林舟的页面”。 */
  title: string;
  /** 成员页传入墙内连播信息；公开页与工作区只有展示模式。 */
  stage?: PageFrameStage;
}

export const PageFrame: FC<PageFrameProps> = ({ ticket, title, stage }) => (
  <figure
    class="page-frame"
    data-nm-page-frame-root=""
    data-nm-stage-wall={stage?.wallId}
    data-nm-stage-page={stage?.pageId}
    data-nm-stage-prev={stage?.prevId ?? undefined}
    data-nm-stage-next={stage?.nextId ?? undefined}
    aria-label={`${stage?.name ?? title}的展示模式`}
  >
    <header class="page-frame__stage-bar" data-nm-stage-bar="" aria-label="展示模式工具栏">
      <div class="page-frame__stage-heading">
        <strong class="page-frame__stage-name" data-nm-stage-name="">{stage?.name ?? title}</strong>
        <span class="page-frame__stage-tagline" data-nm-stage-tagline="">{stage?.tagline ?? ''}</span>
      </div>
      {stage ? (
        <nav class="page-frame__stage-nav" aria-label="墙内连播">
          {stage.prevId ? <button type="button" class="btn btn--ghost btn--small" data-nm-stage-prev-button="">上一位</button> : null}
          <span class="page-frame__stage-position" data-nm-stage-position="">{stage.position} / {stage.total}</span>
          {stage.nextId ? <button type="button" class="btn btn--ghost btn--small" data-nm-stage-next-button="">下一位</button> : null}
        </nav>
      ) : null}
      <button type="button" class="btn btn--ghost btn--small" data-nm-stage-close="">退出</button>
      <p class="page-frame__stage-status" data-nm-stage-status="" role="status" aria-live="polite"></p>
    </header>
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
    <button type="button" class="btn btn--ghost btn--small page-frame__open" data-nm-stage-open="">
      放大看
    </button>
    <div class="page-frame__blocked notice notice--warning" data-nm-page-frame-notice="" role="alert" hidden>
      <span>这个页面试图跳转，已拦截。</span>
      <button type="button" class="btn btn--ghost" data-nm-page-frame-reload="">
        重新加载页面
      </button>
    </div>
  </figure>
);
