/**
 * 主站所有响应的安全头（contracts 第 5 节末尾、10.4）：CSP 只用 `buildWebCsp()` 生成。
 * 动态页面一律 `Cache-Control: no-store`（页面里有 CSRF 令牌、一次性指令与票据）。
 */
import type { MiddlewareHandler } from 'hono';
import { buildWebCsp, WEB_PERMISSIONS_POLICY } from '@nowme/contracts';
import type { AppEnv, WebConfig } from '../context.js';

/** 一年。只在主站是 https 源时发送；不带 includeSubDomains / preload（用户页面在另一个域名，子域名由部署方自己决定）。 */
export const HSTS_VALUE = 'max-age=31536000';

export function securityHeaders(config: Pick<WebConfig, 'pagesOrigin' | 'webOrigin'>): MiddlewareHandler<AppEnv> {
  const csp = buildWebCsp({ pagesOrigin: config.pagesOrigin });
  const https = config.webOrigin.startsWith('https://');
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    // 与页面托管使用同一份关闭清单，只有主站同源文档可以请求全屏（展示模式）。
    c.header('Permissions-Policy', WEB_PERMISSIONS_POLICY);
    // 主站窗口不与别的源共享浏览上下文组；主站的资源（封面、头像、静态文件）不允许被别的源嵌入
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (https) c.header('Strict-Transport-Security', HSTS_VALUE);
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  };
}
