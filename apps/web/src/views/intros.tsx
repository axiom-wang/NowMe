/**
 * 墙上的“AI 介绍给你的人”（contracts 20）：AI 读了你的页面和墙上的人，主动介绍几位适合你认识的，并说明为什么。
 *
 * - 结果只有查看者自己能看到；被介绍的人不会收到通知；
 * - 名字、封面来自对方的发布快照，理由与依据来自模型、经服务端核对，一律按文字渲染；
 * - 第一次是自动的：`data-intro-auto` 的表单由 static/wall.js 在页面加载后提交一次，结果原地替换这个区块；
 *   没有脚本时它就是一个普通按钮。
 */
import type { FC } from 'hono/jsx';
import { COVER_CSS_HEIGHT, COVER_CSS_WIDTH } from '@nowme/contracts';
import { INTRO_KIND_LABEL, type IntroCardView, type IntroPanel } from '../services/intro.js';
import { CsrfField } from './forms.js';
import { initialOf } from './layout.js';

const IntroCard: FC<{ pick: IntroCardView; csrf: string; index: number }> = ({ pick, csrf, index }) => (
  <li class={`intro-card intro-card--${pick.kind}`}>
    <a class="intro-card__who" href={pick.href}>
      <span class="intro-card__cover">
        {pick.coverSrc ? (
          <img src={pick.coverSrc} alt="" width={String(COVER_CSS_WIDTH)} height={String(COVER_CSS_HEIGHT)} loading="lazy" decoding="async" />
        ) : (
          <span class="intro-card__initial" aria-hidden="true">
            {initialOf(pick.displayName)}
          </span>
        )}
      </span>
      <span class="intro-card__name">{pick.displayName}</span>
      <span class="intro-card__kind">{INTRO_KIND_LABEL[pick.kind]}</span>
    </a>
    <div class="intro-card__body">
      <p class="intro-card__title">
        <span class="visually-hidden">第 {index + 1} 位：</span>
        {pick.title}
      </p>
      <p class="intro-card__reason">{pick.reason}</p>
      <div class="intro-card__proof">
        <p class="intro-quote">
          <span class="intro-quote__who">你</span>
          <q>{pick.mine}</q>
        </p>
        <p class="intro-quote intro-quote--them">
          <span class="intro-quote__who">TA</span>
          <q>{pick.theirs}</q>
        </p>
      </div>
      <div class="intro-card__actions">
        <form method="post" action={`${pick.href}/icebreaker`} data-busy-label={`AI 正在帮你想和 ${pick.displayName} 的开场白…`}>
          <CsrfField token={csrf} />
          <button type="submit" class="btn btn--accent btn--small">
            让 AI 帮我起个头
          </button>
        </form>
        <a class="btn btn--ghost btn--small" href={pick.href}>
          看 TA 的页面
        </a>
      </div>
    </div>
  </li>
);

const GenerateForm: FC<{ wallId: string; csrf: string; label: string; auto?: boolean; tool?: boolean }> = ({ wallId, csrf, label, auto = false, tool = false }) => (
  <form method="post" action={`/w/${wallId}/intros`} class={tool ? undefined : 'intros__start'} data-busy-label="AI 正在看墙上的人，挑几位适合你认识的…" data-intro-auto={auto ? '' : undefined}>
    <CsrfField token={csrf} />
    <button type="submit" class={tool ? 'intros__tool' : 'btn btn--accent intros__go'}>
      {label}
    </button>
  </form>
);

export const IntroPanelView: FC<{ wallId: string; panel: IntroPanel; csrf: string; error: string | null; aiSettings: boolean }> = ({ wallId, panel, csrf, error, aiSettings }) => {
  if (panel.kind === 'hidden') return null;
  // 自动发起时的等待状态由 wall.js 加上（没有脚本时这里只是一个普通按钮，不能显示成“正在生成”）
  return (
    <section
      class={`intros${panel.kind === 'ready' ? ' intros--ready' : ''}`}
      id="intros"
      aria-labelledby="intros-heading"
      data-busy-scope
      data-intros
      data-intro-pages={panel.kind === 'ready' ? panel.view.picks.map((pick) => pick.pageId).join(' ') : undefined}
    >
      <header class="intros__head">
        <span class="sticker sticker--lime intros__badge">AI 引荐</span>
        <h2 id="intros-heading" class="intros__title">
          {panel.kind === 'ready' ? 'AI 觉得你可以先认识这几位' : '不用一页页翻，让 AI 帮你找人'}
        </h2>
      </header>
      {error ? (
        <p class="intros__error" role="alert">
          {error}
        </p>
      ) : null}
      {panel.kind === 'ready' ? (
        <>
          <p class="intros__lead">
            AI 读了你的资料和墙上 {panel.candidates} 位成员的页面，挑出了能一起学习、兴趣相投或可以合作的人，下面是它的理由。
          </p>
          <ol class="intros__list">
            {panel.view.picks.map((pick, index) => (
              <IntroCard pick={pick} csrf={csrf} index={index} />
            ))}
          </ol>
          <div class="intros__tools">
            <GenerateForm wallId={wallId} csrf={csrf} tool label={panel.newcomers > 0 ? `墙上新来了 ${panel.newcomers} 位，再看看` : '换一批'} />
            <form method="post" action={`/w/${wallId}/intros/clear`}>
              <CsrfField token={csrf} />
              <button type="submit" class="intros__tool">
                清除
              </button>
            </form>
          </div>
        </>
      ) : panel.kind === 'stale' ? (
        <>
          <p class="intros__lead">上次介绍的几位都更新了页面，或者已经不在墙上了。{panel.newcomers > 0 ? `墙上还新来了 ${panel.newcomers} 位。` : ''}</p>
          <GenerateForm wallId={wallId} csrf={csrf} label="重新看看" />
        </>
      ) : panel.kind === 'start' ? (
        <>
          <p class="intros__lead">
            AI 会读你的资料和墙上 {panel.candidates} 位成员的页面，介绍几位适合你认识的人——能一起学习的、兴趣相投的、可以合作的，并告诉你为什么。
          </p>
          <GenerateForm wallId={wallId} csrf={csrf} label="让 AI 介绍几个人给我" auto={panel.auto} />
        </>
      ) : panel.kind === 'no-material' ? (
        <>
          <p class="intros__lead">
            AI 还不认识这面墙上的你。做好你的一页（或者先和 AI 聊完采访），它就会从墙上 {panel.candidates} 位成员里，把适合你认识的人介绍给你。
          </p>
          <a class="btn btn--accent intros__go" href={`/w/${wallId}/me`}>
            先做我的页面
          </a>
        </>
      ) : (
        <>
          <p class="intros__lead">AI 可以读你的资料和墙上 {panel.candidates} 位成员的页面，介绍几位适合你认识的人。要用这个功能，需要先有一个能用的 AI。</p>
          {aiSettings ? (
            <a class="btn btn--accent intros__go" href="/account/ai">
              去 AI 设置
            </a>
          ) : (
            <p class="intros__hint">体验账号暂时用不了这个功能。</p>
          )}
        </>
      )}
      <p class="intros__busy" role="status" data-busy-status></p>
    </section>
  );
};
