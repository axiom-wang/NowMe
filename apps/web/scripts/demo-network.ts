/** 本地代理的 fake-IP DNS 会被安全策略拒绝；可显式指定独立 DNS，仍逐次校验并固定公网连接。 */
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ModelLookup } from '../src/security/model-network.js';

interface DemoResolver {
  setServers(servers: string[]): void;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}
export function createDemoModelLookup(env: Readonly<Record<string, string | undefined>>, resolver: DemoResolver = new Resolver({ timeout: 3000, tries: 1 })): ModelLookup | undefined {
  const raw = env.NOWME_DEMO_DNS_SERVERS;
  if (!raw) return undefined;
  const servers = raw.split(',').map((server) => server.trim());
  if (!servers.length || servers.some((server) => !isIP(server))) throw new Error('NOWME_DEMO_DNS_SERVERS 必须为逗号分隔的 DNS 服务器 IP');
  resolver.setServers(servers);
  return async (hostname) => {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses: { address: string; family: number }[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') addresses.push(...result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })));
      else if (!['ENODATA', 'ENOTFOUND'].includes((result.reason as { code?: string }).code ?? '')) throw new Error('演示模型 DNS 解析失败');
    }
    return addresses;
  };
}
