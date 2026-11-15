import { AVATAR_REQUEST_MAX_BYTES, AVATAR_ERROR } from '@nowme/contracts';
/**
 * 主站应用（contracts 4.1、4.2、5）：`createWebApp({ config, db, processor?, clock? })`。
 *
 * 全局中间件（按顺序）：
 * 1. 安全响应头：`buildWebCsp()`、nosniff、DENY、no-store、Permissions-Policy、COOP / CORP、https 时 HSTS；
 *    之后是 `/healthz`、`/readyz`（不经过 Host 头校验）；
 * 2. Host 头校验：不是 `NOWME_WEB_ORIGIN` 的主机 → 421；
 * 3. 主站表单请求体上限（Agent API 各自有上限）；
 * 4. 加载会话（只认 `nowme_session` cookie；`/api/` 不加载会话）。
 *
 * 路由见 routes/index.ts。依赖注入：测试可以注入假的提交处理器、时钟、发件箱、Kit 字体清单。
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { dataPaths, HOSTED_UPLOAD_REQUEST_MAX_BYTES, WALL_COVER_ERROR, WALL_COVER_REQUEST_MAX_BYTES, type KitFont } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { FORM_BODY_MAX_BYTES } from './constants.js';
import type { AppDeps, AppEnv, AppHono, WebConfig } from './context.js';
import { createRepos, migrate, type Database } from './db/index.js';
import { registerRoutes } from './routes/index.js';
import { apiError } from './routes/agent-api.js';
import { securityHeaders } from './security/headers.js';
import { createRateLimiter } from './security/rate-limit.js';
import { hostCheck } from './security/host.js';
import { sessionLoader } from './security/session.js';
import { createContentSafety } from './services/content-safety.js';
import { createSmtpOutbox } from './services/mailer.js';
import { createFileOutbox, type Outbox } from './services/outbox.js';
import { createRenderProcessor, type SubmissionProcessor } from './services/processor.js';
import { createSubmissionService } from './services/submissions.js';
import { createTicketIssuer } from './services/tickets.js';
import { createRealRemoteRenderer, createRemotePreviewService, type RemoteRenderer } from './services/remote-preview.js';
import { loadSkillPackage, type SkillPackage } from './services/skill-package.js';
import { SKILL_PACKAGE_DIR } from '@nowme/skill';
import { type ModelClient } from './hosted/model-client.js';
import { ModelAccessError } from './hosted/model-errors.js';
import { createJobModelResolver, createModelServices, fakeResolved, type ModelServices } from './hosted/models.js';
import type { ModelRole, ResolvedModel } from './hosted/user-models.js';
import type { ModelLookup } from './security/model-network.js';
import { resolve } from 'node:path';
import type { DemoAccess } from './demo-access.js';
import { createRenderPreviewer } from './hosted/previewer.js';
import { createWorkerRuntime } from './worker/compose.js';
import { createJobDispatch, type JobDispatch } from './worker/dispatch.js';
import type { BackgroundWorker } from './worker/runtime.js';
import { createJobSignals } from './worker/signals.js';
import { createHostedService, type HostedService } from './hosted/service.js';
import type { PagePreviewer } from './hosted/tools.js';
import { renderError, renderNotFound } from './views/errors.js';
import { asLogger, requestLogging } from './observability/logging.js';
import { sweepDeletedAccounts } from './services/account-deletion.js';
import { createJobNotifier, type JobNotifier } from './services/job-notify.js';
import { createProgressHub, type ProgressSettings } from './services/progress.js';

export type { AppDeps, AppEnv, WebConfig } from './context.js';
export { openDatabase, type Database } from './db/index.js';

export interface CreateWebAppOptions {
  config: WebConfig;
  /** 仅演示启动器使用的固定测试账号；生产环境禁止开启。 */
  demo?: DemoAccess;
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
  /** 是否写访问日志（contracts 17）；默认只在生产环境写。请求 ID 与 X-Request-Id 响应头始终有。 */
  accessLog?: boolean;
  /** 非生产环境假模型测试注入；真实模型始终使用用户账号配置。 */
  model?: ModelClient;
  /** 只读取 NOWME_AI_ENCRYPTION_KEY、开发本机访问开关与 NOWME_SMTP_URL（发信连接串），不读取模型 Key。 */
  secretEnv?: Readonly<Record<string, string | undefined>>;
  /** 非生产环境测试注入：把这个客户端当作平台 AI 的模型（需要同时配置 NOWME_PLATFORM_PROVIDER）。 */
  platformModel?: ModelClient;
  /** OpenAI 兼容服务的 fetch（测试注入模拟服务）。 */
  modelFetch?: typeof fetch;
  modelLookup?: ModelLookup;
  previewer?: PagePreviewer;
  /** 托管任务临时目录的父目录（测试）。 */
  hostedTempRoot?: string;
  /** 内容审核接口的传输层（测试注入；仍经过 URL 与 DNS 检查，DNS 用 modelLookup）。 */
  moderationFetch?: typeof fetch;
  /** 远程预览的渲染器（`POST /api/agent/previews`），默认真实渲染器（第一次预览时才启动浏览器）。 */
  remoteRenderer?: RemoteRenderer;
  /**
   * Skill 包目录（contracts 4.5），默认 `@nowme/skill` 的 `SKILL_PACKAGE_DIR`（`skill/dist-package/`）。
   * 传 null 表示不托管 Skill 包（安装页提示先构建）。
   */
  skillPackageDir?: string | null;
  /** 实时进度的连接限制与时间参数（contracts 18；测试用来缩短间隔）。 */
  progress?: Partial<ProgressSettings>;
  /** 完成提醒的扫描间隔（毫秒），默认 5 秒；null 表示不自动扫描（测试里手动调用 `notifier.tick()`）。 */
  jobNotifyIntervalMs?: number | null;
}

