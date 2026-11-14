/**
 * 举报、拉黑与组织者处理（contracts 15、S12）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | POST /w/:wallId/p/:pageId/report | 墙内有效成员；别人的、墙上可见的页面 → 举报（重复只更新），303 回成员页 |
 * | POST /w/:wallId/p/:pageId/block | 同上 → 拉黑页面主人，303 回墙 |
 * | POST /messages/:id/report | 一对一私聊的参与者 → 举报这段对话（只进平台运营） |
 * | POST /messages/:id/block | 同上 → 拉黑对方 |
 * | POST /account/blocks/remove | 登录用户：`userId` → 解除自己对 TA 的拉黑 |
 * | POST /w/:wallId/admin/reports/takedown | 组织者：`pageId` 有待处理举报 → 请这一页下墙 |
 * | POST /w/:wallId/admin/reports/dismiss | 组织者：`pageId` 有待处理举报 → 忽略 |
 *
 * 全部用 `requireForm`（会话 + CSRF + Origin，忽略 Authorization）。无权访问、对象不存在一律 404。
 */
import type { AppDeps, AppHono } from '../context.js';
import type { ConversationSummary } from '@nowme/contracts';
import { requireForm } from '../security/forms.js';
import { authOf } from '../security/session.js';
import { findOrganizerWall, findPublishedMemberPage, type PublishedMemberPage } from '../services/access.js';
import { directPeer } from '../services/chat.js';
import {
  blockUser,
  canMessage,
  hasReportedPage,
  organizerDismiss,
  organizerTakedown,
  parseReportForm,
  reportConversation,
  reportPage,
  unblockUser,
} from '../services/moderation.js';
import { renderNotFound } from '../views/errors.js';
import type { PageSafetyModel } from '../views/member-page.js';
import type { ConversationSafetyModel } from '../views/messages.js';
import { isSafetyNotice } from '../views/moderation.js';

const REPORT_INVALID_TEXT = '先选一个原因；补充说明最多 500 字。';

/** 成员页底部“举报 / 拉黑”的状态。 */
export function pageSafetyModel(deps: Pick<AppDeps, 'repos'>, found: PublishedMemberPage, viewerId: string, query: string | undefined): PageSafetyModel {
  return {
    reported: hasReportedPage(deps, viewerId, found.entry.pageId),
    notice: query !== 'invalid' && isSafetyNotice(query) ? query : null,
    error: query === 'invalid' ? REPORT_INVALID_TEXT : null,
  };
}

/** 一对一私聊里“举报 / 拉黑”的状态；群聊返回 null。 */
export function conversationSafetyModel(deps: Pick<AppDeps, 'repos'>, summary: ConversationSummary, viewerId: string, query: string | undefined): ConversationSafetyModel | null {
  if (summary.kind !== 'direct') return null;
  const conversation = deps.repos.chat.findVisible(summary.id, viewerId);
  if (!conversation) return null;
  const other = directPeer(conversation, viewerId);
  const report = deps.repos.moderation.findConversationReport(viewerId, summary.id);
  return {
    blockedByMe: deps.repos.moderation.hasBlocked(viewerId, other),
    closed: !canMessage(deps, viewerId, other),
    reported: report?.status === 'open',
    notice: isSafetyNotice(query) ? query : null,
    error: query === 'invalid' ? REPORT_INVALID_TEXT : null,
  };
}

export function registerModerationRoutes(app: AppHono, deps: AppDeps): void {
  const form = requireForm(deps);

  // 成员页：举报与拉黑（只能对别人的、墙上可见的页面）
  app.post('/w/:wallId/p/:pageId/report', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own) return renderNotFound(c);
    const base = `/w/${found.wall.id}/p/${found.entry.pageId}`;
    const parsed = parseReportForm(c.get('form'));
    if (!parsed.ok) return c.redirect(`${base}?safety=invalid#safety`, 303);
    const outcome = reportPage(deps, found, auth.user.id, parsed.input);
    if (!outcome) return renderNotFound(c);
    return c.redirect(`${base}?safety=${outcome === 'created' ? 'reported' : 'report-updated'}#safety`, 303);
  });

  app.post('/w/:wallId/p/:pageId/block', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own || !blockUser(deps, auth.user.id, found.entry.ownerId)) return renderNotFound(c);
    return c.redirect(`/w/${found.wall.id}?notice=blocked`, 303);
  });

  // 私聊：举报与拉黑（只能是自己参与的一对一私聊）
  app.post('/messages/:id/report', form, (c) => {
    const auth = authOf(c);
    const id = c.req.param('id');
    const conversation = deps.repos.chat.findVisible(id, auth.user.id);
    if (!conversation || conversation.kind !== 'direct') return renderNotFound(c);
    const parsed = parseReportForm(c.get('form'));
    if (!parsed.ok) return c.redirect(`/messages/${id}?safety=invalid#safety`, 303);
    const outcome = reportConversation(deps, auth.user.id, id, parsed.input);
    if (!outcome) return renderNotFound(c);
    return c.redirect(`/messages/${id}?safety=${outcome === 'created' ? 'reported' : 'report-updated'}#safety`, 303);
  });

  app.post('/messages/:id/block', form, (c) => {
    const auth = authOf(c);
    const id = c.req.param('id');
    const conversation = deps.repos.chat.findVisible(id, auth.user.id);
    if (!conversation || conversation.kind !== 'direct') return renderNotFound(c);
    if (!blockUser(deps, auth.user.id, directPeer(conversation, auth.user.id))) return renderNotFound(c);
    return c.redirect(`/messages/${id}?safety=blocked#safety`, 303);
  });

  // 我的资料：解除拉黑
  app.post('/account/blocks/remove', form, (c) => {
    const auth = authOf(c);
    if (!unblockUser(deps, auth.user.id, c.get('form').userId ?? '')) return renderNotFound(c);
    return c.redirect('/account/data?notice=unblocked#blocks', 303);
  });

  // 组织者后台：处理页面举报
  app.post('/w/:wallId/admin/reports/takedown', form, (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer || !organizerTakedown(deps, organizer.wall, auth.user.id, c.get('form').pageId ?? '')) return renderNotFound(c);
    return c.redirect(`/w/${organizer.wall.id}/admin?notice=report-takedown#reports`, 303);
  });

  app.post('/w/:wallId/admin/reports/dismiss', form, (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer || !organizerDismiss(deps, organizer.wall, auth.user.id, c.get('form').pageId ?? '')) return renderNotFound(c);
    return c.redirect(`/w/${organizer.wall.id}/admin?notice=report-dismissed#reports`, 303);
  });
}
