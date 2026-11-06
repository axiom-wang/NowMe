/**
 * 主站应用（contracts 4.1、4.2、5）：`createWebApp({ config, db, processor?, clock? })`。
 *
 * 全局中间件（按顺序）：
 * 1. 安全响应头：`buildWebCsp()`、nosniff、DENY、no-store；
 * 2. Host 头校验：不是 `NOWME_WEB_ORIGIN` 的主机 → 421；
 * 3. 主站表单请求体上限（Agent API 各自有上限）；
 * 4. 加载会话（只认 `nowme_session` cookie；`/api/` 不加载会话）。
 *
 * 路由见 routes/index.ts。依赖注入：测试可以注入假的提交处理器、时钟、发件箱、Kit 字体清单。
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { dataPaths, type KitFont } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { FORM_BODY_MAX_BYTES } from './constants.js';
import type { AppDeps, AppEnv, AppHono, WebConfig } from './context.js';
import { createRepos, migrate, type Database } from './db/index.js';
import { registerRoutes } from './routes/index.js';
import { apiError } from './routes/agent-api.js';
import { securityHeaders } from './security/headers.js';
import { hostCheck } from './security/host.js';
import { sessionLoader } from './security/session.js';
import { createFileOutbox, type Outbox } from './services/outbox.js';
import { createRenderProcessor, type SubmissionProcessor } from './services/processor.js';
import { createSubmissionService } from './services/submissions.js';
import { createTicketIssuer } from './services/tickets.js';
import { renderError, renderNotFound } from './views/errors.js';

export type { AppDeps, AppEnv, WebConfig } from './context.js';
export { openDatabase, type Database } from './db/index.js';

export interface CreateWebAppOptions {
  config: WebConfig;
  /** 已打开的数据库（`openDatabase()`）；这里会再确认一次迁移已执行。 */
  db: Database;
  /** 提交处理器，默认真实渲染管线（`buildRevision({ mode: 'submit' })`，共享一个渲染器）。 */
  processor?: SubmissionProcessor;
  /** 当前时间，默认 `new Date()`。 */
  clock?: () => Date;
  /** 发件箱，默认 `<dataDir>/outbox.log` + 控制台。 */
  outbox?: Outbox;
  /** Kit 字体清单，默认 `loadKitFonts()`。 */
  kitFonts?: KitFont[];
  log?: (message: string) => void;
}

export interface WebApp {
  app: AppHono;
  fetch: AppHono['fetch'];
  request: AppHono['request'];
  deps: AppDeps;
  /** 等待排队的提交处理完并关闭渲染器（不关闭数据库）。 */
  close(): Promise<void>;
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function createWebApp(options: CreateWebAppOptions): WebApp {
  const { config, db } = options;
  migrate(db);
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.clock ?? (() => new Date());
  const repos = createRepos(db);
  const kitFonts = options.kitFonts ?? loadKitFonts();
  const outbox = options.outbox ?? createFileOutbox(dataPaths(config.dataDir).outbox, log);
  const processor = options.processor ?? createRenderProcessor();
  const submissions = createSubmissionService({ config, db, repos, now, kitFonts, processor, log });
  const tickets = createTicketIssuer({ secret: config.ticketSecret, pagesOrigin: config.pagesOrigin, now });
  const deps: AppDeps = { config, db, repos, now, kitFonts, tickets, submissions, outbox, log };

  const app: AppHono = new Hono<AppEnv>();
  app.use(securityHeaders(config));
  app.use(hostCheck(config));
  const formLimit = bodyLimit({
    maxSize: FORM_BODY_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '提交的内容太多', message: '表单内容超过了上限，请精简后再试。' }),
  });
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || isApiPath(c.req.path)) return next();
    return formLimit(c, next);
  });
  app.use(sessionLoader(deps));

  registerRoutes(app, deps);

  app.notFound((c) => (isApiPath(c.req.path) ? apiError(c, 'NOT_FOUND', '接口不存在') : renderNotFound(c)));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    log(`[web] 未处理的错误 ${c.req.method} ${c.req.path}：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (isApiPath(c.req.path)) return apiError(c, 'INTERNAL_ERROR', '服务器处理请求时出错了，请稍后重试');
    return renderError(c, { status: 500, title: '出错了', message: '服务器处理请求时出错了，请稍后重试。' });
  });

  return {
    app,
    fetch: app.fetch,
    request: app.request,
    deps,
    close: () => submissions.close(),
  };
}
