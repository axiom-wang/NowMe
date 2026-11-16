/**
 * “问墙”（contracts 21）测试共用：沿用 AI 介绍的那面墙（查看者苏晴 + 林舟、阿岚、栗子三位已上墙 + 小白还没上墙），
 * 加上提问、读库与假模型调用的读取。
 */
import type { Wall } from '../src/db/walls.js';
import type { HostedOwner, HostedTestWeb } from './hosted-helpers.js';
import { introWorld, wallHtml, type IntroWorld } from './intro-helpers.js';
import { post } from './publish-helpers.js';

export type AskWorld = IntroWorld;
export const askWorld = introWorld;
export { wallHtml };

export function askPath(wall: Wall): string {
  return `/w/${wall.id}/ask`;
}

/** 查看者在墙上问一句（整页表单），返回跳转地址。 */
export async function askQuestion(t: HostedTestWeb, wall: Wall, viewer: HostedOwner, question: string, fields: Record<string, string> = {}): Promise<{ status: number; location: string }> {
  const response = await post(t, viewer.session, askPath(wall), { question, ...fields });
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

export function storedAsk(t: HostedTestWeb, viewer: HostedOwner, wall: Wall) {
  return t.repos.asks.findForViewerWall(viewer.session.userId, wall.id);
}

export function askRows(t: HostedTestWeb): number {
  return Number((t.db.prepare('SELECT COUNT(*) AS n FROM wall_asks').get() as { n: number }).n);
}

export function askMatchRows(t: HostedTestWeb): number {
  return Number((t.db.prepare('SELECT COUNT(*) AS n FROM wall_ask_matches').get() as { n: number }).n);
}

/** 假模型最近一次“问墙”调用里，交给模型的用户消息全文。 */
export function lastAskPrompt(t: HostedTestWeb): string {
  const call = [...t.fake.calls].reverse().find((item) => JSON.stringify(item.tool_choice ?? '').includes('submit_answer'));
  if (!call) throw new Error('没有找到 submit_answer 调用');
  return JSON.stringify(call.messages);
}

export function askCalls(t: HostedTestWeb): number {
  return t.fake.calls.filter((item) => JSON.stringify(item.tool_choice ?? '').includes('submit_answer')).length;
}
