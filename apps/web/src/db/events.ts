/**
 * `events` 表（contracts 6、W20）：只存类型、ID、数值 / 布尔属性，不存内容。
 * T3.1 在这里补充按墙聚合的统计查询（`pnpm --filter @nowme/web stats <wallId>`）。
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

export function createEventsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO events (id, type, wall_id, page_id, actor_id, props_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const forPage = db.prepare('SELECT * FROM events WHERE page_id = ? ORDER BY created_at, rowid');

  return {
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
      return (forPage.all(pageId) as Record<string, unknown>[]).map((row) => ({
        id: row.id as string,
        type: row.type as EventType,
        wallId: row.wall_id as string | null,
        pageId: row.page_id as string | null,
        actorId: row.actor_id as string | null,
        props: JSON.parse(row.props_json as string) as EventProps,
        createdAt: row.created_at as string,
      }));
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
