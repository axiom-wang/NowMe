/** 登录后的创作工作台。仅有效成员的墙进入统计和待完成 / 已发布分组。 */
import type { FC } from 'hono/jsx';
import type { MembershipRole } from '../db/memberships.js';
import type { PageDisplayState } from '../db/publications.js';
import type { Wall } from '../db/walls.js';
import { Notice } from './forms.js';
import { HomeIcon, HomeSpark } from './home-icons.js';

export type HomeEntryStatus = 'active' | 'left' | 'removed' | 'closed';
export type HomeFilter = 'all' | 'pending' | 'published';
export interface HomeItem {
  wall: Wall;
  role: MembershipRole;
  sceneLabel: string;
  status: HomeEntryStatus;
  pageId: string | null;
  pageState: PageDisplayState | null;
  coverUrl: string | null;
}
export type HomeNotice = 'wall-closed';
const NOTICE_TEXT: Record<HomeNotice, string> = {
  'wall-closed': '墙已关闭：所有人都看不到它了，成员的页面也都已下墙。',
};
export const PAGE_STATE_LABEL: Record<PageDisplayState, string> = {
  published: '已发布', withdrawn: '已撤下', unpublished: '未发布',
};
const ENDED_LABEL = {
  closed: { badge: '已关闭', text: '组织者已经关闭了这面墙。' },
  left: { badge: '已退出', text: '你已退出这面墙。想回来的话，再打开一次邀请链接即可。' },
  removed: { badge: '已移出', text: '你已不在这面墙里。' },
};

/** 无自定义封面时，按场景和主题提供默认插画。 */
export function defaultWallCover(wall: Wall): string {
  const theme = `${wall.name} ${wall.description}`;
  if (/徒步|山野|登山|户外/.test(theme)) return 'mountain';
  if (wall.sceneType === 'club') return 'camera';
  if (wall.sceneType === 'hackathon') return /演示/.test(wall.name) ? 'bolt' : 'laptop';
  if (/城市|漫游|街|建筑/.test(theme)) return 'city';
  if (wall.sceneType === 'interest') return 'vinyl';
  return 'bolt';
}

const ActiveItem: FC<{ item: HomeItem }> = ({ item }) => {
  const base = `/w/${item.wall.id}`;
  const published = item.pageState === 'published';
  return (
    <li class={`wall-tile home-wall home-wall--${item.wall.sceneType}`}>
      <a class="home-wall__cover" href={base} tabindex={-1} aria-hidden="true">
        <img src={item.coverUrl ?? `/static/home-wall-${defaultWallCover(item.wall)}.svg`} alt="" width="180" height="180" />
      </a>
      <div class="home-wall__copy">
        <div class="home-wall__labels">
          <span class="home-wall__scene">{item.sceneLabel}</span>
          {item.role === 'organizer' ? <a class="home-wall__admin" href={`${base}/admin`}>组织者后台</a> : null}
        </div>
        <h3 class="home-wall__name"><a href={base}>{item.wall.name}</a></h3>
        {item.wall.description ? <p class="home-wall__description">{item.wall.description}</p> : null}
        <span class="visually-hidden">我的页面：{PAGE_STATE_LABEL[item.pageState ?? 'unpublished']}</span>
        {item.pageState === 'withdrawn' ? <span class="home-wall__withdrawn">已撤下，可继续创作后重新发布</span> : null}
      </div>
      <div class="home-wall__actions">
        {published ? (
          <>
            <a class="home-button home-button--dark" href={base}><HomeIcon name="enter" />进入墙</a>
            <a class="home-button home-button--outline" href={item.pageId ? `${base}/p/${item.pageId}` : `${base}/me`}><HomeIcon name="eye" />查看我的页面</a>
          </>
        ) : (
          <>
            <a class="home-button home-button--lime" href={`${base}/me`}><HomeIcon name="pencil" />继续创作</a>
            <a class="home-button home-button--outline" href={base}><HomeIcon name="enter" />进入墙</a>
          </>
        )}
      </div>
    </li>
  );
};

const WallGroup: FC<{ published: boolean; items: HomeItem[] }> = ({ published, items }) => (
  <section class={`home-group home-group--${published ? 'published' : 'pending'}`} aria-labelledby={published ? 'published-heading' : 'pending-heading'}>
    <div class="home-group__heading">
      <HomeIcon name={published ? 'check' : 'pending'} />
      <div>
        <h3 id={published ? 'published-heading' : 'pending-heading'}>{published ? '已发布的页面' : '待完成的页面'} <span class="home-group__count">{items.length}</span></h3>
        <p>{published ? '你的页面已发布，随时可以回访或更新内容。' : '这些墙上你的页面还未发布，继续创作吧！'}</p>
      </div>
    </div>
    {items.length ? <ul class="home-group__list">{items.map((item) => <ActiveItem item={item} />)}</ul> : (
      <div class="home-group__empty">
        <HomeIcon name={published ? 'layers' : 'check'} />
        <h4>{published ? '让你的第一张页面上墙' : '每一页，都已被看见'}</h4>
        <p>{published ? '完成创作并确认发布，就能在这里找到它。' : '所有页面都已发布，去墙上认识新朋友吧。'}</p>
      </div>
    )}
  </section>
);

