/**
 * 墙（W13，`GET /w/:wallId`）：名称、简介、组织者的话、“我的页面”入口、已发布成员的缩略卡网格。
 *
 * - 卡片的名字、一行介绍、接话点取自发布快照（主人确认过的 card）；
 * - 每次请求随机排序（services/wall-view.ts），不按热度；
 * - 封面是静态图片（墙上不运行页面），固定 3:4 画框 + `loading="lazy"`，手机上流畅浏览 100 张卡。
 *
 * 逛墙空间（static/wall.js）：有脚本时默认把网格变成一面可以拖动、缩放的墙，点海报在旁边展开介绍和接话点。
 * 服务端照旧输出完整网格；每张卡片附一份 `<template>` 详情（同一份发布快照里的内容），空间模式只在浏览器里
 * 重新排布这些已有内容，不发请求、不运行页面。没有脚本时就是原来的网格（逛墙空间没有“列表”切换）。
 */
import type { Child, FC } from 'hono/jsx';
import { COVER_CSS_HEIGHT, COVER_CSS_WIDTH } from '@nowme/contracts';
import type { WallCard, WallModel } from '../services/wall-view.js';
import { CsrfField, Notice } from './forms.js';
import { PAGE_STATE_LABEL } from './home.js';
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

/** 卡片的检索文字（名字、一行介绍、全部接话点、必答题的回答），给墙上的搜索用。 */
function searchText(item: WallCard): string {
  return [item.card.displayName, item.card.tagline, ...item.card.hooks.map((hook) => hook.text), ...item.answers.flatMap((answer) => answer.choices.map((choice) => choice.label))]
    .join(' ')
    .toLowerCase();
}

/**
 * 墙上的一张“海报”：封面像被胶带贴在墙上，下面压着一张写着接话点的便签。
 * 便签展示第一个接话点，其余话题在成员页查看。
 */
const WallCardItem: FC<{ item: WallCard }> = ({ item }) => {
  const [first] = item.card.hooks;
  return (
    <li class="wall-card" data-wall-card data-page-id={item.pageId} data-own={item.own ? '1' : undefined} data-search={searchText(item)} data-answers={answerKeys(item.answers)}>
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
          {item.card.tagline ? <span class="wall-card__tagline">{item.card.tagline}</span> : null}
          <CardAnswerTags answers={item.answers} />
        </span>
        <span class="wall-card__tag">
          {item.card.displayName}
        </span>
      </a>
      <CardDetail item={item} />
    </li>
  );
};

/**
 * 逛墙空间里点开海报时展示的详情（名字、一行介绍、回答、全部接话点）。放在 `<template>` 里，
 * 浏览器不渲染、读屏不读，脚本按需复制到详情面板；内容与成员页一样来自发布快照，经过转义。
 */
