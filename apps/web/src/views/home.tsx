/**
 * “我的”（`GET /`，产品文档第 8 节 1）：我加入的墙（角色、我的页面发布状态、进入墙 / 工作区 / 后台的入口）、
 * “建一面墙”，以及已关闭、已退出、已移出的墙（只显示状态，没有链接）。
 */
import type { FC } from 'hono/jsx';
import type { MembershipRole } from '../db/memberships.js';
import type { PageDisplayState } from '../db/publications.js';
import type { Wall } from '../db/walls.js';
import { Notice } from './forms.js';

/** 一面墙在“我的”里的状态：有效 / 我已退出 / 我被移出 / 墙已关闭。 */
export type HomeEntryStatus = 'active' | 'left' | 'removed' | 'closed';

export interface HomeItem {
  wall: Wall;
  role: MembershipRole;
  sceneLabel: string;
  status: HomeEntryStatus;
  /** 我的页面的发布状态（只对有效的墙）。 */
  pageState: PageDisplayState | null;
}

export type HomeNotice = 'wall-closed';

const NOTICE_TEXT: Record<HomeNotice, string> = {
  'wall-closed': '墙已关闭：所有人都看不到它了，成员的页面也都已下墙。',
};

export const PAGE_STATE_LABEL: Record<PageDisplayState, string> = {
  published: '已发布',
  withdrawn: '已撤下',
  unpublished: '未发布',
};

const ENDED_LABEL: Record<Exclude<HomeEntryStatus, 'active'>, { badge: string; text: string }> = {
  closed: { badge: '已关闭', text: '组织者已经关闭了这面墙。' },
  left: { badge: '已退出', text: '你已退出这面墙。想回来的话，再打开一次邀请链接即可。' },
  removed: { badge: '已移出', text: '你已不在这面墙里。' },
};

const ActiveItem: FC<{ item: HomeItem }> = ({ item }) => {
  const base = `/w/${item.wall.id}`;
  const published = item.pageState === 'published';
  return (
    <li class={`wall-tile scene--${item.wall.sceneType}`}>
      <div class="wall-tile__band">
        <span class="chip chip--on-band">{item.sceneLabel}</span>
        {item.role === 'organizer' ? <span class="badge badge--accent">组织者</span> : null}
      </div>
      <div class="wall-tile__body">
        <h2 class="wall-tile__name">
          <a href={base}>{item.wall.name}</a>
        </h2>
        {item.wall.description ? <p class="muted wall-list__desc">{item.wall.description}</p> : null}
        <p class="wall-list__state">
          <span class={`badge ${published ? 'badge--ok' : 'badge--muted'}`}>
            <span class="dot" aria-hidden="true"></span>我的页面：{PAGE_STATE_LABEL[item.pageState ?? 'unpublished']}
          </span>
        </p>
        <div class="actions">
          <a class="btn btn--primary" href={base}>
            进入墙
          </a>
          <a class="btn btn--ghost" href={`${base}/me`}>
            创作工作区
          </a>
          {item.role === 'organizer' ? (
            <a class="btn btn--ghost" href={`${base}/admin`}>
              组织者后台
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
};

const EndedItem: FC<{ item: HomeItem }> = ({ item }) => {
  const label = ENDED_LABEL[item.status === 'active' ? 'closed' : item.status];
  return (
    <li class="ended-list__item">
      <div class="ended-list__head">
        <h3>{item.wall.name}</h3>
        <span class="badge badge--muted">{label.badge}</span>
      </div>
      <p class="muted">{label.text}</p>
    </li>
  );
};

export const HomeView: FC<{ nickname: string; items: HomeItem[]; notice: HomeNotice | null }> = ({ nickname, items, notice }) => {
  const active = items.filter((item) => item.status === 'active');
  const ended = items.filter((item) => item.status !== 'active');
  return (
    <div class="container">
      <section class="hero home-hero">
        <div>
          <p class="eyebrow">我的</p>
          <h1 class="hero__title">你好，{nickname}</h1>
          <p class="hero__lead">这里是你加入的墙。每面墙上你都有一页属于自己的页面。</p>
        </div>
        <a class="btn btn--primary btn--lg" href="/walls/new">
          <span aria-hidden="true">+</span> 建一面墙
        </a>
      </section>
      {notice ? <Notice tone="success">{NOTICE_TEXT[notice]}</Notice> : null}
      {active.length === 0 ? (
        <section class="empty-state">
          <div class="empty-state__art" aria-hidden="true">
            <span class="sticker sticker--lime">你</span>
            <span class="sticker sticker--paper">？</span>
            <span class="sticker sticker--orange">墙</span>
          </div>
          <h2 class="display">还没有加入任何墙</h2>
          <p class="muted">拿到组织者的邀请链接或二维码，打开就能加入。你也可以自己建一面墙，把邀请发到群里。</p>
          <a class="btn btn--ghost" href="/walls/new">
            自己建一面墙
          </a>
        </section>
      ) : (
        <section aria-labelledby="walls-heading">
          <div class="section-head">
            <h2 id="walls-heading" class="section-title display">
              我加入的墙
            </h2>
            <span class="section-head__count">{active.length}</span>
          </div>
          <ul class="wall-list">
            {active.map((item) => (
              <ActiveItem item={item} />
            ))}
          </ul>
        </section>
      )}
      {ended.length > 0 ? (
        <section class="ended-list" aria-labelledby="ended-heading">
          <h2 id="ended-heading" class="section-title section-title--quiet">
            已结束的墙
          </h2>
          <ul class="ended-list__items">
            {ended.map((item) => (
              <EndedItem item={item} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};
