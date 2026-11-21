import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { CHAT_PAGE_SIZE, isId } from '@nowme/contracts';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { requireForm } from '../security/forms.js';
import { authOf, onboardingStep, requireUser } from '../security/session.js';
import { findMemberWall, findPublishedMemberPage } from '../services/access.js';
import { RATE_RULES } from '../constants.js';
import { openDirect, sendMessage, type SendResult } from '../services/chat.js';
import { icebreakerOpener } from '../services/icebreaker.js';
import { parsePublishedCard } from '../services/wall-view.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { ConversationView, MessagesView } from '../views/messages.js';
import { defaultWallCover } from '../views/home.js';
import { conversationSafetyModel } from './moderation.js';

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

/** 左栏一次最多带多少个会话：客户端“加载更早的会话”后轮询要覆盖已展开的部分。 */
const LIST_LIMIT_MAX = 500;

/** `limit`：缺省取一页；给了就必须是不小于一页、不超过上限的整数。 */
function listLimit(raw: string | undefined): number | null {
  if (raw === undefined) return CHAT_PAGE_SIZE;
  const value = integer(raw);
  return value !== undefined && value >= CHAT_PAGE_SIZE && value <= LIST_LIMIT_MAX ? value : null;
}

/** 限流提示里的等待时间：不到 1 分钟说秒，否则向上取整到分钟。 */
function waitText(seconds: number): string {
  if (seconds <= 1) return '稍等一下';
  if (seconds < 60) return `大约 ${seconds} 秒后`;
  return `大约 ${Math.ceil(seconds / 60)} 分钟后`;
}

