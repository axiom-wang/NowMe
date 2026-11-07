/**
 * 主站进程入口：`pnpm --filter @nowme/web dev`（源码 + watch）或 `start`（构建后）。
 * 与页面托管共享 `NOWME_DATA_DIR` 与票据密钥（`NOWME_TICKET_SECRET`，留空时两边都读写 `<dataDir>/secret`）。
 */
import { serve } from '@hono/node-server';
import { dataPaths, loadConfig, loadRepoDotEnv, resolveTicketSecret } from '@nowme/contracts';
import { createWebApp } from './app.js';
import { openDatabase } from './db/index.js';

loadRepoDotEnv();
const config = loadConfig();
const db = openDatabase(dataPaths(config.dataDir).db);
// ANTHROPIC_API_KEY 只从环境变量读取，直接交给 Claude 客户端，不进入配置对象（contracts 9 / hosted-route 1）
const web = createWebApp({
  config: { ...config, ticketSecret: resolveTicketSecret(config) },
  db,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
});

const server = serve({ fetch: web.fetch, port: config.web.port, hostname: config.web.hostname }, () => {
  console.log(`[web] NOWMe 主站已启动：${config.webOrigin}（数据目录 ${config.dataDir}）`);
  if (!config.isProduction) console.log(`[web] 开发发件箱：${config.webOrigin}/dev/outbox`);
  if (web.deps.hosted) {
    const hosted = web.deps.hosted.settings;
    console.log(`[web] 平台托管路线已开启（${hosted.fake ? '假 Claude 客户端' : `采访 ${hosted.interviewModel} · 生成 ${hosted.generateModel}`}，每页免费 ${hosted.freeQuota} 次）`);
  }
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 5000).unref();
  server.close();
  web
    .close()
    .catch((error: unknown) => console.error('[web] 关闭渲染器失败', error))
    .finally(() => {
      db.close();
      process.exit(0);
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
