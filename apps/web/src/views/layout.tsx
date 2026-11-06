/**
 * 页面布局。hono/jsx 不会自动输出 `<!doctype html>`，这里手动写。
 * 主站 CSP 不允许内联脚本与内联样式：样式和脚本都是 `/static/` 下的外部文件，元素上不要写 `style=` 或 `on*=`。
 *
 * - `page-frame.js` 放在 `<head>` 里同步加载：它要在 iframe 第一次 `load` 之前注册监听（contracts 5.2）。
 * - `app.js` defer：复制按钮（`data-copy`）与危险操作确认（`form[data-confirm]`）。
 * - 样式：`app.css`（基础，T2.1）、`wall.css`（墙、加入、组织者后台、“我的”，T3.1）、`workspace.css`（工作区，T3.2）。
 *   只链接 `static/` 里确实存在的样式文件（启动时检查一次），避免缺文件时浏览器报 404。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import { STATIC_PATH_PREFIX } from '../constants.js';
import type { AppEnv, SessionAuth } from '../context.js';
import { STATIC_DIR } from '../routes/static.js';
import { CsrfField } from './forms.js';

/** 页面链接的样式表（按顺序；`app.css` 总是链接）。 */
export const STYLESHEETS: readonly string[] = ['app.css', ...['wall.css', 'workspace.css'].filter((name) => existsSync(join(STATIC_DIR, name)))];

export interface LayoutProps {
  title: string;
  auth: SessionAuth | null;
  /** 页面主体的额外 class（例如 `page--narrow`）。 */
  bodyClass?: string;
}

const Header: FC<{ auth: SessionAuth | null }> = ({ auth }) => (
  <header class="site-header">
    <a class="site-header__brand" href="/">
      NOWMe
    </a>
    {auth?.user.nickname ? (
      <nav class="site-header__nav" aria-label="账号">
        <a href="/">我的</a>
        <span class="site-header__user">{auth.user.nickname}</span>
        <form method="post" action="/logout" class="inline-form">
          <CsrfField token={auth.session.csrfToken} />
          <button type="submit" class="link-button">
            退出登录
          </button>
        </form>
      </nav>
    ) : null}
  </header>
);

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, auth, bodyClass, children }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>{title === 'NOWMe' ? title : `${title} · NOWMe`}</title>
        {STYLESHEETS.map((name) => (
          <link rel="stylesheet" href={`${STATIC_PATH_PREFIX}${name}`} />
        ))}
        <script src={`${STATIC_PATH_PREFIX}page-frame.js`}></script>
        <script src={`${STATIC_PATH_PREFIX}app.js`} defer></script>
      </head>
      <body class={bodyClass ? `site ${bodyClass}` : 'site'}>
        <Header auth={auth} />
        <main class="site-main">{children}</main>
      </body>
    </html>
  </>
);

/** 用布局渲染一个页面（读取当前会话以显示账号栏）。 */
export function renderPage(
  c: Context<AppEnv>,
  options: { title: string; body: Child; status?: number; bodyClass?: string },
): Response | Promise<Response> {
  const auth = c.get('auth') ?? null;
  return c.html(
    <Layout title={options.title} auth={auth} bodyClass={options.bodyClass}>
      {options.body}
    </Layout>,
    (options.status ?? 200) as 200,
  );
}
