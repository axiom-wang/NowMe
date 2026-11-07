import { CHAT_TEXT_MAX_LENGTH, type ChatHistory, type ConversationSummary, type ChatMessage } from '@nowme/contracts';
import type { FC } from 'hono/jsx';
import { CsrfField } from './forms.js';

export const ConversationItem: FC<{ item: ConversationSummary }> = ({ item }) => (
  <li class="conversation-item">
    <a href={`/messages/${item.id}`} class="conversation-link">
      <span class="conversation-icon" aria-hidden="true">{item.kind === 'group' ? '群' : [...item.title][0]}</span>
      <span class="conversation-copy"><strong>{item.title}</strong><span class="muted">{item.wallName}</span><span class="conversation-preview">{item.lastText ?? '还没有消息，来打个招呼吧'}</span></span>
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
}> = ({ conversations, hasMore, paged, walls }) => (
  <div class="container messages-page">
    <header class="messages-heading"><p class="eyebrow">和圈子里的人聊聊</p><h1 class="hero__title">消息</h1><p class="muted">私聊和全员群都属于各自的墙，只有有效成员可以参与。</p></header>
    <div class="inbox-layout">
      <section class="card inbox" aria-label="会话列表" data-inbox={paged ? 'paged' : 'live'}>
        <h2>最近的聊天</h2>
        <p data-inbox-empty hidden={conversations.length > 0}>还没有聊天。先到墙内全员群打个招呼吧。</p>
        <ul class="conversation-list" data-conversation-list>{conversations.map((item) => <ConversationItem item={item} />)}</ul>
        <a class="btn btn--ghost" data-conversation-next hidden={!hasMore} href={hasMore && conversations.length ? `/messages?before=${conversationCursor(conversations.at(-1)!)}` : '/messages'}>更早的会话</a>
        {paged ? <a class="btn btn--ghost" href="/messages">回到最新会话</a> : null}
      </section>
      <aside class="card inbox-walls"><h2>墙内全员群</h2>{walls.length === 0 ? <p class="muted">加入一面墙后，就能和成员聊天。</p> : <ul>{walls.map((wall) => <li><a href={`/messages/wall/${wall.id}`}>{wall.name}<span aria-hidden="true"> →</span></a></li>)}</ul>}</aside>
    </div>
  </div>
);

export const MessageItem: FC<{ message: ChatMessage; userId: string }> = ({ message, userId }) => (
  <li class={`message${message.senderId === userId ? ' message--mine' : ''}`} data-sequence={message.sequence}>
    <p class="message-meta"><strong>{message.senderName}</strong> <time datetime={message.createdAt}>{new Date(message.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></p>
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
  members: { userId: string; nickname: string }[];
}> = ({ summary, history, userId, csrf, clientId, draft, error, members }) => (
  <div class="container conversation-page" data-chat={summary.id} data-user-id={userId}>
    <nav class="back-link" aria-label="返回"><a href="/messages">← 消息列表</a><a href={`/w/${summary.wallId}`}>回到墙上</a></nav>
    <section class="card conversation-panel">
      <header class="conversation-heading"><p class="eyebrow">{summary.wallName} · {summary.kind === 'group' ? '全员群聊' : '一对一私聊'}</p><h1>{summary.title}</h1>
        {summary.kind === 'group' ? <details class="chat-members"><summary>墙内成员 · {members.length} 人</summary><ul>{members.map((member) => <li><span>{member.nickname}{member.userId === userId ? '（我）' : ''}</span>{member.userId !== userId ? <form method="post" action="/messages/direct"><CsrfField token={csrf} /><input type="hidden" name="wallId" value={summary.wallId} /><input type="hidden" name="userId" value={member.userId} /><button class="btn btn--ghost btn--small" type="submit" aria-label={`和${member.nickname}私聊`}>私聊</button></form> : null}</li>)}</ul></details> : null}
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
