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
import type { Outbox } from './services/outbox.js';
import type { SubmissionService } from './services/submissions.js';
import type { TicketIssuer } from './services/tickets.js';

/** 主站运行配置（contracts 0.1、4.3、4.4）。`ticketSecret` 已解析（`resolveTicketSecret`）。 */
export type WebConfig = Pick<NowmeConfig, 'webOrigin' | 'pagesOrigin' | 'dataDir' | 'agentTokenTtlHours' | 'isProduction'> & {
  ticketSecret: string;
};

export interface AppDeps {
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
    /** `requireForm` 解析后的表单字段。 */
    form: FormFields;
    /** `requireCredential` 认证后的 Agent。 */
    agent: AgentAuth;
  };
};

export type AppHono = Hono<AppEnv>;
