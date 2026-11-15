/** 创作工作区（W05、W10、W19）：指令、连接状态、版本列表与报告、预览选择、断开。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, verifyTicket, type RevisionResponse } from '@nowme/contracts';
import {
  brokenFiles,
  connectAgent,
  createTestWeb,
  exampleFiles,
  exchange,
  get,
  iframesOf,
  login,
  postForm,
  postJson,
  issueInstruction,
  seedWall,
  TEST_SECRET,
  TEST_SKILL_VERSION,
  type TestSession,
  type TestWeb,
} from './helpers.js';
import type { Page } from '../src/db/pages.js';
import type { Wall } from '../src/db/walls.js';

describe('创作工作区', () => {
  let t: TestWeb;
  let owner: TestSession;
  let wall: Wall;
  let page: Page;

  beforeEach(async () => {
    t = createTestWeb();
    owner = await login(t, 'owner@example.com', '林舟');
    ({ wall, page } = seedWall(t, owner.userId, '周末黑客松'));
  });
  afterEach(async () => {
    await t.close();
  });

  const open = async (query = '') => {
    const response = await get(t, `/w/${wall.id}/me${query}`, { cookie: owner.cookie });
    return { response, html: await response.text() };
  };

  it('新页面：未连接、没有版本、没有 iframe，提供“生成给 AI 助手的指令”', async () => {
    const { response, html } = await open();
    expect(response.status).toBe(200);
    expect(html).toContain('周末黑客松');
    expect(html).toContain('未连接');
    expect(html).toContain('生成给 AI 助手的指令');
    expect(html).toContain('做好的页面会出现在这里');
    expect(html).toContain('发布需要你本人在这里确认');
    expect(iframesOf(html)).toEqual([]);
  });

  it('生成指令：响应里显示 contracts 4.3 格式的指令与纯文本说明；库里只有哈希；之后的页面不再显示明文', async () => {
    const response = await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    const token = html.match(/nmt_[A-Za-z0-9_-]{43}/)?.[0] as string;
    expect(token).toBeDefined();
    expect(html).toContain(`/nowme-page ${wall.id} ${token} --server ${t.config.webOrigin}`);
    expect(html).toContain(`nowme fetch ${wall.id} ${token} --server ${t.config.webOrigin}`);
    expect(html).toContain('只能使用一次');
    expect(html).toContain('data-copy="nm-instruction-command"');
    const row = t.db.prepare('SELECT token_hash, expires_at FROM agent_tokens WHERE page_id = ?').get(page.id) as {
      token_hash: string;
      expires_at: string;
    };
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.expires_at).toBe(new Date(t.clock.now().getTime() + 72 * 3600 * 1000).toISOString());

    const after = await open();
    expect(after.html).not.toContain(token);
    expect(after.html).toContain('待使用的指令');

    // 重新生成：旧的未使用 token 作废
    const again = await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    const second = (await again.text()).match(/nmt_[A-Za-z0-9_-]{43}/)?.[0] as string;
    expect(second).not.toBe(token);
    expect((await exchange(t, wall.id, token)).status).toBe(401);
    expect((await exchange(t, wall.id, second)).status).toBe(200);
  });

  it('连接后显示“已连接”与最近提交时间；版本列表含来源、时间、通过 / 不通过，不通过时展开中文报告与修复提示', async () => {
    const credential = await connectAgent(t, wall, page);
    const accepted = (await (await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential)).json()) as RevisionResponse;
    t.clock.advance(60_000);
    const rejectedResponse = await postJson(t, '/api/agent/revisions', { files: brokenFiles() }, credential);
    const rejected = ((await rejectedResponse.json()) as RevisionResponse).revision;

    const { html } = await open();
    expect(html).toContain('已连接');
    expect(html).toContain('第 1 版');
    expect(html).toContain('第 2 版');
    expect(html).toContain('你电脑上的 AI 助手做的');
    expect(html).toContain('做好了');
    expect(html).toContain('没做成');
    expect(html).toContain('哪里出了问题');
    // 给人看的说明在前，错误码收在“技术细节”里
    expect(html).toContain('<summary>技术细节</summary>');
    const firstError = rejected.report.errors[0];
    expect(firstError).toBeDefined();
    expect(html).toContain(firstError?.code as string);
    expect(html).toContain(firstError?.message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') as string);
    expect(html).toContain('怎么改：');
    // 最新的 rejected 版本默认展开
    expect(html).toMatch(/<details class="revision__report" open/);
    // 预览的是最新的 accepted 版本
    const [frame] = iframesOf(html);
    const ticket = frame?.src?.split('/v/')[1]?.replace(/\/$/, '') as string;
    const verified = verifyTicket(ticket, TEST_SECRET, t.clock.now());
    expect(verified.ok && verified.revisionId).toBe(accepted.revision.id);
    expect(html).toContain('正在预览');
  });

  it('?rev= 选择预览的版本；rejected 版本不能预览（提示且没有 iframe）', async () => {
    const credential = await connectAgent(t, wall, page);
    const first = ((await (await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential)).json()) as RevisionResponse).revision;
    const second = ((await (await postJson(t, '/api/agent/revisions', { files: exampleFiles() }, credential)).json()) as RevisionResponse).revision;
    const broken = ((await (await postJson(t, '/api/agent/revisions', { files: brokenFiles() }, credential)).json()) as RevisionResponse).revision;

    const latest = iframesOf((await open()).html);
    expect(latest).toHaveLength(1);
    const pick = (src: string | undefined) => {
      const result = verifyTicket(src?.split('/v/')[1]?.replace(/\/$/, '') ?? '', TEST_SECRET, t.clock.now());
      return result.ok ? result.revisionId : null;
    };
    expect(pick(latest[0]?.src)).toBe(second.id);
    expect(pick(iframesOf((await open(`?rev=${first.id}`)).html)[0]?.src)).toBe(first.id);

    const rejected = await open(`?rev=${broken.id}`);
    expect(rejected.response.status).toBe(200);
    expect(rejected.html).toContain('这一版没有做成，不能预览');
    expect(iframesOf(rejected.html)).toEqual([]);

    expect((await open('?rev=rev_aaaaaaaaaaaaaaaaaaaaaaaaaa')).response.status).toBe(404);
    expect((await open('?rev=../../etc')).response.status).toBe(404);
  });

  it('断开本地 Agent：凭证吊销、未使用的指令作废，页面显示提示与“未连接”', async () => {
    const credential = await connectAgent(t, wall, page);
    const pending = (await (await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie })).text()).match(
      /nmt_[A-Za-z0-9_-]{43}/,
    )?.[0] as string;
    const response = await postForm(t, `/w/${wall.id}/me/disconnect`, { _csrf: owner.csrf }, { cookie: owner.cookie });
    expect(response.status).toBe(303);
    const { html } = await open('?notice=disconnected');
    expect(html).toContain('已断开你电脑上的 AI 助手');
    expect(html).toContain('未连接');
    expect((await t.request('/api/agent/context', { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    expect((await exchange(t, wall.id, pending)).status).toBe(401);
  });

  it('未知的 notice 参数不回显', async () => {
    const { html } = await open('?notice=%3Cscript%3Ealert(1)%3C/script%3E');
    expect(html).not.toContain('alert(1)');
  });

  it('墙名等用户内容被转义', async () => {
    const evil = seedWall(t, owner.userId, '<script>alert(1)</script>"');
    const response = await get(t, `/w/${evil.wall.id}/me`, { cookie: owner.cookie });
    const html = await response.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  describe('安装 NOWMe Skill（T3.6）', () => {
    const guideOf = (html: string) => /<details class="skill-install" id="skill-install"[^>]*>[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';

    it('新页面：默认展开；让 Agent 安装的一句话（真实地址）、重开会话、自检、不支持 Skill 的替代、Unknown command 的原因', async () => {
      const { html } = await open();
      const guide = guideOf(html);
      expect(guide).toMatch(/^<details class="skill-install" id="skill-install" open/);
      expect(guide).toContain(`请按 https://raw.githubusercontent.com/axiom-wang/nowme-skill/main/install.md 的说明安装 NOWMe Skill（版本 ${TEST_SKILL_VERSION}）`);
      expect(guide).toContain(`href="${t.config.webOrigin}/skill"`);
      expect(guide).toContain('重新打开一个会话');
      expect(guide).toContain(`NOWMe Skill ${TEST_SKILL_VERSION}`);
      expect(guide).toContain('scripts/nowme.mjs --version');
      expect(guide).toContain('AI 助手不支持 Skill？复制这段纯文本说明');
      expect(guide).toContain('Unknown command: /nowme-page');
      expect(guide).toContain('同一条');
      expect(guide).toContain('data-copy="nm-skill-install"');
      expect(guide).toContain('data-copy="nm-skill-check"');
      // 通用写法：整个工作区都不点名具体的 Agent 产品
      expect(html).not.toMatch(/Claude Code|Cursor|Codex|Copilot|\.claude\//);
    });

    it('生成指令的响应里：指令旁边有指向安装说明的链接，安装说明也在', async () => {
      const response = await postForm(t, `/w/${wall.id}/me/instruction`, { _csrf: owner.csrf }, { cookie: owner.cookie });
      const html = await response.text();
      expect(html).toContain('href="#skill-install"');
      expect(guideOf(html)).toContain('install.md');
    });

    it('连接后：安装说明折叠；显示 Skill 版本（最新 / 过旧 / 未知）', async () => {
      const connectWith = async (client?: { cliVersion: string; skillVersion: string | null }) => {
        const instruction = issueInstruction(t, wall, page);
        const response = await postJson(t, '/api/agent/exchange', { wallId: wall.id, token: instruction.token, ...(client ? { client } : {}) });
        expect(response.status).toBe(200);
        return (await open()).html;
      };

      let html = await connectWith({ cliVersion: '0.1.0', skillVersion: TEST_SKILL_VERSION });
      expect(guideOf(html)).toMatch(/^<details class="skill-install" id="skill-install">/);
      expect(html).toContain('Skill 版本');
      expect(html).not.toContain('有新版本');

      html = await connectWith({ cliVersion: '0.1.0', skillVersion: '0.0.1' });
      expect(html).toContain(`有新版本 ${TEST_SKILL_VERSION}`);
      expect(html).toContain('去更新');

      html = await connectWith();
      expect(html).toContain('未知（AI 助手用的不是随 Skill 分发的命令行）');
    });
  });
});
