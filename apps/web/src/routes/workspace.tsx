/**
 * 创作工作区（contracts 4.2，只给页面主人；不是主人 / 墙关闭 / 不是有效成员 → 404，未登录 → /login?next=）。
 *
 * | 路径 | 说明 |
 * | --- | --- |
 * | GET /w/:wallId/me[?rev=<revisionId>] | 指令、连接状态、版本列表与报告、选中 accepted 版本的沙箱预览 |
 * | POST /w/:wallId/me/instruction | 生成新的一次性 token 与指令（旧的未使用 token 作废），直接在响应里显示 |
 * | POST /w/:wallId/me/disconnect | 吊销页面凭证并作废未使用的 token |
 *
 * T3.2 在这里加：POST /w/:wallId/me/publish、/withdraw、/public-link、/delete，以及 POST /w/:wallId/leave。
 * 新路由一律用 `requireForm(deps)` + `findOwnPage(...)`，找不到返回 `renderNotFound(c)`。
 */
import type { Context } from 'hono';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findOwnPage } from '../services/access.js';
import { disconnectAgent, workspacePath } from '../services/agent.js';
import { createInstruction } from '../services/instruction.js';
import { loadWorkspace, type LoadWorkspaceOptions, type WorkspaceNotice } from '../services/workspace.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { WorkspaceView } from '../views/workspace.js';

const NOTICES: ReadonlySet<string> = new Set<WorkspaceNotice>(['disconnected']);

function renderWorkspace(c: Context<AppEnv>, deps: AppDeps, wallId: string, options: Omit<LoadWorkspaceOptions, 'csrf'>) {
  const auth = authOf(c);
  const own = findOwnPage(deps.repos, auth.user.id, wallId);
  if (!own) return renderNotFound(c);
  const model = loadWorkspace(deps, own, { ...options, csrf: auth.session.csrfToken });
  if (!model) return renderNotFound(c);
  return renderPage(c, {
    title: `${own.wall.name} · 创作工作区`,
    body: <WorkspaceView model={model} ownerName={auth.user.nickname ?? ''} />,
  });
}

export function registerWorkspaceRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);

  app.get('/w/:wallId/me', user, (c) => {
    const notice = c.req.query('notice');
    return renderWorkspace(c, deps, c.req.param('wallId'), {
      revisionId: c.req.query('rev') ?? null,
      notice: notice && NOTICES.has(notice) ? (notice as WorkspaceNotice) : null,
    });
  });

  app.post('/w/:wallId/me/instruction', form, (c) => {
    const own = findOwnPage(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!own) return renderNotFound(c);
    const instruction = createInstruction(deps, own.wall, own.page);
    // 明文 token 只出现在这次响应里（不重定向，库里只有哈希）
    return renderWorkspace(c, deps, own.wall.id, { instruction });
  });

  app.post('/w/:wallId/me/disconnect', form, (c) => {
    const own = findOwnPage(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!own) return renderNotFound(c);
    disconnectAgent(deps, own.page.id);
    return c.redirect(`${workspacePath(own.wall.id)}?notice=disconnected`, 303);
  });
}
