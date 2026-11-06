/**
 * “我的”（`GET /`，登录用户）：我加入的墙、每页发布状态、入口。
 * T2.1 只做最简列表；T3.1 重做（建墙入口、墙页链接、加入的墙与组织的墙分开显示等）。
 */
import { loadSceneGuide } from '@nowme/skill';
import { SCENE_TYPES, type SceneType } from '@nowme/contracts';
import type { AppDeps, AppHono } from '../context.js';
import { authOf, requireUser } from '../security/session.js';
import { workspacePath } from '../services/agent.js';
import { HomeView, type HomeItem } from '../views/home.js';
import { renderPage } from '../views/layout.js';

/** 场景类型的中文名（读 skill/scenes/<type>.json 的 label，contracts 7）。 */
export function sceneLabels(): Record<SceneType, string> {
  return Object.fromEntries(SCENE_TYPES.map((type) => [type, loadSceneGuide(type).label])) as Record<SceneType, string>;
}

export function registerHomeRoutes(app: AppHono, deps: AppDeps): void {
  const labels = sceneLabels();

  app.get('/', requireUser(deps), (c) => {
    const auth = authOf(c);
    const items: HomeItem[] = deps.repos.memberships.listActiveForUser(auth.user.id).map(({ membership, wall, pageId }) => ({
      wall,
      role: membership.role,
      sceneLabel: labels[wall.sceneType],
      pageState: pageId ? deps.repos.publications.displayState(pageId) : null,
      workspacePath: pageId ? workspacePath(wall.id) : null,
    }));
    return renderPage(c, { title: 'NOWMe', body: <HomeView nickname={auth.user.nickname ?? ''} items={items} /> });
  });
}
