/**
 * 直接改文字（contracts 22）：取字与替换的纯函数、工作区入口、存新版本的完整流程。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TEXT_EDIT_LIMITS } from '@nowme/contracts';
import { applyTextEdits, extractTextSegments, markupSignature } from '../src/services/text-edit.js';
import { get } from './helpers.js';
import { workspaceHtml } from './publish-helpers.js';
import { exampleIndex, newRevisionId, originalFiles, originalIndex, postTextEdit, segmentIndex, textEditScenario, type TextEditScenario } from './text-edit-helpers.js';

const page = (body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>标题不列出</title><style>.a{content:"样式不列出"}</style></head><body>${body}</body></html>`;

describe('extractTextSegments', () => {
  it('按 data-nm-id 分组，跳过脚本、样式、模板与空白', () => {
    const html = page(`
      <header data-nm-id="hero"><h1> 林舟 <small>lin</small></h1></header>
      <section data-nm-id="about"><p>我 &amp; 你</p><script>document.write("脚本里的字")</script><template><p>模板里的字</p></template></section>
      <p>没有区块</p>
      <noscript>不列出</noscript>
      <svg><style>.x{}</style><text>SVG 文字</text></svg>`);
    const { segments, truncated } = extractTextSegments(html);
    expect(truncated).toBe(false);
    expect(segments.map((s) => [s.block, s.text])).toEqual([
      ['hero', '林舟'],
      ['hero', 'lin'],
      ['about', '我 & 你'],
      [null, '没有区块'],
      [null, 'SVG 文字'],
    ]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2, 3, 4]);
    const all = JSON.stringify(segments);
    for (const hidden of ['标题不列出', '样式不列出', '脚本里的字', '模板里的字', '不列出']) expect(all).not.toContain(hidden);
  });

  it('超过上限时只列出前面的段并标记', () => {
    const html = page(Array.from({ length: TEXT_EDIT_LIMITS.segments + 5 }, (_, i) => `<p>第${i}段</p>`).join(''));
    const { segments, truncated } = extractTextSegments(html);
    expect(segments).toHaveLength(TEXT_EDIT_LIMITS.segments);
    expect(truncated).toBe(true);
  });

  it('示例页能取出名字', () => {
    expect(() => segmentIndex('林舟')).not.toThrow();
  });
});

describe('applyTextEdits', () => {
  const html = page('<header data-nm-id="hero"><h1>\n  林舟\n</h1><p class="x">我 &amp; 你</p></header>');

  it('只替换改过的段，保留前后空白与其余字节', () => {
    const result = applyTextEdits(html, new Map([[0, '林洲'], [1, '我 & 你']]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toBe(html.replace('林舟', '林洲'));
    expect(result.changed).toEqual(['林洲']);
  });

  it('输入里的标记只会成为转义后的文字', () => {
    const result = applyTextEdits(html, new Map([[0, '<script>alert(1)</script><img src=x onerror=alert(1)>']]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(markupSignature(result.html)).toBe(markupSignature(html));
  });

  it('没改、超长、不认识的序号', () => {
    expect(applyTextEdits(html, new Map([[0, '林舟'], [99, '别的']]))).toEqual({ ok: false, error: 'unchanged' });
    expect(applyTextEdits(html, new Map())).toEqual({ ok: false, error: 'unchanged' });
    expect(applyTextEdits(html, new Map([[1, '字'.repeat(TEXT_EDIT_LIMITS.segment + 1)]]))).toEqual({ ok: false, error: 'too-long', index: 1 });
  });

  it('去掉控制字符；原文没有换行时换行合并为空格；可以删空', () => {
    const result = applyTextEdits(html, new Map([[1, '第一行\r\n第二行\u0007‮']]));
    expect(result.ok && result.html).toContain('<p class="x">第一行 第二行</p>');
    const emptied = applyTextEdits(html, new Map([[1, '   ']]));
    expect(emptied.ok && emptied.html).toContain('<p class="x"></p>');
  });
});

describe('直接改文字的流程', () => {
  let s: TextEditScenario | undefined;
  afterEach(async () => {
    await s?.t.close();
    s = undefined;
  });

  it('工作区有入口；表单列出文字；保存后得到 owner-edit 新版本且不发布、不扣点', async () => {
    const sc = await textEditScenario();
    s = sc;
    const { t, owner, wall, base } = sc;
    const workspace = await workspaceHtml(t, owner, wall.id);
    expect(workspace).toContain(`/w/${wall.id}/me/text?rev=${base.id}`);

    const form = await get(t, `/w/${wall.id}/me/text?rev=${base.id}`, { cookie: owner.cookie });
    expect(form.status).toBe(200);
    const formHtml = await form.text();
    expect(formHtml).toContain('林舟');
    expect(formHtml).toContain('区块 hero');
    // 缺 rev 时用最新的可用版本
    expect((await get(t, `/w/${wall.id}/me/text`, { cookie: owner.cookie })).status).toBe(200);

    const index = segmentIndex('林舟');
    const response = await postTextEdit(t, owner, wall.id, { revisionId: base.id, [`t_${index}`]: '林洲' });
    expect(response.status).toBe(303);
    const revisionId = newRevisionId(response);
    expect(revisionId).toBeTruthy();
    expect(response.headers.get('location')).toContain('notice=text-edited');
    const revision = t.repos.revisions.findById(revisionId!)!;
    expect(revision.source).toBe('owner-edit');
    expect(revision.status).toBe('accepted');
    expect(revision.credentialId).toBeNull();
    expect(revision.number).toBe(base.number + 1);

    const html = await originalIndex(t, revisionId!);
    expect(html).toBe(exampleIndex().replace('<h1 class="name">林舟<small>', '<h1 class="name">林洲<small>'));
    const files = await originalFiles(t, revisionId!);
    expect(files.has('cover.png')).toBe(false);
    expect([...files.keys()].sort()).toEqual([...(await originalFiles(t, base.id)).keys()].filter((p) => p !== 'cover.png').sort());

    expect(t.repos.publications.findActiveForPage(sc.page.id)).toBeNull();
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM credit_entries').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    expect(await workspaceHtml(t, owner, wall.id, `?rev=${revisionId}&notice=text-edited`)).toContain('你自己改了文字');
  });

  it('没改动、超长时回到表单，不存版本', async () => {
    const sc = await textEditScenario();
    s = sc;
    const { t, owner, wall, base } = sc;
    const count = () => t.repos.revisions.listForPage(sc.page.id).length;
    const before = count();
    const unchanged = await postTextEdit(t, owner, wall.id, { revisionId: base.id, t_0: extractTextSegments(exampleIndex()).segments[0]!.text });
    expect(unchanged.status).toBe(422);
    expect(await unchanged.text()).toContain('你还没有改任何文字');
    const tooLong = await postTextEdit(t, owner, wall.id, { revisionId: base.id, t_0: '长'.repeat(TEXT_EDIT_LIMITS.segment + 1) });
    expect(tooLong.status).toBe(422);
    expect(count()).toBe(before);
  });

  it('改完后页面没通过校验时不存版本并显示原因', async () => {
    const sc = await textEditScenario();
    s = sc;
    const { t, owner, wall, base } = sc;
    const before = t.repos.revisions.listForPage(sc.page.id).length;
    // 文字里写进形如凭证的字符串：校验器拒绝（CREDENTIAL_LEAK）
    const edits: Record<string, string> = { revisionId: base.id, [`t_${segmentIndex('林舟')}`]: 'nmc_abcdefghijklmnop1234' };
    const response = await postTextEdit(t, owner, wall.id, edits);
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('没有通过检查');
    expect(body).toContain('nmc_abcdefghijklmnop1234');
    expect(t.repos.revisions.listForPage(sc.page.id).length).toBe(before);
  });
});
