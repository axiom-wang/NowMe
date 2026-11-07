/** 模型请求只允许公网 HTTPS；DNS 结果固定到本次连接，拒绝重定向及 DNS 重绑定。 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { ModelAccessError } from '../hosted/model-errors.js';

export type ModelLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const ipv6Public = new BlockList();
ipv6Public.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

export function isPublicModelAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && ipv6Public.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
function loopback(address: string): boolean { return address === '::1' || /^127\./.test(address); }

export function validateModelUrl(raw: string, allowLocal = false): URL {
  try {
    if (raw.length > 2048) throw new Error();
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = allowLocal && (host === 'localhost' || loopback(host));
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error();
    if (isIP(host) && !isPublicModelAddress(host) && !local) throw new Error();
    if (!isIP(host) && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) && !local) throw new Error();
    return url;
  } catch { throw new ModelAccessError('MODEL_CONFIG'); }
}

export function createModelFetch(options: { allowLocal?: boolean; lookup?: ModelLookup; transport?: typeof fetch; authorize?: () => void } = {}): typeof fetch {
  const resolve = options.lookup ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    options.authorize?.();
    // SDK 以 URL + init 调用；不接受可能隐藏跳转或 body 语义的 Request 对象。
    if (input instanceof Request) throw new ModelAccessError('MODEL_CONFIG');
    const url = validateModelUrl(String(input), options.allowLocal);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
        resolve(host),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(() => reject(new ModelAccessError('MODEL_UNAVAILABLE')), 10000);
          dnsTimer.unref();
        }),
      ]);
    } catch { throw new ModelAccessError('MODEL_UNAVAILABLE'); }
    finally { clearTimeout(dnsTimer); }
    const localAllowed = options.allowLocal && (host === 'localhost' || loopback(host));
    if (!addresses.length || addresses.some(({ address }) => !isPublicModelAddress(address) && !(localAllowed && loopback(address)))) throw new ModelAccessError('MODEL_CONFIG');
    options.authorize?.();
    // 测试可替换传输，但同样经过 URL 与 DNS 检查。
    if (options.transport) {
      const response = await options.transport(input, { ...init, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ModelAccessError('MODEL_CONFIG'); }
      return response;
    }
    const address = addresses[0]!;
    return new Promise<Response>((resolveResponse, reject) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      headers.host = url.host;
      headers['accept-encoding'] = 'identity';
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send({
        hostname: address.address, family: address.family, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        servername: isIP(host) ? undefined : host,
        path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', headers,
        signal: init?.signal ?? AbortSignal.timeout(300000), agent: false,
      }, (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) { res.destroy(); reject(new ModelAccessError('MODEL_CONFIG')); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) { res.destroy(new Error('response limit')); return; }
          chunks.push(chunk);
        });
        res.on('error', () => reject(new ModelAccessError('MODEL_UNAVAILABLE')));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
          resolveResponse(new Response(status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      });
      req.on('error', () => reject(new ModelAccessError('MODEL_UNAVAILABLE')));
      if (typeof init?.body === 'string') req.write(init.body);
      else if (init?.body != null) { req.destroy(); reject(new ModelAccessError('MODEL_CONFIG')); return; }
      req.end();
    });
  }) as typeof fetch;
}