const CardDetail: FC<{ item: WallCard }> = ({ item }) => (
  <template data-card-detail>
    <h2 class="space-detail__name" tabindex={-1}>
      {item.card.displayName}
    </h2>
    {item.card.tagline ? <p class="space-detail__tagline">{item.card.tagline}</p> : null}
    <CardAnswerTags answers={item.answers} />
    {item.card.hooks.length > 0 ? (
      <div class="space-detail__talk">
        <p class="space-detail__label">{item.own ? '我的接话点' : '可以从这里聊起'}</p>
        <ul class="space-detail__hooks">
          {item.card.hooks.map((hook) => (
            <li>
              {item.own ? (
                <p class="space-detail__hook">{hook.text}</p>
              ) : (
                <button type="button" class="space-detail__hook" aria-pressed="false" data-hook-id={hook.id}>
                  {hook.text}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    ) : (
      <p class="space-detail__none">{item.own ? '你的页面还没有留话题。' : 'TA 还没有留话题，可以先看看 TA 的页面。'}</p>
    )}
  </template>
);

/** 详情底部“还想认识更多人？”里的一张入口卡：图标、名字、一句说明。说明只是补充，不算进链接名字。 */
const AssistCard: FC<{ href: string; title: string; note: string; mobileOnly?: boolean; children: Child }> = ({ href, title, note, mobileOnly = false, children }) => (
  <li class={`space-assist-card${mobileOnly ? ' space-assist-card--mobile' : ''}`}>
    <a class="space-assist-card__link" href={href}>
      <span class="space-assist-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          {children}
        </svg>
      </span>
      <span class="space-assist-card__title">{title}</span>
      <span class="space-assist-card__note" aria-hidden="true">
        {note}
      </span>
    </a>
  </li>
);

/**
 * 逛墙空间里这个人的详情：桌面上是墙右侧一直开着的一栏（默认是第一位成员），手机上是点海报后从底部升起的资料卡。
 * 内容：封面（只在桌面）、名字、一句话介绍、回答、接话点、“想聊这个”、成员页入口；有 AI 找人 / 问墙时最下面一行入口。
 */
const SpacePanel: FC<{ csrf: string; intros: boolean; ask: boolean; portrait: boolean }> = ({ csrf, intros, ask, portrait }) => (
  <aside class="wall-space__panel" aria-label="海报详情" hidden data-space-panel>
    <div class="space-panel__card" hidden data-space-card>
      {/* 手机：按住这一条往下拖，收起资料卡 */}
      <span class="space-panel__grip" aria-hidden="true" data-space-grip></span>
      <button type="button" class="space-panel__close" aria-label="收起详情" data-space-close>
        <span aria-hidden="true">×</span>
      </button>
      <div class="space-panel__cover" aria-hidden="true" data-space-cover></div>
      <div class="space-panel__detail" data-space-detail></div>
      <div class="space-panel__actions">
        <form method="post" class="space-panel__chat" hidden data-space-chat>
          <CsrfField token={csrf} />
          <input type="hidden" name="hookId" value="" data-space-hook />
          <button type="submit" class="btn btn--primary space-panel__chat-button">
            <svg class="space-panel__chat-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 12a8 7 0 1 1 3.6 5.9L4 19.5l1.1-3.4A6.7 6.7 0 0 1 4 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              <circle cx="8.5" cy="12" r="1.1" fill="currentColor" />
              <circle cx="12" cy="12" r="1.1" fill="currentColor" />
              <circle cx="15.5" cy="12" r="1.1" fill="currentColor" />
            </svg>
            想聊这个
          </button>
        </form>
        <a class="space-panel__open" href="#" data-space-open>
          <span data-space-open-label>看看 TA 的页面</span>
        </a>
      </div>
      {intros || ask || portrait ? (
        <section class={`space-panel__assist${intros || ask ? '' : ' space-panel__assist--portrait'}`} aria-labelledby="space-assist-heading" data-space-assist>
          <h3 id="space-assist-heading" class="space-panel__assist-title">还想认识更多人？</h3>
          <ul class="space-panel__assist-list">
            {intros ? (
              <AssistCard href="#intros" title="AI 帮我找人" note="按你的资料推荐，说明理由">
                <path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                <path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" fill="currentColor" />
              </AssistCard>
            ) : null}
            {ask ? (
              <AssistCard href="#ask" title="问问这面墙" note="一句话描述想找的人">
                <path d="M4 11.5a8 7 0 1 1 3.6 5.9L4 19l1.1-3.4A6.7 6.7 0 0 1 4 11.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                <path d="M10 9.2a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                <circle cx="12" cy="14.6" r="1" fill="currentColor" />
              </AssistCard>
            ) : null}
            {/* 手机上标题行放不下“墙的群像”，入口在这里（桌面上在标题行） */}
            {portrait ? (
              <AssistCard href="#portrait" title="墙的群像" note="AI 归纳这面墙上都是谁" mobileOnly>
                <circle cx="9" cy="8.5" r="3" fill="none" stroke="currentColor" stroke-width="1.8" />
                <path d="M3.5 19a5.5 5.5 0 0 1 11 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                <path d="M15.5 6a3 3 0 0 1 0 5.6M17 14.2a5.5 5.5 0 0 1 3.5 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </AssistCard>
            ) : null}
          </ul>
        </section>
      ) : null}
    </div>
  </aside>
);

/** 逛墙空间的操作条：探索进度（只存在本机）、左右翻动、缩放；手机上是操作提示和“回到全墙”。 */
const SpaceHud: FC<{ total: number }> = ({ total }) => (
  <div class="wall-space__hud" hidden data-space-hud>
    <p class="space-hud__explored">
      <svg class="space-hud__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 5.5l-.9 4a2.6 2.6 0 0 1-4.6 1L14 16h-4l-1.4 1.5a2.6 2.6 0 0 1-4.6-1l-.9-4A4.5 4.5 0 0 1 7.5 7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        <path d="M8 10v3M6.5 11.5h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        <circle cx="15.5" cy="10.5" r="1" fill="currentColor" />
        <circle cx="17" cy="12.6" r="1" fill="currentColor" />
      </svg>
      <span class="space-hud__explored-label">已探索</span> <strong data-space-explored>0</strong> / <span data-space-total>{total}</span>
      <span class="space-hud__meter" aria-hidden="true">
        <span class="space-hud__meter-fill" data-space-meter></span>
      </span>
    </p>
    <div class="space-hud__nav">
      <button type="button" class="space-hud__button" aria-label="往前看" data-space-step="-1">
        <span aria-hidden="true">←</span>
      </button>
      <span class="space-hud__hint">左右拖动逛墙 · 点击认识 TA</span>
      <button type="button" class="space-hud__button" aria-label="往后看" data-space-step="1">
        <span aria-hidden="true">→</span>
      </button>
    </div>
    <p class="space-hud__tip">
      <svg class="space-hud__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0-1.5a1.5 1.5 0 0 1 3 0V10m0-.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.8-2.4l-2.4-3.2a1.5 1.5 0 0 1 2.4-1.8L9 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      拖动逛墙 · 双指缩放
    </p>
    <button type="button" class="space-hud__overview" data-space-overview>
      <svg class="space-hud__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <rect x="9" y="9" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2" />
      </svg>
      回到全墙
    </button>
    <div class="space-hud__zoom">
      <button type="button" class="space-hud__button" aria-label="缩小" data-space-zoom="-1">
        <span aria-hidden="true">−</span>
      </button>
      <button type="button" class="space-hud__button" aria-label="放大" data-space-zoom="1">
        <span aria-hidden="true">+</span>
      </button>
    </div>
  </div>
);

/** 手机上把搜索收成一个图标，点开再展开输入框。 */
const SearchToggle: FC = () => (
  <button type="button" class="wall-search-toggle" aria-expanded="false" aria-label="搜索墙上的人" hidden data-space-search-toggle>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.4" />
      <path d="m20 20-3.6-3.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
    </svg>
  </button>
);

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
  // 墙的群像：有结果时成员都能看；组织者在还没生成时也能看到入口
  const showPortrait = model.portrait.kind === 'ready' || model.role === 'organizer';
  return (
    <div class="container container--wide">
      {notice ? <Notice tone="success">{NOTICE_TEXT[notice]}</Notice> : null}
      <section class={`wall-members wall-board${cards.length > 0 ? ' wall-board--people' : ''}`} aria-labelledby="wall-title" data-wall-board data-wall-id={wall.id}>
        {/* 一行：墙名 | 人数，右边是搜索、全员群聊（组织者另有后台入口） */}
        <div class="wall-board__head">
          <div class="wall-board__heading">
            <h1 id="wall-title" class="wall-board__title">{wall.name}</h1>
            {cards.length > 0 ? (
              <p class="wall-board__population">
                <span class="section-head__count" data-wall-count>{cards.length}</span>
                <span class="section-head__note" data-wall-count-note>位已上墙</span>
                {model.memberCount > cards.length ? (
                  <span class="wall-board__meta" data-wall-summary>
                    共 {model.memberCount} 位成员
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          <div class="wall-board__tools">
            {intros ? <a class="wall-board__assist-link" href="#intros">AI 帮我找人</a> : null}
            {ask ? <a class="wall-board__assist-link" href="#ask">问问这面墙</a> : null}
            {cards.length >= WALL_SEARCH_MIN_CARDS ? (
              <label class="wall-search">
                <span class="visually-hidden">在墙上找人</span>
                <input type="search" class="wall-search__input" placeholder="搜名字或话题" autocomplete="off" enterkeyhint="search" data-wall-search />
              </label>
            ) : null}
            {cards.length >= WALL_SEARCH_MIN_CARDS ? <SearchToggle /> : null}
            {showPortrait && cards.length > 0 ? (
              <a class="btn btn--ghost btn--small wall-board__portrait" href="#portrait">
                墙的群像
              </a>
            ) : null}
            <a class="btn btn--ghost btn--small wall-board__group" href={`/messages/wall/${wall.id}`}>
              全员群聊
            </a>
            {model.role === 'organizer' ? (
              <a class="btn btn--ghost btn--small wall-board__admin" href={`/w/${wall.id}/admin`}>
                组织者后台
              </a>
            ) : null}
          </div>
        </div>

        {/* 场景、简介与“我的页面”：没有脚本（墙是普通网格）时显示；逛墙空间里不显示，自己的空位就在墙上 */}
        <div class="wall-top" data-wall-top>
          <section class={`wall-head scene--${wall.sceneType}`} aria-label="这面墙">
            <p class="wall-head__meta">
              <span class="chip">{sceneLabel}</span>
            </p>
            {wall.description ? <p class="wall-head__desc">{wall.description}</p> : null}
          </section>

          <section class={`my-page${published ? ' my-page--published' : ''}`} aria-labelledby="my-page-heading">
            <div class="my-page__info">
              <div class="my-page__head">
                <h2 id="my-page-heading">我的页面</h2>
                <span class={`badge ${published ? 'badge--live' : 'badge--muted'}`}>
                  <span class="dot" aria-hidden="true"></span>
                  {PAGE_STATE_LABEL[myPage.state]}
                </span>
              </div>
            </div>
            <div class="actions my-page__actions">
              <a class={`btn btn--small ${published ? 'btn--ghost' : 'btn--primary'}`} href={`/w/${wall.id}/me`}>
                {published ? '去修改我的页面' : '去做我的页面'}
              </a>
              {myPage.href ? (
                <a class="btn btn--small btn--ghost my-page__view" href={myPage.href}>
                  看看我的页面
                </a>
              ) : null}
              {model.questions.length > 0 ? (
                <a class="btn btn--small btn--ghost" href={`/w/${wall.id}/questions`}>
                  我的回答
                </a>
              ) : null}
            </div>
          </section>
        </div>

        {cards.length > 0 ? <WallFilters questions={model.questions} /> : null}
        {cards.length > 0 ? (
          <div class="wall-space" data-wall-space>
          <div class="wall-space__stage">
          <div class="wall-space__viewport" data-space-viewport>
          <ul class="wall-grid" data-space-track>
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
          </div>
          <span class="wall-space__light" aria-hidden="true" data-space-light></span>
          </div>
          <SpaceHud total={cards.length} />
          <SpacePanel csrf={csrf} intros={!!intros} ask={!!ask} portrait={showPortrait} />
          </div>
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
      <div class="wall-assist">
        {intros ? <details class="wall-assist__section"><summary>AI 帮我认识几个人 <span>看看推荐与理由</span></summary>{intros}</details> : null}
        {ask ? <details class="wall-assist__section"><summary>问问这面墙 <span>描述你想找的人</span></summary>{ask}</details> : null}
        <PortraitPanel wall={wall} state={model.portrait} shareText={portraitShare} organizer={model.role === 'organizer'} csrf={csrf} />
      </div>
      {/* 逛墙空间里页面不滚动，上面几块不在底部出现：从详情里的“AI 帮我找人 / 问问这面墙”、标题行的“墙的群像”打开，显示在这个对话框里 */}
      {intros || ask || showPortrait ? (
        <dialog class="space-assist" data-space-assist-dialog>
          <button type="button" class="space-assist__close" aria-label="关闭" data-space-assist-close>
            <span aria-hidden="true">×</span>
          </button>
          <div class="space-assist__slot" data-space-assist-slot></div>
        </dialog>
      ) : null}
    </div>
  );
};
