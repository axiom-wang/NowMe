/** 页面托管进程入口：`pnpm --filter @nowme/pages-host dev`（源码 + watch）或 `node dist/main.js`（构建后）。 */
import { serve } from '@hono/node-server';
import { assertProductionConfig, ConfigError, loadConfig, loadRepoDotEnv, resolveTicketSecret, type NowmeConfig } from '@nowme/contracts';
import { createPagesApp } from './app.js';

loadRepoDotEnv();
let config: NowmeConfig;
try {
  config = loadConfig();
  for (const warning of assertProductionConfig(config, process.env, 'pages')) console.warn(`[pages-host] 配置提醒：${warning}`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`[pages-host] ${error.message}`);
  process.exit(1);
}
const app = createPagesApp({ ...config, ticketSecret: resolveTicketSecret(config) });

const server = serve({ fetch: app.fetch, port: config.pages.port, hostname: config.pages.hostname }, () => {
  console.log(`[pages-host] NOWMe 页面托管已启动：${config.pagesOrigin}（监听 ${config.pages.hostname}:${config.pages.port}）`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
