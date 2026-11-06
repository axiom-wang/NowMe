/**
 * S5：组织者看不到私密内容。
 *
 * - 组织者后台 HTML 只有昵称、加入时间、发布状态：不含任何版本 ID（`rev_`）、发布 / 页面 ID、未发布的 card 内容、
 *   版本原始 card（主人确认前的草稿）、联系方式（公开或未公开）、邮箱、工作区链接（`/me`）、成员页 / 封面 / 页面托管链接；
 * - 组织者请求他人的版本预览（`/w/:wallId/me?rev=<他人版本>`）、未发布 / 已撤下成员的页面与封面、chat → 404，且不签发票据；
 * - 组织者自己的工作区里看不到别人的版本。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wall } from '../../src/db/walls.js';
import { createTestWeb, dumpDb, get, iframesOf, login, postForm, seedMember, seedWall, type TestSession, type TestWeb } from '../helpers.js';
import { makeCard, publishedMember, seedRevision, withdraw, type PublishedMember } from '../wall-helpers.js';

const PUBLIC_CONTACT = { channel: 'wechat', value: 'public_contact_ayou' };
const PRIVATE_CONTACT = 'private_contact_xiaobai_13800000000';

describe('S5 组织者后台与组织者身份', () => {
  let t: TestWeb;
  let organizer: TestSession;
  let wall: Wall;
  let published: PublishedMember;
  let unpublishedRevision: string;
  let unpublishedPageId: string;
  let withdrawnMember: PublishedMember;
  let secrets: string[];

  beforeEach(async () => {
    t = createTestWeb();
    organizer = await login(t, 'organizer@example.com', '组织者林舟');
    ({ wall } = seedWall(t, organizer.userId, '周末黑客松'));

    const ayou = await login(t, 'ayou@example.com', '阿柚');
    published = publishedMember(t, wall, { userId: ayou.userId, name: '阿柚', contact: PUBLIC_CONTACT });

    // 未发布的成员：有一个 accepted 版本（card 里有独特文字）和未公开的联系方式
    const xiaobai = await login(t, 'xiaobai@example.com', '小白');
    const draft = seedMember(t, wall, xiaobai.userId);
    unpublishedPageId = draft.page.id;
    unpublishedRevision = seedRevision(t, draft.page, makeCard('小白', { tagline: '小白未发布的秘密介绍' }));
    t.db
      .prepare("UPDATE pages SET contact_channel = 'wechat', contact_value = ?, contact_public = 0 WHERE id = ?")
      .run(PRIVATE_CONTACT, draft.page.id);

    // 已撤下的成员
    withdrawnMember = publishedMember(t, wall, { email: 'w@example.com', name: '撤下的人', contact: { channel: 'qq', value: 'withdrawn_qq_888' } });
    withdraw(t, withdrawnMember.page);

    secrets = [
      'rev_',
      'pbl_',
      'pg_',
      published.revisionId,
      unpublishedRevision,
      withdrawnMember.revisionId,
      '小白未发布的秘密介绍',
      '小白能帮你做前端',
      `原始介绍：阿柚未确认的草稿`,
      published.card.tagline,
      published.card.hooks[0]?.text ?? '',
      published.card.hooks[0]?.opener ?? '',
      PUBLIC_CONTACT.value,
      PRIVATE_CONTACT,
      'withdrawn_qq_888',
      'ayou@example.com',
      'xiaobai@example.com',
      '/v/',
      '/covers/',
    ];
  });
  afterEach(async () => {
    await t.close();
  });

  it('后台 HTML 只有昵称、加入时间、发布状态：不含版本 ID、未发布 card、联系方式、邮箱、工作区与页面链接', async () => {
    // 有人浏览、想聊过：后台也不显示个人层面的数据
    const viewer = await login(t, 'viewer@example.com', '旁观者');
    seedMember(t, wall, viewer.userId);
    await get(t, `/w/${wall.id}/p/${published.page.id}`, { cookie: viewer.cookie });
    await postForm(t, `/w/${wall.id}/p/${published.page.id}/chat`, { _csrf: viewer.csrf, hookId: 'can-help' }, { cookie: viewer.cookie });

    for (const path of [`/w/${wall.id}/admin`, `/w/${wall.id}/admin?notice=created`, `/w/${wall.id}/admin?notice=removed`]) {
      const response = await get(t, path, { cookie: organizer.cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const secret of secrets) expect(html, `${path} 不能含 ${secret}`).not.toContain(secret);
      expect(html, '没有工作区链接').not.toMatch(/href="[^"]*\/me[/"?]/);
      expect(html, '没有成员页链接').not.toMatch(/href="[^"]*\/p\/[^"]*"/);
      expect(html).not.toContain('user_id');
      expect(html).not.toMatch(/usr_[a-z2-7]{26}/);
      // 昵称与发布状态都在
      for (const nickname of ['组织者林舟', '阿柚', '小白', '撤下的人', '旁观者']) expect(html).toContain(nickname);
      for (const state of ['已发布', '未发布', '已撤下']) expect(html).toContain(state);
      // 没有个人层面的浏览数据
      expect(html).not.toContain('想聊这个');
      expect(html).not.toContain('浏览');
    }

    // 关闭墙失败（未勾选确认）时重新渲染的后台同样干净
    const rerender = await (await postForm(t, `/w/${wall.id}/admin/close`, { _csrf: organizer.csrf }, { cookie: organizer.cookie })).text();
    for (const secret of secrets) expect(rerender, `重新渲染的后台不能含 ${secret}`).not.toContain(secret);
  });

  it('组织者请求他人的版本预览 → 404，不签发票据，数据库无变化', async () => {
    for (const rev of [unpublishedRevision, published.revisionId, withdrawnMember.revisionId]) {
      const before = dumpDb(t.db);
      const response = await get(t, `/w/${wall.id}/me?rev=${rev}`, { cookie: organizer.cookie });
      expect(response.status, rev).toBe(404);
      const html = await response.text();
      expect(iframesOf(html)).toEqual([]);
      expect(html).not.toContain('/v/');
      expect(html).not.toContain(rev);
      expect(dumpDb(t.db)).toEqual(before);
    }
    // 自己的工作区：没有别人的版本与草稿
    const own = await (await get(t, `/w/${wall.id}/me`, { cookie: organizer.cookie })).text();
    for (const secret of [unpublishedRevision, published.revisionId, withdrawnMember.revisionId, '小白未发布的秘密介绍', PRIVATE_CONTACT]) {
      expect(own).not.toContain(secret);
    }
  });

  it('组织者请求未发布 / 已撤下成员的页面、封面、chat → 404，不签发票据，不记事件', async () => {
    for (const pageId of [unpublishedPageId, withdrawnMember.page.id]) {
      for (const path of [`/w/${wall.id}/p/${pageId}`, `/w/${wall.id}/covers/${pageId}.png`]) {
        const before = dumpDb(t.db);
        const response = await get(t, path, { cookie: organizer.cookie });
        expect(response.status, path).toBe(404);
        const body = await response.text();
        expect(body).not.toContain('/v/');
        for (const secret of ['小白未发布的秘密介绍', PRIVATE_CONTACT, 'withdrawn_qq_888']) expect(body).not.toContain(secret);
        expect(dumpDb(t.db), path).toEqual(before);
      }
      const before = dumpDb(t.db);
      const chat = await postForm(t, `/w/${wall.id}/p/${pageId}/chat`, { _csrf: organizer.csrf, hookId: 'can-help' }, { cookie: organizer.cookie });
      expect(chat.status).toBe(404);
      expect(await chat.text()).not.toContain('withdrawn_qq_888');
      expect(dumpDb(t.db)).toEqual(before);
    }
  });

  it('墙与已发布成员页也不泄露未公开的联系方式与版本原始 card', async () => {
    const wallHtml = await (await get(t, `/w/${wall.id}`, { cookie: organizer.cookie })).text();
    const pageHtml = await (await get(t, `/w/${wall.id}/p/${published.page.id}`, { cookie: organizer.cookie })).text();
    for (const html of [wallHtml, pageHtml]) {
      for (const secret of [
        PRIVATE_CONTACT,
        PUBLIC_CONTACT.value, // 公开的联系方式也只在“想聊这个”之后出现
        '小白未发布的秘密介绍',
        '原始介绍：阿柚未确认的草稿',
        'withdrawn_qq_888',
        unpublishedRevision,
        withdrawnMember.revisionId,
      ]) {
        expect(html, secret).not.toContain(secret);
      }
    }
    // 墙上只有封面地址（按页面 ID），没有版本 ID；成员页的版本 ID 只出现在票据里（contracts 4.4 的票据格式）
    expect(wallHtml).not.toContain('rev_');
    expect(pageHtml.replace(/\/v\/rev_[^"/]+\//g, '')).not.toContain('rev_');
  });
});
