/**
 * 公开链接（T3.2 填充，contracts 4.2、W15）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /s/:publicToken | 任何人：只显示当前发布版本的页面（PageFrame），不显示联系方式与“想聊这个” |
 *
 * 公开链接令牌明文存在 `pages.public_token`；关闭后立即失效（置空），墙关闭、页面撤下时也不可见。
 */
import type { AppDeps, AppHono } from '../context.js';

export function registerPublicRoutes(_app: AppHono, _deps: AppDeps): void {
  // T3.2
}
