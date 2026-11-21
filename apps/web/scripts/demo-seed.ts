import { seedDemoAvatars } from './demo-avatars.js';
/**
 * 演示数据（`pnpm demo` 与 demo 种子测试共用）。
 *
 * - 黑客松墙：1 名组织者 + 6 名成员 + 1 名还没做页面的体验成员；墙上五位都是来组队的人（林舟、苏晴用 Skill 示例页，
 *   程野、方棠、祝一一用 demo-people/ 里真实生成的页面）。最后一名成员保持“已提交未发布”。组织者工具的数据见 demo-organizer.ts。
 * - 社团墙“山海摄影社 · 2026 秋季招新”：栗子、贺川、麦冬三位拍照的人，加上体验成员江予安与温溪两页。
 * - AI 共创与山野轻徒步墙各 10 人、6 页，体验成员保留空白工作区。
 * - 四个全员群和虚构私聊：经过聊天服务写入历史消息与部分已读位置。
 * 每名成员都走真实提交管线：生成 Agent 指令 → `/api/agent/exchange` 换凭证 → `/api/agent/revisions` 提交
 * （服务端校验 + 渲染），再以示例 `card.json` 的内容发布。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardSchema, generateId, LEGAL_VERSION, type ExchangeResponse, type RevisionResponse } from '@nowme/contracts';
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
import { seedDemoOrganizerTools } from './demo-organizer.js';
import { DEMO_CHATS, type DemoChatWallKey, type Session } from './demo-chats.js';

export const DEMO_DOMAIN = 'demo.nowme.test';
import { DEMO_WALL_NAME } from '../src/demo-access.js';
export { DEMO_WALL_NAME };
export const DEMO_CLUB_WALL_NAME = '山海摄影社 · 2026 秋季招新';

/** 真实生成后原样保存的人物页（见 demo-people/README.md）。 */
export const DEMO_PEOPLE_DIR = fileURLToPath(new URL('./demo-people/', import.meta.url));

interface DemoMemberPlan {
  /** 页面目录名：默认在 Skill 示例页里找；`people` 为 true 时在 demo-people/ 里找。 */
  dir: string;
  people?: boolean;
  profile?: { files: Record<string, string>; displayName: string };
  email: string;
  /** 发布时是否公开联系方式。 */
  contactPublic: boolean;
  contact: { channel: 'wechat' | 'email'; value: string };
  /** false：只提交，不发布。 */
  publish: boolean;
}

/** 黑客松墙的 6 名成员：墙上五位都是来组队的人，周一鸣只提交、不发布。 */
export const DEMO_MEMBER_PLANS: readonly DemoMemberPlan[] = [
  { dir: 'hackathon-terminal', email: `linzhou@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'linzhou_dev' }, publish: true },
  { dir: 'hackathon-poster', email: `suqing@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'suqing_design' }, publish: true },
  { dir: 'hack-chengye', people: true, email: `chengye@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'wechat', value: 'chengye_nlp' }, publish: true },
  { dir: 'hack-fangtang', people: true, email: `fangtang@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'email', value: `fangtang@${DEMO_DOMAIN}` }, publish: true },
  { dir: 'hack-zhuyiyi', people: true, email: `zhuyiyi@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'wechat', value: 'zhuyiyi_pitch' }, publish: true },
  { dir: 'club-senior-quest', email: `zhouyiming@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'zhou_yiming' }, publish: false },
];

