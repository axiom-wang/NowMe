/**
 * 主站应用（contracts 4.2）。占位（T0.2）：只有首页占位与安全响应头；
 * 登录、墙、工作区、Agent API、数据库等由 T2.1 / T3.x 实现。
 */
import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { buildWebCsp, type NowmeConfig } from '@nowme/contracts';

export type WebConfig = Pick<NowmeConfig, 'webOrigin' | 'pagesOrigin' | 'isProduction'>;

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>{children}</body>
    </html>
  </>
);

export function createApp(config: WebConfig): Hono {
  const app = new Hono();
  const csp = buildWebCsp({ pagesOrigin: config.pagesOrigin });

  app.use(async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.get('/', (c) =>
    c.html(
      <Layout title="NOWMe">
        <main>
          <h1>NOWMe</h1>
          <p>主站占位页（脚手架阶段）。</p>
        </main>
      </Layout>,
    ),
  );

  app.notFound((c) => c.text('Not Found', 404));

  return app;
}
