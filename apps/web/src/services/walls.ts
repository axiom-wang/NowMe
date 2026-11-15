/**
 * 墙与成员关系的操作（contracts 3、4.2、6；build-plan 决策记录）。
 *
 * - 建墙（W02）：`parseWallForm` 校验表单，`createWall` 建墙并让组织者成为成员（有自己的页面）；
 * - 加入（W04）：`joinState` / `joinWall`。新成员 → 新建成员关系与页面；已是成员 → 直接进墙；
 *   退出过（left）→ 重新激活原成员关系，页面保持未发布；被移除（removed）→ 不能加入；墙关闭 → 不能加入；
 * - 移除（W03）：`removeMember`。成员关系 removed、活跃发布以 removed 结束、吊销凭证与未用 token；组织者不能被移除；
 * - 关闭墙（W03）：`closeWall`。墙 closed、全部活跃发布以 closed 结束、吊销全部凭证与未用 token。
 *
 * 状态改变都在一个事务里完成，并写入对应事件（只有 ID 与数字 / 布尔属性）。
 */
import {
  codePointLength,
  generateId,
  generateToken,
  isId,
  SCENE_TYPES,
  type EventType,
  type SceneType,
} from '@nowme/contracts';
import { WALL_TEXT_LIMITS } from '../constants.js';
import type { AppDeps, FormFields } from '../context.js';
import type { EventProps } from '../db/events.js';
import { transaction } from '../db/index.js';
import type { Membership, MembershipRole } from '../db/memberships.js';
import type { Page } from '../db/pages.js';
import { wallQueries } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { disconnectAgent } from './agent.js';
import { returnWallCredits } from './billing.js';

type WallDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;


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

function recordEvent(
  deps: WallDeps,
  type: EventType,
  event: { wallId: string; pageId?: string | null; actorId: string | null; props?: EventProps },
): void {
  deps.repos.events.record({
    type,
    wallId: event.wallId,
    pageId: event.pageId ?? null,
    actorId: event.actorId,
    props: event.props,
    createdAt: deps.now().toISOString(),
  });
}

function createPageFor(deps: WallDeps, wall: Wall, membership: Membership): Page {
  const nowIso = deps.now().toISOString();
  return deps.repos.pages.create({
    id: generateId('pg'),
    membershipId: membership.id,
    wallId: wall.id,
    ownerId: membership.userId,
    contactChannel: null,
    contactValue: null,
    contactPublic: false,
    publicToken: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

/** 新建成员关系与对应页面（加入墙时创建页面，contracts 3）。调用方负责检查是否允许加入。 */
export function addMember(deps: WallDeps, wall: Wall, userId: string, role: MembershipRole = 'member'): MemberPage {
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
    return { membership, page: createPageFor(deps, wall, membership) };
  });
}

/** 建墙：组织者自动成为 role = organizer 的成员并拥有一页（contracts 3）。 */
export function createWall(deps: WallDeps, input: CreateWallInput): { wall: Wall } & MemberPage {
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
    deps.repos.chat.ensureGroup(wall.id, nowIso);
    return { wall, ...addMember(deps, wall, input.organizerId, 'organizer') };
  });
}

// ---------------------------------------------------------------------------
// 建墙表单（W02）
// ---------------------------------------------------------------------------

export interface WallFormValues {
  name: string;
  description: string;
  sceneType: string;
  organizerNote: string;
}

export type WallFormErrors = Partial<Record<keyof WallFormValues, string>>;

export type ParsedWallForm =
  | { ok: true; input: Omit<CreateWallInput, 'organizerId'> }
  | { ok: false; values: WallFormValues; errors: WallFormErrors };

/** 除换行外的控制字符。 */
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SCENE_TYPE_SET: ReadonlySet<string> = new Set(SCENE_TYPES);

function lengthProblem(label: string, value: string, limits: { min: number; max: number }): string | null {
  const length = codePointLength(value);
  if (length < limits.min) return limits.min === 1 ? `请填写${label}` : `${label}至少 ${limits.min} 个字`;
  if (length > limits.max) return `${label}最多 ${limits.max} 个字，现在是 ${length} 个`;
  return null;
}

