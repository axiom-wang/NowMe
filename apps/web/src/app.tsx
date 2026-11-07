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
import { dataPaths, HOSTED_UPLOAD_REQUEST_MAX_BYTES, type KitFont } from '@nowme/contracts';
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
import { createRealRemoteRenderer, createRemotePreviewService, type RemoteRenderer } from './services/remote-preview.js';
import { loadSkillPackage, type SkillPackage } from './services/skill-package.js';
import { SKILL_PACKAGE_DIR } from '@nowme/skill';
import { createAnthropicClaude, type ClaudeClient } from './hosted/claude.js';
import { createFakeClaude } from './hosted/fake-claude.js';
import { createRenderPreviewer } from './hosted/previewer.js';
import { createHostedService, type HostedService } from './hosted/service.js';
import type { PagePreviewer } from './hosted/tools.js';
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
  /**
   * 平台托管路线（contracts 9）。`config.hosted.enabled` 为 false 时一律不开启。
   * - `claude`：注入的客户端（测试）；不给时：`config.hosted.fake` → 假客户端，否则用 `anthropicApiKey` 建真实客户端；
   * - `anthropicApiKey`：只由进程入口从环境变量读取后传入，不进入配置对象；
   * - `previewer`：`preview_page` 工具的渲染，默认真实渲染器。
   */
  claude?: ClaudeClient;
  anthropicApiKey?: string;
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
  migrate(db);
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.clock ?? (() => new Date());
  const repos = createRepos(db);
  const kitFonts = options.kitFonts ?? loadKitFonts();
  const outbox = options.outbox ?? createFileOutbox(dataPaths(config.dataDir).outbox, log);
  const processor = options.processor ?? createRenderProcessor();
  const submissions = createSubmissionService({ config, db, repos, now, kitFonts, processor, log });
  const tickets = createTicketIssuer({ secret: config.ticketSecret, pagesOrigin: config.pagesOrigin, now });
  const remotePreview = createRemotePreviewService({ repos, now, kitFonts, renderer: options.remoteRenderer ?? createRealRemoteRenderer() });
  const skillPackage = loadHostedSkillPackage(options.skillPackageDir === undefined ? SKILL_PACKAGE_DIR : options.skillPackageDir, log);
  const deps: AppDeps = { config, db, repos, now, kitFonts, tickets, submissions, outbox, hosted: null, skillPackage, remotePreview, log };
  deps.hosted = createHosted(deps, options);

  const app: AppHono = new Hono<AppEnv>();
  app.use(securityHeaders(config));
  app.use(hostCheck(config));
  const formLimit = bodyLimit({
    maxSize: FORM_BODY_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '提交的内容太多', message: '表单内容超过了上限，请精简后再试。' }),
  });
  const uploadLimit = bodyLimit({
    maxSize: HOSTED_UPLOAD_REQUEST_MAX_BYTES,
    onError: (c) => renderError(c, { status: 413, title: '上传的内容太多', message: '图片和文字加起来超过了上限（单张图片 2 MB 以内、最多 6 张），请减少后再试。' }),
  });
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || isApiPath(c.req.path)) return next();
    if (HOSTED_UPLOAD_PATH.test(c.req.path)) return uploadLimit(c, next);
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
  let client = options.claude ?? null;
  if (!client && settings.fake) client = createFakeClaude();
  if (!client && options.anthropicApiKey) client = createAnthropicClaude(options.anthropicApiKey);
  if (!client) {
    deps.log('[web] 托管路线已配置但没有拿到 API key，“在这里创作”保持隐藏');
    return null;
  }
  return createHostedService(deps, { settings, client, previewer: options.previewer ?? createRenderPreviewer(), tempRoot: options.hostedTempRoot });
}
