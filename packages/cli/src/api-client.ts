/**
 * Agent API 客户端（contracts 4.1）。凭证只放在 Authorization 头里，不进日志、不进错误信息。
 */
import { DEFAULT_WEB_ORIGIN } from '@nowme/contracts';
import type { EventDelivery } from './events.js';

export const REQUEST_TIMEOUT_MS = 30_000;

export class NetworkError extends Error {}

export interface ApiResult {
  status: number;
  body: unknown;
}

/** 只接受 http(s) 源；返回规范化的 origin。 */
export function normalizeServer(input: string | undefined): string {
  const raw = input ?? DEFAULT_WEB_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`服务器地址不正确：${raw}（应形如 http://localhost:3000）`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`服务器地址只接受 http 或 https：${raw}`);
  if (url.username || url.password) throw new Error('服务器地址里不要带用户名和密码');
  return url.origin;
}

export async function apiRequest(
  server: string,
  path: string,
  options: { method: 'GET' | 'POST'; credential?: string; body?: unknown; timeoutMs?: number },
): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.credential) headers.authorization = `Bearer ${options.credential}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, server), {
      method: options.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new NetworkError(`无法连接 ${server}${cause ? `（${cause}）` : ''}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed };
}

export interface ApiError {
  code: string;
  message: string;
}

export function readApiError(result: ApiResult): ApiError {
  const error = (result.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: typeof error?.message === 'string' ? error.message : `服务器返回 ${result.status}`,
  };
}

/** 默认的事件发送函数：失败由调用方吞掉。 */
export async function sendEventHttp(delivery: EventDelivery): Promise<void> {
  const result = await apiRequest(delivery.link.server, '/api/agent/events', {
    method: 'POST',
    credential: delivery.credential,
    body: { type: delivery.type, props: delivery.props },
    timeoutMs: 5000,
  });
  if (result.status !== 204) throw new Error(`事件上报失败（${result.status}）`);
}
