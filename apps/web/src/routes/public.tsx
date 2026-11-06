/**
 * 公开链接（T3.2，contracts 4.2、W15、S6）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /s/:publicToken | 任何人：只显示当前发布版本的页面（PageFrame）与名字 / 一行介绍，不显示联系方式与“想聊这个” |
 *
 * 令牌格式不对、不存在（关闭或轮换后旧令牌）、墙关闭、成员关系无效、页面未发布或已撤下、版本已删除 → 404
 * （与其他“找不到”完全相同）。全部响应带 `X-Robots-Tag: noindex`；页面 `<head>` 里有 `<meta name="robots" content="noindex">`。
 * 票据只在以上检查全部通过后为当前发布版本签发。
 */
import { isTokenFormat } from '@nowme/contracts';
import type { AppDeps, AppHono } from '../context.js';
import { parsePublishedCard } from '../db/publications.js';
import { isRevisionUsable } from '../services/page-lifecycle.js';
import { renderNotFound } from '../views/errors.js';
import { PublicPageDocument, type PublicPageProps } from '../views/public.js';

/** 公开链接对应的展示内容；任何一项检查不通过都返回 null。 */
export function resolvePublicPage(deps: Pick<AppDeps, 'repos' | 'tickets'>, publicToken: string): PublicPageProps | null {
  if (!isTokenFormat(publicToken, 'publicLink')) return null;
  const { repos } = deps;
  const page = repos.pages.findByPublicToken(publicToken);
  if (!page || page.publicToken !== publicToken) return null;
  const wall = repos.walls.findById(page.wallId);
  if (!wall || wall.status !== 'open') return null;
  const membership = repos.memberships.findById(page.membershipId);
  if (!membership || membership.status !== 'active' || membership.userId !== page.ownerId || membership.wallId !== wall.id) return null;
  const publication = repos.publications.findActiveForPage(page.id);
  if (!publication) return null;
  const revision = repos.revisions.findById(publication.revisionId);
  if (!revision || revision.pageId !== page.id || !isRevisionUsable(revision)) return null;
  const card = parsePublishedCard(publication.cardJson);
  if (!card) return null;
  // 授权检查全部通过：为当前发布版本签发票据
  return { displayName: card.displayName, tagline: card.tagline, ticket: deps.tickets.issue(revision.id) };
}

export function registerPublicRoutes(app: AppHono, deps: AppDeps): void {
  app.get('/s/:publicToken', (c) => {
    c.header('X-Robots-Tag', 'noindex');
    const view = resolvePublicPage(deps, c.req.param('publicToken'));
    if (!view) return renderNotFound(c);
    return c.html(<PublicPageDocument {...view} />);
  });
}
