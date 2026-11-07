import { CHAT_TEXT_MAX_LENGTH, codePointLength, isId, type ChatMessage } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import { findMemberWall } from './access.js';

type ChatDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;

export function openDirect(deps: ChatDeps, userId: string, wallId: string, otherId: string): string | null {
  if (!isId(otherId, 'usr') || otherId === userId) return null;
  return transaction(deps.db, () => {
    if (!findMemberWall(deps.repos, userId, wallId) || !findMemberWall(deps.repos, otherId, wallId)) return null;
    return deps.repos.chat.ensureDirect(wallId, userId, otherId, deps.now().toISOString());
  });
}

export function messageProblem(text: string): string | null {
  if (!text.trim()) return '请输入消息内容';
  if (codePointLength(text) > CHAT_TEXT_MAX_LENGTH) return `每条消息最多 ${CHAT_TEXT_MAX_LENGTH} 个字`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return '消息包含不支持的控制字符';
  return null;
}

export type SendResult = { ok: true; message: ChatMessage } | { ok: false; status: 400 | 404 | 409; error: string };

export function sendMessage(deps: ChatDeps, userId: string, conversationId: string, clientId: string, raw: string): SendResult {
  return transaction(deps.db, (): SendResult => {
    if (!deps.repos.chat.findVisible(conversationId, userId)) return { ok: false, status: 404, error: '会话不存在或已失去访问权限' };
    const text = raw.replace(/\r\n?/g, '\n').trim();
    const error = messageProblem(text);
    if (error || !/^[A-Za-z0-9_-]{16,100}$/.test(clientId)) return { ok: false, status: 400, error: error ?? '消息标识无效，请刷新页面后重试' };
    const existing = deps.repos.chat.findByClient(conversationId, userId, clientId);
    if (existing) return existing.text === text ? { ok: true, message: existing } : { ok: false, status: 409, error: '该消息已经发送，请刷新后查看' };
    return { ok: true, message: deps.repos.chat.insert(conversationId, userId, clientId, text, deps.now().toISOString()) };
  });
}
