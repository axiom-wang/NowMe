import { CHAT_TEXT_MAX_LENGTH, type ChatHistory, type ConversationSummary, type ChatMessage } from '@nowme/contracts';
import type { FC } from 'hono/jsx';
import { CsrfField } from './forms.js';
import { HomeIcon } from './home-icons.js';

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
}> = ({ conversations, hasMore, paged, walls, now }) => (
  <div class="container messages-page" data-messages-page>
    <header class="messages-heading"><p class="eyebrow">和同墙下的人聊天</p><h1>消息</h1><p class="muted">私聊和全员群都在这里，只有有效成员可以参与。</p></header>
    <div class="messages-toolbar">
      <div class="inbox-filters" role="group" aria-label="筛选会话" data-inbox-filters hidden>
        <button type="button" class="inbox-filter is-active" aria-pressed="true" data-inbox-filter="all">最近的聊天</button>
        <button type="button" class="inbox-filter" aria-pressed="false" data-inbox-filter="unread">未读消息 <span class="message-badge" data-inbox-unread hidden={!conversations.some((item) => item.unread > 0)}>{conversations.reduce((total, item) => total + item.unread, 0)}</span></button>
        <button type="button" class="inbox-filter" aria-pressed="false" data-inbox-filter="group">墙内群聊</button>
      </div>
      <details class="start-chat">
        <summary class="home-button home-button--dark"><HomeIcon name="plus" />发起聊天</summary>
        <div class="start-chat__menu">
          <h2>从共同的墙开始</h2>
          <p class="muted">进入全员群，也可以从群内成员列表发起私聊。</p>
          {walls.length ? <ul>{walls.map((wall) => <li><a href={`/messages/wall/${wall.id}`}><span>{wall.name}</span><HomeIcon name="arrow" /></a></li>)}</ul> : <p class="muted">加入一面墙后，就能和成员聊天。</p>}
        </div>
      </details>
    </div>
    <div class="inbox-layout">
      <section class="card inbox" aria-label="会话列表" data-inbox={paged ? 'paged' : 'live'}>
        <h2 class="visually-hidden">最近的聊天</h2>
        <div class="inbox-empty" role="status" data-inbox-empty hidden={conversations.length > 0}>
          <span class="inbox-empty__icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M26 19a6 6 0 0 1-6 6H12l-7 4V11a6 6 0 0 1 6-6h9a6 6 0 0 1 6 6Z" /><path d="M11 12h10M11 17h7" /></svg></span>
          <h3 data-inbox-empty-title>聊天，从一句你好开始</h3>
          <p class="muted" data-inbox-empty-copy>还没有聊天。先到墙内全员群打个招呼吧。</p>
        </div>
        <ul class="conversation-list" data-conversation-list>{conversations.map((item) => <ConversationItem item={item} now={now} />)}</ul>
        <p class="inbox-page-note muted" data-inbox-page-note hidden={!hasMore && !paged}>筛选当前页会话，可继续查看更早的聊天。</p>
        <a class="btn btn--ghost" data-conversation-next hidden={!hasMore} href={hasMore && conversations.length ? `/messages?before=${conversationCursor(conversations.at(-1)!)}` : '/messages'}>更早的会话</a>
        {paged ? <a class="btn btn--ghost" data-conversation-latest href="/messages">回到最新会话</a> : null}
      </section>
      <aside class="card inbox-walls"><h2>墙内全员群</h2>{walls.length === 0 ? <p class="muted">加入一面墙后，就能和成员聊天。</p> : <ul>{walls.map((wall) => <li><a href={`/messages/wall/${wall.id}`}><span>{wall.name}</span><HomeIcon name="arrow" /></a></li>)}</ul>}</aside>
    </div>
  </div>
);

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
}> = ({ summary, history, userId, csrf, clientId, draft, error, members }) => (
  <div class="container conversation-page" data-chat={summary.id} data-user-id={userId}>
    <nav class="back-link" aria-label="返回"><a href="/messages">← 消息列表</a><a href={`/w/${summary.wallId}`}>回到墙上</a></nav>
    <section class="card conversation-panel">
      <header class="conversation-heading"><p class="eyebrow">{summary.wallName} · {summary.kind === 'group' ? '全员群聊' : '一对一私聊'}</p><h1>{summary.title}</h1>
        {summary.kind === 'group' ? <details class="chat-members"><summary>墙内成员 · {members.length} 人</summary><ul>{members.map((member) => <li><span>{member.avatarUrl ? <img class="chat-avatar" src={member.avatarUrl} alt="" loading="lazy" /> : null}{member.nickname}{member.userId === userId ? '（我）' : ''}</span>{member.userId !== userId ? <form method="post" action="/messages/direct"><CsrfField token={csrf} /><input type="hidden" name="wallId" value={summary.wallId} /><input type="hidden" name="userId" value={member.userId} /><button class="btn btn--ghost btn--small" type="submit" aria-label={`和${member.nickname}私聊`}>私聊</button></form> : null}</li>)}</ul></details> : null}
      </header>
      <div class="chat-history" data-chat-history tabindex={0} aria-label="聊天记录">
        <button type="button" class="btn btn--ghost btn--small" data-older hidden={!history.hasMore}>加载更早消息</button>
        <p class="chat-empty muted" data-chat-empty hidden={history.messages.length > 0}>还没有消息。从一句你好开始吧。</p>
        <ol class="message-list" role="log" aria-live="polite" aria-relevant="additions" data-message-list>{history.messages.map((message) => <MessageItem message={message} userId={userId} />)}</ol>
      </div>
      <button type="button" class="btn btn--accent chat-new" data-new-messages hidden>有新消息，点击查看 ↓</button>
      <form class="chat-compose" method="post" action={`/messages/${summary.id}/send`} data-chat-form>
        <CsrfField token={csrf} /><input type="hidden" name="clientId" value={clientId} />
        <label for="message-text">消息内容</label>
        <textarea id="message-text" name="text" rows={3} required data-max-length={CHAT_TEXT_MAX_LENGTH} placeholder="说点什么吧……">{draft ?? ''}</textarea>
        <div class="chat-compose-actions"><span class="muted">最多 {CHAT_TEXT_MAX_LENGTH} 字 · 纯文字</span><button type="submit" class="btn btn--accent">发送</button></div>
        <p class="chat-status" role="status" aria-live="polite" data-chat-status>{error ?? (draft ? '已带入话题开场白，可以修改后发送。' : '')}</p>
        <a href="/login" data-chat-login hidden>重新登录</a><a href="/messages" data-chat-back hidden>返回消息列表</a>
      </form>
    </section>
  </div>
);
