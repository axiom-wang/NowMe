import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_PAGE_SIZE, type ChatHistory, type ChatMessage, type ConversationSummary } from '@nowme/contracts';
import { createTestWeb, get, login, postForm, seedMember, seedWall, type TestSession, type TestWeb } from './helpers.js';
import { openDirect, sendMessage } from '../src/services/chat.js';
import { migrate } from '../src/db/index.js';

describe('墙内聊天', () => {
  let t: TestWeb;
  let a: TestSession;
  let b: TestSession;
  let wallId: string;
  let direct: string;
  let group: string;
  const post = (who: TestSession, path: string, fields: Record<string, string>) => postForm(t, path, { _csrf: who.csrf, ...fields }, { cookie: who.cookie, headers: { accept: 'application/json' } });
  const read = (who: TestSession, path: string) => get(t, path, { cookie: who.cookie });
  const send = (who: TestSession, id: string, text: string, clientId: string = randomUUID()) => post(who, `/messages/${id}/send`, { text, clientId });
  beforeEach(async () => {
    t = createTestWeb();
    a = await login(t, 'a@example.com', '甲');
    b = await login(t, 'b@example.com', '乙');
    const { wall } = seedWall(t, a.userId);
    wallId = wall.id;
    seedMember(t, wall, b.userId);
    group = t.repos.chat.ensureGroup(wallId, wall.createdAt);
    direct = openDirect(t.web.deps, a.userId, wallId, b.userId)!;
  });
  afterEach(async () => { await t.close(); });

  it('群聊自动创建且幂等；双向发起私聊复用同一会话，不需要先发布页面', async () => {
    expect(t.db.prepare("SELECT * FROM conversations WHERE kind = 'group'").all()).toHaveLength(1);
    expect(migrate(t.db)).toEqual([]);
    expect(t.repos.chat.ensureGroup(wallId, 'other')).toBe(group);
    const response = await post(b, '/messages/direct', { wallId, userId: a.userId });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/messages/${direct}`);
    expect((await read(a, `/messages/wall/${wallId}`)).headers.get('location')).toBe(`/messages/${group}`);
    expect((await read(b, `/messages/${group}`)).status).toBe(200);
    expect(openDirect(t.web.deps, a.userId, wallId, a.userId)).toBeNull();
  });

  it('同一对用户在不同墙使用独立私聊', () => {
    const { wall } = seedWall(t, a.userId);
    seedMember(t, wall, b.userId);
    const other = openDirect(t.web.deps, b.userId, wall.id, a.userId)!;
    expect(other).not.toBe(direct);
    sendMessage(t.web.deps, a.userId, direct, randomUUID(), '只在第一面墙');
    expect(t.repos.chat.history(other).messages).toEqual([]);
  });

  it('升级旧数据库为已有墙回填群聊，保留原用户和墙，迁移可重复执行', () => {
    t.db.exec("DROP TABLE chat_reads; DROP TABLE chat_messages; DROP TABLE conversations; DELETE FROM schema_migrations WHERE version = '005_chat.sql'");
    expect(migrate(t.db)).toEqual(['005_chat.sql']);
    expect(migrate(t.db)).toEqual([]);
    expect(t.repos.chat.summary(group, a.userId)?.kind).toBe('group');
    expect(t.repos.users.findById(b.userId)?.nickname).toBe('乙');
    expect(t.repos.memberships.findByWallAndUser(wallId, b.userId)?.status).toBe('active');
  });

  it('会话列表游标分页不丢失同为零消息的群；非法游标返回 400', async () => {
    for (let i = 0; i < 55; i++) seedWall(t, a.userId, `墙${i}`);
    const first = await (await read(a, '/messages/list')).json() as { conversations: ConversationSummary[]; hasMore: boolean };
    expect(first.conversations).toHaveLength(CHAT_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    const last = first.conversations.at(-1)!;
    const second = await (await read(a, `/messages/list?before=${last.lastSequence}:${last.id}`)).json() as { conversations: ConversationSummary[]; hasMore: boolean };
    expect(second.hasMore).toBe(false);
    const ids = [...first.conversations, ...second.conversations].map((c) => c.id);
    expect(new Set(ids).size).toBe(57);
    expect((await read(a, '/messages/list?before=bad')).status).toBe(400);
  });

  it('私聊与群聊双向收发、跨用户显示昵称，刷新后保留历史', async () => {
    for (const id of [direct, group]) {
      expect((await send(a, id, '你好\n一起聊聊')).status).toBe(200);
      expect((await send(b, id, '好的🙂')).status).toBe(200);
      const data = await (await read(a, `/messages/${id}/items`)).json() as ChatHistory;
      expect(data.messages.map((m) => [m.senderName, m.text])).toEqual([['甲', '你好\n一起聊聊'], ['乙', '好的🙂']]);
      expect(await (await read(b, `/messages/${id}`)).text()).toContain('一起聊聊');
    }
  });

  it('相同消息标识重试只保存一次；同标识不同正文返回冲突；不同发送者独立去重', async () => {
    const key = randomUUID();
    const first = await (await send(a, direct, '第一条', key)).json() as { message: ChatMessage };
    const retry = await (await send(a, direct, '第一条', key)).json() as { message: ChatMessage };
    expect(retry).toEqual(first);
    expect((await send(a, direct, '修改后', key)).status).toBe(409);
    expect((await send(b, direct, '对方的', key)).status).toBe(200);
    expect(t.repos.chat.history(direct).messages).toHaveLength(2);
  });

  it('拒绝空白、超长、控制字符和无效标识；按 Unicode 字符计数', async () => {
    for (const text of ['  \n ', '字'.repeat(2001), 'a\0b']) expect((await send(a, direct, text)).status).toBe(400);
    expect((await send(a, direct, '正常', 'bad')).status).toBe(400);
    expect((await send(a, direct, '🙂'.repeat(2000))).status).toBe(200);
  });

  it('同时间戳消息以序号分页，加载旧消息和增量补齐不遗漏、不重复', async () => {
    for (let i = 0; i < 123; i++) sendMessage(t.web.deps, a.userId, direct, randomUUID(), `消息${i}`);
    const latest = await (await read(b, `/messages/${direct}/items`)).json() as ChatHistory;
    expect(latest.messages).toHaveLength(CHAT_PAGE_SIZE);
    expect(latest.hasMore).toBe(true);
    expect(latest.messages[0]?.text).toBe('消息73');
    const middle = await (await read(b, `/messages/${direct}/items?before=${latest.messages[0]!.sequence}`)).json() as ChatHistory;
    const oldest = await (await read(b, `/messages/${direct}/items?before=${middle.messages[0]!.sequence}`)).json() as ChatHistory;
    expect(oldest.hasMore).toBe(false);
    expect([...oldest.messages, ...middle.messages, ...latest.messages].map((m) => m.text)).toEqual(Array.from({ length: 123 }, (_, i) => `消息${i}`));
    const increment = await (await read(b, `/messages/${direct}/items?after=0`)).json() as ChatHistory;
    expect(increment.messages[0]?.text).toBe('消息0');
    expect(increment.hasMore).toBe(true);
    for (const query of ['before=-1', 'after=nope', 'before=1&after=2', 'after=9007199254740992']) expect((await read(a, `/messages/${direct}/items?${query}`)).status).toBe(400);
  });

  it('未读仅统计他人消息；页面或轮询不自动已读，位置不能倒退或指向其他会话', async () => {
    const sent = await (await send(a, direct, '未读')).json() as { message: ChatMessage };
    await send(b, direct, '自己发的不计未读');
    expect(await (await read(b, '/messages/unread')).json()).toEqual({ unread: 1 });
    await read(b, `/messages/${direct}`);
    await read(b, `/messages/${direct}/items`);
    expect(await (await read(b, '/messages/unread')).json()).toEqual({ unread: 1 });
    expect((await post(b, `/messages/${direct}/read`, { sequence: String(sent.message.sequence) })).status).toBe(200);
    await post(b, `/messages/${direct}/read`, { sequence: '0' });
    expect(await (await read(b, '/messages/unread')).json()).toEqual({ unread: 0 });
    const foreign = await (await send(a, group, '群消息')).json() as { message: ChatMessage };
    expect((await post(b, `/messages/${direct}/read`, { sequence: String(foreign.message.sequence) })).status).toBe(400);
    expect((await post(b, `/messages/${direct}/read`, { sequence: '999999' })).status).toBe(400);
  });

  it('列表包含最新摘要和未读数，按最后消息排序，正文在页面上转义', async () => {
    await send(a, direct, '<script>window.evil=1</script>');
    await send(b, group, '群里最后一条');
    const data = await (await read(b, '/messages/list')).json() as { conversations: ConversationSummary[] };
    expect(data.conversations.map((c) => c.id)).toEqual([group, direct]);
    expect(data.conversations[1]).toMatchObject({ unread: 1, lastText: '<script>window.evil=1</script>' });
    const html = await (await read(b, `/messages/${direct}`)).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>window.evil');
    expect(await (await read(b, '/messages')).text()).toContain('消息');
  });
});
