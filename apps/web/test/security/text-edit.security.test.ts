/**
 * S16 直接改文字（contracts 22.4）：
 * - 只有页面主人、只能基于自己可用的版本；其他身份一律 404，且没有任务与版本；
 * - 缺 CSRF、外站来源无效，页面凭证（Bearer、无会话）无效；
 * - 输入只能成为文本节点的文字：标签、属性、脚本与样式不变；脚本 / 样式里的内容不出现在表单里；
 * - 不调用模型、不扣点数、不自动发布；排队期间主人被移出时不存版本。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { createStaticProcessor, dumpDb, get, login, postForm, seedMember, type TestWeb } from '../helpers.js';
import { exampleIndex, newRevisionId, originalIndex, postTextEdit, segmentIndex, textEditScenario, type TextEditScenario } from '../text-edit-helpers.js';
import { applyTextEdits, extractTextSegments, markupSignature } from '../../src/services/text-edit.js';
import { removeMember } from '../../src/services/walls.js';
import { ownerStillOwns } from '../../src/services/submissions.js';
import type { SubmissionProcessor } from '../../src/services/processor.js';

const revisionCount = (t: TestWeb) => (t.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n;
const ownerEditJobs = (t: TestWeb) => (t.db.prepare("SELECT COUNT(*) AS n FROM render_jobs WHERE kind = 'owner-edit'").get() as { n: number }).n;

interface ElementInfo {
  tag: string;
  attrs: string;
}
function elementsOf(html: string): ElementInfo[] {
  const out: ElementInfo[] = [];
  const visit = (node: { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: unknown[]; content?: { childNodes: unknown[] } }) => {
    if (node.tagName) out.push({ tag: node.tagName, attrs: JSON.stringify(node.attrs) });
    for (const child of (node.childNodes ?? []) as (typeof node)[]) visit(child);
    for (const child of (node.content?.childNodes ?? []) as (typeof node)[]) visit(child);
  };
  visit(parse(html) as never);
  return out;
}

describe('S16 直接改文字', () => {
  let s: TextEditScenario | undefined;
  afterEach(async () => {
    await s?.t.close();
    s = undefined;
  });

  it('其他身份访问 GET / POST 一律 404，数据库没有变化', async () => {
    const sc = await textEditScenario();
    s = sc;
    const { t, organizer, wall, base, owner } = sc;
    const member = await login(t, 'member@example.com', '同墙成员');
    seedMember(t, wall, member.userId);
    const outsider = await login(t, 'outsider@example.com', '墙外的人');
    const index = segmentIndex('林舟');
    const before = dumpDb(t.db);
    for (const session of [organizer, member, outsider]) {
      expect((await get(t, `/w/${wall.id}/me/text?rev=${base.id}`, { cookie: session.cookie })).status).toBe(404);
      expect((await postTextEdit(t, session, wall.id, { revisionId: base.id, [`t_${index}`]: '攻击者' })).status).toBe(404);
    }
    // 未登录：GET 去登录，POST 被拒
    expect((await get(t, `/w/${wall.id}/me/text?rev=${base.id}`)).status).toBe(303);
    expect((await postTextEdit(t, owner, wall.id, { revisionId: base.id, [`t_${index}`]: '攻击者' }, { cookie: '' })).status).toBeGreaterThanOrEqual(400);
    // 缺 CSRF、外站来源
    expect((await postTextEdit(t, owner, wall.id, { revisionId: base.id, [`t_${index}`]: '攻击者' }, { csrf: null })).status).toBe(403);
    expect((await postTextEdit(t, owner, wall.id, { revisionId: base.id, [`t_${index}`]: '攻击者' }, { origin: 'https://evil.example' })).status).toBe(403);
    // 页面凭证（Bearer、无会话）
    const bearer = await postForm(t, `/w/${wall.id}/me/text`, { revisionId: base.id, [`t_${index}`]: '攻击者' }, { headers: { authorization: `Bearer ${sc.credential}` } });
    expect(bearer.status).toBeGreaterThanOrEqual(400);
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('别人的版本、被拒绝的版本、格式不对的版本 → 404', async () => {
    const sc = await textEditScenario();
    s = sc;
    const { t, owner, wall, organizer } = sc;
    const organizerPage = t.repos.pages.findByMembership(t.repos.memberships.findByWallAndUser(wall.id, organizer.userId)!.id)!;
    const { submitRevision } = await import('../publish-helpers.js');
    const { connectAgent, brokenFiles } = await import('../helpers.js');
    const organizerCredential = await connectAgent(t, wall, organizerPage);
    const theirs = await submitRevision(t, organizerCredential);
    const rejected = await submitRevision(t, sc.credential, brokenFiles());
    expect(rejected.status).toBe('rejected');
    const before = revisionCount(t);
    for (const revisionId of [theirs.id, rejected.id, 'rev_nope', '../x']) {
      expect((await get(t, `/w/${wall.id}/me/text?rev=${encodeURIComponent(revisionId)}`, { cookie: owner.cookie })).status).toBe(404);
      expect((await postTextEdit(t, owner, wall.id, { revisionId, t_0: '改' })).status).toBe(404);
    }
    expect(revisionCount(t)).toBe(before);
    expect(ownerEditJobs(t)).toBe(0);
  });

  it('输入的标记只成为转义后的文字：元素与属性集合与基础版本相同', async () => {
    const sc = await textEditScenario();
    s = sc;
    const { t, owner, wall, base } = sc;
    const payloads = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '</p><a data-nm-href="https://evil.example">点我</a>', '&lt;b&gt; &amp;'];
    const fields: Record<string, string> = { revisionId: base.id };
    const segments = extractTextSegments(exampleIndex()).segments;
    payloads.forEach((payload, i) => (fields[`t_${segments[i]!.index}`] = payload));
    const response = await postTextEdit(t, owner, wall.id, fields);
    expect(response.status).toBe(303);
    const html = await originalIndex(t, newRevisionId(response)!);
    expect(elementsOf(html)).toEqual(elementsOf(exampleIndex()));
    expect(markupSignature(html)).toBe(markupSignature(exampleIndex()));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('evil.example">');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;lt;b&amp;gt; &amp;amp;');
    // 新版本未发布、没有点数流水与 AI 任务
    expect(t.repos.publications.findActiveForPage(sc.page.id)).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM credit_entries').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
  });

  it('脚本与样式里的文字不出现在表单里，也不能被改', async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>.a::after{content:"样式字"}</style></head><body><p data-nm-id="a">可见</p><script>var s = "脚本字";</script></body></html>`;
    const segments = extractTextSegments(html).segments;
    expect(segments.map((x) => x.text)).toEqual(['可见']);
    // 构造的序号指向不到脚本：改动只落在可见文字上
    const result = applyTextEdits(html, new Map([[0, '改了'], [1, 'alert(1)'], [2, 'x']]));
    expect(result.ok && result.html).toBe(html.replace('可见', '改了'));
  });

  it('排队期间主人被移出：不存版本，返回 404', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = createStaticProcessor();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const processor: SubmissionProcessor = {
      async process(input) {
        if (input.files.get('index.html') && new TextDecoder().decode(input.files.get('index.html')).includes('林洲')) {
          started();
          await gate;
        }
        return inner.process(input);
      },
      close: () => inner.close(),
    };
    const sc = await textEditScenario({ processor });
    s = sc;
    const { t, owner, wall, base, organizer } = sc;
    const before = revisionCount(t);
    const pending = postTextEdit(t, owner, wall.id, { revisionId: base.id, [`t_${segmentIndex('林舟')}`]: '林洲' });
    await startedPromise;
    const membership = t.repos.memberships.findByWallAndUser(wall.id, owner.userId)!;
    expect(removeMember(t.web.deps, wall, organizer.userId, membership.id)).not.toBeNull();
    expect(ownerStillOwns(t.repos, owner.userId, sc.page.id)).toBe(false);
    release();
    expect((await pending).status).toBe(404);
    expect(revisionCount(t)).toBe(before);
  });
});
