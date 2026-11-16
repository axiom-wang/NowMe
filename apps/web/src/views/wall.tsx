/**
 * 墙（W13，`GET /w/:wallId`）：名称、简介、组织者的话、“我的页面”入口、已发布成员的缩略卡网格。
 *
 * - 卡片的名字、一行介绍、接话点取自发布快照（主人确认过的 card）；
 * - 每次请求随机排序（services/wall-view.ts），不按热度；
 * - 封面是静态图片（墙上不运行页面），固定 3:4 画框 + `loading="lazy"`，手机上流畅浏览 100 张卡。
 */
import type { Child, FC } from 'hono/jsx';
import { COVER_CSS_HEIGHT, COVER_CSS_WIDTH } from '@nowme/contracts';
import type { PageDisplayState } from '../db/publications.js';
import type { WallCard, WallModel } from '../services/wall-view.js';
import { Notice } from './forms.js';
import { PAGE_STATE_LABEL } from './home.js';
import { AiBadge } from './ai-badge.js';
import { initialOf } from './layout.js';
import { answerKeys, CardAnswerTags, PortraitPanel, WallFilters } from './organizer-tools.js';

export type WallNotice = 'joined' | 'rejoined' | 'blocked';

/** 墙上至少有这么多张卡片才显示搜索框。 */
const WALL_SEARCH_MIN_CARDS = 4;

const NOTICE_TEXT: Record<WallNotice, string> = {
  joined: '加入成功。先逛逛墙上的人；想好了，再去做你自己的一页，不用着急。',
  rejoined: '欢迎回来。你原来的页面没有自动挂回墙上；想让大家再看到，需要你自己重新发布一下。',
  blocked: '已拉黑。你们互相看不到对方的页面，也不能再私信；TA 不会收到通知。想反悔的话，可以在“我的资料”里解除。',
};

const MY_PAGE_TEXT: Record<PageDisplayState, string> = {
  unpublished: '你的页面还没挂上墙，墙上的人暂时看不到你。和 AI 聊几句，就能做出来。',
  withdrawn: '你的页面已经从墙上撤下。想让大家再看到，随时可以重新发布。',
  published: '你的页面已经挂在墙上了，墙上的人都能看到。',
};

/** 卡片的检索文字（名字、一行介绍、全部接话点、必答题的回答），给墙上的搜索用。 */
function searchText(item: WallCard): string {
  return [item.card.displayName, item.card.tagline, ...item.card.hooks.map((hook) => hook.text), ...item.answers.flatMap((answer) => answer.choices.map((choice) => choice.label))]
    .join(' ')
    .toLowerCase();
}

/**
 * 墙上的一张“海报”：封面像被胶带贴在墙上，下面压着一张写着接话点的便签。
 * 便签只放第一个接话点的完整文字（不截成省略号），其余的写“还想聊 N 个话题”。
 */
const WallCardItem: FC<{ item: WallCard }> = ({ item }) => {
  const [first, ...rest] = item.card.hooks;
  return (
    <li class="wall-card" data-wall-card data-search={searchText(item)} data-answers={answerKeys(item.answers)}>
      <a class="wall-card__link" href={item.href}>
        <span class="wall-card__poster">
          <span class="wall-card__print">
            <span class="wall-card__cover">
              {item.coverSrc ? (
                <img src={item.coverSrc} alt="" width={String(COVER_CSS_WIDTH)} height={String(COVER_CSS_HEIGHT)} loading="lazy" decoding="async" />
              ) : (
                <span class="wall-card__placeholder" aria-hidden="true">
                  {initialOf(item.card.displayName)}
                </span>
              )}
            </span>
          </span>
          {item.own ? <span class="sticker sticker--orange wall-card__me">我</span> : null}
          {item.hasTalk ? <span class="wall-card__talk">✦ 有话题了</span> : item.introduced ? <span class="wall-card__talk wall-card__talk--intro">✦ AI 介绍</span> : null}
        </span>
        {first ? (
          <span class="wall-card__say">
            <span class="wall-card__say-label">想聊</span>
            <span class="wall-card__say-text">{first.text}</span>
          </span>
        ) : null}
        <span class="wall-card__body">
          <span class="wall-card__name">{item.card.displayName}</span>
          <AiBadge />
          {item.card.tagline ? <span class="wall-card__tagline">{item.card.tagline}</span> : null}
          <CardAnswerTags answers={item.answers} />
          {rest.length > 0 ? <span class="wall-card__more">还想聊 {rest.length} 个话题</span> : null}
        </span>
      </a>
    </li>
  );
};

