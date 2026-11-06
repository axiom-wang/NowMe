import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { serve } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { REV_A, makeFixture, write } from '../helpers.js';

describe('路径安全', () => {
  const { app, ticket, dataDir } = makeFixture();
  const t = ticket(REV_A);
  const served = join(dataDir, 'revisions', REV_A, 'served');
  write(dataDir, 'outside', 'secret.png', 'OUTSIDE-SECRET');
  write(dataDir, 'outside', 'secret.woff2', 'OUTSIDE-SECRET');
  mkdirSync(join(dataDir, 'revisions/outside/dir'), { recursive: true });
  write(dataDir, 'outside', 'dir/in.png', 'OUTSIDE-SECRET');
  symlinkSync(join(dataDir, 'revisions/outside/secret.png'), join(served, 'assets/link.png'));
  symlinkSync(join(dataDir, 'revisions/outside/secret.woff2'), join(served, '_fonts/link.woff2'));
  symlinkSync(join(dataDir, 'revisions/outside/dir'), join(served, 'assets/linkdir'));
  symlinkSync(join(dataDir, 'revisions/outside/secret.png'), join(served, 'index-link.html'));

  const bad = [
    '/assets/..%2findex.html',
    '/assets/%2e%2e%2f%2e%2e%2foriginal/index.html',
    '/assets/..%5cindex.html',
    '/assets/a.png%00.txt',
    `/assets/${'a'.repeat(300)}.png`,
    '/original/index.html',
    '/render/full.png',
    '/cover.png',
    '/served/index.html',
    '/index-link.html',
    '/assets//a.png',
    '/assets/a.png/',
    '/assets/notes.txt',
    '/assets/link.png',
    '/assets/linkdir/in.png',
    '/_fonts/link.woff2',
    '/_fonts/test-400.woff2/x',
    '/_fonts/sub/x.woff2',
    '/_fonts/a.ttf',
    '//etc/passwd',
    '/assets/%252e%252e/index.html',
  ];
  for (const path of bad) {
    it(`拒绝 ${JSON.stringify(path).slice(0, 60)}`, async () => {
      const res = await app.request(`/v/${t}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/SECRET|ORIGINAL|OUTSIDE/);
    });
  }

  it('绝对路径与 kit 穿越', async () => {
    for (const url of [
      `/v/${t}/%2fetc/passwd`,
      '/_nowme/kit/v1/nowme.css%00',
      '/_nowme/kit/v1/%2e%2e/nowme.css',
      '/_nowme/kit/v1/nowme.css/x',
      '/_nowme/kit/v1/package.json',
      '/_nowme/kit/v1/',
    ]) {
      expect((await app.request(url)).status, url).toBe(404);
    }
  });

  it('served 或 index.html 本身是符号链接时不返回', async () => {
    const fx = makeFixture();
    const served2 = join(fx.dataDir, 'revisions', REV_A, 'served');
    rmSync(served2, { recursive: true });
    symlinkSync(join(fx.dataDir, 'revisions', REV_A, 'original'), served2);
    expect((await fx.app.request(`/v/${fx.ticket()}/`)).status).toBe(404);

    const fx2 = makeFixture();
    const index = join(fx2.dataDir, 'revisions', REV_A, 'served/index.html');
    rmSync(index);
    symlinkSync(join(fx2.dataDir, 'revisions', REV_A, 'original/index.html'), index);
    const res = await fx2.app.request(`/v/${fx2.ticket()}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('ORIGINAL');
  });

  it('原始请求行（不经 URL 规范化）：穿越、编码斜杠、空字节、反斜杠都得不到文件', async () => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const raw = (target: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1', () =>
          socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
        );
        let data = '';
        socket.on('data', (d) => (data += d));
        socket.on('close', () => resolve(data));
        socket.on('error', () => resolve(data));
      });
    try {
      for (const tail of [
        '/assets/../../../original/index.html',
        '/assets/%2e%2e/%2e%2e/original/index.html',
        '/assets/..%2f..%2foriginal/index.html',
        '/assets/..%5c..%5coriginal%5cindex.html',
        '/assets/..\\..\\original/index.html',
        '/assets/a.png%00.txt',
        '/assets/a.png%00',
        '/assets/%00',
      ]) {
        const out = await raw(`/v/${t}${tail}`);
        expect(out, tail).not.toMatch(/ORIGINAL-SECRET|OUTSIDE/);
        expect(out.split('\r\n')[0], tail).toMatch(/HTTP\/1\.1 (404|400)/);
      }
    } finally {
      server.close();
    }
  });
});
