/**
 * 主站的依赖与 Hono 环境类型。路由模块都是 `register<名字>Routes(app, deps)`，共用一个 Hono 实例。
 *
 * 注意：不要在路由模块里写 `app.use('*', ...)`——所有路由共用一个 app，`'*'` 中间件会作用到别的模块的路由上。
 * 需要的中间件直接写在路由上（`app.post(path, requireForm(deps), handler)`）。
 */
import type { Hono } from 'hono';
import type { KitFont, NowmeConfig } from '@nowme/contracts';
import type { Database, Repos } from './db/index.js';
import type { Membership } from './db/memberships.js';
import type { Page } from './db/pages.js';
import type { PageCredential } from './db/credentials.js';
import type { SessionRecord } from './db/sessions.js';
import type { User } from './db/users.js';
import type { Wall } from './db/walls.js';
import type { UserModels } from './hosted/user-models.js';
import type { PlatformModel } from './hosted/platform-model.js';
import type { HostedService } from './hosted/service.js';
import type { RateLimiter } from './security/rate-limit.js';
import type { ContentSafety } from './services/content-safety.js';
import type { Outbox } from './services/outbox.js';
import type { RemotePreviewService } from './services/remote-preview.js';
import type { SkillPackage } from './services/skill-package.js';
import type { SubmissionService } from './services/submissions.js';
import type { TicketIssuer } from './services/tickets.js';

/** 主站运行配置（contracts 0.1、4.3、4.4）。`ticketSecret` 已解析（`resolveTicketSecret`）。 */
export type WebConfig = Pick<NowmeConfig, 'webOrigin' | 'pagesOrigin' | 'dataDir' | 'agentTokenTtlHours' | 'isProduction' | 'hosted' | 'skillMarket' | 'mail' | 'trustProxyHops' | 'billing' | 'moderation' | 'contactEmail' | 'worker'> & {
  ticketSecret: string;
};

export interface AppDeps {
  demo: import('./demo-access.js').DemoAccess | null;
  config: WebConfig;
  db: Database;
  repos: Repos;
  /** 当前时间（测试可注入）。 */
  now: () => Date;
  /** Kit 字体清单（AgentContext.kit.fonts 与提交校验共用）。 */
  kitFonts: KitFont[];
  /** 页面票据签发：只在授权检查通过后调用。 */
  tickets: TicketIssuer;
  submissions: SubmissionService;
  outbox: Outbox;
  /** 平台 AI（contracts 12）；没有配置时 `available` 为 false。 */
  platformModel: PlatformModel;
  /** 内容安全检查（contracts 16.1）：路由 / 服务边界在写入或发布前调用。 */
  contentSafety: ContentSafety;
  /** 短时限流（按来源地址 / 按用户，contracts 10.3）。 */
  rateLimiter: RateLimiter;
  /** 平台托管路线（contracts 9）；用户未配置时引导到账号设置。 */
  hosted: HostedService | null;
  userModels: UserModels;
  /** 主站托管的 Skill 包（contracts 4.5）；没有打包时为 null（安装页提示先构建）。 */
  skillPackage: SkillPackage | null;
  /** 服务端远程预览（`POST /api/agent/previews`）。 */
  remotePreview: RemotePreviewService;
  log: (message: string) => void;
}

/** 已登录的会话。 */
export interface SessionAuth {
  user: User;
  session: SessionRecord;
}

/** 通过页面凭证认证的 Agent 请求。 */
export interface AgentAuth {
  credential: PageCredential;
  page: Page;
  wall: Wall;
  membership: Membership;
}

/** 表单字段（只保留字符串值；同名多值时取最后一个）。 */
export type FormFields = Record<string, string>;

export type AppEnv = {
  Variables: {
    /** 会话（主站页面与表单；Agent API 不加载会话）。 */
    auth: SessionAuth | null;
    demo: boolean;
    /** `requireForm` 解析后的表单字段。 */
    form: FormFields;
    /** `requireForm({ multipartFiles })` 解析出的上传文件（托管采访的图片）。 */
    uploads: Uint8Array[];
    /** `requireCredential` 认证后的 Agent。 */
    agent: AgentAuth;
  };
};

export type AppHono = Hono<AppEnv>;
