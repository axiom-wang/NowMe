import { seedDemoAvatars } from './demo-avatars.js';
/**
 * 演示数据（`pnpm demo` 与 demo 种子测试共用）。
 *
 * - 黑客松墙：1 名组织者 + 6 名成员（6 个 Skill 示例页各属于一名成员）+ 1 名还没做页面的体验成员。最后一名成员保持“已提交未发布”。
 * - 社团墙“山海摄影社 · 2026 秋季招新”：原有三页，加上体验成员江予安与温溪两页。
 * - AI 共创与山野轻徒步墙各 10 人、6 页，体验成员保留空白工作区。
 * - 四个全员群和虚构私聊：经过聊天服务写入历史消息与部分已读位置。
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
import { openDirect, sendMessage } from '../src/services/chat.js';
import { seedDemoPersonalData } from './demo-persona.js';
import { buildDemoProfile, DEMO_EXTRA_WALLS, DEMO_TEST_EMAIL, DEMO_TEST_NAME, profileEmail } from './demo-content.js';
import { DEMO_AI_PUBLISHED_INDICES } from './demo-ai/index.js';
import { DEMO_TRAIL_PUBLISHED_INDICES } from './demo-trail/index.js';
import { buildDemoClubProfile, DEMO_CLUB_ADDITIONS } from './demo-club.js';

export const DEMO_DOMAIN = 'demo.nowme.test';
import { DEMO_WALL_NAME } from '../src/demo-access.js';
export { DEMO_WALL_NAME };
export const DEMO_CLUB_WALL_NAME = '山海摄影社 · 2026 秋季招新';

interface DemoMemberPlan {
  dir: string;
  profile?: { files: Record<string, string>; displayName: string };
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
  /** 已加入、还没做页面的体验成员：给“用自己的 Agent 走一遍”用。 */
  newcomer: { email: string; nickname: string; userId: string; instruction: AgentInstruction };
  /** 社团墙（含体验成员江予安的已发布页面）。 */
  club: { wall: Wall; inviteUrl: string; members: DemoMember[] };
  tester: { email: string; nickname: string; userId: string };
  extraWalls: { wall: Wall; inviteUrl: string; members: DemoWallMember[] }[];
  chat: { groups: number; directs: number; messages: number };
}

