/**
 * 后台任务进程入口（contracts 13）：`pnpm --filter @nowme/web worker`（源码）或 `start:worker`（构建后，`dist/worker.js`）。
 *
 * 与主站共享 `NOWME_DATA_DIR`（SQLite 数据库、版本文件、任务暂存目录）。负责：提交渲染、远程预览、托管 AI 生成 / 修改。
 * 主站设置 `NOWME_WORKER_MODE=separate` 时只入队，由这个进程执行；可以运行多个（租约保证同一个任务只有一个执行者）。
 *
 * SIGTERM / SIGINT：停止领取，等待进行中的任务最多 `NOWME_WORKER_SHUTDOWN_GRACE_SECONDS` 秒；
 * 到时还没结束的渲染任务交还队列（由下一个 worker 重做），AI 任务取消并退点（不自动重试，避免重复计费）。
 */
import { assertProductionConfig, ConfigError, dataPaths, loadConfig, loadRepoDotEnv, resolveTicketSecret, type NowmeConfig } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { openDatabase, createRepos } from './db/index.js';
import { createJobModelResolver, createModelServices } from './hosted/models.js';
import { createRenderPreviewer } from './hosted/previewer.js';
import { createRenderProcessor } from './services/processor.js';
import { createRealRemoteRenderer } from './services/remote-preview.js';
import { createLogger } from './observability/logging.js';
import { createWorkerRuntime } from './worker/compose.js';

loadRepoDotEnv();
// 生产环境输出 JSON 行日志（contracts 17），开发环境保持可读文本
const logger = createLogger({ service: 'worker', json: process.env.NODE_ENV === 'production' });
let config: NowmeConfig;
try {
  config = loadConfig();
  for (const warning of assertProductionConfig(config, process.env, 'worker')) logger.warn(`[worker] 配置提醒：${warning}`);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`[worker] ${error.message}`);
  process.exit(1);
}

const log = logger;
const now = () => new Date();
const db = openDatabase(dataPaths(config.dataDir).db);
const repos = createRepos(db);
const webConfig = { ...config, ticketSecret: resolveTicketSecret(config) };
// 环境变量只提供凭证库加密密钥与平台 AI 的 Key；用户的模型 Key 来自账号（加密保存）。
const models = createModelServices({ config: webConfig, db, now, log, secretEnv: process.env });
const runtime = createWorkerRuntime({
  config: webConfig,
  db,
  repos,
  now,
  kitFonts: loadKitFonts(),
  log,
  processor: createRenderProcessor(),
  remoteRenderer: createRealRemoteRenderer(),
  previewer: createRenderPreviewer(),
  resolveJob: createJobModelResolver(models, config.hosted),
});
runtime.worker.start();
// 队列轮询定时器为嵌入主站的场景 unref；独立进程必须保持事件循环存活。
const keepAlive = setInterval(() => {}, 60_000);
logger.info(
  `[worker] NOWMe 后台任务进程已启动（${runtime.worker.id}，AI 任务并发 ${config.worker.aiConcurrency}，渲染串行，数据目录 ${config.dataDir}）`,
);
if (config.worker.mode === 'inline') {
  logger.warn('[worker] 提醒：NOWME_WORKER_MODE=inline 时主站进程也在执行任务；只想让这个进程执行，请把主站设为 separate。');
}

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  clearInterval(keepAlive);
  const graceMs = config.worker.shutdownGraceMs;
  logger.info(`[worker] 收到 ${signal}：停止领取新任务，最多等待 ${Math.round(graceMs / 1000)} 秒`);
  // 兜底：取消之后的收尾也卡住时强制退出（租约到期后由别的 worker 回收）
  setTimeout(() => process.exit(1), graceMs + 20_000).unref();
  runtime
    .close({ graceMs })
    .catch((error: unknown) => logger.error(`[worker] 关闭失败：${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      db.close();
      process.exit(0);
    });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
