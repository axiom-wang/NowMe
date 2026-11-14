/**
 * 组织者后台（T3.1，contracts 4.2、W03、S5）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /w/:wallId/admin | 组织者：邀请链接与二维码、聚合数字、成员列表（昵称、加入时间、发布状态）、移除、关闭墙 |
 * | POST /w/:wallId/admin/remove | 组织者：`membershipId` → 成员关系 removed、活跃发布以 removed 结束、吊销凭证与未用 token |
 * | POST /w/:wallId/admin/close | 组织者：`confirm=1` → 墙 closed、全部活跃发布以 closed 结束、吊销全部凭证 |
 *
 * 不是组织者 / 墙已关闭 / 不是有效成员 → 404。组织者不能移除自己。
 * 后台只显示昵称、加入时间、发布状态；不出现版本 ID、未发布的 card 内容、联系方式、工作区链接（S5）。
 */
import type { Context } from 'hono';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { wallQueries } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findMemberWall, findOrganizerWall } from '../services/access.js';
import { uploadWallCover } from '../services/wall-cover.js';
import { loadOrganizerReports } from '../services/moderation.js';
import { qrSvgDataUri } from '../services/qr.js';
import { closeWall, removeMember } from '../services/walls.js';
import { userAccount, wallCredits } from '../services/billing.js';
import { AdminView, type AdminCredits, type AdminModel, type AdminNotice } from '../views/admin.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { sceneLabels } from './home.js';
import { invitePath, wallPath } from './walls.js';

const NOTICES: ReadonlySet<string> = new Set<AdminNotice>(['created', 'removed', 'cover-updated', 'cover-deleted', 'credits-saved', 'report-takedown', 'report-dismissed']);
const CREDITS_ERRORS: ReadonlySet<string> = new Set(['bad-amount', 'bad-cap', 'insufficient']);

export function registerAdminRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);
  const coverForm = requireForm(deps, { multipartFiles: 'cover' });
  const labels = sceneLabels();

  function adminModel(wall: Wall, organizerId: string, creditsError: string | undefined): AdminModel {
    const queries = wallQueries(deps.db);
    const members = queries.listMembersForAdmin(wall.id);
    const inviteUrl = `${deps.config.webOrigin}${invitePath(wall.inviteCode)}`;
    return {
      wall,
      coverUrl: deps.repos.walls.coverUrl(wall.id),
      sceneLabel: labels[wall.sceneType],
      inviteUrl,
      inviteQr: qrSvgDataUri(inviteUrl),
      members,
      counts: { members: members.length, published: queries.countPublished(wall.id) },
      reports: loadOrganizerReports(deps, wall, organizerId),
      // 墙的 AI 额度（contracts 12）：平台 AI 开放时才有意义；只有聚合数字
      credits:
        !deps.demo && deps.platformModel.available
          ? {
              wall: wallCredits(deps, wall.id),
              balance: deps.repos.credits.balanceOf(userAccount(organizerId)),
              prices: deps.config.billing.prices,
              error: creditsError && CREDITS_ERRORS.has(creditsError) ? (creditsError as NonNullable<AdminCredits['error']>) : null,
            }
          : null,
    };
  }

  function renderAdmin(c: Context<AppEnv>, wall: Wall, options: { notice?: AdminNotice | null; closeError?: boolean; coverError?: string; status?: number } = {}) {
    return renderPage(c, {
      title: `${wall.name} · 组织者后台`,
      status: options.status,
      body: (
        <AdminView model={adminModel(wall, authOf(c).user.id, c.req.query('credits'))} csrf={authOf(c).session.csrfToken} notice={options.notice ?? null} closeError={options.closeError} coverError={options.coverError} />
      ),
    });
  }

  app.get('/w/:wallId/admin', user, (c) => {
    const organizer = findOrganizerWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const notice = c.req.query('notice');
    return renderAdmin(c, organizer.wall, { notice: notice && NOTICES.has(notice) ? (notice as AdminNotice) : null });
  });

  app.get('/w/:wallId/cover', user, (c) => {
    const member = findMemberWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!member) return renderNotFound(c);
    const cover = deps.repos.walls.findCover(member.wall.id);
    if (!cover) return renderNotFound(c);
    // 不缓存成员资源：移出、退出、关闭后，旧地址也必须立即失效。
    return c.body(new Uint8Array(cover), 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  });

  app.post('/w/:wallId/admin/cover', coverForm, async (c) => {
    const organizer = findOrganizerWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const result = await uploadWallCover(deps, authOf(c).user.id, organizer.wall.id, c.get('uploads') ?? []);
    if (!result.ok) {
      if (result.status === 404) return renderNotFound(c);
      return renderAdmin(c, organizer.wall, { coverError: result.error, status: result.status });
    }
    return c.redirect(`${wallPath(organizer.wall.id)}/admin?notice=cover-updated#wall-cover-heading`, 303);
  });

  app.post('/w/:wallId/admin/cover/delete', form, (c) => {
    const organizer = findOrganizerWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    deps.repos.walls.deleteCover(organizer.wall.id);
    return c.redirect(`${wallPath(organizer.wall.id)}/admin?notice=cover-deleted#wall-cover-heading`, 303);
  });

  app.post('/w/:wallId/admin/remove', form, (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const removed = removeMember(deps, organizer.wall, auth.user.id, c.get('form').membershipId ?? '');
    if (!removed) return renderNotFound(c);
    return c.redirect(`${wallPath(organizer.wall.id)}/admin?notice=removed`, 303);
  });

  app.post('/w/:wallId/admin/close', form, (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    if (c.get('form').confirm !== '1') return renderAdmin(c, organizer.wall, { closeError: true, status: 400 });
    closeWall(deps, organizer.wall, auth.user.id);
    return c.redirect('/?notice=wall-closed', 303);
  });
}