/** Membership creates a page slot; an empty workspace has no revision or publication. */
export type DemoWallMember = Omit<DemoMember, 'revisionId'> & { revisionId: string | null };

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

  const newcomerUserId = newUser(DEMO_TEST_EMAIL, DEMO_TEST_NAME);
  const { page: newcomerPage } = addMember(deps, wall, newcomerUserId);
  const newcomer = {
    email: DEMO_TEST_EMAIL,
    nickname: DEMO_TEST_NAME,
    userId: newcomerUserId,
    instruction: createInstruction(deps, wall, newcomerPage),
  };

  // 社团墙：保留原有三页，增补江予安与温溪两页。
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
  clubMembers.push(...await ensureDemoClubPages(web, log));

  // 接入现有“成员体验”账号：可看全部四面墙，原黑客松墙仍留空白页供创作体验。
  const tester = { email: newcomer.email, nickname: newcomer.nickname, userId: newcomer.userId };
  const extraWalls: DemoSeed['extraWalls'] = [];
  for (const plan of DEMO_EXTRA_WALLS) {
    const organizerIndex = plan.profiles.length - 1;
    const extraOrganizerId = newUser(profileEmail(plan, organizerIndex), plan.profiles[organizerIndex]!.name);
    const { wall: extraWall } = createWall(deps, { organizerId: extraOrganizerId, name: plan.name, description: plan.description, sceneType: plan.sceneType, organizerNote: plan.note });
    const publishedIndices: readonly number[] = plan.slug === 'ai' ? DEMO_AI_PUBLISHED_INDICES
      : plan.slug === 'trail' ? DEMO_TRAIL_PUBLISHED_INDICES : plan.profiles.map((_, index) => index);
    log(`新墙「${plan.name}」：10 位成员、${publishedIndices.length} 个页面`);
    const extraMembers: DemoWallMember[] = [];
    for (let index = 0; index < plan.profiles.length; index += 1) {
      const person = plan.profiles[index]!;
      const email = profileEmail(plan, index);
      const userId = index === 0 ? tester.userId : index === organizerIndex ? extraOrganizerId : newUser(email, person.name);
      if (!publishedIndices.includes(index)) {
        const page = findOwnPage(repos, userId, extraWall.id)?.page ?? addMember(deps, extraWall, userId).page;
        extraMembers.push({ email, nickname: person.name, userId, pageId: page.id, exampleDir: `${plan.slug}-${index}`,
          published: false, contactPublic: false, revisionId: null });
        continue;
      }
      const profile = buildDemoProfile(plan, index);
      extraMembers.push(await submitAndPublish(web, extraWall, userId, {
        dir: `${plan.slug}-${index}`, profile, email, publish: true, contactPublic: index % 3 !== 0,
        contact: { channel: 'email', value: email },
      }, log));
    }
    extraWalls.push({ wall: extraWall, inviteUrl: `${config.webOrigin}/join/${extraWall.inviteCode}`, members: extraMembers });
  }

  seedDemoAvatars(deps);
  seedDemoPersonalData(deps, tester.userId, []);

  const chat = seedDemoChats(web, tester.userId, [
    { wall, members: [{ userId: tester.userId, nickname: tester.nickname }, ...members], discussion: [
      [0, '欢迎来黑客松墙！这里可以先看每个人的页面，再从感兴趣的话题开始聊天。'],
      [1, '我可以帮忙写后端，想找一个有意思的小问题一起做。'],
      [2, '我带了产品原型，周末可以一起试试。'],
      [4, '我可以帮忙拍过程记录，大家组队之后叫我就好。'],
      [0, '组队前先互相聊聊，想法还没成形也欢迎。'],
    ] },
    { wall: clubWall, members: [{ userId: tester.userId, nickname: tester.nickname }, ...clubMembers.filter((member) => member.userId !== tester.userId)], discussion: [
      [0, '摄影社这周先做一次作品交流，新同学也可以带手机照片。'],
      [1, '我带了一组校园里的树影，想听听大家怎么选照片。'],
      [2, '我可以分享构图经验，周六见！'],
      [3, '我把最近一卷胶片洗出来了，也带过来一起看。'],
      [0, '周六下午两点，先看照片，再去附近走走。'],
    ] },
    ...extraWalls.map((entry, index) => ({ ...entry, discussion: DEMO_EXTRA_WALLS[index]!.discussion })),
  ]);
  log(`聊天已就绪：${chat.groups} 个全员群、${chat.directs} 个私聊、${chat.messages} 条消息`);

  return {
    wall,
    inviteUrl: `${config.webOrigin}/join/${wall.inviteCode}`,
    organizer,
    members,
    newcomer,
    club: { wall: clubWall, inviteUrl: `${config.webOrigin}/join/${clubWall.inviteCode}`, members: clubMembers },
    tester, extraWalls, chat,
  };
}

/** 新旧 Demo 共用的增补：只填写空白工作区，绝不覆盖体验者已经创作的版本。 */
export async function ensureDemoClubPages(web: WebApp, log: (message: string) => void = () => {}): Promise<DemoMember[]> {
  const { deps } = web;
  const organizer = deps.repos.users.findByEmail(`organizer@${DEMO_DOMAIN}`);
  const wall = organizer && deps.repos.walls.findOpenByOrganizerAndName(organizer.id, DEMO_CLUB_WALL_NAME);
  if (!wall) return [];
  const added: DemoMember[] = [];
  for (const [index, person] of DEMO_CLUB_ADDITIONS.entries()) {
    let user = deps.repos.users.findByEmail(person.email);
    if (!user) {
      // The test identity must already exist; never create a second test account.
      if (person.email === DEMO_TEST_EMAIL) throw new Error('摄影社增补缺少体验账号');
      user = deps.repos.users.create({ id: generateId('usr'), email: person.email, nickname: person.name, createdAt: deps.now().toISOString() });
    }
    const own = findOwnPage(deps.repos, user.id, wall.id);
    if (own && deps.repos.revisions.listForPage(own.page.id).length > 0) continue;
    added.push(await submitAndPublish(web, wall, user.id, {
      dir: person.id, email: person.email, profile: buildDemoClubProfile(index), publish: true,
      contactPublic: false, contact: { channel: 'email', value: person.email },
    }, log));
  }
  return added;
}

