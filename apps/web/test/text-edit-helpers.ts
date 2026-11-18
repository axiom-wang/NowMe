/**
 * 直接改文字（contracts 22）测试共用的工具。
 */
import { join } from 'node:path';
import { readPageDir } from '@nowme/validator/node';
import type { RevisionSummary } from '@nowme/contracts';
import { REVISION_ORIGINAL_DIR, revisionDir } from '../src/services/revision-storage.js';
import { extractTextSegments } from '../src/services/text-edit.js';
import { connectAgent, createTestWeb, exampleFiles, login, postForm, seedMember, seedWall, type TestSession, type TestWeb, type TestWebOptions } from './helpers.js';
import { submitRevision } from './publish-helpers.js';
import type { Page } from '../src/db/pages.js';
import type { Wall } from '../src/db/walls.js';

export interface TextEditScenario {
  t: TestWeb;
  organizer: TestSession;
  owner: TestSession;
  wall: Wall;
  page: Page;
  credential: string;
  base: RevisionSummary;
}

/** 组织者建墙；主人用本地 Agent 提交示例页 hackathon-terminal 一版。 */
export async function textEditScenario(options: TestWebOptions = {}): Promise<TextEditScenario> {
  const t = createTestWeb(options);
  const organizer = await login(t, 'organizer@example.com', '组织者');
  const owner = await login(t, 'owner@example.com', '林舟');
  const { wall } = seedWall(t, organizer.userId, '周末黑客松');
  const { page } = seedMember(t, wall, owner.userId);
  const credential = await connectAgent(t, wall, page);
  const base = await submitRevision(t, credential);
  return { t, organizer, owner, wall, page, credential, base };
}

export function exampleIndex(): string {
  return Buffer.from(exampleFiles()['index.html'] as string, 'base64').toString('utf8');
}

/** 示例页里文字恰好是 `text` 的那一段的序号。 */
export function segmentIndex(text: string, html = exampleIndex()): number {
  const found = extractTextSegments(html).segments.find((segment) => segment.text === text);
  if (!found) throw new Error(`示例页里没有这段文字：${text}`);
  return found.index;
}

export async function originalFiles(t: TestWeb, revisionId: string) {
  return readPageDir(join(revisionDir(t.dataDir, revisionId), REVISION_ORIGINAL_DIR));
}

export async function originalIndex(t: TestWeb, revisionId: string): Promise<string> {
  const index = (await originalFiles(t, revisionId)).get('index.html');
  if (!index) throw new Error('没有 index.html');
  return new TextDecoder().decode(index);
}

export function postTextEdit(t: TestWeb, session: TestSession, wallId: string, fields: Record<string, string>, options: { csrf?: string | null; headers?: Record<string, string>; origin?: string | null; cookie?: string } = {}) {
  const base: Record<string, string> = options.csrf === null ? {} : { _csrf: options.csrf ?? session.csrf };
  return postForm(t, `/w/${wallId}/me/text`, { ...base, ...fields }, { cookie: options.cookie ?? session.cookie, headers: options.headers, origin: options.origin });
}

export function newRevisionId(response: Response): string | null {
  return response.headers.get('location')?.match(/[?&]rev=(rev_[A-Za-z0-9_-]+)/)?.[1] ?? null;
}
