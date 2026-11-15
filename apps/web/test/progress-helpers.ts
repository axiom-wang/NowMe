/**
 * 实时进度（contracts 18.2）测试共用：不在本进程执行任务的主站（任务停在队列里，由测试手动写进度、结束任务）、读 SSE。
 */
import { generateId } from '@nowme/contracts';
import type { Wall } from '../src/db/walls.js';
import type { MemberPage } from '../src/services/walls.js';
import { login, seedMember, seedWall, type TestSession } from './helpers.js';
import { createHostedTestWeb, type HostedTestWeb } from './hosted-helpers.js';

export interface SseEvent {
  event: string;
  id: string | null;
  data: string;
}

export interface SseRead {
  events: SseEvent[];
  /** 原始文本（含心跳注释行）。 */
  raw: string;
  /** 服务端是否关闭了流。 */
  ended: boolean;
}

/** 读 SSE，直到流结束、`stop` 返回 true 或超时；之后取消读取（模拟浏览器离开）。 */
export async function readSse(response: Response, options: { timeoutMs?: number; stop?: (events: SseEvent[], raw: string) => boolean } = {}): Promise<SseRead> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  let raw = '';
  let ended = false;
  const parse = (): SseEvent[] =>
    raw
      .split('\n\n')
      .filter((block) => block.trim() && !block.startsWith(':'))
      .map((block) => {
        const lines = block.split('\n');
        const field = (name: string) => lines.filter((line) => line.startsWith(`${name}: `)).map((line) => line.slice(name.length + 2));
        return { event: field('event')[0] ?? 'message', id: field('id')[0] ?? null, data: field('data').join('\n') };
      })
      .filter((event) => event.data !== '' || event.event !== 'message');
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())))]);
    if (chunk === null) break;
    if (chunk.done) {
      ended = true;
      break;
    }
    raw += decoder.decode(chunk.value, { stream: true });
    if (options.stop?.(parse(), raw)) break;
  }
  if (!ended) await reader.cancel().catch(() => {});
  return { events: parse(), raw, ended };
}

export interface ProgressWorld {
  t: HostedTestWeb;
  wall: Wall;
  owner: TestSession;
  member: MemberPage;
  organizer: TestSession;
  /** 在主人的页面上建一个排队中的任务（写 `queued` 事件）。 */
  queueJob(options?: { kind?: 'generate' | 'edit'; requestText?: string | null }): string;
}

/** 任务不在本进程执行（separate 模式），时间参数缩短。 */
export async function progressWorld(progress: Record<string, number> = {}): Promise<ProgressWorld> {
  const t = createHostedTestWeb({
    env: { NOWME_WORKER_MODE: 'separate' },
    progress: { pollMs: 10, heartbeatMs: 40, maxStreamMs: 3000, ...progress },
  });
  const organizer = await login(t, 'org@example.com', '组织者');
  const { wall } = seedWall(t, organizer.userId, '周末黑客松');
  const owner = await login(t, 'owner@example.com', '阿柚');
  const member = seedMember(t, wall, owner.userId);
  return {
    t,
    wall,
    owner,
    member,
    organizer,
    queueJob(options = {}) {
      const id = generateId('gen');
      const at = t.clock.now().toISOString();
      t.repos.jobs.create({
        id,
        pageId: member.page.id,
        ownerId: owner.userId,
        kind: options.kind ?? 'generate',
        baseRevisionId: null,
        targetBlock: null,
        requestText: options.requestText ?? null,
        createdAt: at,
        modelSource: 'own',
      });
      t.repos.jobEvents.append(id, 'queued', at);
      return id;
    },
  };
}

/** 把任务标记为结束（不经过 worker）。 */
export function finishJob(t: HostedTestWeb, jobId: string, status: 'succeeded' | 'failed' | 'needs_input', revisionId: string | null = null): void {
  const at = t.clock.now().toISOString();
  t.repos.jobs.finish(jobId, {
    status,
    revisionId,
    errorCode: status === 'failed' ? 'REJECTED' : null,
    resultMessage: status === 'needs_input' ? '想改哪一块？' : null,
    charged: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 },
    finishedAt: at,
  });
  t.repos.jobEvents.append(jobId, status, at);
}
