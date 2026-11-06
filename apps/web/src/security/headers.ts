/**
 * 主站所有响应的安全头（contracts 第 5 节末尾）：CSP 只用 `buildWebCsp()` 生成。
 * 动态页面一律 `Cache-Control: no-store`（页面里有 CSRF 令牌、一次性指令与票据）。
 */
import type { MiddlewareHandler } from 'hono';
import { buildWebCsp } from '@nowme/contracts';
import type { AppEnv, WebConfig } from '../context.js';

export function securityHeaders(config: Pick<WebConfig, 'pagesOrigin'>): MiddlewareHandler<AppEnv> {
  const csp = buildWebCsp({ pagesOrigin: config.pagesOrigin });
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  };
}
