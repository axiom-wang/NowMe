/**
 * 授权检查（contracts 4.2、S5、S6）。无权访问一律当作不存在（路由返回 404），不暴露墙或页面是否存在。
 *
 * - `findOwnPage`：墙未关闭、当前用户在墙内是有效成员 → 他在这面墙的页面（工作区只给页面主人）。
 * - `findMemberWall`：墙未关闭、当前用户在墙内是有效成员（墙、成员页、封面、chat）。
 * - `findOrganizerWall`：在 `findMemberWall` 之上还要求是这面墙的组织者（组织者后台）。
 * - `findPublishedMemberPage`：查看者是有效成员，且目标页在这面墙上可见（活跃发布 + 主人成员关系有效）。
 *
 * 关闭的墙对所有人（含组织者、原成员）不可见；已退出、已移除的成员立即失去访问。
 */
import { PAGE_ID_PATTERN, WALL_ID_PATTERN } from '@nowme/contracts';
import type { Database, Repos } from '../db/index.js';
import type { Membership } from '../db/memberships.js';
import type { Page } from '../db/pages.js';
import type { Wall } from '../db/walls.js';
import { wallQueries, type PublishedEntry } from '../db/wall-queries.js';

export interface OwnPage {
  wall: Wall;
  membership: Membership;
  page: Page;
}

export interface MemberWall {
  wall: Wall;
  /** 查看者自己的成员关系（有效）。 */
  membership: Membership;
}

export interface PublishedMemberPage extends MemberWall {
  /** 目标页的当前发布（墙上可见）。 */
  entry: PublishedEntry;
  /** 目标页是不是查看者自己的。 */
  own: boolean;
}

export function findOwnPage(repos: Repos, userId: string, wallId: string): OwnPage | null {
  const member = findMemberWall(repos, userId, wallId);
  if (!member) return null;
  const page = repos.pages.findByMembership(member.membership.id);
  if (!page || page.ownerId !== userId) return null;
  return { ...member, page };
}

export function findMemberWall(repos: Repos, userId: string, wallId: string): MemberWall | null {
  if (!WALL_ID_PATTERN.test(wallId)) return null;
  const wall = repos.walls.findById(wallId);
  if (!wall || wall.status !== 'open') return null;
  const membership = repos.memberships.findByWallAndUser(wallId, userId);
  if (!membership || membership.status !== 'active') return null;
  return { wall, membership };
}

export function findOrganizerWall(repos: Repos, userId: string, wallId: string): MemberWall | null {
  const member = findMemberWall(repos, userId, wallId);
  if (!member) return null;
  if (member.membership.role !== 'organizer' || member.wall.organizerId !== userId) return null;
  return member;
}

export function findPublishedMemberPage(
  deps: { db: Database; repos: Repos },
  userId: string,
  wallId: string,
  pageId: string,
): PublishedMemberPage | null {
  const member = findMemberWall(deps.repos, userId, wallId);
  if (!member || !PAGE_ID_PATTERN.test(pageId)) return null;
  const entry = wallQueries(deps.db).findPublished(member.wall.id, pageId);
  if (!entry) return null;
  return { ...member, entry, own: entry.ownerId === userId };
}
