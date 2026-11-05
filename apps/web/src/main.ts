/** 主站进程入口：`pnpm --filter @nowme/web dev`（源码 + watch）或 `node dist/main.js`（构建后）。 */
import { serve } from '@hono/node-server';
import { loadConfig, loadRepoDotEnv } from '@nowme/contracts';
import { createApp } from './app.js';

loadRepoDotEnv();
const config = loadConfig();
const app = createApp(config);

const server = serve({ fetch: app.fetch, port: config.web.port, hostname: config.web.hostname }, () => {
  console.log(`[web] NOWMe 主站已启动：${config.webOrigin}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
