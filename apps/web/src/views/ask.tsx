/**
 * 墙上的“问墙”（contracts 21）：用一句话找人。AI 读墙上公开的页面，找出写到这件事的人，并附上 TA 页面上的原话。
 *
 * - 提问与结果只有提问的人自己能看到；被找到的人不会收到通知；
 * - 名字、封面来自对方的发布快照，说明与原话来自模型、经服务端核对，一律按文字渲染；
 * - 没有脚本也能用：就是一个普通表单，提交后回到这个区块。
 */
import type { FC } from 'hono/jsx';
import { ASK_LIMITS, COVER_CSS_HEIGHT, COVER_CSS_WIDTH } from '@nowme/contracts';
import { formatDateTime } from '../format.js';
import type { AskCardView, AskPanel, AskView } from '../services/ask.js';
import { CsrfField } from './forms.js';
import { initialOf } from './layout.js';

const AskCard: FC<{ match: AskCardView; csrf: string; index: number }> = ({ match, csrf, index }) => (
  <li class="intro-card ask-card">
    <a class="intro-card__who" href={match.href}>
      <span class="intro-card__cover">
        {match.coverSrc ? (
          <img src={match.coverSrc} alt="" width={String(COVER_CSS_WIDTH)} height={String(COVER_CSS_HEIGHT)} loading="lazy" decoding="async" />
        ) : (
          <span class="intro-card__initial" aria-hidden="true">
            {initialOf(match.displayName)}
          </span>
        )}
      </span>
      <span class="intro-card__name">{match.displayName}</span>
    </a>
    <div class="intro-card__body">
      <p class="intro-card__title">
        <span class="visually-hidden">第 {index + 1} 位：</span>
        {match.reason}
      </p>
      <div class="intro-card__proof">
        <p class="intro-quote intro-quote--them">
          <span class="intro-quote__who">TA</span>
          <q>{match.quote}</q>
        </p>
      </div>
      <div class="intro-card__actions">
        <form method="post" action={`${match.href}/icebreaker`} data-busy-label={`AI 正在帮你想和 ${match.displayName} 的开场白…`}>
          <CsrfField token={csrf} />
          <button type="submit" class="btn btn--accent btn--small">
            让 AI 帮我起个头
          </button>
        </form>
        <a class="btn btn--ghost btn--small" href={match.href}>
          看 TA 的页面
        </a>
      </div>
    </div>
  </li>
);

const AskForm: FC<{ wallId: string; csrf: string; suggestions: readonly string[]; again: boolean }> = ({ wallId, csrf, suggestions, again }) => (
  <form method="post" action={`/w/${wallId}/ask`} class="ask__form" data-busy-label="AI 正在读墙上的页面，找写到这件事的人…">
    <CsrfField token={csrf} />
    <div class="ask__row">
      <label class="visually-hidden" for="ask-question">
        用一句话说你想找什么样的人
      </label>
      <input
        id="ask-question"
        class="ask__input"
        type="text"
        name="question"
        required
        minlength={ASK_LIMITS.questionMin}
        maxlength={ASK_LIMITS.question}
        placeholder={again ? '再问一个，比如：谁周末有空？' : '比如：谁会剪视频？'}
        autocomplete="off"
        enterkeyhint="search"
      />
      <button type="submit" class="btn btn--accent ask__go">
        问墙
      </button>
    </div>
    {suggestions.length > 0 ? (
      <p class="ask__suggest">
        <span class="ask__suggest-label">试试：</span>
        {suggestions.map((text) => (
          <button type="submit" class="ask__chip" name="suggest" value={text} formnovalidate>
            {text}
          </button>
        ))}
      </p>
    ) : null}
    <p class="ask__hint">大约十几秒 · 只有你能看到你问了什么</p>
  </form>
);

const AskAnswer: FC<{ wallId: string; view: AskView; csrf: string }> = ({ wallId, view, csrf }) => (
  <div class="ask__answer">
    <p class="ask__asked">
      <span class="ask__asked-label">你问</span>
      <span class="ask__asked-text">{view.question}</span>
    </p>
    {view.matches.length > 0 ? (
      <>
        <p class="ask__lead">
          AI 读了墙上 {view.read} 位成员公开的页面，{view.matches.length} 位写到了这件事：
        </p>
        <ol class="intros__list ask__list">
          {view.matches.map((match, index) => (
            <AskCard match={match} csrf={csrf} index={index} />
          ))}
        </ol>
      </>
    ) : view.found > 0 ? (
      <p class="ask__lead">上次找到的几位都更新了页面，或者已经不在墙上了。可以再问一次。</p>
    ) : (
      <p class="ask__lead">
        AI 读了墙上 {view.read} 位成员公开的页面，没有人写到这件事。换个问法试试，或者去
        <a href={`/messages/wall/${wallId}`}>全员群</a>里直接问一句。
      </p>
    )}
    <p class="intros__foot ask__foot">
      只有你能看到这次提问和结果，被找到的人不会收到任何通知。“TA”后面是对方页面上的原话，AI 不会替别人编；它只读公开的页面，也可能有遗漏。问于 {formatDateTime(view.createdAt)}。
    </p>
    <div class="intros__tools">
      <form method="post" action={`/w/${wallId}/ask/clear`}>
        <CsrfField token={csrf} />
        <button type="submit" class="intros__tool">
          清除这次提问
        </button>
      </form>
    </div>
  </div>
);

export const AskPanelView: FC<{ wallId: string; panel: AskPanel; csrf: string; error: string | null; aiSettings: boolean }> = ({ wallId, panel, csrf, error, aiSettings }) => {
  if (panel.kind === 'hidden') return null;
  const { last } = panel;
  return (
    <section class={`intros ask${last && last.matches.length > 0 ? ' ask--ready' : ''}`} id="ask" aria-labelledby="ask-heading" data-busy-scope>
      <header class="intros__head">
        <span class="sticker sticker--orange intros__badge">问墙</span>
        <h2 id="ask-heading" class="intros__title">
          想找什么样的人？问一句就行
        </h2>
      </header>
      {error ? (
        <p class="intros__error" role="alert">
          {error}
        </p>
      ) : null}
      {last ? null : (
        <p class="intros__lead">
          不用一页页翻。AI 会读墙上 {panel.candidates} 位成员公开的页面，把写到这件事的人找出来，并附上 TA 页面上的原话。
        </p>
      )}
      {panel.blocked === 'no-model' ? (
        <div class="ask__blocked">
          <p class="intros__lead">要问墙，需要先有一个能用的 AI。</p>
          {aiSettings ? (
            <a class="btn btn--accent intros__go" href="/account/ai">
              去 AI 设置
            </a>
          ) : (
            <p class="intros__hint">体验账号暂时用不了这个功能。</p>
          )}
        </div>
      ) : panel.blocked === 'too-few' ? (
        <p class="intros__hint ask__blocked">墙上现在的人不多，直接逛逛就能看完。</p>
      ) : (
        <AskForm wallId={wallId} csrf={csrf} suggestions={panel.suggestions} again={last !== null} />
      )}
      {last ? <AskAnswer wallId={wallId} view={last} csrf={csrf} /> : null}
      <p class="intros__busy" role="status" data-busy-status></p>
    </section>
  );
};
