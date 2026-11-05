/** 页面托管进程入口：`pnpm --filter @nowme/pages-host dev`（源码 + watch）或 `node dist/main.js`（构建后）。 */
import { serve } from '@hono/node-server';
import { loadConfig, loadRepoDotEnv, resolveTicketSecret } from '@nowme/contracts';
import { createApp } from './app.js';

loadRepoDotEnv();
const config = loadConfig();
const app = createApp({ ...config, ticketSecret: resolveTicketSecret(config) });

const server = serve({ fetch: app.fetch, port: config.pages.port, hostname: config.pages.hostname }, () => {
  console.log(`[pages-host] NOWMe 页面托管已启动：${config.pagesOrigin}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
