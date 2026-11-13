/**
 * 成员页面、“想聊这个”站内私聊入口与独立的公开联系方式结果（W14）。
 *
 * - 页面用 PageFrame 展示当前发布版本（S1）；名字、介绍、接话点来自发布快照；
 * - “想聊这个”进入站内私聊并预填开场白；公开联系方式使用独立入口。
 */
import type { FC } from 'hono/jsx';
import type { IcebreakerLink } from '../hosted/icebreaker.js';
import type { IcebreakerPanel, IcebreakerView } from '../services/icebreaker.js';
import type { ChatModel, MemberPageModel } from '../services/wall-view.js';
import { CsrfField } from './forms.js';
import { initialOf } from './layout.js';
import { PageFrame } from './page-frame.js';

const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <nav class="back-link" aria-label="返回">
    <a href={href}>
      <span aria-hidden="true">←</span> {label}
    </a>
  </nav>
);

/** 两位序号：01、02…… */
function ordinal(index: number): string {
  return String(index + 1).padStart(2, '0');
}

const LINK_KIND_LABEL: Record<IcebreakerLink['kind'], string> = { common: '共同点', complement: '正好互补', curious: '可以问问' };

/** “你 ⟷ TA”的小图：两个圆和一条虚线，中间一颗星。纯装饰。 */
const TalkPair: FC<{ theirInitial: string }> = ({ theirInitial }) => (
  <span class="talk__pair" aria-hidden="true">
    <span class="talk__who talk__who--me">你</span>
    <span class="talk__wire">
      <span class="talk__spark">✦</span>
    </span>
    <span class="talk__who talk__who--them">{theirInitial}</span>
  </span>
);

function sourceText(sources: IcebreakerView['sources']): string {
  const used = [sources.page ? '你已发布的页面' : '', sources.brief ? '你确认过的采访' : ''].filter(Boolean);
  return used.length > 0 ? `用到了：${used.join('、')}，和 TA 公开在墙上的页面。` : '你还没有自己的页面，这次只读了 TA 公开在墙上的页面。';
}

/**
 * 和 TA 聊什么（contracts 11）：查看者请 AI 读两个人的页面，找连接点、起草开场白。
 * 结果只有查看者自己能看到；开场白只会预填进私聊输入框，不会自动发送。
 */
