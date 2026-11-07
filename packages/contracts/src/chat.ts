/** 墙内文字聊天的共享契约。sequence 为数据库分配的稳定递增游标。 */
export const CHAT_TEXT_MAX_LENGTH = 2000;
export const CHAT_PAGE_SIZE = 50;
export const CHAT_POLL_MS = 2500;

export interface ChatMessage {
  sequence: number;
  conversationId: string;
  senderId: string;
  senderName: string;
  clientId: string;
  text: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  wallId: string;
  wallName: string;
  kind: 'group' | 'direct';
  title: string;
  unread: number;
  lastSequence: number;
  lastText: string | null;
  lastAt: string | null;
}

export interface ChatHistory {
  messages: ChatMessage[];
  hasMore: boolean;
}
