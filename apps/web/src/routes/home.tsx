/**
 * “我的”（`GET /`，登录用户）：我加入的墙、每页发布状态、进入墙 / 工作区 / 后台的入口、“建一面墙”，
 * 以及已关闭、已退出、已移出的墙（只显示状态，没有链接）。
 */
import { loadSceneGuide } from '@nowme/skill';
import { SCENE_TYPES, type SceneType } from '@nowme/contracts';
import type { AppDeps, AppHono } from '../context.js';
import { authOf, requireUser } from '../security/session.js';
import { HomeView, type HomeEntryStatus, type HomeItem, type HomeNotice } from '../views/home.js';
import { renderPage } from '../views/layout.js';

/** 场景类型的中文名（读 skill/scenes/<type>.json 的 label，contracts 7）。 */
export function sceneLabels(): Record<SceneType, string> {
  return Object.fromEntries(SCENE_TYPES.map((type) => [type, loadSceneGuide(type).label])) as Record<SceneType, string>;
}

const NOTICES: ReadonlySet<string> = new Set<HomeNotice>(['wall-closed']);

export function registerHomeRoutes(app: AppHono, deps: AppDeps): void {
  const labels = sceneLabels();

  app.get('/', requireUser(deps), (c) => {
    const auth = authOf(c);
    const items: HomeItem[] = deps.repos.memberships.listAllForUser(auth.user.id).map(({ membership, wall, pageId }) => {
      const status: HomeEntryStatus = wall.status === 'closed' ? 'closed' : membership.status;
      return {
        wall,
        role: membership.role,
        sceneLabel: labels[wall.sceneType],
        status,
        pageState: status === 'active' && pageId ? deps.repos.publications.displayState(pageId) : null,
      };
    });
    const notice = c.req.query('notice');
    return renderPage(c, {
      title: 'NOWMe',
      body: (
        <HomeView
          nickname={auth.user.nickname ?? ''}
          items={items}
          notice={notice && NOTICES.has(notice) ? (notice as HomeNotice) : null}
        />
      ),
    });
  });
}
