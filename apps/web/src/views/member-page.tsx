/**
 * 成员页面、“想聊这个”站内私聊入口与独立的公开联系方式结果（W14）。
 *
 * - 页面用 PageFrame 展示当前发布版本（S1）；名字、介绍、接话点来自发布快照；
 * - “想聊这个”进入站内私聊并预填开场白；公开联系方式使用独立入口。
 */
import type { FC } from 'hono/jsx';
import type { ChatModel, MemberPageModel } from '../services/wall-view.js';
import { CsrfField } from './forms.js';
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

export const MemberPageView: FC<{ model: MemberPageModel; csrf: string }> = ({ model, csrf }) => {
  const { wall, card, contact, own } = model;
  const canChat = !own;
  const base = `/w/${wall.id}/p/${model.pageId}`;
  return (
    <div class="container container--wide">
      <BackLink href={`/w/${wall.id}`} label={`回到墙：${wall.name}`} />
      <div class="member-layout">
        <header class="member-head">
          <p class="eyebrow">{wall.name}</p>
          <h1 class="hero__title">
            {card.displayName}
            {own ? <span class="sticker sticker--orange member-head__me">我的页面</span> : null}
          </h1>
          {card.tagline ? <p class="member-head__tagline">{card.tagline}</p> : null}
          {!own ? <form method="post" action={`${base}/direct`}><CsrfField token={csrf} /><button type="submit" class="btn btn--accent">发私信</button></form> : null}
        </header>
        <div class="member-layout__frame">
          <PageFrame ticket={model.ticket} title={`${card.displayName}的页面`} />
        </div>
        <section class="card topics" aria-labelledby="hooks-heading">
          <h2 id="hooks-heading" class="topics__title">
            {own ? '我的接话点' : '可以和 TA 聊这些'}
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
