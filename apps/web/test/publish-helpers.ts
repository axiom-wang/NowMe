/**
 * 发布、公开链接、删除、退出相关测试（T3.2）共用的工具。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cardSchema, type Card, type RevisionResponse, type RevisionSummary } from '@nowme/contracts';
import { b64, exampleFiles, get, postForm, postJson, type TestSession, type TestWeb } from './helpers.js';

/** 提交一个版本（默认示例页 hackathon-terminal），返回版本摘要。 */
export async function submitRevision(t: TestWeb, credential: string, files: Record<string, string> = exampleFiles()): Promise<RevisionSummary> {
  const response = await postJson(t, '/api/agent/revisions', { files }, credential);
  if (response.status !== 201 && response.status !== 422) throw new Error(`提交失败：${response.status} ${await response.text()}`);
  return ((await response.json()) as RevisionResponse).revision;
}

/** 示例页的 card.json。 */
export function exampleCard(name = 'hackathon-terminal'): Card {
  const files = exampleFiles(name);
  return cardSchema.parse(JSON.parse(Buffer.from(files['card.json'] as string, 'base64').toString('utf8')));
}

/** 用自定义的 card.json 替换示例页的 card.json。 */
export function filesWithCard(card: unknown, name = 'hackathon-terminal'): Record<string, string> {
  return { ...exampleFiles(name), 'card.json': b64(JSON.stringify(card)) };
}

/** 发布确认表单字段：默认照抄 card（全部接话点保留）、公开微信联系方式、勾选确认。 */
export function publishFields(
  csrf: string,
  revisionId: string,
  card: Card,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    _csrf: csrf,
    revisionId,
    displayName: card.displayName,
    tagline: card.tagline,
    contactChannel: 'wechat',
    contactValue: 'linzhou_dev',
    contactPublic: '1',
    confirm: '1',
  };
  card.hooks.forEach((hook, index) => {
    fields[`hooks[${index}][id]`] = hook.id;
    fields[`hooks[${index}][text]`] = hook.text;
    fields[`hooks[${index}][opener]`] = hook.opener;
  });
  Object.assign(fields, overrides);
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function publish(
  t: TestWeb,
  session: TestSession,
  wallId: string,
  revisionId: string,
  card: Card,
  overrides: Record<string, string | undefined> = {},
): Promise<Response> {
  return postForm(t, `/w/${wallId}/me/publish`, publishFields(session.csrf, revisionId, card, overrides), { cookie: session.cookie });
}

export function post(t: TestWeb, session: TestSession, path: string, fields: Record<string, string> = {}): Promise<Response> {
  return postForm(t, path, { _csrf: session.csrf, ...fields }, { cookie: session.cookie });
}

export async function workspaceHtml(t: TestWeb, session: TestSession, wallId: string, query = ''): Promise<string> {
  const response = await get(t, `/w/${wallId}/me${query}`, { cookie: session.cookie });
  if (response.status !== 200) throw new Error(`工作区 ${response.status}`);
  return response.text();
}

/** 开启公开链接，返回令牌。 */
export async function enablePublicLink(t: TestWeb, session: TestSession, wallId: string, pageId: string): Promise<string> {
  const response = await post(t, session, `/w/${wallId}/me/public-link`, { enabled: '1' });
  if (response.status !== 303) throw new Error(`开启公开链接失败：${response.status}`);
  const token = t.repos.pages.findById(pageId)?.publicToken;
  if (!token) throw new Error('公开链接没有开启');
  return token;
}

export function revisionDirExists(t: TestWeb, revisionId: string): boolean {
  return existsSync(join(t.dataDir, 'revisions', revisionId));
}

/** HTML 转义（断言转义后的文字是否出现在页面里）。 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 某一页的行（pages、publications、revisions、page_credentials、agent_tokens、memberships），断言“这一页的数据没变”。 */
export function pageRows(t: TestWeb, pageId: string): Record<string, unknown[]> {
  const page = t.db.prepare('SELECT * FROM pages WHERE id = ?').all(pageId);
  const membershipId = (page[0] as { membership_id?: string } | undefined)?.membership_id ?? '';
  return {
    page,
    membership: t.db.prepare('SELECT * FROM memberships WHERE id = ?').all(membershipId),
    publications: t.db.prepare('SELECT * FROM publications WHERE page_id = ? ORDER BY rowid').all(pageId),
    revisions: t.db.prepare('SELECT * FROM revisions WHERE page_id = ? ORDER BY rowid').all(pageId),
    credentials: t.db.prepare('SELECT * FROM page_credentials WHERE page_id = ? ORDER BY rowid').all(pageId),
    tokens: t.db.prepare('SELECT * FROM agent_tokens WHERE page_id = ? ORDER BY rowid').all(pageId),
    events: t.db.prepare('SELECT * FROM events WHERE page_id = ? ORDER BY rowid').all(pageId),
  };
}
