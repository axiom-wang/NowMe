/**
 * Host 头校验（contracts 第 5 节末尾）：只接受 `NOWME_WEB_ORIGIN` 的主机（含端口）。
 * cookie 不按端口隔离：不能让主站在页面托管的主机名（127.0.0.1）下响应、签发 cookie。
 * 不匹配时返回 421，并给出正确的地址。
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, WebConfig } from '../context.js';

export function hostCheck(config: Pick<WebConfig, 'webOrigin'>): MiddlewareHandler<AppEnv> {
  const expected = new URL(config.webOrigin).host;
  return async (c, next) => {
    const header = c.req.header('host');
    let urlHost: string | null = null;
    try {
      urlHost = new URL(c.req.url).host;
    } catch {
      urlHost = null;
    }
    if ((header !== undefined && header.toLowerCase() !== expected) || urlHost !== expected) {
      return c.text(`主机名不对：请使用 ${config.webOrigin} 访问 NOWMe。`, 421);
    }
    return next();
  };
}
