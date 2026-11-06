/**
 * 授权检查（contracts 4.2、S5、S6）。无权访问一律当作不存在（路由返回 404），不暴露墙或页面是否存在。
 *
 * - `findOwnPage`：墙未关闭、当前用户在墙内是有效成员 → 他在这面墙的页面（工作区只给页面主人）。
 * - T3.1 在这里补充 `findMemberWall`（墙内有效成员才能看墙、成员页、封面、chat）。
 */
import { WALL_ID_PATTERN } from '@nowme/contracts';
import type { Repos } from '../db/index.js';
import type { Membership } from '../db/memberships.js';
import type { Page } from '../db/pages.js';
import type { Wall } from '../db/walls.js';

export interface OwnPage {
  wall: Wall;
  membership: Membership;
  page: Page;
}

export function findOwnPage(repos: Repos, userId: string, wallId: string): OwnPage | null {
  if (!WALL_ID_PATTERN.test(wallId)) return null;
  const wall = repos.walls.findById(wallId);
  if (!wall || wall.status !== 'open') return null;
  const membership = repos.memberships.findByWallAndUser(wallId, userId);
  if (!membership || membership.status !== 'active') return null;
  const page = repos.pages.findByMembership(membership.id);
  if (!page || page.ownerId !== userId) return null;
  return { wall, membership, page };
}
