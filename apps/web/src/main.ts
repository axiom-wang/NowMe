/**
 * 主站进程入口：`pnpm --filter @nowme/web dev`（源码 + watch）或 `start`（构建后）。
 * 与页面托管共享 `NOWME_DATA_DIR` 与票据密钥（`NOWME_TICKET_SECRET`，留空时两边都读写 `<dataDir>/secret`）。
 */
import { serve } from '@hono/node-server';
import { assertProductionConfig, ConfigError, dataPaths, loadConfig, loadRepoDotEnv, resolveTicketSecret, type NowmeConfig } from '@nowme/contracts';
import { createWebApp } from './app.js';
import { describeHostedModels } from './hosted/describe.js';
import { openDatabase } from './db/index.js';
import { createLogger } from './observability/logging.js';

loadRepoDotEnv();
// 生产环境输出 JSON 行日志（contracts 17），开发环境保持可读文本
const logger = createLogger({ service: 'web', json: process.env.NODE_ENV === 'production' });
let config: NowmeConfig;
try {
  config = loadConfig();
  // 生产环境：配置不完整（http 源、没有凭证库密钥、邮件只写本地文件……）直接拒绝启动，并一次列出全部问题
  for (const warning of assertProductionConfig(config, process.env, 'web')) logger.warn(`[web] 配置提醒：${warning}`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`[web] ${error.message}`);
  process.exit(1);
}
const db = openDatabase(dataPaths(config.dataDir).db);
// 环境变量只提供凭证库加密密钥；模型 Key 来自用户账号。
const web = createWebApp({ config: { ...config, ticketSecret: resolveTicketSecret(config) }, db, secretEnv: process.env, log: logger });

const server = serve({ fetch: web.fetch, port: config.web.port, hostname: config.web.hostname }, () => {
  logger.info(`[web] NOWMe 主站已启动：${config.webOrigin}（监听 ${config.web.hostname}:${config.web.port}，数据目录 ${config.dataDir}）`);
  if (!config.isProduction) logger.info(`[web] 开发发件箱：${config.webOrigin}/dev/outbox`);
  if (web.deps.hosted) {
    const hosted = web.deps.hosted.settings;
    logger.info(`[web] 平台托管路线已开启（${describeHostedModels(hosted)}，用户自带 API）`);
  }
  logger.info(
    config.worker.mode === 'separate'
      ? '[web] 后台任务交给独立的 worker 进程（NOWME_WORKER_MODE=separate）：主站只入队，请同时运行 pnpm --filter @nowme/web start:worker'
      : '[web] 后台任务在本进程内执行（NOWME_WORKER_MODE=inline）',
  );
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  // inline 模式下要等进行中的任务（contracts 13.4）；separate 模式下主站没有任务要等
  const graceMs = config.worker.mode === 'inline' ? config.worker.shutdownGraceMs : 0;
  setTimeout(() => process.exit(0), graceMs + 15_000).unref();
  server.close();
  web
    .close({ graceMs })
    .catch((error: unknown) => logger.error(`[web] 关闭渲染器失败：${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      db.close();
      process.exit(0);
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
