/**
 * 按墙统计（W20、contracts 6）：`computeWallStats` 的口径、只有聚合数字（不含任何个人层面的数据），
 * 以及 `pnpm --filter @nowme/web stats <wallId> [--json]` 脚本本身。
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, STORED_AGENT_EVENT_TYPES, WEB_EVENT_TYPES } from '@nowme/contracts';
import { createRepos, openDatabase } from '../src/db/index.js';
import type { Wall } from '../src/db/walls.js';
import { computeWallStats, formatWallStats } from '../src/services/stats.js';
import { createWall, addMember } from '../src/services/walls.js';
import { connectAgent, createTestWeb, get, login, postForm, postJson, seedWall, type TestSession, type TestWeb } from './helpers.js';
import { publishedMember, publishPage, type PublishedMember } from './wall-helpers.js';

const run = promisify(execFile);
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const CONTACT = { channel: 'wechat', value: 'stats_contact_value' };

/** 把对象里所有字符串值收集起来（断言统计里没有个人数据）。 */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
}

describe('computeWallStats', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let wall: Wall;
  let pages: PublishedMember[];
  let heavy: TestSession;
  let light: TestSession;

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者');
    ({ wall } = seedWall(t, organizer.userId, '统计用的墙'));
    pages = ['阿柚', '小白', '林舟', '大橘'].map((name) => publishedMember(t, wall, { name, contact: CONTACT }));
    heavy = await login(t, 'heavy@example.com', '逛很多的人');
    light = await login(t, 'light@example.com', '只看一页的人');
    // 通过邀请加入（记 join 事件）
    for (const session of [heavy, light]) {
      expect((await postForm(t, `/join/${wall.inviteCode}`, { _csrf: session.csrf }, { cookie: session.cookie })).status).toBe(303);
    }
  });
  afterEach(async () => {
    await t.close();
  });

  it('口径：成员、已发布、墙浏览、页面打开、≥3 页人数、想聊这个、北极星候选、各 agent_* 事件', async () => {
    // heavy：看墙 2 次，打开 3 个不同页面（其中一个打开 2 次），想聊 1 次 → 北极星候选
    await get(t, `/w/${wall.id}`, { cookie: heavy.cookie });
    await get(t, `/w/${wall.id}`, { cookie: heavy.cookie });
    for (const target of [pages[0], pages[1], pages[2], pages[0]]) {
      await get(t, `/w/${wall.id}/p/${target?.page.id}`, { cookie: heavy.cookie });
    }
    await postForm(t, `/w/${wall.id}/p/${pages[0]?.page.id}/chat`, { _csrf: heavy.csrf, hookId: 'can-help' }, { cookie: heavy.cookie });
    // light：看墙 1 次，打开 1 页，想聊 2 次 → 不是北极星候选
    await get(t, `/w/${wall.id}`, { cookie: light.cookie });
    await get(t, `/w/${wall.id}/p/${pages[3]?.page.id}`, { cookie: light.cookie });
    for (let i = 0; i < 2; i += 1) {
      await postForm(t, `/w/${wall.id}/p/${pages[3]?.page.id}/chat`, { _csrf: light.csrf, hookId: 'looking-for' }, { cookie: light.cookie });
    }
    // Agent 事件
    const credential = await connectAgent(t, wall, pages[0]?.page ?? (undefined as never));
    for (const type of ['fetch', 'validate', 'validate', 'submit']) {
      expect((await postJson(t, '/api/agent/events', { type }, credential)).status).toBe(204);
    }
    // 移除一个已发布的成员：成员数、已发布都减少，加入过的人数不变
    expect(
      (await postForm(t, `/w/${wall.id}/admin/remove`, { _csrf: organizer.csrf, membershipId: pages[2]?.membership.id ?? '' }, { cookie: organizer.cookie }))
        .status,
    ).toBe(303);

    const stats = computeWallStats(t.web.deps, wall.id);
    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({
      wall: { id: wall.id, name: '统计用的墙', status: 'open', closedAt: null },
      members: { active: 6, joined: 7 },
      published: 3,
      wallViews: { count: 3, people: 2 },
      pageOpens: { count: 5, people: 2, peopleOpened3Plus: 1 },
      wantToChat: { count: 3, people: 2 },
      northStar: { numerator: 1, denominator: 7, minPages: 3 },
    });
    expect(stats?.northStar.ratio).toBeCloseTo(1 / 7, 4);
    expect(stats?.agentEvents).toEqual({ agent_fetch: 1, agent_validate: 2, agent_preview: 0, agent_generate: 0, agent_submit: 1 });
    expect(Object.keys(stats?.agentEvents ?? {})).toEqual([...STORED_AGENT_EVENT_TYPES]);
    expect(Object.keys(stats?.webEvents ?? {})).toEqual([...WEB_EVENT_TYPES]);
    expect(stats?.webEvents).toMatchObject({ join: 2, member_removed: 1, wall_view: 3, page_open: 5, want_to_chat: 3 });
  });

  it('只有聚合数字：除墙本身的 ID / 名称 / 状态 / 时间外，没有任何用户、页面、版本 ID、昵称、邮箱或联系方式', async () => {
    await get(t, `/w/${wall.id}/p/${pages[0]?.page.id}`, { cookie: heavy.cookie });
    await postForm(t, `/w/${wall.id}/p/${pages[0]?.page.id}/chat`, { _csrf: heavy.csrf, hookId: 'can-help' }, { cookie: heavy.cookie });
    const stats = computeWallStats(t.web.deps, wall.id);
    if (!stats) throw new Error('缺少统计');
    const { wall: wallInfo, ...rest } = stats;
    expect(stringsOf(rest), '墙以外只有数字').toEqual([]);
    expect(Object.keys(wallInfo).sort()).toEqual(['closedAt', 'createdAt', 'id', 'name', 'status']);
    const text = `${JSON.stringify(stats)}\n${formatWallStats(stats)}`;
    for (const forbidden of ['usr_', 'pg_', 'rev_', 'pbl_', 'mem_', 'evt_', '@example.com', '逛很多的人', '阿柚', CONTACT.value, heavy.userId]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('不存在的墙 → null；关闭的墙也能统计（wall_closed 计数、已发布归零）', async () => {
    expect(computeWallStats(t.web.deps, 'wal_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect((await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: organizer.csrf, confirm: '1' }, { cookie: organizer.cookie })).status).toBe(303);
    const stats = computeWallStats(t.web.deps, wall.id);
    expect(stats).toMatchObject({ wall: { status: 'closed' }, published: 0, webEvents: { wall_closed: 1 } });
    expect(formatWallStats(stats ?? (undefined as never))).toContain('已关闭于');
  });

  it('自己打开自己的页面不计入页面打开', async () => {
    const owner = await login(t, 'owner@example.com', '主人');
    const own = seedWall(t, owner.userId, '自己的墙');
    publishPage(t, own, '主人');
    expect((await get(t, `/w/${own.wall.id}/p/${own.page.id}`, { cookie: owner.cookie })).status).toBe(200);
    expect(computeWallStats(t.web.deps, own.wall.id)?.pageOpens).toEqual({ count: 0, people: 0, peopleOpened3Plus: 0 });
  });
});

describe('stats 脚本', () => {
  let dataDir: string;
  let wallId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nowme-stats-'));
    const db = openDatabase(dataPaths(dataDir).db);
    const repos = createRepos(db);
    const deps = { db, repos, now: () => new Date('2026-11-06T08:00:00.000Z') };
    const organizerId = 'usr_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    repos.users.create({ id: organizerId, email: 'o@example.com', nickname: '组织者', createdAt: deps.now().toISOString() });
    const { wall } = createWall(deps, { organizerId, name: '脚本墙', description: '', sceneType: 'hackathon', organizerNote: null });
    const memberId = 'usr_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    repos.users.create({ id: memberId, email: 'm@example.com', nickname: '成员', createdAt: deps.now().toISOString() });
    addMember(deps, wall, memberId);
    repos.events.record({ type: 'wall_view', wallId: wall.id, pageId: null, actorId: memberId, createdAt: deps.now().toISOString() });
    wallId = wall.id;
    db.close();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function stats(args: string[]) {
    return run(
      process.execPath,
      ['--import', 'tsx', '--conditions=source', '--disable-warning=ExperimentalWarning', 'scripts/stats.ts', ...args],
      { cwd: WEB_DIR, env: { ...process.env, NOWME_DATA_DIR: dataDir, NODE_ENV: 'test' } },
    );
  }

  it('--json 输出聚合数字；默认输出中文可读文本', async () => {
    const json = JSON.parse((await stats([wallId, '--json'])).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ wall: { id: wallId, name: '脚本墙' }, members: { active: 2, joined: 2 }, wallViews: { count: 1, people: 1 } });
    expect(JSON.stringify(json)).not.toContain('usr_');
    const text = (await stats([wallId])).stdout;
    expect(text).toContain('成员数：2');
    expect(text).toContain('墙浏览：1 次，1 人');
    expect(text).toContain('agent_submit：0');
    expect(text).not.toContain('usr_');
  }, 30_000);

  it('参数不对或墙不存在：退出码 1，中文提示', async () => {
    for (const args of [[], ['not-a-wall'], ['wal_cccccccccccccccccccccccccc']]) {
      const error = await stats(args).then(
        () => null,
        (reason: unknown) => reason as { code: number; stderr: string },
      );
      expect(error?.code, args.join(' ')).toBe(1);
      expect(error?.stderr).toContain('用法：pnpm --filter @nowme/web stats');
    }
  }, 30_000);
});