/** 校验建墙表单。名称 1–40 字、单行；简介 0–200 字、可换行；场景类型必须点选；组织者的话 0–80 字、单行、可空。 */
export function parseWallForm(form: FormFields): ParsedWallForm {
  const values: WallFormValues = {
    name: (form.name ?? '').trim(),
    description: (form.description ?? '').replace(/\r\n?/g, '\n').trim(),
    sceneType: form.sceneType ?? '',
    organizerNote: (form.organizerNote ?? '').trim(),
  };
  const errors: WallFormErrors = {};

  const nameProblem = lengthProblem('墙的名称', values.name, WALL_TEXT_LIMITS.name);
  if (nameProblem) errors.name = nameProblem;
  else if (CONTROL_CHARS.test(values.name)) errors.name = '墙的名称只能是一行文字';

  const descriptionProblem = lengthProblem('简介', values.description, WALL_TEXT_LIMITS.description);
  if (descriptionProblem) errors.description = descriptionProblem;
  else if (CONTROL_CHARS_EXCEPT_NEWLINE.test(values.description)) errors.description = '简介里有不支持的字符，换个写法试试';

  if (!SCENE_TYPE_SET.has(values.sceneType)) errors.sceneType = '请选一种场景';

  const noteProblem = lengthProblem('组织者的话', values.organizerNote, WALL_TEXT_LIMITS.organizerNote);
  if (noteProblem) errors.organizerNote = noteProblem;
  else if (CONTROL_CHARS.test(values.organizerNote)) errors.organizerNote = '组织者的话只能是一行文字';

  if (Object.keys(errors).length > 0) return { ok: false, values, errors };
  return {
    ok: true,
    input: {
      name: values.name,
      description: values.description,
      sceneType: values.sceneType as SceneType,
      organizerNote: values.organizerNote === '' ? null : values.organizerNote,
    },
  };
}

// ---------------------------------------------------------------------------
// 加入（W04）
// ---------------------------------------------------------------------------

export type JoinState =
  /** 已是有效成员：直接进墙。 */
  | { kind: 'member' }
  /** 被组织者移除过：不能再加入。 */
  | { kind: 'removed' }
  /** 可以加入；`rejoin` 表示之前退出过（重新激活原成员关系）。 */
  | { kind: 'joinable'; rejoin: boolean };

/** 某人对一面（开启的）墙的加入状态。 */
export function joinState(deps: Pick<AppDeps, 'repos'>, wall: Wall, userId: string): JoinState {
  const membership = deps.repos.memberships.findByWallAndUser(wall.id, userId);
  if (!membership) return { kind: 'joinable', rejoin: false };
  if (membership.status === 'active') return { kind: 'member' };
  if (membership.status === 'removed') return { kind: 'removed' };
  return { kind: 'joinable', rejoin: true };
}

export type JoinResult =
  | { kind: 'joined' | 'rejoined' | 'already'; membership: Membership }
  | { kind: 'removed' }
  | { kind: 'closed' };

/**
 * 加入墙（调用方已用邀请码找到这面墙）。在一个事务里重新读取墙与成员关系后决定：
 * 墙已关闭 → closed；新成员 → 新建成员关系与页面；已是有效成员 → already；被移除 → removed；
 * 退出过 → 重新激活原成员关系（加入时间更新），页面保持未发布（防御：若还有活跃发布，以 withdrawn 结束）。
 */
