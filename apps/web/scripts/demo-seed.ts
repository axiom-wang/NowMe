/**
 * 演示数据（`pnpm demo` 与 demo 种子测试共用）。
 *
 * - 黑客松墙：1 名组织者 + 6 名成员（6 个 Skill 示例页各属于一名成员）+ 1 名还没做页面的新同学。最后一名成员保持“已提交未发布”。
 * - 社团墙“山海摄影社 · 2026 秋季招新”（club，M5 验收时加入）：同一位组织者；小满、周一鸣、栗子三位成员各发布一页
 *   （club / interest 示例），新同学也已加入，可以在这面墙上试“在这里创作”。
 * 每名成员都走真实提交管线：生成 Agent 指令 → `/api/agent/exchange` 换凭证 → `/api/agent/revisions` 提交
 * （服务端校验 + 渲染），再以示例 `card.json` 的内容发布。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cardSchema, generateId, type ExchangeResponse, type RevisionResponse } from '@nowme/contracts';
import { EXAMPLES_DIR } from '@nowme/skill';
import type { WebApp } from '../src/app.js';
import type { Wall } from '../src/db/walls.js';
import { findOwnPage } from '../src/services/access.js';
import { createInstruction, type AgentInstruction } from '../src/services/instruction.js';
import { publishDefaults, publishRevision, validatePublishForm } from '../src/services/publish.js';
import { addMember, createWall } from '../src/services/walls.js';

export const DEMO_DOMAIN = 'demo.nowme.test';
export const DEMO_WALL_NAME = 'NOWMe 演示黑客松';
export const DEMO_CLUB_WALL_NAME = '山海摄影社 · 2026 秋季招新';

interface DemoMemberPlan {
  dir: string;
  email: string;
  /** 发布时是否公开联系方式。 */
  contactPublic: boolean;
  contact: { channel: 'wechat' | 'email'; value: string };
  /** false：只提交，不发布。 */
  publish: boolean;
}

/** 6 个示例页 → 6 名成员。 */
export const DEMO_MEMBER_PLANS: readonly DemoMemberPlan[] = [
  { dir: 'hackathon-terminal', email: `linzhou@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'linzhou_dev' }, publish: true },
  { dir: 'hackathon-poster', email: `suqing@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'suqing_design' }, publish: true },
  { dir: 'interest-vinyl', email: `alan@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'wechat', value: 'alan_vinyl' }, publish: true },
  { dir: 'interest-film-zine', email: `lizi@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'email', value: `lizi@${DEMO_DOMAIN}` }, publish: true },
  { dir: 'club-newbie-sticker', email: `xiaoman@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'wechat', value: 'xiaoman_2026' }, publish: true },
  { dir: 'club-senior-quest', email: `zhouyiming@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'zhou_yiming' }, publish: false },
];