export const HomeView: FC<{ nickname: string; items: HomeItem[]; notice: HomeNotice | null; filter?: HomeFilter }> = ({ nickname, items, notice, filter = 'all' }) => {
  const active = items.filter((item) => item.status === 'active');
  const ended = items.filter((item) => item.status !== 'active');
  const pending = active.filter((item) => item.pageState !== 'published');
  const published = active.filter((item) => item.pageState === 'published');
  return (
    <div class="home-dashboard">
      <section class="home-overview" aria-labelledby="home-heading">
        <div class="home-welcome">
          <p class="home-eyebrow"><span aria-hidden="true">❖</span> 我的创作工作台</p>
          <h1 id="home-heading">继续创作，让更多人<span class="home-underline">认识你。<svg viewBox="0 0 180 15" preserveAspectRatio="none" aria-hidden="true"><path d="M2 10 Q80 -1 177 7 M42 13 Q99 5 172 11" /></svg></span></h1>
          <HomeSpark />
          <p class="home-welcome__lead">你好，{nickname}！<br />在 NOWMe，为自己创作一页内容，并在不同的墙上与同好相遇。</p>
        </div>
        <dl class="home-stats" aria-label="我的创作统计">
          {([{ icon: 'layers', count: active.length, label: '加入的墙' }, { icon: 'check', count: published.length, label: '已发布' }, { icon: 'pending', count: pending.length, label: '待完成' }] as const).map((stat) => (
            <div class="home-stat"><dt><HomeIcon name={stat.icon} />{stat.label}</dt><dd>{stat.count}</dd></div>
          ))}
        </dl>
        <aside class="home-reminder">
          <span class="home-reminder__icon"><HomeIcon name={pending.length ? 'pencil' : 'check'} /></span>
          <div class="home-reminder__copy"><h2>{pending.length ? `你还有 ${pending.length} 个页面未发布` : active.length ? '你的页面，都已闪亮上墙' : '从一面墙，开启新的相遇'}</h2><p>{pending.length ? '继续完善个人页面，让其他成员认识你。' : active.length ? '去看看圈子里的新朋友，也让灵感继续生长。' : '和你的 Agent 一起，做一页有个性的自己。'}</p></div>
          <a class="home-button home-button--dark" href={pending[0] ? `/w/${pending[0].wall.id}/me` : active[0] ? `/w/${active[0].wall.id}` : '/walls/new'}>{pending.length ? '继续创作' : active.length ? '去看看墙' : '建一面墙'}<HomeIcon name="arrow" /></a>
          <HomeSpark />
        </aside>
      </section>
      {notice ? <Notice tone="success">{NOTICE_TEXT[notice]}</Notice> : null}
      <section class="home-walls" aria-labelledby="walls-heading">
        <div class="home-toolbar">
          <div class="home-toolbar__main"><h2 id="walls-heading">我加入的墙 <span class="home-total" aria-label={`${active.length} 面墙`}>{active.length}</span></h2>
            <nav class="home-filters" aria-label="按页面状态筛选">
              {([{ value: 'all', label: '全部', count: active.length }, { value: 'pending', label: '待完成', count: pending.length }, { value: 'published', label: '已发布', count: published.length }] as const).map((tab) => (
                <a href={tab.value === 'all' ? '/' : `/?filter=${tab.value}`} class={`home-filter${filter === tab.value ? ' is-active' : ''}`} aria-current={filter === tab.value ? 'page' : undefined}>{tab.label} <span>{tab.count}</span></a>
              ))}
            </nav>
          </div>
          <a class="home-button home-button--outline home-create" href="/walls/new"><HomeIcon name="plus" />建一面墙</a>
        </div>
        {active.length === 0 ? (
          <div class="empty-state home-empty"><div class="empty-state__art" aria-hidden="true"><span class="sticker sticker--lime">你</span><span class="sticker sticker--paper">？</span><span class="sticker sticker--orange">墙</span></div><h3>还没有加入任何墙</h3><p class="muted">拿到组织者的邀请链接或二维码，打开就能加入。你也可以自己建一面墙，把邀请发到群里。</p><a class="home-button home-button--lime" href="/walls/new">自己建一面墙<HomeIcon name="arrow" /></a></div>
        ) : (
          <div class={`home-groups${filter !== 'all' ? ' home-groups--single' : ''}`}>
            {filter !== 'published' ? <WallGroup published={false} items={pending} /> : null}
            {filter !== 'pending' ? <WallGroup published={true} items={published} /> : null}
          </div>
        )}
      </section>
      {ended.length ? <section class="ended-list" aria-labelledby="ended-heading"><h2 id="ended-heading" class="section-title section-title--quiet">已结束的墙</h2><ul class="ended-list__items">{ended.map((item) => {
        const label = ENDED_LABEL[item.status === 'active' ? 'closed' : item.status];
        return <li class="ended-list__item"><div class="ended-list__head"><h3>{item.wall.name}</h3><span class="badge badge--muted">{label.badge}</span></div><p class="muted">{label.text}</p></li>;
      })}</ul></section> : null}
    </div>
  );
};
