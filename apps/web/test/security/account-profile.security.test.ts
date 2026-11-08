import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AVATAR_MAX_BYTES, AVATAR_REQUEST_MAX_BYTES } from '@nowme/contracts';
import { createTestWeb, get, login, seedWall, seedMember, type TestSession, type TestWeb } from '../helpers.js';
import { saveAccountProfile } from '../../src/services/account-profile.js';

let t: TestWeb;
let owner: TestSession;
let other: TestSession;
async function png() { return sharp({ create: { width: 400, height: 300, channels: 3, background: '#cfea39' } }).png().toBuffer(); }
async function save(fields: Record<string, string> = {}, images: Uint8Array[] = [], headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ _csrf: owner.csrf, nickname: '新昵称', ...fields })) form.append(k, v);
  for (const bytes of images) form.append('avatar', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), '../../private.png');
  return t.request('/account/profile', { method: 'POST', headers: { cookie: owner.cookie, origin: t.config.webOrigin, ...headers }, body: form });
}
beforeEach(async () => {
  t = createTestWeb();
  owner = await login(t, 'owner@example.com', '原昵称');
  other = await login(t, 'other@example.com', '其他用户');
});
afterEach(async () => { await t.close(); });

describe('账号资料修改', () => {
  it('保存昵称和重编码头像，刷新页面同步导航，更换与移除生效', async () => {
    const image = await sharp(await png()).withMetadata({ exif: { IFD0: { Artist: 'secret' } } }).jpeg().toBuffer();
    expect((await save({ nickname: '  小江  ' }, [image])).status).toBe(303);
    const user = t.repos.users.findById(owner.userId)!;
    expect(user.nickname).toBe('小江');
    expect(user.avatarVersion).toBeTruthy();
    const res = await get(t, '/account/avatar', { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const metadata = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(256);
    expect(metadata.exif).toBeUndefined();
    const html = await (await get(t, '/account/data', { cookie: owner.cookie })).text();
    expect(html.match(new RegExp(`/account/avatar\\?v=${user.avatarVersion}`, 'g'))).toHaveLength(2);
    expect(html).toContain('<h2>小江</h2>');
    expect(html).not.toContain('private.png');
    expect((await save({ nickname: '只改昵称' })).status).toBe(303);
    expect(t.repos.users.findById(owner.userId)?.avatarVersion).toBe(user.avatarVersion);
    expect((await save({}, [await png()])).status).toBe(303);
    expect(t.repos.users.findById(owner.userId)?.avatarVersion).not.toBe(user.avatarVersion);
    expect((await save({ removeAvatar: '1' })).status).toBe(303);
    expect(t.repos.users.avatarForUser(owner.userId)).toBeNull();
    expect((await get(t, '/account/avatar', { cookie: owner.cookie })).status).toBe(404);
  });

  it('同墙头像供有效成员查看，退出、移除、关墙后拒绝；聊天与后台使用头像地址', async () => {
    await save({}, [await png()]);
    const { wall } = seedWall(t, owner.userId);
    const member = seedMember(t, wall, other.userId);
    const url = `/w/${wall.id}/members/${owner.userId}/avatar`;
    expect((await get(t, url, { cookie: other.cookie })).status).toBe(200);
    const stranger = await login(t, 'stranger@example.com');
    expect((await get(t, url, { cookie: stranger.cookie })).status).toBe(404);
    const direct = t.repos.chat.ensureDirect(wall.id, owner.userId, other.userId, t.clock.now().toISOString());
    expect(t.repos.chat.summary(direct, other.userId)?.avatarUrl).toContain(url);
    const group = t.repos.chat.members(wall.id);
    expect(group.find((m) => m.userId === owner.userId)?.avatarUrl).toContain(url);
    expect(await (await get(t, `/w/${wall.id}/admin`, { cookie: owner.cookie })).text()).toContain(url);
    t.repos.memberships.markRemoved(member.membership.id, t.clock.now().toISOString());
    expect((await get(t, url, { cookie: other.cookie })).status).toBe(404);
    t.repos.memberships.reactivate(member.membership.id, t.clock.now().toISOString());
    t.repos.walls.close(wall.id, t.clock.now().toISOString());
    expect((await get(t, url, { cookie: owner.cookie })).status).toBe(404);
  });

  it('错误昵称、伪造图片、多文件、过大图片均不改动资料', async () => {
    const image = await png();
    for (const fields of [{ nickname: '' }, { nickname: 'x'.repeat(25) }, { nickname: 'a\nb' }]) expect((await save(fields, [image])).status).toBe(400);
    for (const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from([137,80,78,71,13,10,26,10])]) expect((await save({}, [bytes])).status).toBe(400);
    expect((await save({}, [image, image])).status).toBe(400);
    expect((await save({ removeAvatar: '1' }, [image])).status).toBe(400);
    expect(await saveAccountProfile(t.repos.users, owner.userId, '新昵称', [new Uint8Array(AVATAR_MAX_BYTES + 1)], false)).toContain('2 MB');
    expect((await save({}, [new Uint8Array(AVATAR_REQUEST_MAX_BYTES + 1)])).status).toBe(413);
    const huge = await sharp({ create: { width: 4100, height: 4000, channels: 3, background: 'red' } }).png().toBuffer();
    expect((await save({}, [huge])).status).toBe(400);
    expect(t.repos.users.findById(owner.userId)?.nickname).toBe('原昵称');
    expect(t.repos.users.avatarForUser(owner.userId)).toBeNull();
  });

  it('仅会话本人可改，来源、CSRF、登录校验不可绕过', async () => {
    const image = await png();
    expect((await save({ _csrf: 'bad' }, [image])).status).toBe(403);
    expect((await save({}, [image], { origin: 'https://evil.example' })).status).toBe(403);
    expect((await save({}, [image], { cookie: '', authorization: 'Bearer nmc_fake' })).status).toBe(401);
    expect((await save({ userId: other.userId, user_id: other.userId }, [image])).status).toBe(303);
    expect(t.repos.users.findById(other.userId)?.nickname).toBe('其他用户');
    expect((await get(t, `/account/avatar?userId=${owner.userId}`, { cookie: other.cookie })).status).toBe(404);
    expect((await get(t, '/account/avatar', { headers: { authorization: 'Bearer nmc_fake' } })).status).not.toBe(200);
  });
});
