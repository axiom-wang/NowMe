/**
 * 组织者后台（T3.1 填充，contracts 4.2、S5）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /w/:wallId/admin | 组织者：邀请链接与二维码、成员列表（昵称、加入时间、发布状态）、移除、关闭墙 |
 * | POST /w/:wallId/admin/remove | 组织者：移除成员（其页面立即下墙、凭证吊销：services/agent.ts 的 disconnectAgent） |
 * | POST /w/:wallId/admin/close | 组织者：关闭墙（所有发布结束为 closed、所有凭证吊销） |
 *
 * 后台只显示昵称、加入时间、发布状态；不出现版本 ID、未发布的 card 内容、私密联系方式（S5）。
 */
import type { AppDeps, AppHono } from '../context.js';

export function registerAdminRoutes(_app: AppHono, _deps: AppDeps): void {
  // T3.1
}
