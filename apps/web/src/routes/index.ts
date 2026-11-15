/**
 * 挂载全部路由。每个模块一个 `register<名字>Routes(app, deps)`，按文件分工：
 *
 * | 文件 | 负责 | 内容 |
 * | --- | --- | --- |
 * | static.ts | T2.1 | `/static/*` |
 * | auth.tsx | T2.1 | 登录、验证码、昵称与协议确认（`/welcome`、`/consent`）、退出、`/dev/outbox` |
 * | legal.tsx | T8.4 | `/terms`、`/privacy` |
 * | agent-api.ts | T2.1 | `/api/agent/*` |
 * | home.tsx | T2.1（T3.1 重做） | `GET /` |
 * | workspace.tsx | T2.1 + T3.2 | `/w/:wallId/me*`、`/w/:wallId/leave` |
 * | walls.tsx | T3.1 | 建墙、加入、墙、成员页、想聊这个、封面 |
 * | admin.tsx | T3.1 | 组织者后台（含必答题、完成度与提醒、群像，contracts 19） |
 * | organizer-tools.tsx | contracts 19 | 成员回答必答题、`questionsGate`、提醒邮件开关 |
 * | public.tsx | T3.2 | `/s/:publicToken` |
 * | skill.tsx | T3.6 | Skill 分发：`/skill`、`/skill/install.md`、`/skill/manifest.json`、`/skill/<归档>` |
 * | credits.tsx | contracts 12 | 点数：`/account/credits`、兑换码、组织者给墙充额度 |
 * | moderation.tsx | contracts 15 | 举报、拉黑、组织者处理举报 |
 * | account.tsx | contracts 14 | 注销账号与导出数据：`/account/export`、`/account/delete*` |
 * | hosted.tsx | M5 | 平台托管路线：`/w/:wallId/me/create*`、`/generate`、`/edit`、`/jobs/:jobId`、`/brief*`、`/account/data` 等 |
 */
import type { AppDeps, AppHono } from '../context.js';
import { registerAccountRoutes } from './account.js';
import { registerAiSettingsRoutes } from './ai-settings.js';
import { registerAdminRoutes } from './admin.js';
import { registerAgentApiRoutes } from './agent-api.js';
import { registerAuthRoutes } from './auth.js';
import { registerCreditsRoutes } from './credits.js';
import { registerHomeRoutes } from './home.js';
import { registerLegalRoutes } from './legal.js';
import { registerMessageRoutes } from './messages.js';
import { registerModerationRoutes } from './moderation.js';
import { registerOrganizerToolRoutes } from './organizer-tools.js';
import { registerHostedRoutes } from './hosted.js';
import { registerPublicRoutes } from './public.js';
import { registerSkillRoutes } from './skill.js';
import { registerStaticRoutes } from './static.js';
import { registerWallRoutes } from './walls.js';
import { registerWorkspaceRoutes } from './workspace.js';

export function registerRoutes(app: AppHono, deps: AppDeps): void {
  registerStaticRoutes(app);
  registerAuthRoutes(app, deps);
  registerLegalRoutes(app, deps);
  registerAgentApiRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerHomeRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerModerationRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerHostedRoutes(app, deps);
  registerAiSettingsRoutes(app, deps);
  registerCreditsRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerOrganizerToolRoutes(app, deps);
  registerWallRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerPublicRoutes(app, deps);
}
