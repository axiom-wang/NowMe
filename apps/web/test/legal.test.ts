/** 用户协议、隐私政策（contracts 16.3）与用户页面展示（contracts 16.2）。 */
import { afterEach, describe, expect, it } from 'vitest';
import { LEGAL_VERSION, LOGIN_CODE_TTL_SECONDS, SESSION_TTL_SECONDS } from '@nowme/contracts';
import { connectAgent, createTestWeb, get, login, seedMember, seedWall, type TestWeb } from './helpers.js';
import { enablePublicLink, exampleCard, publish, submitRevision } from './publish-helpers.js';

let t: TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('/terms 与 /privacy', () => {
  it('不需要登录；带版本号；页脚在登录页和站内页都有链接', async () => {
    t = createTestWeb();
    for (const path of ['/terms', '/privacy']) {
      const response = await get(t, path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html).toContain(`版本 ${LEGAL_VERSION}`);
      expect(html).toContain('<!doctype html>');
    }
    const login = await (await get(t, '/login')).text();
    expect(login).toContain('href="/terms"');
    expect(login).toContain('href="/privacy"');
  });

  it('用户协议写明年龄、AI 协助生成、内容检查、点数、注销入口', async () => {
    t = createTestWeb();
    const html = await (await get(t, '/terms')).text();
    for (const text of ['年满 18 周岁', 'AI 协助生成', '内容检查与处理', '不能提现', '我的资料']) expect(html, text).toContain(text);
  });

  it('隐私政策与实际存的数据一致：每类数据都写了，期限与代码常量一致', async () => {
    t = createTestWeb();
    const html = await (await get(t, '/privacy')).text();
    for (const text of ['邮箱', '登录验证码', '登录状态', '协议确认记录', '昵称、头像', '采访素材', '长期画像', '页面的各个版本', '联系方式', '站内消息', '和 TA 聊什么', '点数余额', '模型服务设置', '使用事件', '运行日志', '模型服务', '邮件服务']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain(`${LOGIN_CODE_TTL_SECONDS / 60} 分钟内有效`);
    expect(html).toContain(`最长 ${SESSION_TTL_SECONDS / 86400} 天`);
    // 没有配置外部审核服务时不声称使用了它
    expect(html).not.toContain('内容审核服务');
  });

  it('配置了外部审核接口时，隐私政策要说明文字会发给它；联系邮箱可配置', async () => {
    t = createTestWeb({ env: { NOWME_MODERATION_URL: 'https://mod.example.com/check', NOWME_CONTACT_EMAIL: 'help@nowme.example' } });
    const html = await (await get(t, '/privacy')).text();
    expect(html).toContain('内容审核服务');
    expect(html).toContain('mailto:help@nowme.example');
    const terms = await (await get(t, '/terms')).text();
    expect(terms).toContain('help@nowme.example');
  });
});

describe('用户页面展示', () => {
  it('墙卡片、成员页与公开链接页不显示生成标识；沙箱与页面内容不变', async () => {
    t = createTestWeb();
    const owner = await login(t, 'owner@example.com', '林舟');
    const viewer = await login(t, 'viewer@example.com', '访客');
    const { wall, page } = seedWall(t, owner.userId, '周末黑客松');
    seedMember(t, wall, viewer.userId);
    const credential = await connectAgent(t, wall, page);
    const revision = await submitRevision(t, credential);
    const published = await publish(t, owner, wall.id, revision.id, exampleCard());
    expect(published.status).toBe(303);
    const token = await enablePublicLink(t, owner, wall.id, page.id);

    const wallHtml = await (await get(t, `/w/${wall.id}`, { cookie: viewer.cookie })).text();
    expect(wallHtml).not.toContain('data-ai-badge');
    expect(wallHtml).not.toContain('AI 协助生成');

    const memberHtml = await (await get(t, `/w/${wall.id}/p/${page.id}`, { cookie: viewer.cookie })).text();
    expect(memberHtml).not.toContain('data-ai-badge');
    expect(memberHtml).not.toContain('AI 协助生成');

    const publicHtml = await (await get(t, `/s/${token}`)).text();
    expect(publicHtml).not.toContain('data-ai-badge');
    expect(publicHtml).not.toContain('AI 协助生成');
    expect(publicHtml).toContain('href="/terms"');

    // 移除提示不影响 iframe 的受限 sandbox，也不改写用户页面文件
    expect(memberHtml).toMatch(/<iframe[^>]*sandbox="allow-scripts"/);
    const files = t.repos.revisions.findById(revision.id);
    expect(files?.renderedText ?? '').not.toContain('AI 协助生成');
  });
});
