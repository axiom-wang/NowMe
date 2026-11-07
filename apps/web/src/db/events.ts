/**
 * `events` 表（contracts 6、W20）：只存类型、ID、数值 / 布尔属性，不存内容。
 * 按墙聚合的统计查询（`pnpm --filter @nowme/web stats <wallId>`，services/stats.ts）只返回计数，不返回任何人的 ID 或轨迹。
 */
import { EVENT_PROP_KEY_PATTERN, EVENT_PROPS_MAX_KEYS, EVENT_TYPES, generateId, type EventType } from '@nowme/contracts';
import type { Database } from './database.js';

export type EventProps = Record<string, number | boolean>;

export interface RecordEventInput {
  type: EventType;
  wallId: string | null;
  pageId: string | null;
  actorId: string | null;
  props?: EventProps;
  createdAt: string;
}

export interface StoredEvent {
  id: string;
  type: EventType;
  wallId: string | null;
  pageId: string | null;
  actorId: string | null;
  props: EventProps;
  createdAt: string;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** 只保留合法键名的有限数字与布尔值（防御：调用方不应该传别的东西）。 */
export function sanitizeEventProps(props: Record<string, unknown> | undefined): EventProps {
  const result: EventProps = {};
  if (!props) return result;
  for (const [key, value] of Object.entries(props)) {
    if (Object.keys(result).length >= EVENT_PROPS_MAX_KEYS) break;
    if (!EVENT_PROP_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
  }
  return result;
}

function toStoredEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as string,
    type: row.type as EventType,
    wallId: row.wall_id as string | null,
    pageId: row.page_id as string | null,
    actorId: row.actor_id as string | null,
    props: JSON.parse(row.props_json as string) as EventProps,
    createdAt: row.created_at as string,
  };
}

export function createEventsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO events (id, type, wall_id, page_id, actor_id, props_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const forPage = db.prepare('SELECT * FROM events WHERE page_id = ? ORDER BY created_at, rowid');
  const countPageTypeSince = db.prepare('SELECT COUNT(*) AS n FROM events WHERE page_id = ? AND type = ? AND created_at > ?');
  const forWall = db.prepare('SELECT * FROM events WHERE wall_id = ? ORDER BY created_at, rowid');
  const countsByType = db.prepare('SELECT type, COUNT(*) AS n FROM events WHERE wall_id = ? GROUP BY type');
  const distinctActors = db.prepare(
    'SELECT COUNT(DISTINCT actor_id) AS n FROM events WHERE wall_id = ? AND type = ? AND actor_id IS NOT NULL',
  );
  // 打开别人的页面（不算自己的页面）：按人数出不同页面数
  const browsedOthers = `SELECT e.actor_id AS actor_id
       FROM events e
       LEFT JOIN pages p ON p.id = e.page_id
      WHERE e.wall_id = ? AND e.type = 'page_open' AND e.actor_id IS NOT NULL AND e.page_id IS NOT NULL
        AND (p.owner_id IS NULL OR p.owner_id <> e.actor_id)
      GROUP BY e.actor_id
     HAVING COUNT(DISTINCT e.page_id) >= ?`;
  const browsedAtLeast = db.prepare(`SELECT COUNT(*) AS n FROM (${browsedOthers})`);
  const northStar = db.prepare(
    `SELECT COUNT(*) AS n FROM memberships m
      WHERE m.wall_id = ?
        AND m.user_id IN (${browsedOthers})
        AND m.user_id IN (SELECT actor_id FROM events WHERE wall_id = ? AND type = 'want_to_chat' AND actor_id IS NOT NULL)`,
  );

  return {
    /** 某页某类事件在 `since`（ISO）之后的条数（远程预览限流用）。 */
    countForPageSince(pageId: string, type: EventType, since: string): number {
      return Number((countPageTypeSince.get(pageId, type, since) as { n: number }).n);
    },
    record(event: RecordEventInput): string {
      if (!EVENT_TYPE_SET.has(event.type)) throw new Error(`未知的事件类型：${event.type}`);
      const id = generateId('evt');
      insert.run(
        id,
        event.type,
        event.wallId,
        event.pageId,
        event.actorId,
        JSON.stringify(sanitizeEventProps(event.props)),
        event.createdAt,
      );
      return id;
    },
    listForPage(pageId: string): StoredEvent[] {
      return (forPage.all(pageId) as Record<string, unknown>[]).map(toStoredEvent);
    },
    listForWall(wallId: string): StoredEvent[] {
      return (forWall.all(wallId) as Record<string, unknown>[]).map(toStoredEvent);
    },
    /** 这面墙每种事件的次数（没有出现的类型不在结果里）。 */
    countByType(wallId: string): Partial<Record<EventType, number>> {
      const result: Partial<Record<EventType, number>> = {};
      for (const row of countsByType.all(wallId) as { type: string; n: number }[]) {
        if (EVENT_TYPE_SET.has(row.type)) result[row.type as EventType] = Number(row.n);
      }
      return result;
    },
    /** 这面墙里发生过某种事件的不同人数。 */
    countDistinctActors(wallId: string, type: EventType): number {
      return Number((distinctActors.get(wallId, type) as { n: number }).n);
    },
    /** 打开过至少 `minPages` 个不同的别人页面的人数。 */
    countActorsBrowsedAtLeast(wallId: string, minPages: number): number {
      return Number((browsedAtLeast.get(wallId, minPages) as { n: number }).n);
    },
    /** 加入过这面墙的人里，打开过至少 `minPages` 个别人页面、且至少用过一次“想聊这个”的人数（北极星分子）。 */
    countNorthStarMembers(wallId: string, minPages: number): number {
      return Number((northStar.get(wallId, wallId, minPages, wallId) as { n: number }).n);
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