/** 还没上墙时，墙上给自己留的空位。 */
const WallGhost: FC<{ href: string; withdrawn: boolean }> = ({ href, withdrawn }) => (
  <li class="wall-ghost">
    <a class="wall-ghost__link" href={href}>
      <span class="wall-ghost__plus" aria-hidden="true">
        +
      </span>
      <span class="wall-ghost__title">{withdrawn ? '把你的一页挂回来' : '这里留给你'}</span>
      <span class="wall-ghost__text">{withdrawn ? '你的页面已撤下，随时可以重新发布。' : '和 AI 聊几句，做一页自己，挂上来。'}</span>
    </a>
  </li>
);

/** 组织者的话：一张贴在墙上的便签（墙上有人时是墙面的第一格）。 */
export const OrganizerNote: FC<{ text: string }> = ({ text }) => (
  <blockquote class="note note--yellow organizer-note">
    <p class="organizer-note__label">组织者的话</p>
    <p class="organizer-note__text">{text}</p>
  </blockquote>
);

export const WallView: FC<{ model: WallModel; sceneLabel: string; notice: WallNotice | null; csrf: string; portraitShare: string | null; intros?: Child; ask?: Child }> = ({
  model,
  sceneLabel,
  notice,
  csrf,
  portraitShare,
  intros = null,
  ask = null,
}) => {
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
          <a class={`btn ${published ? 'btn--on-dark' : 'btn--accent'}`} href={`/w/${wall.id}/me`}>
            {published ? '去修改我的页面' : '去做我的页面'}
          </a>
          {myPage.href ? (
            <a class="btn btn--on-dark" href={myPage.href}>
              看看我的页面
            </a>
          ) : null}
          {model.questions.length > 0 ? (
            <a class="btn btn--on-dark" href={`/w/${wall.id}/questions`}>
              我的回答
            </a>
          ) : null}
        </div>
      </section>

      {intros}

      <PortraitPanel wall={wall} state={model.portrait} shareText={portraitShare} organizer={model.role === 'organizer'} csrf={csrf} />

      {ask}

      <section class="wall-members wall-board" aria-labelledby="members-heading" data-wall-board>
        <div class="section-head wall-board__head">
          <h2 id="members-heading" class="section-title display">
            墙上的人
          </h2>
          {cards.length > 0 ? (
            <>
              <span class="section-head__count" data-wall-count>
                {cards.length}
              </span>
              <span class="section-head__note" data-wall-count-note>
                位已上墙{model.memberCount > cards.length ? ` · 共 ${model.memberCount} 位成员` : ''} · 每次进来顺序都不一样
              </span>
            </>
          ) : null}
          {cards.length >= WALL_SEARCH_MIN_CARDS ? (
            <label class="wall-search">
              <span class="visually-hidden">在墙上找人</span>
              <input type="search" class="wall-search__input" placeholder="搜名字或话题，如：设计、后端" autocomplete="off" enterkeyhint="search" data-wall-search />
            </label>
          ) : null}
        </div>
        {cards.length > 0 ? <WallFilters questions={model.questions} /> : null}
        {cards.length > 0 ? (
          <ul class="wall-grid">
            {wall.organizerNote ? (
              <li class="wall-note">
                <OrganizerNote text={wall.organizerNote} />
              </li>
            ) : null}
            {!published ? <WallGhost href={`/w/${wall.id}/me`} withdrawn={myPage.state === 'withdrawn'} /> : null}
            {cards.map((item) => (
              <WallCardItem item={item} />
            ))}
          </ul>
        ) : null}
        {cards.length > 0 ? <p class="visually-hidden" role="status" data-wall-status></p> : null}
        {cards.length > 0 ? (
          <p class="wall-board__none" hidden data-wall-none>
            没有找到符合条件的人。可以调整搜索或筛选条件，或者去全员群里问一句。
          </p>
        ) : (
          <div class="empty-state">
            {wall.organizerNote ? <OrganizerNote text={wall.organizerNote} /> : null}
            <div class="empty-state__art" aria-hidden="true">
              <span class="sticker sticker--paper">空</span>
              <span class="sticker sticker--lime">墙</span>
            </div>
            <h3 class="display">墙上还没有人</h3>
            <p class="muted">
              {model.role === 'organizer'
                ? '还没有成员把页面挂上来。你可以先做好自己的一页，再把邀请链接发给圈子里的人。'
                : '还没有人把页面挂上来。你可以做第一个：和 AI 聊几句，就能做出自己的一页。'}
            </p>
            <p class="actions empty-state__actions">
              <a class="btn btn--accent" href={`/w/${wall.id}/me`}>
                {myPage.state === 'withdrawn' ? '把我的页面挂回来' : '去做我的页面'}
              </a>
              {model.role === 'organizer' ? (
                <a class="btn btn--ghost" href={`/w/${wall.id}/admin`}>
                  去拿邀请链接
                </a>
              ) : (
                <a class="btn btn--ghost" href={`/messages/wall/${wall.id}`}>
                  去全员群打个招呼
                </a>
              )}
            </p>
          </div>
        )}
      </section>
    </div>
  );
};
