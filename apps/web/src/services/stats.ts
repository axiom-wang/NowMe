/**
 * 按墙聚合的统计（W20、contracts 6、产品文档第 10 节）：`pnpm --filter @nowme/web stats <wallId> [--json]`。
 *
 * 只输出聚合数字，不输出任何个人层面的数据（没有用户 ID、昵称、邮箱、页面 ID、浏览轨迹）。
 *
 * 口径：
 * - 成员数：当前有效成员（含组织者）；加入过：成员关系总数（含已退出、已移除）；
 * - 已发布：墙上当前可见的页面数（活跃发布 + 主人成员关系有效）；
 * - 页面打开：`page_open` 事件（打开别人的页面；自己的页面不记、也不计入）；
 * - 北极星候选：加入过这面墙的人里，打开过 ≥3 个不同的别人页面、且至少用过一次“想聊这个”的人数 ÷ 加入过的人数。
 */
import { STORED_AGENT_EVENT_TYPES, WEB_EVENT_TYPES, type EventType } from '@nowme/contracts';
import type { Database, Repos } from '../db/index.js';
import { wallQueries } from '../db/wall-queries.js';
import { formatDateTime } from '../format.js';

/** 北极星候选里“浏览过 3 页以上”的阈值。 */
export const NORTH_STAR_MIN_PAGES = 3;

type AgentEventType = (typeof STORED_AGENT_EVENT_TYPES)[number];
type WebEventType = (typeof WEB_EVENT_TYPES)[number];

export interface WallStats {
  wall: { id: string; name: string; status: 'open' | 'closed'; createdAt: string; closedAt: string | null };
  members: { active: number; joined: number };
  published: number;
  wallViews: { count: number; people: number };
  pageOpens: { count: number; people: number; peopleOpened3Plus: number };
  wantToChat: { count: number; people: number };
  northStar: { numerator: number; denominator: number; ratio: number; minPages: number };
  /** 各 agent_* 事件次数。 */
  agentEvents: Record<AgentEventType, number>;
  /** 其他主站事件次数。 */
  webEvents: Record<WebEventType, number>;
}

function countsFor<T extends EventType>(types: readonly T[], counts: Partial<Record<EventType, number>>): Record<T, number> {
  return Object.fromEntries(types.map((type) => [type, counts[type] ?? 0])) as Record<T, number>;
}

/** 这面墙的聚合统计；墙不存在时返回 null。关闭的墙也可以统计。 */
export function computeWallStats(deps: { db: Database; repos: Repos }, wallId: string): WallStats | null {
  const wall = deps.repos.walls.findById(wallId);
  if (!wall) return null;
  const { events, memberships } = deps.repos;
  const counts = events.countByType(wall.id);
  const joined = memberships.countAllForWall(wall.id);
  const numerator = events.countNorthStarMembers(wall.id, NORTH_STAR_MIN_PAGES);
  return {
    wall: { id: wall.id, name: wall.name, status: wall.status, createdAt: wall.createdAt, closedAt: wall.closedAt },
    members: { active: memberships.countActiveForWall(wall.id), joined },
    published: wallQueries(deps.db).countPublished(wall.id),
    wallViews: { count: counts.wall_view ?? 0, people: events.countDistinctActors(wall.id, 'wall_view') },
    pageOpens: {
      count: counts.page_open ?? 0,
      people: events.countDistinctActors(wall.id, 'page_open'),
      peopleOpened3Plus: events.countActorsBrowsedAtLeast(wall.id, NORTH_STAR_MIN_PAGES),
    },
    wantToChat: { count: counts.want_to_chat ?? 0, people: events.countDistinctActors(wall.id, 'want_to_chat') },
    northStar: {
      numerator,
      denominator: joined,
      ratio: joined === 0 ? 0 : Math.round((numerator / joined) * 10000) / 10000,
      minPages: NORTH_STAR_MIN_PAGES,
    },
    agentEvents: countsFor(STORED_AGENT_EVENT_TYPES, counts),
    webEvents: countsFor(WEB_EVENT_TYPES, counts),
  };
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 人类可读的中文统计。 */
export function formatWallStats(stats: WallStats): string {
  const lines = [
    `墙：${stats.wall.name}（${stats.wall.id}，${stats.wall.status === 'open' ? '开启' : `已关闭于 ${formatDateTime(stats.wall.closedAt ?? '')}`}）`,
    `建墙时间：${formatDateTime(stats.wall.createdAt)}`,
    '',
    `成员数：${stats.members.active}（加入过 ${stats.members.joined} 人，含已退出、已移除）`,
    `已发布：${stats.published}`,
    `墙浏览：${stats.wallViews.count} 次，${stats.wallViews.people} 人`,
    `页面打开：${stats.pageOpens.count} 次，${stats.pageOpens.people} 人；打开过 ≥${NORTH_STAR_MIN_PAGES} 个不同页面：${stats.pageOpens.peopleOpened3Plus} 人`,
    `想聊这个：${stats.wantToChat.count} 次，${stats.wantToChat.people} 人`,
    `北极星候选（浏览 ≥${stats.northStar.minPages} 页且至少一次想聊这个 ÷ 加入过的成员）：${stats.northStar.numerator} / ${stats.northStar.denominator} = ${percent(stats.northStar.ratio)}`,
    '',
    '本地 Agent 事件：',
    ...STORED_AGENT_EVENT_TYPES.map((type) => `  ${type}：${stats.agentEvents[type]}`),
    '主站事件：',
    ...WEB_EVENT_TYPES.map((type) => `  ${type}：${stats.webEvents[type]}`),
  ];
  return `${lines.join('\n')}\n`;
}
