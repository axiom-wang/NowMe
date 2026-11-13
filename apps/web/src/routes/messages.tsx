import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { isId } from '@nowme/contracts';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findMemberWall, findPublishedMemberPage } from '../services/access.js';
import { openDirect, sendMessage } from '../services/chat.js';
import { icebreakerOpener } from '../services/icebreaker.js';
import { parsePublishedCard } from '../services/wall-view.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { ConversationView, MessagesView } from '../views/messages.js';
import { defaultWallCover } from '../views/home.js';

function integer(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^(0|[1-9]\d{0,15})$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function listCursor(raw: string | undefined) {
  if (!raw) return undefined;
  const [seq, id] = raw.split(':');
  const sequence = integer(seq);
  return sequence !== undefined && isId(id, 'cnv') && raw === `${seq}:${id}` ? { sequence, id } : null;
}

export function registerMessageRoutes(app: AppHono, deps: AppDeps): void {
  // 首屏与轮询使用同一份头像；群聊沿用墙的自定义封面或默认插画。
  const listWithAvatars = (userId: string, cursor?: { sequence: number; id: string }) => {
    const list = deps.repos.chat.list(userId, cursor);
    return { ...list, conversations: list.conversations.map((item) => {
      if (item.kind !== 'group') return item;
      const wall = deps.repos.walls.findById(item.wallId);
      return wall ? { ...item, avatarUrl: deps.repos.walls.coverUrl(wall.id) ?? `/static/home-wall-${defaultWallCover(wall)}.svg` } : item;
    }) };
  };
  const user = requireUser(deps);
  const form = requireForm(deps);
  const jsonUser: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!c.get('auth')?.user.nickname) return c.json({ error: '登录已过期，请重新登录' }, 401);
    return next();
  };

  app.get('/messages', user, (c) => {
    const cursor = listCursor(c.req.query('before'));
    if (cursor === null) return renderNotFound(c);
    const userId = authOf(c).user.id;
    const list = listWithAvatars(userId, cursor);
    return renderPage(c, { title: '消息', bodyClass: 'page--messages', body: <MessagesView {...list} now={deps.now()} paged={!!cursor} walls={deps.repos.memberships.listActiveForUser(userId).map((m) => ({ id: m.wall.id, name: m.wall.name }))} /> });
  });
  app.get('/messages/list', jsonUser, (c) => {
    const cursor = listCursor(c.req.query('before'));
    if (cursor === null) return c.json({ error: '会话游标无效' }, 400);
    return c.json(listWithAvatars(authOf(c).user.id, cursor));
  });
  app.get('/messages/unread', jsonUser, (c) => c.json({ unread: deps.repos.chat.unread(authOf(c).user.id) }));
  app.get('/messages/wall/:wallId', user, (c) => {
    const found = findMemberWall(deps.repos, authOf(c).user.id, c.req.param('wallId'));
    if (!found) return renderNotFound(c);
    return c.redirect(`/messages/${deps.repos.chat.ensureGroup(found.wall.id, found.wall.createdAt)}`, 303);
  });
  app.post('/messages/direct', form, (c) => {
    const fields = c.get('form');
    const id = openDirect(deps, authOf(c).user.id, fields.wallId ?? '', fields.userId ?? '');
    return id ? c.redirect(`/messages/${id}`, 303) : renderNotFound(c);
  });
  app.get('/messages/:id', user, (c) => {
    const auth = authOf(c);
    const summary = deps.repos.chat.summary(c.req.param('id'), auth.user.id);
    if (!summary) return renderNotFound(c);
    let draft = '';
    const source = findPublishedMemberPage(deps, auth.user.id, summary.wallId, c.req.query('pageId') ?? '');
    const conversation = deps.repos.chat.findVisible(summary.id, auth.user.id)!;
    if (source && !source.own && summary.kind === 'direct' && [conversation.userA, conversation.userB].includes(source.entry.ownerId)) {
      const hook = parsePublishedCard(source.entry.cardJson, '').hooks.find((h) => h.id === c.req.query('hookId'));
      if (hook) draft = hook.opener || `你好！我在墙上看到你的页面，想和你聊聊「${hook.text}」。`;
      // “和 TA 聊什么”里选的那一句：只预填，由本人修改后发送（contracts 11）
      const opener = /^[0-2]$/.test(c.req.query('o') ?? '') ? icebreakerOpener(deps, source, auth.user.id, c.req.query('ice') ?? '', Number(c.req.query('o'))) : null;
      if (opener) draft = opener;
    }
    return renderPage(c, { title: summary.title, body: <ConversationView summary={summary} history={deps.repos.chat.history(summary.id)} userId={auth.user.id} csrf={auth.session.csrfToken} clientId={randomUUID()} draft={draft} members={summary.kind === 'group' ? deps.repos.chat.members(summary.wallId) : []} /> });
  });
  app.get('/messages/:id/items', jsonUser, (c) => {
    const id = c.req.param('id');
    if (!deps.repos.chat.findVisible(id, authOf(c).user.id)) return c.json({ error: '会话不存在或已失去访问权限' }, 404);
    const beforeRaw = c.req.query('before');
    const afterRaw = c.req.query('after');
    const before = integer(beforeRaw);
    const after = integer(afterRaw);
    if ((beforeRaw !== undefined && before === undefined) || (afterRaw !== undefined && after === undefined) || (beforeRaw !== undefined && afterRaw !== undefined)) return c.json({ error: '消息游标无效' }, 400);
    return c.json(deps.repos.chat.history(id, { before, after }));
  });
  app.post('/messages/:id/send', form, (c) => {
    const auth = authOf(c);
    const id = c.req.param('id');
    const fields = c.get('form');
    const result = sendMessage(deps, auth.user.id, id, fields.clientId ?? '', fields.text ?? '');
    if (c.req.header('accept')?.includes('application/json')) return result.ok ? c.json({ message: result.message }) : c.json({ error: result.error }, result.status);
    if (result.ok) return c.redirect(`/messages/${id}`, 303);
    if (result.status === 404) return renderNotFound(c);
    const summary = deps.repos.chat.summary(id, auth.user.id)!;
    return renderPage(c, { title: summary.title, status: result.status, body: <ConversationView summary={summary} history={deps.repos.chat.history(id)} userId={auth.user.id} csrf={auth.session.csrfToken} clientId={fields.clientId ?? randomUUID()} draft={fields.text} error={result.error} members={summary.kind === 'group' ? deps.repos.chat.members(summary.wallId) : []} /> });
  });
  app.post('/messages/:id/read', form, (c) => {
    const id = c.req.param('id');
    const userId = authOf(c).user.id;
    if (!deps.repos.chat.findVisible(id, userId)) return c.json({ error: '会话不存在或已失去访问权限' }, 404);
    const sequence = integer(c.get('form').sequence);
    if (sequence === undefined || !deps.repos.chat.markRead(id, userId, sequence)) return c.json({ error: '已读位置无效' }, 400);
    return c.json({ ok: true });
  });
}
