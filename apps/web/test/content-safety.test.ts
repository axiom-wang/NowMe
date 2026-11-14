/**
 * 内容安全检查（contracts 16.1）：内置规则、外部词表、外部审核接口（含失败策略），以及各检查点的路由行为。
 * 日志不含原文、审核接口只允许公网 HTTPS 等安全约束见 test/security/content-safety.security.test.ts。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModerationConfig } from '@nowme/contracts';
import { createContentSafety } from '../src/services/content-safety.js';
import { connectAgent, createTestWeb, login, postForm, seedMember, seedWall, type TestWeb } from './helpers.js';
import { postMultipart } from './hosted-helpers.js';
import { openDirect } from '../src/services/chat.js';
import { exampleCard, publish, submitRevision } from './publish-helpers.js';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const OFF: ModerationConfig = { blocklistFile: null, url: null, onFailure: 'allow' };
const REMOTE: ModerationConfig = { blocklistFile: null, url: 'https://mod.example.com/check', onFailure: 'allow' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('内置规则', () => {
  const safety = createContentSafety({ moderation: OFF, log: () => {} });

  it('明显违规的写法被拦下，带规则编号和中文提示', async () => {
    const cases: [string, string][] = [
      ['招募兼职刷单，日结', 'B01'],
      ['稳 赚 不 赔 的项目', 'B01'],
      ['网络赌博开户', 'B02'],
      ['可以裸聊', 'B03'],
      ['办假证 刻章', 'B04'],
      ['拉人头 发展下线', 'B05'],
    ];
    for (const [text, rule] of cases) {
      const verdict = await safety.checkText('message', text);
      expect(verdict.ok, text).toBe(false);
      if (!verdict.ok) {
        expect(verdict.rule).toBe(rule);
        expect(verdict.message).toContain(rule);
        expect(verdict.message).toMatch(/[一-龥]/);
      }
    }
  });

  it('正常的自我介绍、聊天和技术词不会误拦', async () => {
    for (const text of ['我在背单词，刷单词App很有意思', '想找一位做视觉的队友，周末一起去逛二手唱片店', '会 Rust 和 React，做过一个抢票脚本', '加我微信 linzhou_dev 聊聊']) {
      expect((await safety.checkText('page', text)).ok, text).toBe(true);
    }
  });

  it('空文字、null 直接放行', async () => {
    expect((await safety.checkText('message', '')).ok).toBe(true);
    expect((await safety.checkText('message', null)).ok).toBe(true);
    expect((await safety.checkTexts('wall', [undefined, '  ', '正常'])).ok).toBe(true);
  });

  it('checkTexts 遇到第一处命中就返回，并带上检查点类型', async () => {
    const verdict = await safety.checkTexts('wall', ['正常', '六合彩', '裸聊']);
    expect(verdict).toMatchObject({ ok: false, kind: 'wall', rule: 'B02' });
  });
});

describe('外部词表', () => {
  it('启动时读入；命中给出 F<行号>；文件不合法时拒绝创建', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-safety-'));
    try {
      const file = join(dir, 'words.txt');
      writeFileSync(file, '# 自定义\n内部暗号\n');
      const safety = createContentSafety({ moderation: { ...OFF, blocklistFile: file }, log: () => {} });
      expect(await safety.checkText('interview', '这是内部暗号')).toMatchObject({ ok: false, rule: 'F2' });
      writeFileSync(file, '/(/\n');
      expect(() => createContentSafety({ moderation: { ...OFF, blocklistFile: file }, log: () => {} })).toThrow(/第 1 行/);
      expect(() => createContentSafety({ moderation: { ...OFF, blocklistFile: join(dir, 'missing.txt') }, log: () => {} })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('外部审核接口', () => {
  it('POST { kind, text }，allowed:true 放行；带上密钥', async () => {
    const calls: { url: string; body: { kind: string; text: string }; auth: string | null }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
      return json({ allowed: true });
    }) as typeof fetch;
    const safety = createContentSafety({ moderation: REMOTE, apiKey: 'k-1', lookup: PUBLIC_LOOKUP, transport, log: () => {} });
    expect((await safety.checkText('edit', '把标题改大一点')).ok).toBe(true);
    expect(calls).toEqual([{ url: 'https://mod.example.com/check', body: { kind: 'edit', text: '把标题改大一点' }, auth: 'Bearer k-1' }]);
  });

  it('allowed:false 拦截，规则编号清洗后带 M: 前缀；本地规则命中时不调用接口', async () => {
    let calls = 0;
    const transport = (async () => {
      calls += 1;
      return json({ allowed: false, rule: 'spam-1' });
    }) as unknown as typeof fetch;
    const safety = createContentSafety({ moderation: REMOTE, lookup: PUBLIC_LOOKUP, transport, log: () => {} });
    expect(await safety.checkText('message', '你好呀')).toMatchObject({ ok: false, rule: 'M:spam-1' });
    expect(calls).toBe(1);
    await safety.checkText('message', '六合彩');
    expect(calls).toBe(1);
  });

  it('规则编号里有奇怪字符时用 M01', async () => {
    const transport = (async () => json({ allowed: false, rule: '<script>' })) as unknown as typeof fetch;
    const safety = createContentSafety({ moderation: REMOTE, lookup: PUBLIC_LOOKUP, transport, log: () => {} });
    expect(await safety.checkText('message', '你好')).toMatchObject({ ok: false, rule: 'M01' });
  });

  const failures: [string, typeof fetch][] = [
    ['5xx', (async () => json({}, 503)) as unknown as typeof fetch],
    ['返回格式不对', (async () => json({ ok: 1 })) as unknown as typeof fetch],
    ['网络错误', (async () => { throw new Error('boom'); }) as unknown as typeof fetch],
  ];
  for (const [name, transport] of failures) {
    it(`失败（${name}）：默认放行并记日志`, async () => {
      const logs: string[] = [];
      const safety = createContentSafety({ moderation: REMOTE, lookup: PUBLIC_LOOKUP, transport, log: (line) => logs.push(line) });
      expect((await safety.checkText('message', '你好呀')).ok).toBe(true);
      expect(logs.join('\n')).toContain('审核接口不可用');
      expect(logs.join('\n')).toContain('action=allow');
    });

    it(`失败（${name}）：配置为拦截时拦截`, async () => {
      const safety = createContentSafety({ moderation: { ...REMOTE, onFailure: 'block' }, lookup: PUBLIC_LOOKUP, transport, log: () => {} });
      expect(await safety.checkText('message', '你好呀')).toMatchObject({ ok: false, rule: 'M00' });
    });
  }
});

describe('各检查点', () => {
  let t: TestWeb;
  afterEach(async () => {
    await t.close();
  });

  it('建墙：名称 / 简介命中时返回 422，字段上有提示，不建墙', async () => {
    t = createTestWeb();
    const owner = await login(t, 'o@example.com', '组织者');
    const response = await postForm(t, '/walls', { _csrf: owner.csrf, name: '六合彩交流群', description: '大家一起聊天', sceneType: 'interest', organizerNote: '' }, { cookie: owner.cookie });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('墙的名称或介绍里');
    expect(html).toContain('value="六合彩交流群"');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM walls').get()).toEqual({ n: 0 });
    const ok = await postForm(t, '/walls', { _csrf: owner.csrf, name: '周末摄影', description: '拍照', sceneType: 'interest', organizerNote: '' }, { cookie: owner.cookie });
    expect(ok.status).toBe(303);
  });

  it('昵称：首次填写与在“我的资料”里修改都会检查', async () => {
    t = createTestWeb();
    const user = await login(t, 'm@example.com', '正常昵称');
    const profile = await postMultipart(t, '/account/profile', { _csrf: user.csrf, nickname: '约炮达人' }, [], { cookie: user.cookie });
    expect(profile.status).toBe(400);
    expect(await profile.text()).toContain('这个昵称里');
    expect(t.repos.users.findById(user.userId)?.nickname).toBe('正常昵称');
  });

  it('私信：命中时返回错误（JSON 与表单两种），消息不入库', async () => {
    t = createTestWeb();
    const a = await login(t, 'a@example.com', '甲');
    const b = await login(t, 'b@example.com', '乙');
    const { wall } = seedWall(t, a.userId);
    seedMember(t, wall, b.userId);
    const direct = openDirect(t.web.deps, a.userId, wall.id, b.userId)!;
    const json = await postForm(t, `/messages/${direct}/send`, { _csrf: a.csrf, text: '加入我们，兼职刷单日结', clientId: 'client-id-0000000001' }, { cookie: a.cookie, headers: { accept: 'application/json' } });
    expect(json.status).toBe(400);
    expect(((await json.json()) as { error: string }).error).toContain('这条消息里');
    const form = await postForm(t, `/messages/${direct}/send`, { _csrf: a.csrf, text: '加入我们，兼职刷单日结', clientId: 'client-id-0000000002' }, { cookie: a.cookie });
    expect(form.status).toBe(400);
    expect(await form.text()).toContain('这条消息里');
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 0 });
    const fine = await postForm(t, `/messages/${direct}/send`, { _csrf: a.csrf, text: '你好！', clientId: 'client-id-0000000003' }, { cookie: a.cookie, headers: { accept: 'application/json' } });
    expect(fine.status).toBe(200);
  });

  it('发布：渲染文字或确认表单命中时不发布；改好后能发布', async () => {
    t = createTestWeb();
    const owner = await login(t, 'owner@example.com', '林舟');
    const { wall, page } = seedWall(t, owner.userId, '周末黑客松');
    const credential = await connectAgent(t, wall, page);
    const revision = await submitRevision(t, credential);
    const card = exampleCard();

    // 假处理器的渲染文字固定为“渲染后的文字”；这里改库里的渲染文字，模拟页面里有违规内容
    t.db.prepare('UPDATE revisions SET rendered_text = ? WHERE id = ?').run('欢迎来玩，百家乐开户加我', revision.id);
    const blocked = await publish(t, owner, wall.id, revision.id, card);
    expect(blocked.status).toBe(400);
    expect(await blocked.text()).toContain('页面里的文字');
    expect(t.repos.publications.findActiveForPage(page.id)).toBeNull();

    t.db.prepare('UPDATE revisions SET rendered_text = ? WHERE id = ?').run('正常的文字', revision.id);
    const tagline = await publish(t, owner, wall.id, revision.id, card, { tagline: '做点有意思的事，也接刷单兼职' });
    expect(tagline.status).toBe(400);
    expect(t.repos.publications.findActiveForPage(page.id)).toBeNull();

    const ok = await publish(t, owner, wall.id, revision.id, card);
    expect(ok.status).toBe(303);
    expect(t.repos.publications.findActiveForPage(page.id)).not.toBeNull();
  });
});