/** 社团墙：复用黑客松墙的三个账号（按邮箱对应），各发布一页。 */
export const DEMO_CLUB_PLANS: readonly DemoMemberPlan[] = [
  { dir: 'club-newbie-sticker', email: `xiaoman@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'xiaoman_2026' }, publish: true },
  { dir: 'club-senior-quest', email: `zhouyiming@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'zhou_yiming' }, publish: true },
  { dir: 'interest-film-zine', email: `lizi@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'email', value: `lizi@${DEMO_DOMAIN}` }, publish: true },
];

export interface DemoMember {
  email: string;
  nickname: string;
  userId: string;
  pageId: string;
  exampleDir: string;
  published: boolean;
  contactPublic: boolean;
  revisionId: string;
}

export interface DemoSeed {
  wall: Wall;
  inviteUrl: string;
  organizer: { email: string; nickname: string; userId: string };
  members: DemoMember[];
  /** 已加入、还没做页面的新同学：给“用自己的 Agent 走一遍”用。 */
  newcomer: { email: string; nickname: string; userId: string; instruction: AgentInstruction };
  /** 社团墙（新同学也已加入，还没做页面）。 */
  club: { wall: Wall; inviteUrl: string; members: DemoMember[] };
}

function readExample(dir: string): { files: Record<string, string>; displayName: string } {
  const root = join(EXAMPLES_DIR, dir);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root)) {
    if (entry === 'DESIGN.md') continue;
    files[entry] = readFileSync(join(root, entry)).toString('base64');
  }
  const card = cardSchema.parse(JSON.parse(readFileSync(join(root, 'card.json'), 'utf8')));
  return { files, displayName: card.displayName };
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok && response.status !== 422) throw new Error(`${what}失败：${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function seedDemo(web: WebApp, log: (message: string) => void = () => {}): Promise<DemoSeed> {
  const { deps } = web;
  const { repos, config } = deps;
  const nowIso = () => deps.now().toISOString();
  const newUser = (email: string, nickname: string): string => {
    const id = generateId('usr');
    repos.users.create({ id, email, nickname, createdAt: nowIso() });
    return id;
  };

  const organizerUserId = newUser(`organizer@${DEMO_DOMAIN}`, '组织者小乐');
  const organizer = { email: `organizer@${DEMO_DOMAIN}`, nickname: '组织者小乐', userId: organizerUserId };
  const { wall } = createWall(deps, {
    organizerId: organizer.userId,
    name: DEMO_WALL_NAME,
    description: '周末 48 小时，找到能一起熬夜的队友。这是演示用的墙，里面的人都是虚构的。',
    sceneType: 'hackathon',
    organizerNote: '先挂上自己的一页，再去墙上找人聊',
  });

  const members: DemoMember[] = [];
  const userIds = new Map<string, string>();
  for (const plan of DEMO_MEMBER_PLANS) {
    const userId = newUser(plan.email, readExample(plan.dir).displayName);
    userIds.set(plan.email, userId);
    members.push(await submitAndPublish(web, wall, userId, plan, log));
  }

  const newcomerUserId = newUser(`newbie@${DEMO_DOMAIN}`, '新同学');
  const { page: newcomerPage } = addMember(deps, wall, newcomerUserId);
  const newcomer = {
    email: `newbie@${DEMO_DOMAIN}`,
    nickname: '新同学',
    userId: newcomerUserId,
    instruction: createInstruction(deps, wall, newcomerPage),
  };

  // 社团墙：同一位组织者，三位成员各发布一页；新同学也加入
  const { wall: clubWall } = createWall(deps, {
    organizerId: organizer.userId,
    name: DEMO_CLUB_WALL_NAME,
    description: '每周六早上扫街，月底一起冲洗胶片办小展。新社员、老社员都在这里挂一页，让大家先认识你。这是演示用的墙，里面的人都是虚构的。',
    sceneType: 'club',
    organizerNote: '新同学写写想拍什么，老社员写写可以来问你什么',
  });
  log(`社团墙「${DEMO_CLUB_WALL_NAME}」`);
  const clubMembers: DemoMember[] = [];
  for (const plan of DEMO_CLUB_PLANS) {
    const userId = userIds.get(plan.email);
    if (!userId) throw new Error(`演示数据异常：社团墙成员 ${plan.email} 不在黑客松墙里`);
    clubMembers.push(await submitAndPublish(web, clubWall, userId, plan, log));
  }
  addMember(deps, clubWall, newcomerUserId);

  return {
    wall,
    inviteUrl: `${config.webOrigin}/join/${wall.inviteCode}`,
    organizer,
    members,
    newcomer,
    club: { wall: clubWall, inviteUrl: `${config.webOrigin}/join/${clubWall.inviteCode}`, members: clubMembers },
  };
}

/** 一名成员在一面墙上：加入 → 指令 → 换凭证 → 提交（校验 + 渲染）→ 按计划由主人确认发布。 */
async function submitAndPublish(web: WebApp, wall: Wall, userId: string, plan: DemoMemberPlan, log: (message: string) => void): Promise<DemoMember> {
  const { deps } = web;
  const { repos, config } = deps;
  const example = readExample(plan.dir);
  const { page } = addMember(deps, wall, userId);

  // 真实提交管线：指令 → 换凭证 → 提交（校验 + 渲染）
  const instruction = createInstruction(deps, wall, page);
  const exchanged = await json<ExchangeResponse>(
    await web.request(`${config.webOrigin}/api/agent/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallId: wall.id, token: instruction.token }),
    }),
    `${example.displayName}换取凭证`,
  );
  const submitted = await json<RevisionResponse>(
    await web.request(`${config.webOrigin}/api/agent/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${exchanged.credential}` },
      body: JSON.stringify({ files: example.files }),
    }),
    `${example.displayName}提交页面`,
  );
  if (submitted.revision.status !== 'accepted') {
    throw new Error(`示例页 ${plan.dir} 没有通过服务端校验：${JSON.stringify(submitted.revision.report.errors.map((e) => e.code))}`);
  }
  const revisionId = submitted.revision.id;
  log(`  已提交 ${example.displayName}（${plan.dir}）`);

  // 主人在工作区确认并发布（这里直接调用与表单路由相同的服务）
  if (plan.publish) {
    const own = findOwnPage(repos, userId, wall.id);
    const revision = repos.revisions.findById(revisionId);
    if (!own || !revision?.cardJson) throw new Error('演示数据异常：找不到页面或版本');
    const defaults = publishDefaults(deps, own, revision);
    if (!defaults) throw new Error('演示数据异常：版本缺少 card');
    const checked = validatePublishForm(
      {
        ...defaults.values,
        contactChannel: plan.contact.channel,
        contactValue: plan.contact.value,
        contactPublic: plan.contactPublic,
        confirm: true,
      },
      cardSchema.parse(JSON.parse(revision.cardJson)),
    );
    if (!checked.ok) throw new Error(`演示数据异常：发布表单不通过 ${JSON.stringify(checked.errors)}`);
    if (!publishRevision(deps, own, revision, checked, userId)) throw new Error('演示数据异常：发布失败');
    log(`  已发布 ${example.displayName}（联系方式${plan.contactPublic ? '公开' : '不公开'}）`);
  }
  return {
    email: plan.email,
    nickname: example.displayName,
    userId,
    pageId: page.id,
    exampleDir: plan.dir,
    published: plan.publish,
    contactPublic: plan.contactPublic,
    revisionId,
  };
}