const TalkPanel: FC<{ base: string; name: string; csrf: string; panel: IcebreakerPanel; error: string | null; aiSettings: boolean }> = ({ base, name, csrf, panel, error, aiSettings }) => {
  const view = panel.view;
  return (
    <section class={`talk${view ? ' talk--ready' : ''}`} id="talk" aria-labelledby="talk-heading" data-busy-scope>
      <header class="talk__head">
        <span class="sticker sticker--lime talk__badge">AI 破冰</span>
        <TalkPair theirInitial={initialOf(name)} />
      </header>
      <h2 id="talk-heading" class="talk__title">
        和<span class="talk__name">{name}</span>聊什么？
      </h2>
      {error ? (
        <p class="talk__error" role="alert">
          {error}
        </p>
      ) : null}

      {view ? (
        <>
          {view.links.length > 0 ? (
            <ul class="talk__links">
              {view.links.map((link) => (
                <li class={`talk-link talk-link--${link.kind}`}>
                  <p class="talk-link__title">
                    <span class="talk-link__kind">{LINK_KIND_LABEL[link.kind]}</span>
                    {link.title}
                  </p>
                  <div class="talk-link__proof">
                    {link.mine ? (
                      <p class="talk-quote talk-quote--me">
                        <span class="talk-quote__who">你</span>
                        <q>{link.mine}</q>
                      </p>
                    ) : null}
                    <p class="talk-quote talk-quote--them">
                      <span class="talk-quote__who">TA</span>
                      <q>{link.theirs}</q>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <h3 class="talk__sub">可以这样开口</h3>
          <ol class="talk__openers">
            {view.openers.map((opener, index) => (
              <li class="talk-opener">
                <p class="talk-opener__bubble">{opener.text}</p>
                <form method="post" action={`${base}/icebreaker/chat`} class="talk-opener__action">
                  <CsrfField token={csrf} />
                  <input type="hidden" name="icebreakerId" value={view.id} />
                  <input type="hidden" name="opener" value={String(index)} />
                  {opener.about ? <span class="talk-opener__about">从「{opener.about}」说起</span> : <span></span>}
                  <button type="submit" class="btn btn--accent btn--small">
                    用这句开聊
                  </button>
                </form>
              </li>
            ))}
          </ol>
          <p class="talk__foot">
            只有你能看到。{sourceText(view.sources)}
            {view.links.length > 0 ? '引号里的话都是从你们页面里原样摘出来的。' : ''}点“用这句开聊”只会把它填进输入框，改成你的语气再发。
          </p>
          <div class="talk__tools">
            <form method="post" action={`${base}/icebreaker`} data-busy-label="正在重新读你们俩的页面…">
              <CsrfField token={csrf} />
              <button type="submit" class="talk__tool">
                换一批
              </button>
            </form>
            <form method="post" action={`${base}/icebreaker/clear`}>
              <CsrfField token={csrf} />
              <button type="submit" class="talk__tool">
                清除
              </button>
            </form>
          </div>
        </>
      ) : panel.modelReady ? (
        <>
          <p class="talk__lead">
            {panel.hasMaterial
              ? '让 AI 读一读你们俩的页面，找出共同点和互补的地方，再替你起个头。'
              : '你还没有自己的页面。AI 会先从 TA 的页面里找最值得问的点；等你也挂上墙，它还能找出你们的共同点。'}
          </p>
          <form method="post" action={`${base}/icebreaker`} class="talk__start" data-busy-label="AI 正在读你们俩的页面…">
            <CsrfField token={csrf} />
            <button type="submit" class="btn btn--accent talk__go">
              帮我找话题
            </button>
            <span class="talk__hint">大约十几秒 · 结果只有你能看到</span>
          </form>
        </>
      ) : (
        <>
          <p class="talk__lead">让 AI 读一读你们俩的页面，找出共同点，再替你起个头。这个功能需要先配置可用的 AI。</p>
          {aiSettings ? (
            <a class="btn btn--accent talk__go" href="/account/ai">
              去 AI 设置
            </a>
          ) : (
            <p class="talk__hint">体验账号暂时没有可用的 AI 配置。</p>
          )}
        </>
      )}
      <p class="talk__busy" aria-live="polite" hidden data-busy-status></p>
    </section>
  );
};

export const MemberPageView: FC<{ model: MemberPageModel; csrf: string; icebreaker?: IcebreakerPanel | null; icebreakerError?: string | null; aiSettings?: boolean }> = ({
  model,
  csrf,
  icebreaker = null,
  icebreakerError = null,
  aiSettings = true,
}) => {
  const { wall, card, contact, own } = model;
  const canChat = !own;
  const base = `/w/${wall.id}/p/${model.pageId}`;
  return (
    <div class="container container--wide">
      <BackLink href={`/w/${wall.id}`} label={`回到墙：${wall.name}`} />
      <div class={`member-layout${icebreaker ? ' member-layout--talk' : ''}`}>
        <header class="member-head">
          <p class="eyebrow">{wall.name}</p>
          <h1 class="hero__title">
            {card.displayName}
            {own ? <span class="sticker sticker--orange member-head__me">我的页面</span> : null}
          </h1>
          {card.tagline ? <p class="member-head__tagline">{card.tagline}</p> : null}
          {!own ? <form method="post" action={`${base}/direct`}><CsrfField token={csrf} /><button type="submit" class="btn btn--ghost">直接发私信</button></form> : null}
        </header>
        <div class="member-layout__frame">
          <PageFrame ticket={model.ticket} title={`${card.displayName}的页面`} />
        </div>
        {icebreaker ? <TalkPanel base={base} name={card.displayName} csrf={csrf} panel={icebreaker} error={icebreakerError} aiSettings={aiSettings} /> : null}
        <section class="card topics" aria-labelledby="hooks-heading">
          <h2 id="hooks-heading" class="topics__title">
            {own ? '我的接话点' : 'TA 自己想聊的'}
          </h2>
          {card.hooks.length > 0 ? (
            <ol class="topic-list">
              {card.hooks.map((hook, index) => (
                <li class="topic">
                  <span class="topic__index" aria-hidden="true">
                    {ordinal(index)}
                  </span>
                  <p class="topic__text">{hook.text}</p>
                  {canChat ? (
                    <form method="post" action={`${base}/chat`} class="topic__action">
                      <CsrfField token={csrf} />
                      <input type="hidden" name="hookId" value={hook.id} />
                      <button type="submit" class="btn btn--accent btn--small">
                        想聊这个
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {own ? (
            <p class="muted topics__note">这是你自己的页面。别人点“想聊这个”时，会进入站内私聊，并带入你确认的开场白。</p>
          ) : (
            <p class="muted topics__note">点“想聊这个”，把话题带入站内私聊。开场白可以修改后再发送。</p>
          )}
          {!own && contact && card.hooks[0] ? <form method="post" action={`${base}/contact`}><CsrfField token={csrf} /><input type="hidden" name="contactHookId" value={card.hooks[0].id} /><button type="submit" class="btn btn--ghost btn--small">查看公开联系方式</button></form> : null}
        </section>
      </div>
    </div>
  );
};

/** 没有开场白时的兜底（只用接话点文字，不编造内容）。 */
function openerOf(model: ChatModel): string {
  return model.hook.opener || `你好！我在墙上看到你的页面，想和你聊聊「${model.hook.text}」。`;
}

export const ChatView: FC<{ model: ChatModel }> = ({ model }) => (
  <div class="container container--narrow">
    <BackLink href={`/w/${model.wall.id}/p/${model.pageId}`} label={`回到 ${model.displayName} 的页面`} />
    <section class="card chat">
      <p class="eyebrow">想聊这个</p>
      <h1 class="chat__title">
        想和 {model.displayName} 聊「{model.hook.text}」
      </h1>
      <p class="muted">这是 TA 主动公开的联系方式。也可以回到成员页，使用站内私聊。</p>
      <div class="chat__steps">
        <div class="chat__block">
          <h2 class="chat__label">
            <span class="chat__step" aria-hidden="true">
              1
            </span>
            TA 的{model.contact.channelLabel}
          </h2>
          <p class="chat__value" id="nm-chat-contact">
            {model.contact.value}
          </p>
          <button type="button" class="btn btn--ghost btn--small" data-copy="nm-chat-contact">
            复制{model.contact.channelLabel}
          </button>
        </div>
        <div class="chat__block">
          <h2 class="chat__label">
            <span class="chat__step" aria-hidden="true">
              2
            </span>
            开场白
          </h2>
          <p class="chat__opener" id="nm-chat-opener">
            {openerOf(model)}
          </p>
          <button type="button" class="btn btn--primary btn--small" data-copy="nm-chat-opener">
            复制开场白
          </button>
        </div>
      </div>
      <p class="muted chat__tip">开场白由 TA 的 Agent 起草、TA 自己确认过；可以改成你的语气再发。</p>
      <p class="chat__back">
        <a href={`/w/${model.wall.id}`}>回到墙上继续逛 →</a>
      </p>
    </section>
  </div>
);
