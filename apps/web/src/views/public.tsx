/**
 * 公开链接页（`GET /s/:publicToken`，W15）：任何人可访问，只显示当前发布版本的页面（PageFrame）与名字 / 一行介绍。
 * **不显示联系方式、接话点与“想聊这个”**，也不显示墙名与其他成员。
 *
 * 用自己的文档骨架（不是 views/layout.tsx）：要在 `<head>` 里放 `<meta name="robots" content="noindex">`，
 * 且不显示账号栏。和主布局一样：手写 `<!doctype html>`；没有内联脚本与样式；`page-frame.js` 在 `<head>` 中同步加载
 * （contracts 5.2：必须在 iframe 第一次 load 之前注册监听）；`app.js` defer。
 */
import { raw } from 'hono/html';
import type { FC } from 'hono/jsx';
import { STATIC_PATH_PREFIX } from '../constants.js';
import type { IssuedTicket } from '../services/tickets.js';
import { PageFrame } from './page-frame.js';

export interface PublicPageProps {
  displayName: string;
  tagline: string;
  ticket: IssuedTicket;
}

export const PublicPageDocument: FC<PublicPageProps> = ({ displayName, tagline, ticket }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="same-origin" />
        <title>{`${displayName} · NOWMe`}</title>
        <link rel="stylesheet" href={`${STATIC_PATH_PREFIX}app.css`} />
        <link rel="stylesheet" href={`${STATIC_PATH_PREFIX}workspace.css`} />
        <script src={`${STATIC_PATH_PREFIX}page-frame.js`}></script>
        <script src={`${STATIC_PATH_PREFIX}app.js`} defer></script>
      </head>
      <body class="site site--public">
        <header class="site-header">
          <a class="site-header__brand" href="/">
            NOWMe
          </a>
        </header>
        <main class="site-main public-page">
          <section class="public-page__intro">
            <h1>{displayName}</h1>
            <p class="public-page__tagline">{tagline}</p>
          </section>
          <PageFrame ticket={ticket} title={`${displayName}的页面`} />
          <p class="muted public-page__note">这是 {displayName} 用 NOWMe 做的个人页面，由主人通过公开链接分享。</p>
        </main>
      </body>
    </html>
  </>
);
