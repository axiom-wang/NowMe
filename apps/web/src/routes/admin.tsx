/**
 * 组织者后台（T3.1，contracts 4.2、W03、S5）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /w/:wallId/admin | 组织者：邀请链接与二维码、聚合数字、成员列表（昵称、加入时间、发布状态）、移除、关闭墙 |
 * | POST /w/:wallId/admin/remove | 组织者：`membershipId` → 成员关系 removed、活跃发布以 removed 结束、吊销凭证与未用 token |
 * | POST /w/:wallId/admin/close | 组织者：`confirm=1` → 墙 closed、全部活跃发布以 closed 结束、吊销全部凭证 |
 *
 * | POST /w/:wallId/admin/questions | 组织者：保存必答题（contracts 19.1） |
 * | POST /w/:wallId/admin/remind | 组织者：一键提醒还没发布 / 没答完题的成员（contracts 19.2） |
 * | POST /w/:wallId/admin/portrait | 组织者：生成 / 刷新墙的群像（contracts 19.3） |
 * | GET /w/:wallId/admin/members.csv | 组织者：成员名单（昵称、角色、加入时间、发布状态、必答题回答） |
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
import { generatePortrait, loadPortrait, PORTRAIT_ERROR_TEXT, portraitShareText, type PortraitFailure } from '../services/portrait.js';
import { groupReminderText, loadWallProgress, remindMembers } from '../services/reminders.js';
import { answersForWall, cardAnswers, parseQuestionForm, questionFormValues, questionStats, questionTexts, saveQuestions, type QuestionFormValue } from '../services/wall-questions.js';
import { PAGE_STATE_LABEL } from '../views/home.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { sceneLabels } from './home.js';
import { invitePath, wallPath } from './walls.js';

const NOTICES: ReadonlySet<string> = new Set<AdminNotice>(['created', 'removed', 'cover-updated', 'cover-deleted', 'credits-saved', 'report-takedown', 'report-dismissed', 'questions-saved', 'portrait-ready']);

/** CSV 单元格：加引号；以 = + - @ 制表符开头的加 '，防止表格软件当公式执行。 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
const CREDITS_ERRORS: ReadonlySet<string> = new Set(['bad-amount', 'bad-cap', 'insufficient']);

export function registerAdminRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);
  const coverForm = requireForm(deps, { multipartFiles: 'cover' });
  const labels = sceneLabels();

  interface AdminExtras {
    questionValues?: QuestionFormValue[];
    questionErrors?: Record<number, string>;
    reminded?: number | null;
    portraitError?: string | null;
  }

  function adminModel(wall: Wall, organizerId: string, creditsError: string | undefined, extras: AdminExtras = {}): AdminModel {
    const queries = wallQueries(deps.db);
    const members = queries.listMembersForAdmin(wall.id);
    const inviteUrl = `${deps.config.webOrigin}${invitePath(wall.inviteCode)}`;
    const wallUrl = `${deps.config.webOrigin}${wallPath(wall.id)}`;
    const questions = deps.repos.questions.listForWall(wall.id);
    const answers = answersForWall(deps, wall.id, questions);
    const progress = loadWallProgress(deps, wall, organizerId);
    const portrait = loadPortrait(deps, wall.id);
    return {
      questions: {
        stats: questionStats(questions, answers, members.map((member) => member.userId)),
        values: extras.questionValues ?? questionFormValues(questions),
        errors: extras.questionErrors,
      },
      memberAnswers: new Map(members.map((member) => [member.membershipId, cardAnswers(questions, answers.get(member.userId))])),
      progress,
      groupReminder: groupReminderText(wall, progress, wallUrl),
      reminded: extras.reminded ?? null,
      portrait: { state: portrait, shareText: portrait.kind === 'ready' ? portraitShareText(wall, portrait.view, wallUrl) : null, error: extras.portraitError ?? null },
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

  function renderAdmin(c: Context<AppEnv>, wall: Wall, options: { notice?: AdminNotice | null; closeError?: boolean; coverError?: string; status?: number; extras?: AdminExtras } = {}) {
    return renderPage(c, {
      title: `${wall.name} · 组织者后台`,
      status: options.status,
      body: (
        <AdminView model={adminModel(wall, authOf(c).user.id, c.req.query('credits'), options.extras)} csrf={authOf(c).session.csrfToken} notice={options.notice ?? null} closeError={options.closeError} coverError={options.coverError} />
      ),
    });
  }

  app.get('/w/:wallId/admin', user, (c) => {
    const organizer = findOrganizerWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const notice = c.req.query('notice');
    const reminded = c.req.query('reminded');
    const portraitError = c.req.query('portrait');
    return renderAdmin(c, organizer.wall, {
      notice: notice && NOTICES.has(notice) ? (notice as AdminNotice) : null,
      extras: {
        reminded: reminded && /^\d{1,5}$/.test(reminded) ? Number(reminded) : null,
        portraitError: portraitError && Object.hasOwn(PORTRAIT_ERROR_TEXT, portraitError) ? PORTRAIT_ERROR_TEXT[portraitError as PortraitFailure] : null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // 组织者工具（contracts 19）
  // -------------------------------------------------------------------------

  app.post('/w/:wallId/admin/questions', form, async (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const parsed = parseQuestionForm(c.get('form'));
    if (!parsed.ok) return renderAdmin(c, organizer.wall, { status: 400, extras: { questionValues: parsed.values, questionErrors: parsed.errors } });
    const blocked: Record<number, string> = {};
    const texts = questionTexts(parsed.drafts);
    for (const [index, draft] of parsed.drafts.entries()) {
      const verdict = await deps.contentSafety.checkText('wall', texts[index] ?? '');
      if (!verdict.ok) blocked[draft.index] = verdict.message;
    }
    if (Object.keys(blocked).length > 0) return renderAdmin(c, organizer.wall, { status: 422, extras: { questionValues: parsed.values, questionErrors: blocked } });
    const result = saveQuestions(deps, organizer.wall.id, parsed.drafts);
    deps.repos.events.record({
      type: 'wall_questions_save',
      wallId: organizer.wall.id,
      pageId: null,
      actorId: auth.user.id,
      props: { questions: parsed.drafts.length, added: result.added, changed: result.changed, removed: result.removed, reset: result.reset },
      createdAt: deps.now().toISOString(),
    });
    return c.redirect(`${wallPath(organizer.wall.id)}/admin?notice=questions-saved#questions`, 303);
  });

  app.post('/w/:wallId/admin/remind', form, (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const count = remindMembers(deps, organizer.wall, auth.user.id);
    return c.redirect(`${wallPath(organizer.wall.id)}/admin?reminded=${count}#progress`, 303);
  });

  app.post('/w/:wallId/admin/portrait', form, async (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const result = await generatePortrait(deps, organizer.wall, auth.user.id);
    const base = `${wallPath(organizer.wall.id)}/admin`;
    return c.redirect(result.ok ? `${base}?notice=portrait-ready#portrait` : `${base}?portrait=${result.error}#portrait`, 303);
  });

  app.get('/w/:wallId/admin/members.csv', user, (c) => {
    const organizer = findOrganizerWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const wall = organizer.wall;
    const questions = deps.repos.questions.listForWall(wall.id);
    const answers = answersForWall(deps, wall.id, questions);
    const header = ['昵称', '角色', '加入时间', '发布状态', ...questions.map((question) => question.prompt)];
    const rows = wallQueries(deps.db)
      .listMembersForAdmin(wall.id)
      .map((member) => [
        member.nickname,
        member.role === 'organizer' ? '组织者' : '成员',
        member.joinedAt,
        PAGE_STATE_LABEL[member.state],
        ...questions.map((question) => (answers.get(member.userId)?.get(question.id) ?? []).join('、')),
      ]);
    const body = `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
    return c.body(body, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nowme-members.csv"`,
      'Cache-Control': 'private, no-store',
    });
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
