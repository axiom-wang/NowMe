/** “我的”（`GET /`）：我加入的墙、每页发布状态、入口。T2.1 的最简版本，T3.1 重做。 */
import type { FC } from 'hono/jsx';
import type { PageDisplayState } from '../db/publications.js';
import type { Wall } from '../db/walls.js';

export interface HomeItem {
  wall: Wall;
  role: 'organizer' | 'member';
  sceneLabel: string;
  pageState: PageDisplayState | null;
  workspacePath: string | null;
}

const STATE_LABEL: Record<PageDisplayState, string> = {
  published: '已发布',
  withdrawn: '已撤下',
  unpublished: '未发布',
};

export const HomeView: FC<{ nickname: string; items: HomeItem[] }> = ({ nickname, items }) => (
  <>
    <section class="page-intro">
      <h1>你好，{nickname}</h1>
      <p class="muted">这里是你加入的墙。每面墙上你有一页属于自己的页面。</p>
    </section>
    {items.length === 0 ? (
      <section class="card">
        <h2>还没有加入任何墙</h2>
        <p class="muted">拿到组织者的邀请链接后打开它就能加入。</p>
      </section>
    ) : (
      <ul class="wall-list">
        {items.map((item) => (
          <li class="card wall-list__item">
            <div class="wall-list__head">
              <h2>{item.wall.name}</h2>
              <span class="badge badge--muted">{item.sceneLabel}</span>
              {item.role === 'organizer' ? <span class="badge badge--muted">组织者</span> : null}
            </div>
            {item.wall.description ? <p class="muted">{item.wall.description}</p> : null}
            <div class="wall-list__foot">
              {item.pageState ? (
                <span class={`badge ${item.pageState === 'published' ? 'badge--ok' : 'badge--muted'}`}>
                  我的页面：{STATE_LABEL[item.pageState]}
                </span>
              ) : null}
              {item.workspacePath ? (
                <a class="btn btn--primary" href={item.workspacePath}>
                  创作工作区
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    )}
  </>
);
