import { CHAT_TEXT_MAX_LENGTH, type ChatHistory, type ConversationSummary, type ChatMessage } from '@nowme/contracts';
import type { FC } from 'hono/jsx';
import { CsrfField } from './forms.js';
import { HomeIcon } from './home-icons.js';
import { ConversationSafety, type SafetyNotice } from './moderation.js';

/** 一对一私聊里“举报 / 拉黑”的状态。`closed`：拉黑（任一方向）或停用后不能再发消息。 */
export interface ConversationSafetyModel {
  blockedByMe: boolean;
  closed: boolean;
  reported: boolean;
  notice: SafetyNotice | null;
  error: string | null;
}

/** 与客户端保持一致，以东京时区的自然日显示相对时间。 */
export function formatConversationTime(value: string | null, now = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const day = (time: Date) => Math.floor((time.getTime() + 9 * 60 * 60 * 1000) / 86_400_000);
  const days = day(now) - day(date);
  if (days === 0) return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Tokyo', weekday: 'short' });
  const year = (time: Date) => new Date(time.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
  return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Tokyo', ...(year(date) !== year(now) ? { year: 'numeric' as const } : {}), month: 'numeric', day: 'numeric' });
}

export const ConversationItem: FC<{ item: ConversationSummary; now?: Date }> = ({ item, now }) => (
  <li class="conversation-item" data-kind={item.kind} data-unread={item.unread}>
    <a href={`/messages/${item.id}`} class="conversation-link">
      <span class={`conversation-icon${item.kind === 'group' ? ' conversation-icon--group' : ''}`} aria-hidden="true">{item.avatarUrl ? <img src={item.avatarUrl} alt="" /> : item.kind === 'group' ? '群' : [...item.title][0]}</span>
      <span class="conversation-copy"><strong>{item.title}</strong><span class="muted">{item.wallName}</span><span class="conversation-preview">{item.lastText ?? '还没有消息，来打个招呼吧'}</span></span>
      {item.lastAt ? <time class="conversation-time" datetime={item.lastAt}>{formatConversationTime(item.lastAt, now)}</time> : null}
      {item.unread > 0 ? <span class="message-badge" aria-label={`${item.unread} 条未读`}>{item.unread}</span> : null}
    </a>
  </li>
);

export function conversationCursor(item: ConversationSummary): string {
  return `${item.lastSequence}:${item.id}`;
}

export const MessagesView: FC<{
  conversations: ConversationSummary[];
  hasMore: boolean;
  paged: boolean;
  walls: { id: string; name: string }[];
  now?: Date;
}> = ({ conversations, hasMore, paged, walls, now }) => {
  const emptyTitle = walls.length > 0 ? '还没有聊天' : '还没有可以聊天的人';
  const emptyCopy = walls.length > 0 ? '去全员群打个招呼，或者在别人的页面点“想聊这个”，聊天就开始了。' : '加入一面墙之后，就能和墙上的人聊天了。';
  return (
  <div class="container messages-page" data-messages-page>
    <header class="messages-heading"><p class="eyebrow">和同一面墙上的人聊天</p><h1>消息</h1><p class="muted">私信和全员群都在这里，只有墙上的成员能看到和参与。</p></header>
    <div class="messages-toolbar">
      <div class="inbox-filters" role="group" aria-label="筛选会话" data-inbox-filters hidden>
        <button type="button" class="inbox-filter is-active" aria-pressed="true" data-inbox-filter="all">最近的聊天</button>
        <button type="button" class="inbox-filter" aria-pressed="false" data-inbox-filter="unread">未读消息 <span class="message-badge" data-inbox-unread hidden={!conversations.some((item) => item.unread > 0)}>{conversations.reduce((total, item) => total + item.unread, 0)}</span></button>
        <button type="button" class="inbox-filter" aria-pressed="false" data-inbox-filter="group">墙内群聊</button>
      </div>
      <details class="start-chat">
        <summary class="btn btn--primary"><HomeIcon name="plus" />发起聊天</summary>
        <div class="start-chat__menu">
          <h2>从共同的墙开始</h2>
          <p class="muted">先进某面墙的全员群；想私信谁，在群里点 TA 名字旁边的“私聊”。</p>
          {walls.length ? <ul>{walls.map((wall) => <li><a href={`/messages/wall/${wall.id}`}><span>{wall.name}</span><HomeIcon name="arrow" /></a></li>)}</ul> : <p class="muted">你还没有加入任何一面墙。拿到邀请链接加入后，就能和墙上的人聊天。</p>}
        </div>
      </details>
    </div>
    <div class="inbox-layout">
      <section class="card inbox" aria-label="会话列表" data-inbox={paged ? 'paged' : 'live'}>
        <h2 class="visually-hidden">最近的聊天</h2>
        <div class="inbox-empty" role="status" data-inbox-empty data-empty-title={emptyTitle} data-empty-copy={emptyCopy} hidden={conversations.length > 0}>
          <span class="inbox-empty__icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M26 19a6 6 0 0 1-6 6H12l-7 4V11a6 6 0 0 1 6-6h9a6 6 0 0 1 6 6Z" /><path d="M11 12h10M11 17h7" /></svg></span>
          <h3 data-inbox-empty-title>{emptyTitle}</h3>
          <p class="muted" data-inbox-empty-copy>{emptyCopy}</p>
          <a class="btn btn--accent btn--small" data-inbox-empty-action href={walls[0] ? `/messages/wall/${walls[0].id}` : '/'}>{walls[0] ? '去全员群打个招呼' : '回到首页'}</a>
        </div>
        <ul class="conversation-list" data-conversation-list>{conversations.map((item) => <ConversationItem item={item} now={now} />)}</ul>
        <p class="inbox-page-note muted" data-inbox-page-note hidden={!hasMore && !paged}>筛选只作用于当前显示的这些聊天；更早的在下面。</p>
        <a class="btn btn--ghost" data-conversation-next hidden={!hasMore} href={hasMore && conversations.length ? `/messages?before=${conversationCursor(conversations.at(-1)!)}` : '/messages'}>更早的会话</a>
        {paged ? <a class="btn btn--ghost" data-conversation-latest href="/messages">回到最新会话</a> : null}
      </section>
      <aside class="card inbox-walls"><h2>墙内全员群</h2>{walls.length === 0 ? <p class="muted">你还没有加入任何一面墙。拿到邀请链接加入后，就能和墙上的人聊天。</p> : <ul>{walls.map((wall) => <li><a href={`/messages/wall/${wall.id}`}><span>{wall.name}</span><HomeIcon name="arrow" /></a></li>)}</ul>}</aside>
    </div>
  </div>
  );
};

export const MessageItem: FC<{ message: ChatMessage; userId: string }> = ({ message, userId }) => (
  <li class={`message${message.senderId === userId ? ' message--mine' : ''}`} data-sequence={message.sequence}>
    <p class="message-meta">{message.senderAvatarUrl ? <img class="chat-avatar" src={message.senderAvatarUrl} alt="" loading="lazy" /> : null}<strong>{message.senderName}</strong> <time datetime={message.createdAt}>{new Date(message.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></p>
    <p class="message-text">{message.text}</p>
  </li>
);

export const ConversationView: FC<{
  summary: ConversationSummary;
  history: ChatHistory;
  userId: string;
  csrf: string;
  clientId: string;
  draft?: string;
  error?: string;
  members: { userId: string; nickname: string; avatarUrl?: string | null }[];
  /** 一对一私聊的举报 / 拉黑状态（contracts 15）；群聊为空。 */
  safety?: ConversationSafetyModel | null;
}> = ({ summary, history, userId, csrf, clientId, draft, error, members, safety = null }) => (
  <div class="container conversation-page" data-chat={summary.id} data-user-id={userId}>
    <nav class="back-link" aria-label="返回"><a href="/messages">← 消息列表</a><a href={`/w/${summary.wallId}`}>回到墙上</a></nav>
    <section class="card conversation-panel">
      <header class="conversation-heading"><p class="eyebrow">{summary.wallName} · {summary.kind === 'group' ? '全员群聊' : '私信'}</p><h1>{summary.title}</h1>
        {summary.kind === 'group' ? <details class="chat-members"><summary>墙内成员 · {members.length} 人</summary><ul>{members.map((member) => <li><span>{member.avatarUrl ? <img class="chat-avatar" src={member.avatarUrl} alt="" loading="lazy" /> : null}{member.nickname}{member.userId === userId ? '（我）' : ''}</span>{member.userId !== userId ? <form method="post" action="/messages/direct"><CsrfField token={csrf} /><input type="hidden" name="wallId" value={summary.wallId} /><input type="hidden" name="userId" value={member.userId} /><button class="btn btn--ghost btn--small" type="submit" aria-label={`和${member.nickname}私聊`}>私聊</button></form> : null}</li>)}</ul></details> : null}
      </header>
      <div class="chat-history" data-chat-history tabindex={0} aria-label="聊天记录">
        <button type="button" class="btn btn--ghost btn--small" data-older hidden={!history.hasMore}>加载更早消息</button>
        <p class="chat-empty muted" data-chat-empty hidden={history.messages.length > 0}>{summary.kind === 'group' ? '群里还没有人说话，你来开个头吧。' : '还没有消息。打个招呼吧，或者从 TA 页面上的话题聊起。'}</p>
        <ol class="message-list" role="log" aria-live="polite" aria-relevant="additions" data-message-list>{history.messages.map((message) => <MessageItem message={message} userId={userId} />)}</ol>
      </div>
      <button type="button" class="btn btn--accent chat-new" data-new-messages hidden>有新消息，点击查看 ↓</button>
      {safety ? <ConversationSafety conversationId={summary.id} csrf={csrf} name={summary.title} {...safety} /> : null}
      {/* 不能再发消息时隐藏输入框（表单保留：客户端用其中的 CSRF 标记已读）；服务端发送接口同样拒绝 */}
      <form class="chat-compose" method="post" action={`/messages/${summary.id}/send`} data-chat-form hidden={!!safety?.closed}>
        <CsrfField token={csrf} /><input type="hidden" name="clientId" value={clientId} />
        <label for="message-text">消息内容</label>
        <textarea id="message-text" name="text" rows={3} required data-max-length={CHAT_TEXT_MAX_LENGTH} placeholder="说点什么吧……">{draft ?? ''}</textarea>
        <div class="chat-compose-actions"><span class="muted">最多 {CHAT_TEXT_MAX_LENGTH} 字 · 纯文字</span><button type="submit" class="btn btn--accent">发送</button></div>
        <p class="chat-status" role="status" aria-live="polite" data-chat-status>{error ?? (draft ? '开场白已经填好了，改成你自己的话再发送。' : '')}</p>
        <a href="/login" data-chat-login hidden>重新登录</a><a href="/messages" data-chat-back hidden>返回消息列表</a>
      </form>
    </section>
  </div>
);
