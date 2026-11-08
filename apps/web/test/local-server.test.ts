import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '@nowme/contracts';
import { checkLocalPorts, startLocalServers } from '../scripts/local-server.js';
import { prepareDemoDirectory } from '../scripts/demo-data.js';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const config = () => {
  const c = loadConfig({ NODE_ENV: 'test' });
  return { ...c, ticketSecret: 'local-server-test-secret-at-least-32', web: { ...c.web, port: 0 }, pages: { ...c.pages, port: 0 } };
};
const app = () => new Hono().get('/', (c) => c.text('NOWMe'));

describe('一个进程管理双源服务', () => {
  it('同时提供主站和页面沙箱，并一起关闭、释放两个端口', async () => {
    const runtime = await startLocalServers(config(), app());
    cleanups.push(runtime.close);
    const addresses = runtime.servers.map((server) => server.address() as AddressInfo);
    expect(await (await fetch(`http://localhost:${addresses[0]!.port}/`)).text()).toBe('NOWMe');
    const page = await fetch(`http://127.0.0.1:${addresses[1]!.port}/`);
    expect(page.status).toBe(404);
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(page.headers.get('content-security-policy')).toBeTruthy();
    expect(addresses[0]!.port).not.toBe(addresses[1]!.port);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(runtime.servers.every((server) => !server.listening)).toBe(true);
    for (const address of addresses) {
      const probe = createServer();
      await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(address.port, address.address, resolve));
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it('启动前检查两个端口，第二个端口冲突时不留下主站', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const c = config();
    c.pages.port = (occupied.address() as AddressInfo).port;
    const first = createServer();
    await new Promise<void>((resolve) => first.listen(0, c.web.hostname, resolve));
    c.web.port = (first.address() as AddressInfo).port;
    await new Promise<void>((resolve) => first.close(() => resolve()));
    await expect(checkLocalPorts(c)).rejects.toThrow('页面沙箱端口');
    await expect(startLocalServers(c, app())).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((resolve, reject) => first.once('error', reject).listen(c.web.port, c.web.hostname, resolve));
    await new Promise<void>((resolve) => first.close(() => resolve()));
  });
});

describe('演示重启保留数据', () => {
  it('首次初始化，后续保留数据库和其他文件，显式重置才清空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-demo-restart-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(prepareDemoDirectory(dir, false)).toBe(false);
    writeFileSync(join(dir, 'db.sqlite'), 'existing database');
    writeFileSync(join(dir, 'page.html'), 'existing page');
    expect(prepareDemoDirectory(dir, false)).toBe(true);
    expect(readFileSync(join(dir, 'db.sqlite'), 'utf8')).toBe('existing database');
    expect(readFileSync(join(dir, 'page.html'), 'utf8')).toBe('existing page');
    expect(prepareDemoDirectory(dir, true)).toBe(false);
    expect(existsSync(join(dir, 'db.sqlite'))).toBe(false);
    expect(existsSync(join(dir, 'page.html'))).toBe(false);
  });
});
