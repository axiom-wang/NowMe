/**
 * 请求来自哪个地址（按地址限流用，contracts 10.3）。
 *
 * - `NOWME_TRUST_PROXY=0`（默认）：只用 TCP 连接的对端地址，忽略 `X-Forwarded-For`（任何人都能伪造这个头）。
 * - `NOWME_TRUST_PROXY=N`：进程前面有 N 层可信反向代理，取 `X-Forwarded-For` 从右数第 N 个
 *   （右边 N−1 个是我们自己的代理追加的，再往左才是客户端可以伪造的部分）。头缺失或层数不够时退回连接地址。
 * - 拿不到地址（测试里直接调用 `app.request`）时返回 `unknown`，所有这类请求算同一个来源。
 */
import { isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export const UNKNOWN_CLIENT = 'unknown';

function normalize(address: string): string {
  const trimmed = address.trim().replace(/^\[(.*)\]$/, '$1');
  // IPv4 映射的 IPv6（::ffff:1.2.3.4）按 IPv4 记
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return (mapped?.[1] ?? trimmed).toLowerCase();
}

export function clientAddress(c: Context, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((part) => normalize(part))
      .filter(Boolean);
    const picked = forwarded[forwarded.length - trustProxyHops];
    if (picked && isIP(picked)) return picked;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return normalize(address);
  } catch {
    // 没有底层连接（测试）
  }
  return UNKNOWN_CLIENT;
}
