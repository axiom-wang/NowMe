/**
 * 挂载全部路由。每个模块一个 `register<名字>Routes(app, deps)`，按文件分工：
 *
 * | 文件 | 负责 | 内容 |
 * | --- | --- | --- |
 * | static.ts | T2.1 | `/static/*` |
 * | auth.tsx | T2.1 | 登录、验证码、昵称、退出、`/dev/outbox` |
 * | agent-api.ts | T2.1 | `/api/agent/*` |
 * | home.tsx | T2.1（T3.1 重做） | `GET /` |
 * | workspace.tsx | T2.1 + T3.2 | `/w/:wallId/me*`、`/w/:wallId/leave` |
 * | walls.tsx | T3.1 | 建墙、加入、墙、成员页、想聊这个、封面 |
 * | admin.tsx | T3.1 | 组织者后台 |
 * | public.tsx | T3.2 | `/s/:publicToken` |
 */
import type { AppDeps, AppHono } from '../context.js';
import { registerAdminRoutes } from './admin.js';
import { registerAgentApiRoutes } from './agent-api.js';
import { registerAuthRoutes } from './auth.js';
import { registerHomeRoutes } from './home.js';
import { registerPublicRoutes } from './public.js';
import { registerStaticRoutes } from './static.js';
import { registerWallRoutes } from './walls.js';
import { registerWorkspaceRoutes } from './workspace.js';

export function registerRoutes(app: AppHono, deps: AppDeps): void {
  registerStaticRoutes(app);
  registerAuthRoutes(app, deps);
  registerAgentApiRoutes(app, deps);
  registerHomeRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerWallRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerPublicRoutes(app, deps);
}