export interface WebApp {
  app: AppHono;
  fetch: AppHono['fetch'];
  request: AppHono['request'];
  deps: AppDeps;
  /** inline 模式下本进程内的 worker（separate 模式为 null）。 */
  worker: BackgroundWorker | null;
  /** 生成 / 修改结束后的提醒邮件（contracts 18.3）。 */
  notifier: JobNotifier;
  /** 停止领取任务、等待进行中的任务（`graceMs` 默认无限）并关闭渲染器（不关闭数据库）。 */
  close(options?: { graceMs?: number }): Promise<void>;
}

const DEFAULT_JOB_NOTIFY_INTERVAL_MS = 5000;

/** 带图片上传的托管采访表单（multipart，上限 HOSTED_UPLOAD_REQUEST_MAX_BYTES）。 */
const HOSTED_UPLOAD_PATH = /^\/w\/wal_[a-z2-7]{26}\/me\/create\/start$/;

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function createWebApp(options: CreateWebAppOptions): WebApp {
  const { config, db } = options;
  if (options.demo && (config.isProduction || resolve(options.demo.dataDir) !== resolve(config.dataDir))) throw new Error('演示登录必须绑定独立演示数据目录，且不能在生产环境启用');
  if (options.demo && (config.hosted.fake || options.model)) throw new Error('演示模式必须使用真实账号模型配置，不能使用假模型');
  migrate(db);
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.clock ?? (() => new Date());
  const repos = createRepos(db);
  const kitFonts = options.kitFonts ?? loadKitFonts();
  const outbox =
    options.outbox ??
    (config.mail.transport === 'smtp'
      ? createSmtpOutbox({ url: options.secretEnv?.NOWME_SMTP_URL, from: config.mail.from, isProduction: config.isProduction, log })
      : createFileOutbox(dataPaths(config.dataDir).outbox, log));
  const tickets = createTicketIssuer({ secret: config.ticketSecret, pagesOrigin: config.pagesOrigin, now });
  const skillPackage = loadHostedSkillPackage(options.skillPackageDir === undefined ? SKILL_PACKAGE_DIR : options.skillPackageDir, log);
  const models = createModelServices({ config, db, now, log, secretEnv: options.secretEnv, model: options.model, platformModel: options.platformModel, modelFetch: options.modelFetch, modelLookup: options.modelLookup });
  const { userModels, platformModel } = models;
  const contentSafety = createContentSafety({
    moderation: config.moderation,
    apiKey: options.secretEnv?.NOWME_MODERATION_API_KEY,
    allowLocal: !config.isProduction && options.secretEnv?.NOWME_AI_ALLOW_LOCAL === '1',
    lookup: options.modelLookup,
    transport: options.moderationFetch,
    log,
  });

  // 后台任务（contracts 13）：inline 时 worker 循环在本进程内运行；separate 时主站只入队，
  // 不创建处理器 / 渲染器 / 预览器（不启动浏览器、不跑 Agent 循环），由独立的 worker 进程执行。
  const signals = createJobSignals();
  const runtime =
    config.worker.mode === 'inline'
      ? createWorkerRuntime({
          config, db, repos, now, kitFonts, log, signals,
          processor: options.processor ?? createRenderProcessor(),
          remoteRenderer: options.remoteRenderer ?? createRealRemoteRenderer(),
          previewer: options.previewer ?? createRenderPreviewer(),
          resolveJob: createJobModelResolver(models, config.hosted),
          tempRoot: options.hostedTempRoot,
        })
      : null;
  const dispatch = createJobDispatch({ repos, signals, worker: () => runtime?.worker ?? null });
  const submissions = createSubmissionService({ config, db, repos, now, dispatch });
  const remotePreview = createRemotePreviewService({ dataDir: config.dataDir, db, repos, now, dispatch });

  const deps: AppDeps = { demo: options.demo ?? null, contentSafety, userModels, platformModel, config, db, repos, now, kitFonts, tickets, submissions, outbox, rateLimiter: createRateLimiter(now), hosted: null, skillPackage, remotePreview, progress: createProgressHub(now, options.progress), log };
  deps.hosted = createHosted(deps, models, dispatch);
  runtime?.worker.start();
  const notifier = createJobNotifier(deps, deps.progress);
  const notifyInterval = options.jobNotifyIntervalMs === undefined ? DEFAULT_JOB_NOTIFY_INTERVAL_MS : options.jobNotifyIntervalMs;
  if (notifyInterval !== null && deps.hosted) notifier.start(notifyInterval);
  // 已注销账号：清理到期的举报证据与残留文件（幂等，contracts 14.7）
  const sweep = sweepDeletedAccounts(deps).catch((error: unknown) => log(`[web] 清理已注销账号失败：${error instanceof Error ? error.message : String(error)}`));

  const app: AppHono = new Hono<AppEnv>();
  app.use(requestLogging({ logger: asLogger(log), trustUpstreamRequestId: config.trustProxyHops > 0, accessLog: options.accessLog ?? config.isProduction }));
  app.use(securityHeaders(config));
  // 健康检查（contracts 10.5）：给负载均衡 / 容器编排用，放在 Host 头校验之前（探针常用 IP 访问）。
  // 不读会话、不设 cookie、不返回任何业务信息。
  app.get('/healthz', (c) => c.text('ok', 200, { 'Cache-Control': 'no-store' }));
  app.get('/readyz', (c) => {
    try {
      db.prepare('SELECT 1').get();
      return c.json({ status: 'ok' }, 200, { 'Cache-Control': 'no-store' });
    } catch {
      return c.json({ status: 'unavailable' }, 503, { 'Cache-Control': 'no-store' });
    }
  });
  app.use(hostCheck(config));
  const formLimit = bodyLimit({
    maxSize: FORM_BODY_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '内容太长了', message: '这次填的内容超过了上限。删掉一些再试一次。' }),
  });
  const uploadLimit = bodyLimit({
    maxSize: HOSTED_UPLOAD_REQUEST_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '上传的内容太大了', message: '图片和文字加起来超过了上限（单张图片 2 MB 以内，最多 6 张）。少传几张或压缩一下再试。' }),
  });
  const avatarLimit = bodyLimit({
    maxSize: AVATAR_REQUEST_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '头像图片太大', message: AVATAR_ERROR.size }),
  });
  const coverLimit = bodyLimit({
    maxSize: WALL_COVER_REQUEST_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '封面图太大', message: WALL_COVER_ERROR.size }),
  });
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || isApiPath(c.req.path)) return next();
    if (c.req.path === '/account/profile') return avatarLimit(c, next);
    if (HOSTED_UPLOAD_PATH.test(c.req.path)) return uploadLimit(c, next);
    if (/^\/w\/wal_[a-z2-7]{26}\/admin\/cover$/.test(c.req.path)) return coverLimit(c, next);
    return formLimit(c, next);
  });
  app.use(sessionLoader(deps));

  registerRoutes(app, deps);

  app.notFound((c) => (isApiPath(c.req.path) ? apiError(c, 'NOT_FOUND', '接口不存在') : renderNotFound(c)));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    log(`[web] 未处理的错误 ${c.req.method} ${c.req.path}：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (isApiPath(c.req.path)) return apiError(c, 'INTERNAL_ERROR', '服务器处理请求时出错了，请稍后重试');
    return renderError(c, { status: 500, title: '我们这边出了点问题', message: '不是你的操作有误。过一两分钟再试一次；一直不行的话，请告诉我们。' });
  });

  return {
    app,
    fetch: app.fetch,
    request: app.request,
    deps,
    worker: runtime?.worker ?? null,
    notifier,
    async close(closeOptions) {
      await sweep;
      await notifier.stop();
      await runtime?.close(closeOptions);
      await outbox.close?.();
    },
  };
}

function loadHostedSkillPackage(dir: string | null, log: (message: string) => void): SkillPackage | null {
  if (dir === null) return null;
  const result = loadSkillPackage(dir);
  if (result.ok) return result.skillPackage;
  log(`[web] Skill 包不可用（${result.reason}）。运行 pnpm --filter @nowme/skill pack:skill 后重启主站，/skill 才能提供下载。`);
  return null;
}

function createHosted(deps: AppDeps, models: ModelServices, dispatch: JobDispatch): HostedService | null {
  const settings = deps.config.hosted;
  if (!settings.enabled) return null;
  const { fake } = models;
  const platform = deps.platformModel;
  const fakeModel = (role: ModelRole): ResolvedModel => fakeResolved(fake!, settings, role);
  const ownReady = (userId: string) => !!fake || deps.userModels.ready(userId);
  // 平台 AI 的免费调用（采访、和 TA 聊什么）有全站每日上限：防止批量注册消耗平台的模型费用
  const platformFree = (role: ModelRole): ResolvedModel => {
    if (!deps.rateLimiter.hit('platform-free', 'all', { max: deps.config.billing.freeDailyCalls, windowMs: 24 * 3600 * 1000 }).ok) {
      deps.log('[web] 平台 AI 的每日免费调用已达上限（NOWME_PLATFORM_FREE_DAILY_CALLS）');
      throw new ModelAccessError('MODEL_UNAVAILABLE');
    }
    return platform.resolve(role);
  };
  return createHostedService(deps, {
    settings,
    ready: (userId) => ownReady(userId) || platform.available,
    ownReady,
    platformAvailable: platform.available,
    resolve: (userId, role) => (fake ? fakeModel(role) : deps.userModels.ready(userId) ? deps.userModels.resolve(userId, role) : platformFree(role)),
    pinModel: (userId, source) => (!fake && source === 'own' ? deps.userModels.version(userId, 'generate') : null),
    dispatch,
  });
}
