/** 本地双源服务共用一个进程；浏览器只需打开主站。 */
import { createServer, type Server } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import type { NowmeConfig } from '@nowme/contracts';
import { createPagesApp } from '@nowme/pages-host';
import type { WebApp } from '../src/app.js';

export async function checkLocalPorts(config: NowmeConfig): Promise<void> {
  for (const [name, endpoint] of [['主站', config.web], ['页面沙箱', config.pages]] as const) {
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(endpoint.port, endpoint.hostname, resolve);
      });
    } catch {
      throw new Error(`${name}端口 ${endpoint.port} 已被占用，请先关闭已有的 NOWMe 服务再启动。`);
    } finally {
      if (probe.listening) await closeServer(probe);
    }
  }
}

function closeServer(server: Server | ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
}

/** 任一端口启动失败都会释放已绑定端口；关闭可重复调用。 */
export async function startLocalServers(config: NowmeConfig & { ticketSecret: string }, web: Pick<WebApp, 'fetch'>) {
  const servers: ServerType[] = [];
  async function listen(fetch: WebApp['fetch'], endpoint: NowmeConfig['web']) {
    await new Promise<void>((resolve, reject) => {
      const server = serve({ fetch, port: endpoint.port, hostname: endpoint.hostname }, () => {
        server.off('error', reject);
        resolve();
      });
      servers.push(server);
      server.once('error', reject);
    });
  }
  try {
    await listen(web.fetch, config.web);
    await listen(createPagesApp(config).fetch, config.pages);
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    servers,
    close: () => closing ??= Promise.all(servers.map(closeServer)).then(() => undefined),
  };
}

export function handleLocalShutdown(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
