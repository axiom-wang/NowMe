/**
 * 墙（W13，`GET /w/:wallId`）：名称、简介、组织者的话、“我的页面”入口、已发布成员的缩略卡网格。
 *
 * - 卡片的名字、一行介绍、接话点取自发布快照（主人确认过的 card）；
 * - 每次请求随机排序（services/wall-view.ts），不按热度；
 * - 封面是静态图片（墙上不运行页面），固定 3:4 画框 + `loading="lazy"`，手机上流畅浏览 100 张卡。
 */
import type { FC } from 'hono/jsx';
import { COVER_CSS_HEIGHT, COVER_CSS_WIDTH } from '@nowme/contracts';
import type { PageDisplayState } from '../db/publications.js';
import type { WallCard, WallModel } from '../services/wall-view.js';
import { Notice } from './forms.js';
import { PAGE_STATE_LABEL } from './home.js';
import { initialOf } from './layout.js';

export type WallNotice = 'joined' | 'rejoined';

const NOTICE_TEXT: Record<WallNotice, string> = {
  joined: '欢迎加入！先逛逛墙上的人；准备好了，再去创作工作区做你自己的一页。',
  rejoined: '欢迎回来！你原来的页面没有自动回到墙上，需要时在创作工作区重新发布。',
};

const MY_PAGE_TEXT: Record<PageDisplayState, string> = {
  unpublished: '你的页面还没发布，墙上的人还看不到你。到创作工作区复制指令给你的 Agent，就能开始做。',
  withdrawn: '你的页面已从墙上撤下。需要时可以在创作工作区重新发布。',
  published: '你的页面已经挂在墙上了。',
};

const WallCardItem: FC<{ item: WallCard }> = ({ item }) => (
  <li class="wall-card">
    <a class="wall-card__link" href={item.href}>
      <span class="wall-card__cover">
        {item.coverSrc ? (
          <img src={item.coverSrc} alt="" width={String(COVER_CSS_WIDTH)} height={String(COVER_CSS_HEIGHT)} loading="lazy" decoding="async" />
        ) : (
          <span class="wall-card__placeholder" aria-hidden="true">
            {initialOf(item.card.displayName)}
          </span>
        )}
        {item.own ? <span class="sticker sticker--orange wall-card__me">我</span> : null}
      </span>
      <span class="wall-card__body">
        <span class="wall-card__name">{item.card.displayName}</span>
        {item.card.tagline ? <span class="wall-card__tagline">{item.card.tagline}</span> : null}
        {item.card.hooks.length > 0 ? (
          <span class="wall-card__hooks">
            {item.card.hooks.map((hook) => (
              <span class="wall-card__hook">{hook.text}</span>
            ))}
          </span>
        ) : null}
      </span>
    </a>
  </li>
);

/** 组织者的话：一张贴在墙上的便签。 */
export const OrganizerNote: FC<{ text: string }> = ({ text }) => (
  <blockquote class="organizer-note">
    <p class="organizer-note__label">组织者的话</p>
    <p class="organizer-note__text">{text}</p>
  </blockquote>
);

export const WallView: FC<{ model: WallModel; sceneLabel: string; notice: WallNotice | null }> = ({ model, sceneLabel, notice }) => {
  const { wall, myPage, cards } = model;
  const published = myPage.state === 'published';
  return (
    <div class="container container--wide">
      <section class={`wall-head scene--${wall.sceneType}`}>
        <div class="wall-head__main">
          <p class="wall-head__meta">
            <span class="chip">{sceneLabel}</span>
            <a class="btn btn--accent btn--small" href={`/messages/wall/${wall.id}`}>全员群聊</a>
            {model.role === 'organizer' ? (
              <a class="btn btn--ghost btn--small wall-head__admin" href={`/w/${wall.id}/admin`}>
                组织者后台 <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </p>
          <h1 class="hero__title">{wall.name}</h1>
          {wall.description ? <p class="wall-head__desc">{wall.description}</p> : null}
        </div>
        {wall.organizerNote ? <OrganizerNote text={wall.organizerNote} /> : null}
      </section>

      {notice ? <Notice tone="success">{NOTICE_TEXT[notice]}</Notice> : null}

      <section class={`my-page${published ? ' my-page--published' : ''}`} aria-labelledby="my-page-heading">
        <div class="my-page__info">
          <div class="my-page__head">
            <h2 id="my-page-heading">我的页面</h2>
            <span class={`badge ${published ? 'badge--live' : 'badge--muted'}`}>
              <span class="dot" aria-hidden="true"></span>
              {PAGE_STATE_LABEL[myPage.state]}
            </span>
          </div>
          <p class="my-page__text">{MY_PAGE_TEXT[myPage.state]}</p>
        </div>
        <div class="actions my-page__actions">
          <a class="btn btn--accent" href={`/w/${wall.id}/me`}>
            {published ? '去工作区更新' : '去创作工作区'}
          </a>
          {myPage.href ? (
            <a class="btn btn--on-dark" href={myPage.href}>
              看看我的页面
            </a>
          ) : null}
        </div>
      </section>

      <section class="wall-members" aria-labelledby="members-heading">
        <div class="section-head">
          <h2 id="members-heading" class="section-title display">
            墙上的人
          </h2>
          {cards.length > 0 ? (
            <>
              <span class="section-head__count">{cards.length}</span>
              <span class="section-head__note">位已发布 · 每次进入随机排序</span>
            </>
          ) : null}
        </div>
        {cards.length > 0 ? (
          <ul class="wall-grid">
            {cards.map((item) => (
              <WallCardItem item={item} />
            ))}
          </ul>
        ) : (
          <div class="empty-state">
            <div class="empty-state__art" aria-hidden="true">
              <span class="sticker sticker--paper">空</span>
              <span class="sticker sticker--lime">墙</span>
            </div>
            <h3 class="display">墙上还没有人</h3>
            <p class="muted">还没有成员发布页面。做好你的一页，第一个挂上墙吧！</p>
          </div>
        )}
      </section>
    </div>
  );
};
