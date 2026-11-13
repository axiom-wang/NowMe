/**
 * “和 TA 聊什么”（contracts 11）测试共用：假模型的测试主站、把成员的页面挂上墙、发起一次。
 */
import type { Card } from '@nowme/contracts';
import type { Wall } from '../src/db/walls.js';
import { connectAgent, exampleFiles, get, type TestWeb } from './helpers.js';
import type { HostedOwner } from './hosted-helpers.js';
import { exampleCard, filesWithCard, post, publish, submitRevision } from './publish-helpers.js';

/** 用示例页给成员提交一个版本并发布到墙上；`card` 可以改写卡片（一行介绍、接话点）。返回发布用的卡片。 */
export async function putOnWall(t: TestWeb, wall: Wall, owner: HostedOwner, example = 'hackathon-terminal', card: Partial<Card> = {}): Promise<Card> {
  const credential = await connectAgent(t, wall, owner.member.page);
  const merged = { ...exampleCard(example), ...card };
  const revision = await submitRevision(t, credential, Object.keys(card).length > 0 ? filesWithCard(merged, example) : exampleFiles(example));
  if (revision.status !== 'accepted') throw new Error(`示例页没有通过校验：${JSON.stringify(revision)}`);
  const response = await publish(t, owner.session, wall.id, revision.id, merged);
  if (response.status !== 303) throw new Error(`发布失败：${response.status} ${(await response.text()).slice(0, 300)}`);
  return merged;
}

export function memberPath(wall: Wall, target: HostedOwner): string {
  return `/w/${wall.id}/p/${target.member.page.id}`;
}

/** 查看者对目标页发起“帮我找话题”，返回跳转地址。 */
export async function askIcebreaker(t: TestWeb, wall: Wall, viewer: HostedOwner, target: HostedOwner): Promise<{ status: number; location: string }> {
  const response = await post(t, viewer.session, `${memberPath(wall, target)}/icebreaker`);
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

export async function memberHtml(t: TestWeb, wall: Wall, viewer: HostedOwner, target: HostedOwner, query = ''): Promise<string> {
  const response = await get(t, `${memberPath(wall, target)}${query}`, { cookie: viewer.session.cookie });
  if (response.status !== 200) throw new Error(`成员页 ${response.status}`);
  return response.text();
}

/** 库里查看者对目标页保存的结果（解析后的 JSON）；没有时为 null。 */
export function storedIcebreaker(t: TestWeb, viewer: HostedOwner, target: HostedOwner) {
  const record = t.repos.icebreakers.findLatest(viewer.session.userId, target.member.page.id);
  if (!record) return null;
  return {
    record,
    result: JSON.parse(record.resultJson) as {
      links: { kind: string; title: string; mine: string; theirs: string }[];
      openers: { text: string; about: string }[];
      sources: { page: boolean; brief: boolean };
    },
  };
}

/** 假模型最近一次“找话题”调用里，交给模型的用户消息全文。 */
export function lastIcebreakerPrompt(t: { fake: { calls: { tool_choice?: unknown; messages: { role: string; content: unknown }[] }[] } }): string {
  const call = [...t.fake.calls].reverse().find((item) => JSON.stringify(item.tool_choice ?? '').includes('submit_icebreaker'));
  if (!call) throw new Error('没有找到 submit_icebreaker 调用');
  return JSON.stringify(call.messages);
}