export function joinWall(deps: WallDeps, wall: Wall, userId: string): JoinResult {
  return transaction(deps.db, (): JoinResult => {
    const current = deps.repos.walls.findById(wall.id);
    if (!current || current.status !== 'open') return { kind: 'closed' };
    const existing = deps.repos.memberships.findByWallAndUser(current.id, userId);
    if (!existing) {
      const { membership, page } = addMember(deps, current, userId);
      recordEvent(deps, 'join', { wallId: current.id, pageId: page.id, actorId: userId, props: { rejoin: false } });
      return { kind: 'joined', membership };
    }
    if (existing.status === 'active') return { kind: 'already', membership: existing };
    if (existing.status === 'removed') return { kind: 'removed' };

    const nowIso = deps.now().toISOString();
    if (!deps.repos.memberships.reactivate(existing.id, nowIso)) throw new Error('重新加入失败：成员关系状态已改变');
    const page = deps.repos.pages.findByMembership(existing.id) ?? createPageFor(deps, current, existing);
    wallQueries(deps.db).endActivePublication(page.id, 'withdrawn', nowIso);
    recordEvent(deps, 'join', { wallId: current.id, pageId: page.id, actorId: userId, props: { rejoin: true } });
    const membership = deps.repos.memberships.findById(existing.id);
    if (!membership) throw new Error('成员关系不存在');
    return { kind: 'rejoined', membership };
  });
}

// ---------------------------------------------------------------------------
// 组织者操作（W03）
// ---------------------------------------------------------------------------

/**
 * 移除成员。`membershipId` 必须属于这面墙、有效、角色是 member，且不是组织者本人；否则返回 null（路由回 404）。
 * 移除后：成员关系 removed；其活跃发布以 removed 结束（立即下墙）；吊销凭证、作废未用 token；事件 member_removed。
 */
export function removeMember(deps: WallDeps, wall: Wall, organizerId: string, membershipId: string): Membership | null {
  if (!isId(membershipId, 'mem')) return null;
  return transaction(deps.db, () => {
    const membership = deps.repos.memberships.findById(membershipId);
    if (!membership || membership.wallId !== wall.id) return null;
    if (membership.status !== 'active' || membership.role !== 'member' || membership.userId === organizerId) return null;
    const nowIso = deps.now().toISOString();
    if (!deps.repos.memberships.markRemoved(membership.id, nowIso)) return null;
    const page = deps.repos.pages.findByMembership(membership.id);
    if (page) {
      wallQueries(deps.db).endActivePublication(page.id, 'removed', nowIso);
      disconnectAgent(deps, page.id);
    }
    deps.repos.icebreakers.deleteForViewerWall(membership.userId, wall.id);
    recordEvent(deps, 'member_removed', { wallId: wall.id, pageId: page?.id ?? null, actorId: organizerId });
    return deps.repos.memberships.findById(membership.id);
  });
}

export interface CloseWallResult {
  /** 结束的活跃发布数。 */
  endedPublications: number;
  /** 吊销的凭证数。 */
  revokedCredentials: number;
}

/**
 * 关闭墙：墙 closed；全部活跃发布以 closed 结束；全部页面的凭证吊销、未用 token 作废；事件 wall_closed。
 * 关闭后所有墙内路由对所有人 404（services/access.ts 只认开启的墙）。已经关闭时返回 null。
 */
export function closeWall(deps: WallDeps, wall: Wall, organizerId: string): CloseWallResult | null {
  return transaction(deps.db, () => {
    const nowIso = deps.now().toISOString();
    if (!deps.repos.walls.close(wall.id, nowIso)) return null;
    const queries = wallQueries(deps.db);
    const endedPublications = queries.endActivePublicationsForWall(wall.id, 'closed', nowIso);
    let revokedCredentials = 0;
    for (const pageId of queries.pageIdsForWall(wall.id)) revokedCredentials += disconnectAgent(deps, pageId);
    deps.repos.icebreakers.deleteForWall(wall.id);
    deps.repos.portraits.deleteForWall(wall.id);
    // 墙的剩余额度退回组织者的个人余额（contracts 12）
    returnWallCredits(deps, wall);
    recordEvent(deps, 'wall_closed', {
      wallId: wall.id,
      actorId: organizerId,
      props: { members: deps.repos.memberships.countActiveForWall(wall.id), endedPublications },
    });
    return { endedPublications, revokedCredentials };
  });
}