/** 一名成员在一面墙上：加入 → 指令 → 换凭证 → 提交（校验 + 渲染）→ 按计划由主人确认发布。 */
async function submitAndPublish(web: WebApp, wall: Wall, userId: string, plan: DemoMemberPlan, log: (message: string) => void): Promise<DemoMember> {
  const { deps } = web;
  const { repos, config } = deps;
  const example = plan.profile ?? readExample(plan.dir);
  // 组织者建墙时已自动拥有成员关系与页面。
  const existing = findOwnPage(repos, userId, wall.id);
  const page = existing?.page ?? addMember(deps, wall, userId).page;

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

interface ChatWall {
  wall: Wall;
  members: { userId: string; nickname: string }[];
  discussion: readonly (readonly [number, string])[];
}

/** 经过实际聊天服务写入，包含历史往返、部分已读与待回复消息，不调用模型。 */
function seedDemoChats(web: WebApp, testerId: string, walls: ChatWall[]): DemoSeed['chat'] {
  const { deps } = web;
  const result = { groups: 0, directs: 0, messages: 0 };
  const base = deps.now().getTime() - 30 * 60 * 60 * 1000;
  // 全部消息按时间顺序写入，保证序号排序与时间排序一致。
  const pending: { conversationId: string; userId: string; text: string; at: number }[] = [];
  const readAt = new Map<string, number>();
  walls.forEach((entry, wallIndex) => {
    const groupId = deps.repos.chat.ensureGroup(entry.wall.id, entry.wall.createdAt);
    result.groups += 1;
    entry.discussion.forEach(([index, text], messageIndex) => {
      const member = entry.members[index];
      if (!member) throw new Error('模拟群聊的成员不存在');
      pending.push({ conversationId: groupId, userId: member.userId, text, at: base + wallIndex * 45 * 60_000 + messageIndex * 9 * 60_000 });
    });
    // 已读到中段，保留后半段未读，便于评委体验未读数变化。
    readAt.set(groupId, 3);
    const extraPlan = DEMO_EXTRA_WALLS[wallIndex - 2];
    for (let memberIndex = 1; memberIndex <= Math.min(3, entry.members.length - 1); memberIndex += 1) {
      const other = entry.members[memberIndex]!;
      const conversationId = openDirect(deps, testerId, entry.wall.id, other.userId);
      if (!conversationId) throw new Error('模拟私聊创建失败');
      result.directs += 1;
      const topic = extraPlan?.directTopics[memberIndex - 1];
      const exchange: [string, string][] = [
        [testerId, `${other.nickname}你好！看了你的页面，想和你聊聊${topic?.[0] ?? '周末一起参加活动的安排'}。`],
        [other.userId, '好呀，很高兴在这面墙上认识你！你比较想先从哪一部分开始？'],
        [testerId, '先互相看看手上的小作品吧，周末见面时就有具体的话题了。'],
        [other.userId, topic?.[1] ?? '可以，我把最近做的东西整理一下，周末带过来。'],
        [other.userId, '对了，你周六下午方便吗？我们也可以先在群里约个时间。'],
      ];
      exchange.forEach(([userId, text], index) => pending.push({ conversationId, userId, text, at: base + 12 * 60 * 60_000 + wallIndex * 40 * 60_000 + memberIndex * 15 * 60_000 + index * 3 * 60_000 }));
      readAt.set(conversationId, memberIndex === 2 ? exchange.length : 3);
    }
    // 让其他成员之间也有自己的私聊；主测试账号无权读取这段历史。
    if (entry.members.length >= 6) {
      const a = entry.members[4]!;
      const b = entry.members[5]!;
      const id = openDirect(deps, a.userId, entry.wall.id, b.userId);
      if (!id) throw new Error('模拟成员私聊创建失败');
      result.directs += 1;
      pending.push({ conversationId: id, userId: a.userId, text: `${b.nickname}，刚在群里看到你的介绍，周末活动的时候想听你多讲讲。`, at: base + 20 * 60 * 60_000 + wallIndex * 20 * 60_000 });
      pending.push({ conversationId: id, userId: b.userId, text: '没问题，我也对你的作品很感兴趣，见面一起聊。', at: base + 20 * 60 * 60_000 + wallIndex * 20 * 60_000 + 5 * 60_000 });
    }
  });
  const sent = new Map<string, number[]>();
  for (const [index, message] of pending.sort((a, b) => a.at - b.at).entries()) {
    const item = sendMessage({ ...deps, now: () => new Date(message.at) }, message.userId, message.conversationId, `demo-message-${String(index).padStart(6, '0')}`, message.text);
    if (!item.ok) throw new Error(`模拟聊天失败：${item.error}`);
    result.messages += 1;
    const sequences = sent.get(message.conversationId) ?? [];
    sequences.push(item.message.sequence);
    sent.set(message.conversationId, sequences);
  }
  for (const [id, count] of readAt) {
    const sequence = sent.get(id)?.[count - 1];
    if (sequence !== undefined) deps.repos.chat.markRead(id, testerId, sequence);
  }
  return result;
}
