/**
 * 注销与导出（contracts 14）测试共用：读 zip、搭一个“什么都有”的账号。
 */
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { connectAgent, get, issueInstruction, login, seedWall, type TestSession, type TestWeb } from './helpers.js';
import { completeInterview, createHostedTestWeb, joinAs, type HostedOwner, type HostedTestWeb } from './hosted-helpers.js';
import { askIcebreaker, putOnWall } from './icebreaker-helpers.js';
import { enablePublicLink, post } from './publish-helpers.js';
import type { Wall } from '../src/db/walls.js';
import { grantCredits } from '../src/services/billing.js';

/** 解析 zip（只支持 store / deflate），返回 路径 → 内容。同时校验 CRC。 */
export function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('不是 zip');
  const count = buf.readUInt16LE(end + 10);
  let offset = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localName = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const body = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return out;
}

export async function downloadExport(t: HostedTestWeb, session: TestSession): Promise<{ response: Response; files: Map<string, Buffer>; data: Record<string, unknown> }> {
  const response = await get(t, '/account/export', { cookie: session.cookie });
  if (response.status !== 200) throw new Error(`导出失败：${response.status}`);
  const files = readZip(new Uint8Array(await response.arrayBuffer()));
  const data = JSON.parse(files.get('data.json')?.toString('utf8') ?? '{}') as Record<string, unknown>;
  return { response, files, data };
}

export const OWNER_MATERIAL = '我叫阿柚，做过 3 个校园小程序。秘密爱好是在天台上种番茄。';
export const OWNER_PROFILE_TEXT = '阿柚的长期画像：喜欢在天台种番茄';
export const OWNER_MESSAGE = '阿柚在群里说：周六一起去看展吗';
export const OWNER_DIRECT = '阿柚私聊说：我的微信是 ayou_secret';
export const PEER_DIRECT_TO_OTHER = '林舟私下对小白说的悄悄话';
export const PEER_GROUP = '林舟在群里说：欢迎新同学';
export const THIRD_MATERIAL = '小白的采访：偷偷在学架子鼓，还没告诉任何人';
export const API_KEY = 'sk-ant-api03-account-export-secret-key';
export const ENCRYPTION = { NOWME_AI_ENCRYPTION_KEY: 'ab'.repeat(32) };

export interface AccountWorld {
  t: HostedTestWeb;
  wall: Wall;
  organizer: TestSession;
  /** 要注销 / 导出的人：页面已发布、公开链接开着、连着本地 Agent、有采访、画像、头像、破冰结果、聊天、点数、模型配置。 */
  owner: HostedOwner;
  /** 同墙的另一位成员（页面已发布）。 */
  peer: HostedOwner;
  third: HostedOwner;
  credential: string;
  pendingToken: string;
  publicToken: string;
  groupId: string;
  directId: string;
}

async function send(t: HostedTestWeb, session: TestSession, conversationId: string, text: string): Promise<void> {
  const response = await post(t, session, `/messages/${conversationId}/send`, { text, clientId: randomUUID() });
  if (response.status !== 303) throw new Error(`发消息失败：${response.status}`);
}

export async function accountWorld(): Promise<AccountWorld> {
  const t = createHostedTestWeb({ secretEnv: ENCRYPTION });
  const organizer = await login(t, 'org@example.com', '组织者');
  const { wall } = seedWall(t, organizer.userId, '周末黑客松');
  const owner = await joinAs(t, wall, 'ayou@example.com', '阿柚');
  const peer = await joinAs(t, wall, 'linzhou@example.com', '林舟');
  const third = await joinAs(t, wall, 'third@example.com', '小白');

  await completeInterview(t, wall, owner, OWNER_MATERIAL);
  await completeInterview(t, wall, third, THIRD_MATERIAL);
  await putOnWall(t, wall, peer, 'hackathon-terminal');
  await putOnWall(t, wall, owner, 'hackathon-poster', { tagline: '阿柚：在天台种番茄的前端' });
  const publicToken = await enablePublicLink(t, owner.session, wall.id, owner.member.page.id);
  const credential = await connectAgent(t, wall, owner.member.page);
  const pendingToken = issueInstruction(t, wall, owner.member.page).token;
  // 再生成一条还没被换取的指令（已经换到的凭证仍有效）
  const asked = await askIcebreaker(t, wall, owner, peer);
  if (asked.status !== 303) throw new Error(`破冰失败：${asked.status}`);
  // 对方也针对他的页面找过话题（注销时一并清掉）
  await askIcebreaker(t, wall, peer, owner);
  const nowIso = t.clock.now().toISOString();
  t.repos.profileEntries.insert({ id: 'pfe_aaaaaaaaaaaaaaaaaaaaaaaaaa', userId: owner.session.userId, category: 'fact', text: OWNER_PROFILE_TEXT, source: 'interview', confirmation: 'owner-stated', createdAt: nowIso, updatedAt: nowIso });
  t.db.prepare('UPDATE users SET avatar_webp = ?, avatar_version = ? WHERE id = ?').run(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), 'v1', owner.session.userId);
  const settings = { provider: 'anthropic', baseUrl: '', model: '', apiKey: API_KEY, vision: false };
  t.web.deps.userModels.save(owner.session.userId, { interview: settings, generate: settings });
  grantCredits(t.web.deps, owner.session.userId, 30);

  const groupId = t.repos.chat.ensureGroup(wall.id, nowIso);
  const directId = t.repos.chat.ensureDirect(wall.id, owner.session.userId, peer.session.userId, nowIso);
  const otherDirect = t.repos.chat.ensureDirect(wall.id, peer.session.userId, third.session.userId, nowIso);
  await send(t, owner.session, groupId, OWNER_MESSAGE);
  await send(t, peer.session, groupId, PEER_GROUP);
  await send(t, owner.session, directId, OWNER_DIRECT);
  await send(t, peer.session, otherDirect, PEER_DIRECT_TO_OTHER);
  return { t, wall, organizer, owner, peer, third, credential, pendingToken, publicToken, groupId, directId };
}

/** 发注销确认码并取出（内存发件箱里最新一封“注销”邮件）。 */
export async function requestDeletionCode(t: TestWeb, session: TestSession): Promise<{ status: number; code: string | null }> {
  const response = await post(t, session, '/account/delete/code');
  const mail = [...t.outbox.messages].reverse().find((item) => item.to === session.email && item.subject.includes('注销'));
  return { status: response.status, code: mail?.body.match(/\d{6}/)?.[0] ?? null };
}

export function confirmDeletion(t: TestWeb, session: TestSession, code: string, fields: Record<string, string> = {}): Promise<Response> {
  return post(t, session, '/account/delete', { code, confirm: '1', ...fields });
}