export function registerMessageRoutes(app: AppHono, deps: AppDeps): void {
  // 首屏与轮询使用同一份头像；群聊沿用墙的自定义封面或默认插画。
  const listWithAvatars = (userId: string, cursor?: { sequence: number; id: string }, limit = CHAT_PAGE_SIZE) => {
    const list = deps.repos.chat.list(userId, cursor, limit);
    return { ...list, conversations: list.conversations.map((item) => {
      if (item.kind !== 'group') return item;
      const wall = deps.repos.walls.findById(item.wallId);
      return wall ? { ...item, avatarUrl: deps.repos.walls.coverUrl(wall.id) ?? `/static/home-wall-${defaultWallCover(wall)}.svg` } : item;
    }) };
  };
  // 左栏会话列表：/messages 与每个会话页共用，保证双栏布局两侧一致。
  const inboxOf = (userId: string, cursor?: { sequence: number; id: string }, activeId?: string) => {
    // 会话页：当前会话排在前 50 之外时，多取几页，保证它在左栏里并高亮
    let limit = CHAT_PAGE_SIZE;
    let list = listWithAvatars(userId, cursor, limit);
    while (activeId && list.hasMore && limit < LIST_LIMIT_MAX && !list.conversations.some((item) => item.id === activeId)) list = listWithAvatars(userId, cursor, limit += CHAT_PAGE_SIZE);
    return {
      ...list,
      paged: !!cursor,
      now: deps.now(),
      walls: deps.repos.memberships.listActiveForUser(userId).map((m) => ({ id: m.wall.id, name: m.wall.name })),
    };
  };
  const user = requireUser(deps);
  const form = requireForm(deps);
  const jsonUser: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.get('auth');
    if (!auth?.user.nickname) return c.json({ error: '登录已经过期，请重新登录。' }, 401);
    if (onboardingStep(auth, c.get('demo'))) return c.json({ error: '请先确认用户协议和隐私政策，再继续聊天。' }, 403);
    return next();
  };

  app.get('/messages', user, (c) => {
    const cursor = listCursor(c.req.query('before'));
    if (cursor === null) return renderNotFound(c);
    return renderPage(c, { title: '消息', bodyClass: 'page--messages', body: <MessagesView {...inboxOf(authOf(c).user.id, cursor)} /> });
  });
  app.get('/messages/list', jsonUser, (c) => {
    const cursor = listCursor(c.req.query('before'));
    const limit = listLimit(c.req.query('limit'));
    if (cursor === null || limit === null) return c.json({ error: '翻页参数不对，刷新页面再试。' }, 400);
    return c.json(listWithAvatars(authOf(c).user.id, cursor, limit));
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
    return renderPage(c, { title: summary.title, bodyClass: 'page--conversation', body: <ConversationView summary={summary} history={deps.repos.chat.history(summary.id)} userId={auth.user.id} csrf={auth.session.csrfToken} clientId={randomUUID()} draft={draft} members={summary.kind === 'group' ? deps.repos.chat.members(summary.wallId) : []} safety={conversationSafetyModel(deps, summary, auth.user.id, c.req.query('safety'))} inbox={inboxOf(auth.user.id, undefined, summary.id)} /> });
  });
  app.get('/messages/:id/items', jsonUser, (c) => {
    const id = c.req.param('id');
    if (!deps.repos.chat.findVisible(id, authOf(c).user.id)) return c.json({ error: '这段对话打不开了。' }, 404);
    const beforeRaw = c.req.query('before');
    const afterRaw = c.req.query('after');
    const before = integer(beforeRaw);
    const after = integer(afterRaw);
    if ((beforeRaw !== undefined && before === undefined) || (afterRaw !== undefined && after === undefined) || (beforeRaw !== undefined && afterRaw !== undefined)) return c.json({ error: '翻页参数不对，刷新页面再试。' }, 400);
    return c.json(deps.repos.chat.history(id, { before, after }));
  });
  app.post('/messages/:id/send', form, async (c) => {
    const auth = authOf(c);
    const id = c.req.param('id');
    const fields = c.get('form');
    // 按用户限流（群聊 + 私聊合计）：挡住脚本刷屏，正常聊天碰不到
    const pace = deps.rateLimiter.hit('chat-send', auth.user.id, RATE_RULES.chatSend);
    // 内容安全（contracts 16.1）：会话存在且没被限流时才检查，不替无权访问的人调用审核接口
    const verdict = pace.ok && deps.repos.chat.findVisible(id, auth.user.id) ? await deps.contentSafety.checkText('message', fields.text) : { ok: true as const };
    const result: SendResult = !verdict.ok
      ? { ok: false, status: 400, error: verdict.message }
      : pace.ok
      ? sendMessage(deps, auth.user.id, id, fields.clientId ?? '', fields.text ?? '')
      : deps.repos.chat.findVisible(id, auth.user.id)
        ? { ok: false, status: 429, error: `发得有点快，${waitText(pace.retryAfterSeconds)}再发。` }
        : { ok: false, status: 404, error: '这段对话打不开了。' };
    if (!pace.ok) c.header('Retry-After', String(pace.retryAfterSeconds));
    if (c.req.header('accept')?.includes('application/json')) return result.ok ? c.json({ message: result.message }) : c.json({ error: result.error }, result.status);
    if (result.ok) return c.redirect(`/messages/${id}`, 303);
    if (result.status === 404) return renderNotFound(c);
    const summary = deps.repos.chat.summary(id, auth.user.id)!;
    return renderPage(c, { title: summary.title, bodyClass: 'page--conversation', status: result.status, body: <ConversationView summary={summary} history={deps.repos.chat.history(id)} userId={auth.user.id} csrf={auth.session.csrfToken} clientId={fields.clientId ?? randomUUID()} draft={fields.text} error={result.error} members={summary.kind === 'group' ? deps.repos.chat.members(summary.wallId) : []} safety={conversationSafetyModel(deps, summary, auth.user.id, undefined)} inbox={inboxOf(auth.user.id, undefined, summary.id)} /> });
  });
  app.post('/messages/:id/read', form, (c) => {
    const id = c.req.param('id');
    const userId = authOf(c).user.id;
    if (!deps.repos.chat.findVisible(id, userId)) return c.json({ error: '这段对话打不开了。' }, 404);
    const sequence = integer(c.get('form').sequence);
    if (sequence === undefined || !deps.repos.chat.markRead(id, userId, sequence)) return c.json({ error: '没能标记为已读，刷新页面再试。' }, 400);
    return c.json({ ok: true });
  });
}
