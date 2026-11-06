/**
 * 页面票据（contracts 4.4）。主站**只在授权检查通过后**签发：
 * - 主人 → 自己页面的任意 accepted 版本（工作区，T2.1）；
 * - 墙内有效成员 → 当前发布版本（成员页，T3.1）；
 * - 公开链接 → 当前发布版本（T3.2）。
 * 调用方负责授权检查；这里只负责签名与拼出 iframe 的 src。
 */
import { issueTicket, PAGE_VIEW_PATH_PREFIX, TICKET_TTL_SECONDS } from '@nowme/contracts';

export interface IssuedTicket {
  ticket: string;
  /** iframe 的 src：`<pagesOrigin>/v/<ticket>/`。 */
  src: string;
  expiresAt: Date;
}

export interface TicketIssuer {
  issue(revisionId: string): IssuedTicket;
}

/** 页面托管上某个票据的页面地址。 */
export function pageViewUrl(pagesOrigin: string, ticket: string): string {
  return `${pagesOrigin}${PAGE_VIEW_PATH_PREFIX}${ticket}/`;
}

export function createTicketIssuer(options: { secret: string; pagesOrigin: string; now: () => Date }): TicketIssuer {
  return {
    issue(revisionId) {
      const now = options.now();
      const ticket = issueTicket(revisionId, options.secret, now);
      return {
        ticket,
        src: pageViewUrl(options.pagesOrigin, ticket),
        expiresAt: new Date(now.getTime() + TICKET_TTL_SECONDS * 1000),
      };
    },
  };
}
