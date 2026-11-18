/**
 * 直接改文字（contracts 22.3）：只给页面主人；会话 + CSRF + Origin 的表单路由，忽略 `Authorization`；
 * 无权访问、别人的 / 不可用的版本一律 404，且不入队。不需要开启托管功能，不调用模型、不扣点数。
 *
 * | 路径 | 说明 |
 * | --- | --- |
 * | GET /w/:wallId/me/text[?rev=<revisionId>] | 按区块列出可改的文字（缺 rev 时用最新的可用版本） |
 * | POST /w/:wallId/me/text | `revisionId` + `t_<序号>` → 存新版本，303 到工作区预览 |
 */
import type { Context } from 'hono';
import type { AppDeps, AppEnv, AppHono, FormFields } from '../context.js';
import type { Revision } from '../db/revisions.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findMemberWall, findOwnPage, type OwnPage } from '../services/access.js';
import { isRevisionUsable } from '../services/page-lifecycle.js';
import { findOwnRevision } from '../services/publish.js';
import { applyTextEdits, extractTextSegments } from '../services/text-edit.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { TextEditView, type TextEditModel } from '../views/text-edit.js';
import { questionsGate } from './organizer-tools.js';

const FIELD = /^t_(\d{1,4})$/;

function readEdits(fields: FormFields): Map<number, string> {
  const edits = new Map<number, string>();
  for (const [name, value] of Object.entries(fields)) {
    const match = FIELD.exec(name);
    if (match && typeof value === 'string') edits.set(Number(match[1]), value);
  }
  return edits;
}

export function registerTextEditRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);

  const ownOf = (c: Context<AppEnv>): OwnPage | null => findOwnPage(deps.repos, authOf(c).user.id, c.req.param('wallId') ?? '');

  /** 主人这一页可用的版本：指定的（必须属于这一页、accepted、未删除），或最新的可用版本。 */
  const usableRevision = (own: OwnPage, revisionId: string | undefined): Revision | null => {
    if (revisionId) {
      const revision = findOwnRevision(deps, own, revisionId);
      return revision && isRevisionUsable(revision) ? revision : null;
    }
    const latest = deps.repos.revisions.listForPage(own.page.id).find(isRevisionUsable);
    return latest ? deps.repos.revisions.findById(latest.id) : null;
  };

  const render = async (c: Context<AppEnv>, own: OwnPage, revision: Revision, extra: Pick<TextEditModel, 'values' | 'error'> = {}, status = 200) => {
    const html = await deps.ownerEdit.readIndex(revision);
    if (html === null) return renderNotFound(c);
    const { segments, truncated } = extractTextSegments(html);
    return renderPage(c, {
      title: `直接改文字 · ${own.wall.name}`,
      status,
      body: (
        <TextEditView
          model={{ wallId: own.wall.id, wallName: own.wall.name, csrf: authOf(c).session.csrfToken, revisionId: revision.id, revisionNumber: revision.number, segments, truncated, ...extra }}
        />
      ),
    });
  };

  app.get('/w/:wallId/me/text', user, async (c) => {
    const member = findMemberWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    const gate = member ? questionsGate(c, deps, member) : null;
    if (gate) return gate;
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const revision = usableRevision(own, c.req.query('rev'));
    if (!revision) return renderNotFound(c);
    return render(c, own, revision);
  });

  app.post('/w/:wallId/me/text', form, async (c) => {
    const own = ownOf(c);
    if (!own) return renderNotFound(c);
    const fields = c.get('form');
    const revisionId = fields.revisionId;
    if (!revisionId) return renderNotFound(c);
    const revision = usableRevision(own, revisionId);
    if (!revision) return renderNotFound(c);
    const html = await deps.ownerEdit.readIndex(revision);
    if (html === null) return renderNotFound(c);

    const edits = readEdits(fields);
    const fail = (error: NonNullable<TextEditModel['error']>, status: number) => render(c, own, revision, { values: edits, error }, status);

    const applied = applyTextEdits(html, edits);
    if (!applied.ok) return fail({ kind: applied.error, index: applied.index }, 422);

    // 内容安全（contracts 16.1）：只查主人这次写进去的文字
    if (applied.changed.length > 0) {
      const verdict = await deps.contentSafety.checkTexts('page', applied.changed);
      if (!verdict.ok) return fail({ kind: 'content', message: verdict.message }, 400);
    }

    const outcome = await deps.ownerEdit.submit(own, revision, applied.html);
    switch (outcome.kind) {
      case 'stored':
        return c.redirect(`/w/${own.wall.id}/me?rev=${outcome.revisionId}&notice=text-edited#preview-heading`, 303);
      case 'rejected':
        return fail({ kind: 'rejected', report: outcome.report }, 422);
      case 'rate_limited':
        return fail({ kind: 'rate-limited' }, 429);
      case 'pending':
        return fail({ kind: 'pending' }, 202);
      case 'gone':
        return renderNotFound(c);
      default:
        return fail({ kind: 'failed' }, 500);
    }
  });
}
