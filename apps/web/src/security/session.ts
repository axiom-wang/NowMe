/**
 * 会话 cookie 与登录检查（contracts 4.2）。
 *
 * cookie：`nowme_session`，`HttpOnly; SameSite=Lax; Path=/`，host-only（不设 Domain），主站为 https 时加 `Secure`。
 * 会话只来自这个 cookie：主站路由**从不读取 `Authorization` 头**，页面凭证在这里无效；
 * cookie 里放页面凭证（`nmc_...`）也不会被当成会话（格式不符直接忽略）。
 * Agent API（`/api/`）不加载会话：会话不能当凭证用。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from '@nowme/contracts';
import type { AppDeps, AppEnv, WebConfig } from '../context.js';
import { demoAccountFor } from '../demo-access.js';
import { loadSession, type CreatedSession } from '../services/auth.js';
import { loginRedirectPath, safeNextPath } from './redirect.js';

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** 加载会话到 `c.var.auth`（Agent API 路径除外）。 */
export function sessionLoader(deps: Pick<AppDeps, 'repos' | 'now' | 'demo'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = isApiPath(c.req.path) ? null : loadSession(deps, getCookie(c, SESSION_COOKIE_NAME));
    c.set('demo', !!deps.demo);
    c.set('auth', auth && deps.demo && !demoAccountFor(auth.user.email) ? null : auth);
    return next();
  };
}

export function readSessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

export function setSessionCookie(c: Context<AppEnv>, config: Pick<WebConfig, 'webOrigin'>, session: CreatedSession): void {
  setCookie(c, SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: config.webOrigin.startsWith('https:'),
  });
}

export function clearSessionCookie(c: Context<AppEnv>, config: Pick<WebConfig, 'webOrigin'>): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/', secure: config.webOrigin.startsWith('https:') });
}

function currentPath(c: Context<AppEnv>): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

/** `/welcome?next=<当前路径>`（首次登录填昵称）。 */
export function welcomeRedirectPath(next: string, webOrigin: string): string {
  const safe = safeNextPath(next, webOrigin);
  return safe === '/' ? '/welcome' : `/welcome?next=${encodeURIComponent(safe)}`;
}

/**
 * 需要登录的页面（GET）：未登录 → `303 /login?next=...`；还没填昵称 → `303 /welcome?next=...`。
 * 改变状态的 POST 用 `requireForm`（security/forms.ts）。
 */
export function requireUser(deps: Pick<AppDeps, 'config'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) return c.redirect(loginRedirectPath(currentPath(c), deps.config.webOrigin), 303);
    if (!auth.user.nickname) return c.redirect(welcomeRedirectPath(currentPath(c), deps.config.webOrigin), 303);
    return next();
  };
}

/** 路由处理函数里取已登录用户（必须先经过 requireUser / requireForm）。 */
export function authOf(c: Context<AppEnv>) {
  const auth = c.get('auth');
  if (!auth) throw new Error('authOf：路由缺少 requireUser / requireForm');
  return auth;
}
