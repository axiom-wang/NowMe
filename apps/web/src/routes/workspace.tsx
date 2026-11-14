/**
 * 创作工作区（contracts 4.2，只给页面主人；不是主人 / 墙关闭 / 不是有效成员 → 404，未登录 → /login?next=，
 * 未登录的表单 POST → 401）。所有 POST 走 `requireForm`（会话 + CSRF + Origin，忽略 `Authorization`）。
 *
 * | 路径 | 说明 |
 * | --- | --- |
 * | GET /w/:wallId/me[?rev=<revisionId>] | 墙上的页面、公开链接、指令、连接状态、版本预览与发布确认、版本列表、删除与退出入口 |
 * | POST /w/:wallId/me/instruction | 生成新的一次性 token 与指令（旧的未使用 token 作废），直接在响应里显示 |
 * | POST /w/:wallId/me/disconnect | 吊销页面凭证并作废未使用的 token |
 * | POST /w/:wallId/me/publish | 发布确认（也用于恢复旧版本）：版本属于这一页且通过、未删除；只存确认后的缩略卡 |
 * | POST /w/:wallId/me/withdraw | 撤下（活跃发布以 withdrawn 结束） |
 * | POST /w/:wallId/me/public-link | `enabled=1` 开启（每次生成新令牌）/ `enabled=0` 关闭（旧链接立即失效） |
 * | GET /w/:wallId/me/delete | 删除页面前的影响范围确认页 |
 * | POST /w/:wallId/me/delete | `confirm=1`：删除页面（墓碑语义，见 services/page-lifecycle.ts） |
 * | GET /w/:wallId/leave | 退出墙前的影响说明（组织者：提示先关闭墙） |
 * | POST /w/:wallId/leave | 退出墙（组织者不能退出） |
 *
 * 新路由一律用 `requireForm(deps)` + `findOwnPage(...)`，找不到返回 `renderNotFound(c)`。
 */
