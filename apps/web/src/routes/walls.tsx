/**
 * 墙、邀请、加入、浏览、想聊这个（T3.1 填充，contracts 4.2）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /walls/new、POST /walls | 登录用户 |
 * | GET /join/:inviteCode、POST /join/:inviteCode | 登录用户（已移除不能再加入；关闭的墙不能加入） |
 * | GET /w/:wallId | 墙内有效成员 |
 * | GET /w/:wallId/p/:pageId | 墙内有效成员（页面用 views/page-frame.tsx 的 PageFrame，票据只给当前发布版本） |
 * | POST /w/:wallId/p/:pageId/chat | 墙内有效成员（主人未公开联系方式时 404） |
 * | GET /w/:wallId/covers/:pageId.png | 墙内有效成员（已发布版本的封面） |
 *
 * 约定：GET 页面用 `requireUser(deps)`；POST 用 `requireForm(deps)`；无权访问一律 `renderNotFound(c)`；
 * 授权检查放进 services/access.ts（例如 `findMemberWall`）；建墙 / 加入用 services/walls.ts。
 */
import type { AppDeps, AppHono } from '../context.js';

export function registerWallRoutes(_app: AppHono, _deps: AppDeps): void {
  // T3.1
}
