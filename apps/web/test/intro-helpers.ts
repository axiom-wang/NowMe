/**
 * “AI 介绍值得认识的人”（contracts 20）测试共用：一面墙（查看者 + 三位已上墙的成员 + 一位还没上墙的成员）、发起、读库。
 */
import type { Wall } from '../src/db/walls.js';
import { get, login, seedWall, type TestSession } from './helpers.js';
import { createHostedTestWeb, joinAs, type HostedOwner, type HostedTestWeb } from './hosted-helpers.js';
import { putOnWall } from './icebreaker-helpers.js';
import { post } from './publish-helpers.js';

export interface IntroWorld {
  t: HostedTestWeb;
  wall: Wall;
  organizer: TestSession;
  /** 苏晴（hackathon-poster），已上墙。 */
  viewer: HostedOwner;
  /** 林舟、阿岚、栗子，都已上墙。 */
  targets: HostedOwner[];
  /** 小白：加入了墙，还没上墙。 */
  pending: HostedOwner;
  outsider: TestSession;
}

export const TARGET_EXAMPLES = ['hackathon-terminal', 'interest-vinyl', 'interest-film-zine'] as const;

export async function introWorld(options: { viewerOnWall?: boolean } = {}): Promise<IntroWorld> {
  const t = createHostedTestWeb();
  const organizer = await login(t, 'org@example.com', '组织者');
  const { wall } = seedWall(t, organizer.userId, '周末黑客松');
  const viewer = await joinAs(t, wall, 'viewer@example.com', '苏晴');
  const targets: HostedOwner[] = [];
  for (const [index, example] of TARGET_EXAMPLES.entries()) {
    const target = await joinAs(t, wall, `target${index}@example.com`, `成员${index}`);
    await putOnWall(t, wall, target, example);
    targets.push(target);
  }
  const pending = await joinAs(t, wall, 'pending@example.com', '小白');
  const outsider = await login(t, 'outsider@example.com', '路人');
  if (options.viewerOnWall !== false) await putOnWall(t, wall, viewer, 'hackathon-poster');
  return { t, wall, organizer, viewer, targets, pending, outsider };
}

export function introPath(wall: Wall): string {
  return `/w/${wall.id}/intros`;
}

/** 查看者请 AI 介绍一次（整页表单），返回跳转地址。 */
export async function askIntro(t: HostedTestWeb, wall: Wall, viewer: HostedOwner, fields: Record<string, string> = {}): Promise<{ status: number; location: string }> {
  const response = await post(t, viewer.session, introPath(wall), fields);
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

export async function wallHtml(t: HostedTestWeb, wall: Wall, session: TestSession, query = ''): Promise<string> {
  const response = await get(t, `/w/${wall.id}${query}`, { cookie: session.cookie });
  if (response.status !== 200) throw new Error(`墙 ${response.status}`);
  return response.text();
}

export function storedIntro(t: HostedTestWeb, viewer: HostedOwner, wall: Wall) {
  return t.repos.intros.findForViewerWall(viewer.session.userId, wall.id);
}

export function introRows(t: HostedTestWeb): number {
  return Number((t.db.prepare('SELECT COUNT(*) AS n FROM intros').get() as { n: number }).n);
}

/** 假模型最近一次“介绍”调用里，交给模型的用户消息全文。 */
export function lastIntroPrompt(t: HostedTestWeb): string {
  const call = [...t.fake.calls].reverse().find((item) => JSON.stringify(item.tool_choice ?? '').includes('submit_intro'));
  if (!call) throw new Error('没有找到 submit_intro 调用');
  return JSON.stringify(call.messages);
}

export function introCalls(t: HostedTestWeb): number {
  return t.fake.calls.filter((item) => JSON.stringify(item.tool_choice ?? '').includes('submit_intro')).length;
}
