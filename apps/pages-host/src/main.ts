/** 页面托管进程入口：`pnpm --filter @nowme/pages-host dev`（源码 + watch）或 `node dist/main.js`（构建后）。 */
import { serve } from '@hono/node-server';
import { assertProductionConfig, ConfigError, loadConfig, loadRepoDotEnv, resolveTicketSecret, type NowmeConfig } from '@nowme/contracts';
import { createPagesApp } from './app.js';
import { createLogger } from './logging.js';

loadRepoDotEnv();
// 生产环境输出 JSON 行日志（contracts 17）
const logger = createLogger({ service: 'pages', json: process.env.NODE_ENV === 'production' });
let config: NowmeConfig;
try {
  config = loadConfig();
  for (const warning of assertProductionConfig(config, process.env, 'pages')) logger.warn(`[pages-host] 配置提醒：${warning}`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`[pages-host] ${error.message}`);
  process.exit(1);
}
const app = createPagesApp(
  { ...config, ticketSecret: resolveTicketSecret(config) },
  { log: logger, accessLog: config.isProduction, trustRequestId: config.trustProxyHops > 0 },
);

const server = serve({ fetch: app.fetch, port: config.pages.port, hostname: config.pages.hostname }, () => {
  logger.info(`[pages-host] NOWMe 页面托管已启动：${config.pagesOrigin}（监听 ${config.pages.hostname}:${config.pages.port}）`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
