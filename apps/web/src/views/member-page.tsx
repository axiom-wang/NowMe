/**
 * 成员页面（`GET /w/:wallId/p/:pageId`）与“想聊这个”的结果（`POST /w/:wallId/p/:pageId/chat`，W14）。
 *
 * - 页面用 PageFrame 展示当前发布版本（S1）；名字、介绍、接话点来自发布快照；
 * - 只有发布快照里公开了联系方式、且不是自己的页面时，接话点旁才有“想聊这个”；
 * - 联系方式只出现在“想聊这个”的结果里（记录 want_to_chat 事件之后），成员页 HTML 里没有；
 * - 不提供站内聊天：提示复制开场白，去微信等外部渠道继续。
 */
import type { FC } from 'hono/jsx';
import type { ChatModel, MemberPageModel } from '../services/wall-view.js';
import { CsrfField } from './forms.js';
import { PageFrame } from './page-frame.js';

const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <nav class="back-link" aria-label="返回">
    <a href={href}>← {label}</a>
  </nav>
);

export const MemberPageView: FC<{ model: MemberPageModel; csrf: string }> = ({ model, csrf }) => {
  const { wall, card, contact, own } = model;
  const canChat = contact !== null && !own;
  const base = `/w/${wall.id}/p/${model.pageId}`;
  return (
    <>
      <BackLink href={`/w/${wall.id}`} label={`回到墙：${wall.name}`} />
      <header class="member-head">
        <h1>
          {card.displayName}
          {own ? <span class="badge badge--accent member-head__me">我的页面</span> : null}
        </h1>
        {card.tagline ? <p class="member-head__tagline">{card.tagline}</p> : null}
      </header>
      <div class="member-layout">
        <PageFrame ticket={model.ticket} title={`${card.displayName}的页面`} />
        <section class="card hooks" aria-labelledby="hooks-heading">
          <h2 id="hooks-heading">{own ? '我的接话点' : '可以和 TA 聊这些'}</h2>
          {card.hooks.length > 0 ? (
            <ul class="hook-list">
              {card.hooks.map((hook) => (
                <li class="hook">
                  <p class="hook__text">{hook.text}</p>
                  {canChat ? (
                    <form method="post" action={`${base}/chat`} class="hook__action">
                      <CsrfField token={csrf} />
                      <input type="hidden" name="hookId" value={hook.id} />
                      <button type="submit" class="btn btn--primary">
                        想聊这个
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {own ? (
            <p class="muted hooks__note">这是你自己的页面。别人点“想聊这个”时，会看到你发布时公开的联系方式和对应的开场白。</p>
          ) : contact === null ? (
            <p class="muted hooks__note">TA 没有公开联系方式，可以在活动现场找 TA 聊聊。</p>
          ) : (
            <p class="muted hooks__note">点“想聊这个”，会看到 TA 公开的联系方式和一句开场白。</p>
          )}
        </section>
      </div>
    </>
  );
};

/** 没有开场白时的兜底（只用接话点文字，不编造内容）。 */
function openerOf(model: ChatModel): string {
  return model.hook.opener || `你好！我在墙上看到你的页面，想和你聊聊「${model.hook.text}」。`;
}

export const ChatView: FC<{ model: ChatModel }> = ({ model }) => (
  <>
    <BackLink href={`/w/${model.wall.id}/p/${model.pageId}`} label={`回到 ${model.displayName} 的页面`} />
    <section class="card chat">
      <h1>
        想和 {model.displayName} 聊「{model.hook.text}」
      </h1>
      <p class="muted">NOWMe 不提供站内聊天。复制下面的联系方式和开场白，到{model.contact.channelLabel}里找 TA 继续聊吧。</p>
      <div class="chat__block">
        <h2 class="chat__label">TA 的{model.contact.channelLabel}</h2>
        <p class="chat__value" id="nm-chat-contact">
          {model.contact.value}
        </p>
        <button type="button" class="btn btn--ghost" data-copy="nm-chat-contact">
          复制{model.contact.channelLabel}
        </button>
      </div>
      <div class="chat__block">
        <h2 class="chat__label">开场白</h2>
        <p class="chat__opener" id="nm-chat-opener">
          {openerOf(model)}
        </p>
        <button type="button" class="btn btn--primary" data-copy="nm-chat-opener">
          复制开场白
        </button>
      </div>
      <p class="muted chat__tip">开场白由 TA 的 Agent 起草、TA 自己确认过；可以改成你的语气再发。</p>
      <p>
        <a href={`/w/${model.wall.id}`}>回到墙上继续逛</a>
      </p>
    </section>
  </>
);
