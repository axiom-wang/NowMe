import { CHAT_TEXT_MAX_LENGTH, codePointLength, isId, type ChatMessage } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import { findMemberWall } from './access.js';
import { canMessage } from './moderation.js';

type ChatDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;

export function openDirect(deps: ChatDeps, userId: string, wallId: string, otherId: string): string | null {
  if (!isId(otherId, 'usr') || otherId === userId) return null;
  return transaction(deps.db, () => {
    if (!findMemberWall(deps.repos, userId, wallId) || !findMemberWall(deps.repos, otherId, wallId)) return null;
    // 拉黑（任一方向）或对方已停用：不能发起私信（contracts 15）
    if (!canMessage(deps, userId, otherId)) return null;
    return deps.repos.chat.ensureDirect(wallId, userId, otherId, deps.now().toISOString());
  });
}

/** 私聊里的另一方。 */
export function directPeer(conversation: { userA: string | null; userB: string | null }, userId: string): string {
  return (conversation.userA === userId ? conversation.userB : conversation.userA) ?? '';
}

/** 私聊被拉黑或对方停用后不能再发：对两边都用同一句中性的话，不透露是谁拉黑了谁。 */
export const DIRECT_CLOSED_TEXT = '现在没法在这段对话里发消息了。';

export function messageProblem(text: string): string | null {
  if (!text.trim()) return '请输入消息内容';
  if (codePointLength(text) > CHAT_TEXT_MAX_LENGTH) return `每条消息最多 ${CHAT_TEXT_MAX_LENGTH} 个字`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return '消息里有不支持的字符，换个写法试试';
  return null;
}

export type SendResult = { ok: true; message: ChatMessage } | { ok: false; status: 400 | 403 | 404 | 409 | 429; error: string };

export function sendMessage(deps: ChatDeps, userId: string, conversationId: string, clientId: string, raw: string): SendResult {
  return transaction(deps.db, (): SendResult => {
    const conversation = deps.repos.chat.findVisible(conversationId, userId);
    if (!conversation) return { ok: false, status: 404, error: '这段对话打不开了。' };
    if (conversation.kind === 'direct' && !canMessage(deps, userId, directPeer(conversation, userId))) return { ok: false, status: 403, error: DIRECT_CLOSED_TEXT };
    const text = raw.replace(/\r\n?/g, '\n').trim();
    const error = messageProblem(text);
    if (error || !/^[A-Za-z0-9_-]{16,100}$/.test(clientId)) return { ok: false, status: 400, error: error ?? '这条消息没能发出去，刷新页面后再试一次。' };
    const existing = deps.repos.chat.findByClient(conversationId, userId, clientId);
    if (existing) return existing.text === text ? { ok: true, message: existing } : { ok: false, status: 409, error: '这条消息已经发出去了，刷新页面就能看到。' };
    return { ok: true, message: deps.repos.chat.insert(conversationId, userId, clientId, text, deps.now().toISOString()) };
  });
}
