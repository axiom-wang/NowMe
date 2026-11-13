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
import { createSmtpOutbox } from './services/mailer.js';
import { createFileOutbox, type Outbox } from './services/outbox.js';
import { createRenderProcessor, type SubmissionProcessor } from './services/processor.js';
import { createSubmissionService } from './services/submissions.js';
import { createTicketIssuer } from './services/tickets.js';
import { createRealRemoteRenderer, createRemotePreviewService, type RemoteRenderer } from './services/remote-preview.js';
import { loadSkillPackage, type SkillPackage } from './services/skill-package.js';
import { SKILL_PACKAGE_DIR } from '@nowme/skill';
import { type ModelClient } from './hosted/model-client.js';
import { createUserModels } from './hosted/user-models.js';
import type { ModelLookup } from './security/model-network.js';
import { resolve } from 'node:path';
import type { DemoAccess } from './demo-access.js';
import { createFakeModel } from './hosted/fake-model.js';
import { createRenderPreviewer } from './hosted/previewer.js';
import { createHostedService, type HostedService } from './hosted/service.js';
import type { PagePreviewer } from './hosted/tools.js';
import { renderError, renderNotFound } from './views/errors.js';

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
  /** 非生产环境假模型测试注入；真实模型始终使用用户账号配置。 */
  model?: ModelClient;
  /** 只读取 NOWME_AI_ENCRYPTION_KEY、开发本机访问开关与 NOWME_SMTP_URL（发信连接串），不读取模型 Key。 */
  secretEnv?: Readonly<Record<string, string | undefined>>;
  /** OpenAI 兼容服务的 fetch（测试注入模拟服务）。 */
  modelFetch?: typeof fetch;
  modelLookup?: ModelLookup;
  previewer?: PagePreviewer;
  /** 托管任务临时目录的父目录（测试）。 */
  hostedTempRoot?: string;
  /** 远程预览的渲染器（`POST /api/agent/previews`），默认真实渲染器（第一次预览时才启动浏览器）。 */
  remoteRenderer?: RemoteRenderer;
  /**
   * Skill 包目录（contracts 4.5），默认 `@nowme/skill` 的 `SKILL_PACKAGE_DIR`（`skill/dist-package/`）。
   * 传 null 表示不托管 Skill 包（安装页提示先构建）。
   */
  skillPackageDir?: string | null;
}

export interface WebApp {
  app: AppHono;
  fetch: AppHono['fetch'];
  request: AppHono['request'];
  deps: AppDeps;
  /** 等待排队的提交处理完并关闭渲染器（不关闭数据库）。 */
  close(): Promise<void>;
}

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
  const processor = options.processor ?? createRenderProcessor();
  const submissions = createSubmissionService({ config, db, repos, now, kitFonts, processor, log });
  const tickets = createTicketIssuer({ secret: config.ticketSecret, pagesOrigin: config.pagesOrigin, now });
  const remotePreview = createRemotePreviewService({ repos, now, kitFonts, renderer: options.remoteRenderer ?? createRealRemoteRenderer() });
  const skillPackage = loadHostedSkillPackage(options.skillPackageDir === undefined ? SKILL_PACKAGE_DIR : options.skillPackageDir, log);
  const userModels = createUserModels(db, {
    encryptionKey: options.secretEnv?.NOWME_AI_ENCRYPTION_KEY,
    allowLocal: !config.isProduction && options.secretEnv?.NOWME_AI_ALLOW_LOCAL === '1',
    fetch: options.modelFetch, lookup: options.modelLookup, now,
  });
  const deps: AppDeps = { demo: options.demo ?? null, userModels, config, db, repos, now, kitFonts, tickets, submissions, outbox, rateLimiter: createRateLimiter(now), hosted: null, skillPackage, remotePreview, log };
  deps.hosted = createHosted(deps, options);

  const app: AppHono = new Hono<AppEnv>();
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
    onError: (c) => renderError(c, { status: 413, title: '提交的内容太多', message: '表单内容超过了上限，请精简后再试。' }),
  });
  const uploadLimit = bodyLimit({
    maxSize: HOSTED_UPLOAD_REQUEST_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '上传的内容太多', message: '图片和文字加起来超过了上限（单张图片 2 MB 以内、最多 6 张），请减少后再试。' }),
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
    return renderError(c, { status: 500, title: '出错了', message: '服务器处理请求时出错了，请稍后重试。' });
  });

  return {
    app,
    fetch: app.fetch,
    request: app.request,
    deps,
    async close() {
      await deps.hosted?.close();
      await submissions.close();
      await remotePreview.close();
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

function createHosted(deps: AppDeps, options: CreateWebAppOptions): HostedService | null {
  const settings = deps.config.hosted;
  if (!settings.enabled) return null;
  if (deps.config.isProduction && (settings.fake || options.model)) throw new Error('生产环境不能注入测试模型');
  const fake = settings.fake ? options.model ?? createFakeModel() : null;
  return createHostedService(deps, {
    settings,
    ready: (userId) => !!fake || deps.userModels.ready(userId),
    resolve: (userId, role) => fake
      ? { client: fake, endpoint: { ...settings[role], ready: true } }
      : deps.userModels.resolve(userId, role),
    previewer: options.previewer ?? createRenderPreviewer(), tempRoot: options.hostedTempRoot,
  });
}