import type { Context } from 'hono';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findOwnPage, type OwnPage } from '../services/access.js';
import { disconnectAgent, workspacePath } from '../services/agent.js';
import { createInstruction } from '../services/instruction.js';
import { deletePage, deletionImpact, isRevisionDeleted, isRevisionUsable, leaveWall } from '../services/page-lifecycle.js';
import {
  findOwnRevision,
  publishRevision,
  readPublishForm,
  revisionCard,
  setPublicLink,
  validatePublishForm,
  withdrawPublication,
} from '../services/publish.js';
import { loadWorkspace, type LoadWorkspaceOptions, type WorkspaceNotice } from '../services/workspace.js';
import { DeleteConfirmView, LeaveConfirmView, LeftView, type LeaveImpact } from '../views/confirm.js';
import { renderError, renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { WorkspaceView } from '../views/workspace.js';
import { JOB_START_ERROR_TEXT } from '../views/hosted.js';
import type { JobStartError } from '../hosted/service.js';

/** `?notice=` 只接受这些（固定文案，不回显参数）。 */
const NOTICES: ReadonlySet<string> = new Set<WorkspaceNotice>([
  'disconnected',
  'published',
  'withdrawn',
  'not-published',
  'public-link-on',
  'public-link-off',
  'deleted',
]);

function renderWorkspace(
  c: Context<AppEnv>,
  deps: AppDeps,
  wallId: string,
  options: Omit<LoadWorkspaceOptions, 'csrf'>,
  status = 200,
) {
  const auth = authOf(c);
  const own = findOwnPage(deps.repos, auth.user.id, wallId);
  if (!own) return renderNotFound(c);
  const model = loadWorkspace(deps, own, { ...options, csrf: auth.session.csrfToken });
  if (!model) return renderNotFound(c);
  return renderPage(c, {
    title: `${own.wall.name} · 创作工作区`,
    status,
    body: <WorkspaceView model={model} ownerName={auth.user.nickname ?? ''} />,
  });
}

function redirectToWorkspace(c: Context<AppEnv>, wallId: string, notice: WorkspaceNotice, options: { rev?: string; hash?: string } = {}) {
  const query = options.rev ? `?rev=${options.rev}&notice=${notice}` : `?notice=${notice}`;
  return c.redirect(`${workspacePath(wallId)}${query}${options.hash ?? ''}`, 303);
}

function leaveImpact(deps: AppDeps, own: OwnPage): LeaveImpact {
  const pending = deps.repos.agentTokens.findPendingForPage(own.page.id, deps.now().toISOString());
  return {
    isOrganizer: own.membership.role === 'organizer',
    published: deps.repos.publications.findActiveForPage(own.page.id) !== null,
    publicLinkOn: own.page.publicToken !== null,
    agentConnected: deps.repos.credentials.findActiveForPage(own.page.id) !== null || pending !== null,
  };
}

const ORGANIZER_CANNOT_LEAVE =
  '组织者不能退出这面墙。如果活动已经结束，请在组织者后台关闭这面墙（关闭后所有页面一并下墙）。';
const DELETE_NOT_CONFIRMED = '还没有勾选“我明白删除后无法恢复”。勾选后再点“删除这一页”；什么都没有被删除。';

export function registerWorkspaceRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);

  /** 当前用户在这面墙的页面（不是有效成员 / 墙关闭 / 格式不对 → null）。 */
  const ownOf = (c: Context<AppEnv>) => findOwnPage(deps.repos, authOf(c).user.id, c.req.param('wallId') ?? '');

  app.get('/w/:wallId/me', user, (c) => {
    const notice = c.req.query('notice');
    const hostedError = c.req.query('hosted');
    return renderWorkspace(c, deps, c.req.param('wallId'), {
      revisionId: c.req.query('rev') ?? null,
      notice: notice && NOTICES.has(notice) ? (notice as WorkspaceNotice) : null,
      hostedError: hostedError && Object.hasOwn(JOB_START_ERROR_TEXT, hostedError) ? (hostedError as JobStartError) : null,
    });
  });

  app.post('/w/:wallId/me/instruction', form, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const instruction = createInstruction(deps, own.wall, own.page);
    // 明文 token 只出现在这次响应里（不重定向，库里只有哈希）
    return renderWorkspace(c, deps, own.wall.id, { instruction });
  });

  app.post('/w/:wallId/me/disconnect', form, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    disconnectAgent(deps, own.page.id);
    return c.redirect(`${workspacePath(own.wall.id)}?notice=disconnected`, 303);
  });

  // ---------------------------------------------------------------------------
  // 发布、撤下、公开链接（W10、W11、W12、W15）
  // ---------------------------------------------------------------------------

  app.post('/w/:wallId/me/publish', form, async (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const fields = c.get('form');
    // 不属于这一页（含别人的版本）→ 404，不暴露版本是否存在
    const revision = findOwnRevision(deps, own, fields.revisionId);
    if (!revision) return renderNotFound(c);
    if (!isRevisionUsable(revision)) {
      const notice: WorkspaceNotice = isRevisionDeleted(revision) ? 'publish-deleted' : 'publish-rejected';
      return renderWorkspace(c, deps, own.wall.id, { notice }, 422);
    }
    const base = revisionCard(revision);
    if (!base) return renderWorkspace(c, deps, own.wall.id, { revisionId: revision.id, notice: 'publish-failed' }, 422);
    const values = readPublishForm(fields);
    const checked = validatePublishForm(values, base);
    if (!checked.ok) {
      return renderWorkspace(
        c,
        deps,
        own.wall.id,
        { revisionId: revision.id, notice: 'publish-errors', publishForm: { values, errors: checked.errors } },
        422,
      );
    }
    // 内容安全（contracts 16.1）：发布时页面的渲染文字，加上确认表单里主人改过的名字、介绍、接话点与开场白
    const verdict = await deps.contentSafety.checkTexts('page', [
      revision.renderedText,
      values.displayName,
      values.tagline,
      ...values.hooks.filter((hook) => !hook.remove).flatMap((hook) => [hook.text, hook.opener]),
    ]);
    if (!verdict.ok) {
      return renderError(c, { status: 400, title: '这一页暂时不能发布', message: verdict.message, back: { href: workspacePath(own.wall.id), label: '回到工作区' } });
    }
    const result = publishRevision(deps, own, revision, checked, authOf(c).user.id);
    if (!result) return renderWorkspace(c, deps, own.wall.id, { notice: 'publish-failed' }, 409);
    return redirectToWorkspace(c, own.wall.id, 'published', { rev: revision.id, hash: '#wall-status' });
  });

  app.post('/w/:wallId/me/withdraw', form, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const withdrew = withdrawPublication(deps, own, authOf(c).user.id);
    return redirectToWorkspace(c, own.wall.id, withdrew ? 'withdrawn' : 'not-published');
  });

  app.post('/w/:wallId/me/public-link', form, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const enabled = c.get('form').enabled;
    if (enabled !== '1' && enabled !== '0') {
      return renderError(c, {
        status: 400,
        title: '没有看懂这个操作',
        message: '公开链接的开关参数不对。请回到创作工作区，用“开启公开链接”或“关闭公开链接”按钮重新操作。',
      });
    }
    setPublicLink(deps, own, enabled === '1', authOf(c).user.id);
    return redirectToWorkspace(c, own.wall.id, enabled === '1' ? 'public-link-on' : 'public-link-off', { hash: '#public-link' });
  });

  // ---------------------------------------------------------------------------
  // 删除页面、退出墙（W16）
  // ---------------------------------------------------------------------------

  const renderDeleteConfirm = (c: Context<AppEnv>, own: OwnPage, error: string | null, status = 200) =>
    renderPage(c, {
      title: `删除这一页 · ${own.wall.name}`,
      status,
      body: <DeleteConfirmView wall={own.wall} csrf={authOf(c).session.csrfToken} impact={deletionImpact(deps, own)} error={error} />,
    });

  app.get('/w/:wallId/me/delete', user, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    return renderDeleteConfirm(c, own, null);
  });

  app.post('/w/:wallId/me/delete', form, async (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    if (c.get('form').confirm !== '1') return renderDeleteConfirm(c, own, DELETE_NOT_CONFIRMED, 400);
    await deletePage(deps, own, authOf(c).user.id);
    return redirectToWorkspace(c, own.wall.id, 'deleted');
  });

  const renderLeaveConfirm = (c: Context<AppEnv>, own: OwnPage, error: string | null, status = 200) =>
    renderPage(c, {
      title: `退出 · ${own.wall.name}`,
      status,
      body: <LeaveConfirmView wall={own.wall} csrf={authOf(c).session.csrfToken} impact={leaveImpact(deps, own)} error={error} />,
    });

  app.get('/w/:wallId/leave', user, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    return renderLeaveConfirm(c, own, null);
  });

  app.post('/w/:wallId/leave', form, (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const result = leaveWall(deps, own, authOf(c).user.id);
    if (!result.ok) return renderLeaveConfirm(c, own, ORGANIZER_CANNOT_LEAVE, 400);
    // 退出后这个用户已看不到这面墙，没有可以重定向的工作区：直接显示结果
    return renderPage(c, { title: `已退出 · ${own.wall.name}`, body: <LeftView wallName={own.wall.name} withdrew={result.withdrew} /> });
  });
}
