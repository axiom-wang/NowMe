/**
 * 事件上报钩子（contracts 4.1 `POST /api/agent/events`、6）。
 *
 * validate / preview 结束时调用 `reportEvent(type, props)`。只有工作目录里有 `nowme.json`
 * 且 `NOWME_HOME/credentials` 里有这个页面的凭证时才会交给 `send`；否则静默跳过。
 * 上报失败一律忽略，不影响命令本身。props 只保留数字与布尔值（最多 16 个键），不带任何内容。
 *
 * T1.3 只提供钩子：默认没有 `send`（不联网）。T2.3 实现 fetch / submit 时提供真正的发送函数。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EVENT_PROPS_MAX_KEYS,
  EVENT_PROP_KEY_PATTERN,
  NOWME_HOME_CREDENTIALS_FILE,
  WORKDIR_LINK_FILE,
  type AgentEventType,
} from '@nowme/contracts';
import { nowmeHome } from './workdir.js';

export type EventProps = Record<string, number | boolean>;

/** 工作目录的关联信息（`nowme.json`，不含密钥）。 */
export interface WorkdirLink {
  server: string;
  wallId: string;
  pageId: string;
}

export interface EventDelivery {
  link: WorkdirLink;
  /** 页面凭证（只交给发送函数，绝不打印）。 */
  credential: string;
  type: AgentEventType;
  props: EventProps;
}

/** 真正发送事件的函数（T2.3 提供）。 */
export type EventSender = (delivery: EventDelivery) => Promise<void>;

export type ReportEvent = (type: AgentEventType, props: EventProps) => Promise<void>;

/** 只保留数字（有限值）与布尔值、合法键名，最多 EVENT_PROPS_MAX_KEYS 个。 */
export function sanitizeEventProps(props: Record<string, unknown>): EventProps {
  const out: EventProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (Object.keys(out).length >= EVENT_PROPS_MAX_KEYS) break;
    if (!EVENT_PROP_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 读取工作目录的 `nowme.json`；不存在或格式不对时返回 null。 */
export async function readWorkdirLink(workDir: string): Promise<WorkdirLink | null> {
  const value = await readJson(join(workDir, WORKDIR_LINK_FILE));
  if (typeof value !== 'object' || value === null) return null;
  const { server, wallId, pageId } = value as Record<string, unknown>;
  if (typeof server !== 'string' || typeof wallId !== 'string' || typeof pageId !== 'string') return null;
  return { server, wallId, pageId };
}

/** 读取某个页面的凭证（`credentials` 按 pageId 索引）；没有时返回 null。 */
export async function readPageCredential(env: NodeJS.ProcessEnv, pageId: string): Promise<string | null> {
  const value = await readJson(join(nowmeHome(env), NOWME_HOME_CREDENTIALS_FILE));
  if (typeof value !== 'object' || value === null) return null;
  const entry = (value as Record<string, unknown>)[pageId];
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).credential === 'string') {
    return (entry as Record<string, string>).credential as string;
  }
  return null;
}

/** 创建上报函数：没有关联信息、没有凭证或没有发送函数时什么也不做。 */
export function createEventReporter(options: { workDir: string; env: NodeJS.ProcessEnv; send?: EventSender }): ReportEvent {
  return async (type, props) => {
    if (!options.send) return;
    try {
      const link = await readWorkdirLink(options.workDir);
      if (!link) return;
      const credential = await readPageCredential(options.env, link.pageId);
      if (!credential) return;
      await options.send({ link, credential, type, props: sanitizeEventProps(props) });
    } catch {
      // 上报失败不影响命令
    }
  };
}
