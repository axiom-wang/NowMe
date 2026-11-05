/**
 * 页面托管（contracts 4.4、S2）。独立进程、独立源：只做静态托管 + 票据校验 + 安全响应头，
 * 不读主站 cookie、不连数据库、不设任何 cookie。
 *
 * 占位（T0.2）：所有路径返回 404，且都带 PAGE_SECURITY_HEADERS；
 * `/v/:ticket/...` 与 `/_nowme/kit/v1/*` 由 T2.2 实现。
 */
import { Hono } from 'hono';
import { PAGE_SECURITY_HEADERS, type NowmeConfig } from '@nowme/contracts';

export type PagesHostConfig = Pick<NowmeConfig, 'pagesOrigin' | 'webOrigin' | 'dataDir'> & {
  ticketSecret: string;
};

export function createApp(_config: PagesHostConfig): Hono {
  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) c.header(name, value);
  });

  app.notFound((c) => c.text('Not Found', 404));

  return app;
}
