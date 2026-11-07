import { CHAT_PAGE_SIZE, generateId, type ChatMessage, type ConversationSummary } from '@nowme/contracts';
import type { Database } from './database.js';

export interface Conversation {
  id: string;
  wallId: string;
  kind: 'group' | 'direct';
  userA: string | null;
  userB: string | null;
}

/** 群成员由墙成员关系动态决定；私聊还要求本人参与且双方均为有效成员。 */
const VISIBLE = `FROM conversations c
  JOIN walls w ON w.id = c.wall_id AND w.status = 'open'
  JOIN memberships viewer ON viewer.wall_id = c.wall_id AND viewer.user_id = $user AND viewer.status = 'active'
  WHERE (c.kind = 'group' OR ((c.user_a = $user OR c.user_b = $user)
    AND EXISTS (SELECT 1 FROM memberships a WHERE a.wall_id = c.wall_id AND a.user_id = c.user_a AND a.status = 'active')
    AND EXISTS (SELECT 1 FROM memberships b WHERE b.wall_id = c.wall_id AND b.user_id = c.user_b AND b.status = 'active')))`;

const SUMMARY = `SELECT c.id, c.wall_id AS wallId, w.name AS wallName, c.kind,
  CASE WHEN c.kind = 'group' THEN w.name || ' · 全员群'
    ELSE COALESCE((SELECT nickname FROM users WHERE id = CASE WHEN c.user_a = $user THEN c.user_b ELSE c.user_a END), '成员') END AS title,
  (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_id <> $user
    AND m.sequence > COALESCE((SELECT last_sequence FROM chat_reads r WHERE r.conversation_id = c.id AND r.user_id = $user), 0)) AS unread,
  COALESCE((SELECT sequence FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY sequence DESC LIMIT 1), 0) AS lastSequence,
  (SELECT substr(body, 1, 100) FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY sequence DESC LIMIT 1) AS lastText,
  (SELECT created_at FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY sequence DESC LIMIT 1) AS lastAt
  ${VISIBLE}`;

const MESSAGE = `SELECT m.sequence, m.conversation_id AS conversationId, m.sender_id AS senderId,
  COALESCE(u.nickname, '成员') AS senderName, m.client_id AS clientId, m.body AS text, m.created_at AS createdAt
  FROM chat_messages m JOIN users u ON u.id = m.sender_id`;

export function createChatRepo(db: Database) {
  return {
    ensureGroup(wallId: string, createdAt: string): string {
      const id = `cnv_${wallId.slice(4)}`;
      db.prepare("INSERT INTO conversations (id, wall_id, kind, created_at) VALUES (?, ?, 'group', ?) ON CONFLICT (wall_id) WHERE kind = 'group' DO NOTHING").run(id, wallId, createdAt);
      return id;
    },
    ensureDirect(wallId: string, first: string, second: string, createdAt: string): string {
      const [a, b] = [first, second].sort();
      db.prepare("INSERT INTO conversations (id, wall_id, kind, user_a, user_b, created_at) VALUES (?, ?, 'direct', ?, ?, ?) ON CONFLICT (wall_id, user_a, user_b) WHERE kind = 'direct' DO NOTHING")
        .run(generateId('cnv'), wallId, a!, b!, createdAt);
      return (db.prepare("SELECT id FROM conversations WHERE wall_id = ? AND kind = 'direct' AND user_a = ? AND user_b = ?").get(wallId, a!, b!) as { id: string }).id;
    },
    findVisible(id: string, userId: string): Conversation | null {
      return db.prepare(`SELECT c.id, c.wall_id AS wallId, c.kind, c.user_a AS userA, c.user_b AS userB ${VISIBLE} AND c.id = $id`)
        .get({ $user: userId, $id: id }) as unknown as Conversation | undefined ?? null;
    },
    summary(id: string, userId: string): ConversationSummary | null {
      return db.prepare(`${SUMMARY} AND c.id = $id`).get({ $user: userId, $id: id }) as unknown as ConversationSummary | undefined ?? null;
    },
    list(userId: string, before?: { sequence: number; id: string }) {
      const rows = db.prepare(`${SUMMARY} ${before ? 'AND (lastSequence < $sequence OR (lastSequence = $sequence AND c.id < $id))' : ''}
        ORDER BY lastSequence DESC, c.id DESC LIMIT ${CHAT_PAGE_SIZE + 1}`)
        .all(before ? { $user: userId, $sequence: before.sequence, $id: before.id } : { $user: userId }) as unknown as ConversationSummary[];
      return { conversations: rows.slice(0, CHAT_PAGE_SIZE), hasMore: rows.length > CHAT_PAGE_SIZE };
    },
    unread(userId: string): number {
      return (db.prepare(`SELECT COALESCE(SUM(unread), 0) AS total FROM (${SUMMARY})`).get({ $user: userId }) as { total: number }).total;
    },
    history(id: string, cursor: { before?: number; after?: number } = {}) {
      const after = cursor.after !== undefined;
      const rows = db.prepare(`${MESSAGE} WHERE m.conversation_id = ? ${after ? 'AND m.sequence > ?' : cursor.before !== undefined ? 'AND m.sequence < ?' : ''}
        ORDER BY m.sequence ${after ? 'ASC' : 'DESC'} LIMIT ${CHAT_PAGE_SIZE + 1}`)
        .all(...(after ? [id, cursor.after!] : cursor.before !== undefined ? [id, cursor.before] : [id])) as unknown as ChatMessage[];
      const messages = rows.slice(0, CHAT_PAGE_SIZE);
      return { messages: after ? messages : messages.reverse(), hasMore: rows.length > CHAT_PAGE_SIZE };
    },
    findByClient(id: string, userId: string, clientId: string): ChatMessage | null {
      return db.prepare(`${MESSAGE} WHERE m.conversation_id = ? AND m.sender_id = ? AND m.client_id = ?`)
        .get(id, userId, clientId) as unknown as ChatMessage | undefined ?? null;
    },
    insert(id: string, userId: string, clientId: string, text: string, createdAt: string): ChatMessage {
      db.prepare('INSERT INTO chat_messages (conversation_id, sender_id, client_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, userId, clientId, text, createdAt);
      return this.findByClient(id, userId, clientId)!;
    },
    markRead(id: string, userId: string, sequence: number): boolean {
      if (sequence !== 0 && !db.prepare('SELECT 1 FROM chat_messages WHERE conversation_id = ? AND sequence = ?').get(id, sequence)) return false;
      db.prepare(`INSERT INTO chat_reads (conversation_id, user_id, last_sequence) VALUES (?, ?, ?)
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence)`)
        .run(id, userId, sequence);
      return true;
    },
    members(wallId: string): { userId: string; nickname: string }[] {
      return db.prepare(`SELECT u.id AS userId, COALESCE(u.nickname, '成员') AS nickname FROM memberships m
        JOIN users u ON u.id = m.user_id WHERE m.wall_id = ? AND m.status = 'active' ORDER BY m.joined_at, m.id`)
        .all(wallId) as unknown as { userId: string; nickname: string }[];
    },
  };
}
