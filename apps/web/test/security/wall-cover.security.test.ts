/** 墙封面：只有组织者可写、有效成员可读；CSRF、图片内容校验与失效访问。 */
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WALL_COVER_MAX_BYTES, WALL_COVER_REQUEST_MAX_BYTES } from '@nowme/contracts';
import { createTestWeb, get, login, postForm, seedMember, seedWall, type TestSession, type TestWeb } from '../helpers.js';
import type { Wall } from '../../src/db/walls.js';
import { uploadWallCover } from '../../src/services/wall-cover.js';

async function png(color = '#d7ff22') {
  return sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).png().toBuffer();
}

async function upload(t: TestWeb, wall: Wall, session: TestSession, bytes: Uint8Array | Uint8Array[], options: { csrf?: string; origin?: string; filename?: string } = {}) {
  const data = new FormData();
  data.append('_csrf', options.csrf ?? session.csrf);
  for (const image of Array.isArray(bytes) ? bytes : [bytes]) data.append('cover', new Blob([new Uint8Array(image)], { type: 'image/png' }), options.filename ?? 'cover.png');
  return t.request(`/w/${wall.id}/admin/cover`, { method: 'POST', headers: { cookie: session.cookie, origin: options.origin ?? t.config.webOrigin }, body: data });
}

describe('墙封面安全与上传闭环', () => {
  let t: TestWeb;
  let owner: TestSession;
  let member: TestSession;
  let wall: Wall;
  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '组织者');
    member = await login(t, 'member@example.com', '成员');
    ({ wall } = seedWall(t, owner.userId));
    seedMember(t, wall, member.userId);
  });
  afterEach(async () => { await t.close(); });

  it('上传、成员查看、首页展示、更换、删除恢复默认；不保留原文件名与 EXIF', async () => {
    const jpeg = await sharp(await png()).withMetadata({ exif: { IFD0: { Artist: 'private-camera-owner' } } }).jpeg().toBuffer();
    expect((await upload(t, wall, owner, jpeg, { filename: '../../secret.jpg' })).status).toBe(303);
    const firstUrl = t.repos.walls.coverUrl(wall.id)!;
    const response = await get(t, firstUrl, { cookie: member.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBe(60);
    expect(metadata.height).toBe(metadata.width);
    const home = await (await get(t, '/', { cookie: member.cookie })).text();
    expect(home).toContain(firstUrl.replaceAll('&', '&amp;'));
    expect(home).not.toContain('secret.jpg');
    expect((await upload(t, wall, owner, await png('#3355ff'))).status).toBe(303);
    expect(t.repos.walls.coverUrl(wall.id)).not.toBe(firstUrl);
    expect(t.db.prepare('SELECT count(*) AS n FROM wall_covers').get()).toEqual({ n: 1 });
    expect((await postForm(t, `/w/${wall.id}/admin/cover/delete`, { _csrf: owner.csrf }, { cookie: owner.cookie })).status).toBe(303);
    expect((await get(t, firstUrl, { cookie: member.cookie })).status).toBe(404);
    expect(await (await get(t, '/', { cookie: member.cookie })).text()).toContain('/static/home-wall-laptop.svg');
  });

  it('普通成员、其他组织者、非成员不能写；外部来源、错误 CSRF、仅页面凭证不能写', async () => {
    const outsider = await login(t, 'outsider@example.com');
    seedWall(t, outsider.userId);
    const image = await png();
    for (const session of [member, outsider]) {
      expect((await upload(t, wall, session, image)).status).toBe(404);
      expect((await postForm(t, `/w/${wall.id}/admin/cover/delete`, { _csrf: session.csrf }, { cookie: session.cookie })).status).toBe(404);
    }
    expect((await upload(t, wall, owner, image, { csrf: 'bad' })).status).toBe(403);
    expect((await upload(t, wall, owner, image, { origin: 'https://elsewhere.example' })).status).toBe(403);
    const bearerOnly = await postForm(t, `/w/${wall.id}/admin/cover/delete`, { _csrf: owner.csrf }, { headers: { authorization: 'Bearer nmc_fake' } });
    expect(bearerOnly.status).toBe(401);
    expect(t.repos.walls.findCover(wall.id)).toBeNull();
  });

  it('非成员、退出、移出、墙关闭后，旧封面地址立即失效', async () => {
    await upload(t, wall, owner, await png());
    const url = t.repos.walls.coverUrl(wall.id)!;
    const outsider = await login(t, 'no-access@example.com');
    expect((await get(t, url, { cookie: outsider.cookie })).status).toBe(404);
    const membership = t.repos.memberships.findByWallAndUser(wall.id, member.userId)!;
    t.repos.memberships.markLeft(membership.id, t.clock.now().toISOString());
    expect((await get(t, url, { cookie: member.cookie })).status).toBe(404);
    t.repos.memberships.reactivate(membership.id, t.clock.now().toISOString());
    expect((await get(t, url, { cookie: member.cookie })).status).toBe(200);
    t.repos.memberships.markRemoved(membership.id, t.clock.now().toISOString());
    expect((await get(t, url, { cookie: member.cookie })).status).toBe(404);
    t.repos.walls.close(wall.id, t.clock.now().toISOString());
    expect((await get(t, url, { cookie: owner.cookie })).status).toBe(404);
    expect((await upload(t, wall, owner, await png())).status).toBe(404);
  });

  it('拒绝 SVG、伪装文件、损坏图片、多文件、动图和超限图片，失败保留旧封面', async () => {
    await upload(t, wall, owner, await png());
    const url = t.repos.walls.coverUrl(wall.id);
    const oversized = new Uint8Array(WALL_COVER_MAX_BYTES + 1);
    const invalids = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from('not an image'), new Uint8Array([137,80,78,71,13,10,26,10]), Buffer.from('GIF89a'), oversized];
    for (const bytes of invalids) {
      const response = await upload(t, wall, owner, bytes);
      expect([400, 413]).toContain(response.status);
      expect(t.repos.walls.coverUrl(wall.id)).toBe(url);
    }
    expect((await upload(t, wall, owner, [])).status).toBe(400);
    expect((await upload(t, wall, owner, [await png(), await png()])).status).toBe(400);
    const animation = await sharp(Buffer.concat([Buffer.alloc(12, 0), Buffer.alloc(12, 255)]), { raw: { width: 2, height: 4, pageHeight: 2, channels: 3 } }).webp({ loop: 0 }).toBuffer();
    expect((await sharp(animation).metadata()).pages).toBe(2);
    expect((await upload(t, wall, owner, animation)).status).toBe(400);
    const manyPixels = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: '#111111' } }).png().toBuffer();
    expect((await upload(t, wall, owner, manyPixels)).status).toBe(400);
    expect(t.repos.walls.coverUrl(wall.id)).toBe(url);
    expect((await uploadWallCover(t.web.deps, owner.userId, wall.id, [oversized])).ok).toBe(false);
  });

  it('请求体大小保护不依赖客户端的 Content-Length', async () => {
    const response = await t.request(`/w/${wall.id}/admin/cover`, { method: 'POST', headers: { cookie: owner.cookie, origin: t.config.webOrigin, 'content-type': 'multipart/form-data; boundary=test' }, body: new Uint8Array(WALL_COVER_REQUEST_MAX_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(t.repos.walls.findCover(wall.id)).toBeNull();
  });
});
