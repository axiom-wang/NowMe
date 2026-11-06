import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readKitStaticFile } from '@nowme/kit';
import { FONT_FIXTURE, PNG_BYTES, REV_A, makeFixture } from './helpers.js';

describe('正常路径', () => {
  const { app, ticket } = makeFixture();
  const t = ticket(REV_A);

  it('index 两种路径', async () => {
    for (const p of ['/', '/index.html']) {
      const res = await app.request(`/v/${t}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(REV_A);
    }
  });

  it('/v/:ticket 308 到带斜杠', async () => {
    const res = await app.request(`/v/${t}`);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`/v/${t}/`);
    expect((await app.request(`/v/${t}`, { method: 'HEAD' })).status).toBe(308);
  });

  it('assets 与 content-type', async () => {
    const png = await app.request(`/v/${t}/assets/a.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    const jpg = await app.request(`/v/${t}/assets/sub/b.jpg`);
    expect(jpg.headers.get('content-type')).toBe('image/jpeg');
    expect(await jpg.text()).toBe('jpgdata');
  });

  it('fonts', async () => {
    const res = await app.request(`/v/${t}/_fonts/test-400.woff2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/woff2');
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(FONT_FIXTURE))).toBe(true);
  });

  it('kit 静态文件', async () => {
    const css = await app.request('/_nowme/kit/v1/nowme.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    expect(css.headers.get('cache-control')).toMatch(/max-age/);
    expect(await css.text()).toBe(readKitStaticFile('nowme.css').toString());
    const js = await app.request('/_nowme/kit/v1/nowme.js');
    expect(js.headers.get('content-type')).toMatch(/javascript/);
  });

  it('HEAD 无正文但有长度', async () => {
    for (const url of [
      `/v/${t}/`,
      `/v/${t}/assets/a.png`,
      `/v/${t}/_fonts/test-400.woff2`,
      '/_nowme/kit/v1/nowme.css',
    ]) {
      const res = await app.request(url, { method: 'HEAD' });
      expect(res.status, url).toBe(200);
      expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0);
      expect(await res.text()).toBe('');
    }
  });

  it('未知路径 404，非 GET/HEAD 拒绝', async () => {
    for (const url of ['/', '/api/agent/context', '/v/x/y', `/v/${t}/other`, `/v/${t}/assets/`]) {
      expect((await app.request(url)).status, url).toBe(404);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect((await app.request(`/v/${t}/`, { method })).status).toBe(405);
    }
  });
});