/** 社团墙：三位拍照的人（各自的账号，不在黑客松墙里），各发布一页。 */
export const DEMO_CLUB_PLANS: readonly DemoMemberPlan[] = [
  { dir: 'interest-film-zine', email: `lizi@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'email', value: `lizi@${DEMO_DOMAIN}` }, publish: true },
  { dir: 'club-hechuan', people: true, email: `hechuan@${DEMO_DOMAIN}`, contactPublic: true, contact: { channel: 'wechat', value: 'hechuan_darkroom' }, publish: true },
  { dir: 'club-maidong', people: true, email: `maidong@${DEMO_DOMAIN}`, contactPublic: false, contact: { channel: 'wechat', value: 'maidong_2026' }, publish: true },
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

function readExample(plan: Pick<DemoMemberPlan, 'dir' | 'people'>): { files: Record<string, string>; displayName: string } {
  const root = join(plan.people ? DEMO_PEOPLE_DIR : EXAMPLES_DIR, plan.dir);
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
    repos.users.recordConsent(id, LEGAL_VERSION, nowIso()); // 种子账号视为已确认协议
    return id;
  };

  const organizerUserId = newUser(`organizer@${DEMO_DOMAIN}`, '组织者小乐');
  const organizer = { email: `organizer@${DEMO_DOMAIN}`, nickname: '组织者小乐', userId: organizerUserId };
  const { wall } = createWall(deps, {
    organizerId: organizer.userId,
    name: DEMO_WALL_NAME,
    description: '周末 48 小时，找到能一起熬夜的队友。',
    sceneType: 'hackathon',
    organizerNote: '先挂上自己的一页，再去墙上找人聊',
  });

  const members: DemoMember[] = [];
  const userIds = new Map<string, string>();
  for (const plan of DEMO_MEMBER_PLANS) {
    const userId = newUser(plan.email, readExample(plan).displayName);
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

  // 社团墙：三位拍照的人，再增补江予安与温溪两页。
  const { wall: clubWall } = createWall(deps, {
    organizerId: organizer.userId,
    name: DEMO_CLUB_WALL_NAME,
    description: '每周六早上扫街，月底一起冲洗胶片办小展。新社员、老社员都在这里挂一页，让大家先认识你。',
    sceneType: 'club',
    organizerNote: '新同学写写想拍什么，老社员写写可以来问你什么',
  });
  log(`社团墙「${DEMO_CLUB_WALL_NAME}」`);
  const clubMembers: DemoMember[] = [];
  for (const plan of DEMO_CLUB_PLANS) {
    const userId = userIds.get(plan.email) ?? newUser(plan.email, readExample(plan).displayName);
    userIds.set(plan.email, userId);
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
  seedDemoOrganizerTools(deps, wall, { organizerId: organizer.userId, testerId: tester.userId, members });

  const chat = seedDemoChats(web, tester.userId, [
    { key: 'hackathon', wall, members: [organizer, tester, ...members] },
    { key: 'club', wall: clubWall, members: [organizer, ...clubMembers] },
    ...extraWalls.map((entry, index): ChatWall => ({ ...entry, key: index === 0 ? 'ai' : 'trail' })),
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
      deps.repos.users.recordConsent(user.id, LEGAL_VERSION, deps.now().toISOString());
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
  const example = plan.profile ?? readExample(plan);
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
  key: DemoChatWallKey;
  wall: Wall;
  members: readonly { userId: string; nickname: string }[];
}

/** 经过实际聊天服务写入，包含历史往返、部分已读与待回复消息，不调用模型。 */
function seedDemoChats(web: WebApp, testerId: string, walls: readonly ChatWall[]): DemoSeed['chat'] {
  const { deps } = web;
  const result = { groups: 0, directs: 0, messages: 0 };
  const now = deps.now().getTime();
  // 全部消息按时间顺序写入，保证序号排序与时间排序一致。
  const pending: { conversationId: string; userId: string; text: string; at: number }[] = [];
  const readAt = new Map<string, number>();

  for (const entry of walls) {
    const script = DEMO_CHATS[entry.key];
    const members = new Map(entry.members.map((member) => [member.nickname, member.userId]));
    const speakerId = (speaker: string): string => {
      if (speaker === 'me') return testerId;
      const userId = members.get(speaker);
      if (!userId) throw new Error(`模拟聊天的昵称在墙内不存在：${entry.wall.name}/${speaker}`);
      return userId;
    };
    const addSessions = (conversationId: string, sessions: readonly Session[]): void => {
      for (const session of sessions) {
        let at = now - session.hoursAgo * 60 * 60_000;
        session.lines.forEach(([speaker, text], index) => {
          if (index > 0) {
            const previous = session.lines[index - 1]![1];
            at += (1 + [...previous].length % 6) * 60_000;
          }
          pending.push({ conversationId, userId: speakerId(speaker), text, at });
        });
      }
    };
    const setRead = (conversationId: string, sessions: readonly Session[], read: number): void => {
      const count = sessions.reduce((total, session) => total + session.lines.length, 0);
      if (read < 0 || read > count) throw new Error(`模拟聊天的已读位置超出消息数：${entry.wall.name}`);
      readAt.set(conversationId, read);
    };

    const groupId = deps.repos.chat.ensureGroup(entry.wall.id, entry.wall.createdAt);
    result.groups += 1;
    addSessions(groupId, script.group.sessions);
    setRead(groupId, script.group.sessions, script.group.read);

    for (const direct of script.directs) {
      const otherId = speakerId(direct.with);
      const conversationId = openDirect(deps, testerId, entry.wall.id, otherId);
      if (!conversationId) throw new Error(`模拟私聊创建失败：${direct.with}`);
      result.directs += 1;
      addSessions(conversationId, direct.sessions);
      setRead(conversationId, direct.sessions, direct.read);
    }

    // 其他成员之间也有自己的私聊；体验成员无权读取这些历史。
    for (const peer of script.peers) {
      const aId = speakerId(peer.a);
      const bId = speakerId(peer.b);
      const conversationId = openDirect(deps, aId, entry.wall.id, bId);
      if (!conversationId) throw new Error(`模拟成员私聊创建失败：${peer.a}/${peer.b}`);
      result.directs += 1;
      addSessions(conversationId, peer.sessions);
    }
  }

  for (const message of pending) {
    if (message.at >= now) throw new Error(`模拟聊天时间不能等于或晚于种子时刻：${message.text}`);
  }
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
