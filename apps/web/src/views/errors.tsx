/** 错误页。无权访问一律显示“找不到”（404），不暴露墙或页面是否存在。 */
import type { Context } from 'hono';
import type { AppEnv } from '../context.js';
import { renderPage } from './layout.js';

export function renderNotFound(c: Context<AppEnv>): Response | Promise<Response> {
  return renderPage(c, {
    title: '找不到这个页面',
    status: 404,
    body: (
      <section class="card">
        <h1>找不到这个页面</h1>
        <p>链接可能已经失效，或者你没有访问权限。</p>
        <p>
          <a class="btn btn--primary" href="/">
            回到“我的”
          </a>
        </p>
      </section>
    ),
  });
}

export function renderError(
  c: Context<AppEnv>,
  options: { status: 400 | 401 | 403 | 413 | 429 | 500; title: string; message: string; loginLink?: boolean },
): Response | Promise<Response> {
  return renderPage(c, {
    title: options.title,
    status: options.status,
    body: (
      <section class="card">
        <h1>{options.title}</h1>
        <p>{options.message}</p>
        <p>
          {options.loginLink ? (
            <a class="btn btn--primary" href="/login">
              去登录
            </a>
          ) : (
            <a class="btn btn--primary" href="/">
              回到“我的”
            </a>
          )}
        </p>
      </section>
    ),
  });
}
