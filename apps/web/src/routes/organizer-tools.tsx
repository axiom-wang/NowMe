/**
 * 组织者工具里成员这一侧的路由（contracts 19）。组织者后台的部分（编辑必答题、一键提醒、群像、成员名单）在 admin.tsx。
 *
 * | 路径 | 谁能访问 | 作用 |
 * | --- | --- | --- |
 * | GET /w/:wallId/questions | 墙内有效成员 | 回答 / 修改必答题；墙没有题目时回到墙 |
 * | POST /w/:wallId/questions | 同上 | 保存回答 → 303 `next`（只允许这面墙内的路径） |
 * | POST /account/notifications | 登录用户 | `reminders=1/0`：接收 / 关闭组织者的提醒邮件 |
 *
 * `questionsGate`：没答完必答题的成员打开墙、成员页、工作区时，先 303 到回答页。
 */
import type { Context } from 'hono';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { requireForm } from '../security/forms.js';
import { safeNextPath } from '../security/redirect.js';
import { authOf, requireUser } from '../security/session.js';
import { findMemberWall, type MemberWall } from '../services/access.js';
import { answersOf, missingCount, parseAnswerForm, questionsVersion, saveAnswers } from '../services/wall-questions.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { AnswerView } from '../views/organizer-tools.js';

/** 回答后回到哪里：只允许这面墙里的路径，否则回墙。 */
function nextFor(wallId: string, raw: string | undefined, webOrigin: string): string {
  const next = safeNextPath(raw, webOrigin);
  return next === `/w/${wallId}` || next.startsWith(`/w/${wallId}/`) || next.startsWith(`/w/${wallId}?`) ? next : `/w/${wallId}`;
}

/** 没答完必答题时返回去回答页的跳转；否则 null。 */
export function questionsGate(c: Context<AppEnv>, deps: Pick<AppDeps, 'repos'>, member: MemberWall): Response | null {
  if (missingCount(deps, member.wall.id, member.membership.userId) === 0) return null;
  const url = new URL(c.req.url);
  const next = `${url.pathname}${url.search}`;
  return c.redirect(`/w/${member.wall.id}/questions?next=${encodeURIComponent(next)}`, 303);
}

export function registerOrganizerToolRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);

  app.get('/w/:wallId/questions', user, (c) => {
    const auth = authOf(c);
    const member = findMemberWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!member) return renderNotFound(c);
    const questions = deps.repos.questions.listForWall(member.wall.id);
    const next = nextFor(member.wall.id, c.req.query('next'), deps.config.webOrigin);
    if (questions.length === 0) return c.redirect(next, 303);
    const answers = answersOf(questions, deps.repos.questions.answersForUser(member.wall.id, auth.user.id));
    return renderPage(c, {
      title: `必答题 · ${member.wall.name}`,
      body: (
        <AnswerView
          wall={member.wall}
          questions={questions}
          version={questionsVersion(questions)}
          csrf={auth.session.csrfToken}
          next={next}
          selected={answers}
          editing={answers.size === questions.length}
        />
      ),
    });
  });

  app.post('/w/:wallId/questions', form, (c) => {
    const auth = authOf(c);
    const member = findMemberWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!member) return renderNotFound(c);
    const fields = c.get('form');
    const next = nextFor(member.wall.id, fields.next, deps.config.webOrigin);
    const questions = deps.repos.questions.listForWall(member.wall.id);
    if (questions.length === 0) return c.redirect(next, 303);
    const parsed = parseAnswerForm(questions, fields);
    if (!parsed.ok) {
      const previous = answersOf(questions, deps.repos.questions.answersForUser(member.wall.id, auth.user.id));
      return renderPage(c, {
        title: `必答题 · ${member.wall.name}`,
        status: 400,
        body: (
          <AnswerView
            wall={member.wall}
            questions={questions}
            version={questionsVersion(questions)}
            csrf={auth.session.csrfToken}
            next={next}
            selected={parsed.stale ? previous : parsed.draft}
            errors={parsed.stale ? {} : parsed.errors}
            stale={parsed.stale}
            editing={previous.size === questions.length}
          />
        ),
      });
    }
    saveAnswers(deps, member.wall.id, auth.user.id, parsed.answers);
    return c.redirect(next, 303);
  });

  app.post('/account/notifications', form, (c) => {
    const accept = c.get('form').reminders === '1';
    deps.repos.reminders.setAcceptsReminders(authOf(c).user.id, accept);
    return c.redirect(`/account/data?notice=${accept ? 'reminders-on' : 'reminders-off'}#notifications`, 303);
  });
}
