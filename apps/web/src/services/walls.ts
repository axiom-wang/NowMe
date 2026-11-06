/**
 * 墙与成员关系的基础操作。T2.1 只提供开发种子脚本与测试需要的两个函数；
 * T3.1 在这里补充建墙表单校验、加入（已移除不能再加入、关闭的墙不能加入、退出后重新加入）、移除、关闭墙。
 */
import { generateId, generateToken, type SceneType } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { Membership, MembershipRole } from '../db/memberships.js';
import type { Page } from '../db/pages.js';
import type { Wall } from '../db/walls.js';

export interface CreateWallInput {
  organizerId: string;
  name: string;
  description: string;
  sceneType: SceneType;
  organizerNote: string | null;
}

export interface MemberPage {
  membership: Membership;
  page: Page;
}

/** 新建成员关系与对应页面（加入墙时创建页面，contracts 3）。调用方负责检查是否允许加入。 */
export function addMember(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now'>,
  wall: Wall,
  userId: string,
  role: MembershipRole = 'member',
): MemberPage {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const membership = deps.repos.memberships.create({
      id: generateId('mem'),
      wallId: wall.id,
      userId,
      role,
      status: 'active',
      joinedAt: nowIso,
      endedAt: null,
    });
    const page = deps.repos.pages.create({
      id: generateId('pg'),
      membershipId: membership.id,
      wallId: wall.id,
      ownerId: userId,
      contactChannel: null,
      contactValue: null,
      contactPublic: false,
      publicToken: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { membership, page };
  });
}

/** 建墙：组织者自动成为 role = organizer 的成员并拥有一页（contracts 3）。 */
export function createWall(deps: Pick<AppDeps, 'db' | 'repos' | 'now'>, input: CreateWallInput): { wall: Wall } & MemberPage {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const wall = deps.repos.walls.create({
      id: generateId('wal'),
      name: input.name,
      description: input.description,
      sceneType: input.sceneType,
      organizerNote: input.organizerNote,
      organizerId: input.organizerId,
      inviteCode: generateToken('invite'),
      status: 'open',
      createdAt: nowIso,
      closedAt: null,
    });
    return { wall, ...addMember(deps, wall, input.organizerId, 'organizer') };
  });
}
