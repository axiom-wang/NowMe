/**
 * 平台托管路线的测试工具：开启假 Claude 客户端的测试主站、假预览器、multipart 表单、走完采访的捷径。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePage } from '@nowme/validator';
import type { Wall } from '../src/db/walls.js';
import { createFakeClaude, type FakeClaude } from '../src/hosted/fake-claude.js';
import type { PagePreviewer } from '../src/hosted/tools.js';
import type { MemberPage } from '../src/services/walls.js';
import { createTestWeb, createUser, get, login, seedMember, TINY_PNG, type TestSession, type TestWeb, type TestWebOptions } from './helpers.js';
import { post } from './publish-helpers.js';

export interface HostedTestWeb extends TestWeb {
  fake: FakeClaude;
  previewer: FakePreviewer;
  tempRoot: string;
  /** tempRoot 下残留的任务临时目录。 */
  leftoverJobDirs(): string[];
}

export interface FakePreviewer extends PagePreviewer {
  calls: number;
}

/** 假预览器：真实静态校验，截图用 1×1 PNG（不启动浏览器）。 */
export function createFakePreviewer(): FakePreviewer {
  const previewer: FakePreviewer = {
    calls: 0,
    async preview(files, kitFonts) {
      previewer.calls += 1;
      return { report: validatePage(files, { kitFonts }), images: [{ label: '封面（首屏 375×500）', png: TINY_PNG }] };
    },
    async close() {},
  };
  return previewer;
}

export function createHostedTestWeb(options: TestWebOptions & { env?: Record<string, string> } = {}): HostedTestWeb {
  const fake = (options.claude as FakeClaude | undefined) ?? createFakeClaude();
  const previewer = createFakePreviewer();
  const tempRoot = mkdtempSync(join(tmpdir(), 'nowme-hosted-tmp-'));
  const t = createTestWeb({ ...options, env: { NOWME_CLAUDE_FAKE: '1', ...options.env }, claude: fake, previewer, hostedTempRoot: tempRoot });
  const close = t.close;
  return {
    ...t,
    fake,
    previewer,
    tempRoot,
    leftoverJobDirs: () => readdirSync(tempRoot),
    async close() {
      await close();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

/** 一个 1×1 的 JPEG 文件头（魔数正确即可）。 */
export const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

export function postMultipart(
  t: TestWeb,
  path: string,
  fields: Record<string, string>,
  files: { name: string; bytes: Uint8Array; type?: string; filename?: string }[] = [],
  options: { cookie?: string; origin?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  for (const file of files) body.append(file.name, new Blob([file.bytes], { type: file.type ?? 'application/octet-stream' }), file.filename ?? 'upload.bin');
  const headers: Record<string, string> = { ...options.headers };
  const origin = options.origin === undefined ? t.config.webOrigin : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.cookie) headers.cookie = options.cookie;
  return t.request(path, { method: 'POST', headers, body });
}

export interface HostedOwner {
  session: TestSession;
  member: MemberPage;
}

/** 新用户登录并加入墙。 */
export async function joinAs(t: TestWeb, wall: Wall, email: string, nickname: string): Promise<HostedOwner> {
  const session = await login(t, email, nickname);
  const member = seedMember(t, wall, session.userId);
  return { session, member };
}

export const MATERIAL = '我叫阿柚。做过 3 个校园小程序，负责前端。最近在沉迷做手冲咖啡。';

/** 第 1、2 步的表单字段（黑客松场景：角色、技能、想找的队友等按题目 id 填）。 */
export function interviewFields(session: TestSession, material = MATERIAL): Record<string, string> {
  return {
    _csrf: session.csrf,
    material,
    q_role: '0',
    q_teammate_0: '1',
    'style_hackathon-terminal': '1',
    motion: 'calm',
  };
}

/** 走完采访到“已确认”（含 1 张图片），返回 brief 记录。 */
export async function completeInterview(t: TestWeb, wall: Wall, owner: HostedOwner, material = MATERIAL): Promise<void> {
  const started = await postMultipart(t, `/w/${wall.id}/me/create/start`, interviewFields(owner.session, material), [{ name: 'photos', bytes: TINY_JPEG, filename: 'me.png' }], {
    cookie: owner.session.cookie,
  });
  if (started.status !== 303) throw new Error(`start ${started.status}: ${(await started.text()).slice(0, 300)}`);
  const brief = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
  if (brief?.status === 'followups') {
    const answered = await post(t, owner.session, `/w/${wall.id}/me/create/followups`, { f_f1: '0', f_f1_text: '会用五种方言说你吃了没' });
    if (answered.status !== 303) throw new Error(`followups ${answered.status}`);
  }
  const review = t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId);
  const parsed = JSON.parse(review?.briefJson ?? '{}') as { aiView: string[]; hooks: { text: string; opener: string }[]; profileSuggestions: unknown[] };
  const fields: Record<string, string> = {};
  parsed.aiView.forEach((sentence, index) => (fields[`ai_${index}`] = sentence));
  parsed.hooks.forEach((hook, index) => {
    fields[`hook_${index}_text`] = hook.text;
    fields[`hook_${index}_opener`] = hook.opener;
  });
  parsed.profileSuggestions.forEach((_, index) => (fields[`profile_${index}`] = '1'));
  const confirmed = await post(t, owner.session, `/w/${wall.id}/me/create/confirm`, fields);
  if (confirmed.status !== 303) throw new Error(`confirm ${confirmed.status}: ${(await confirmed.text()).slice(0, 300)}`);
}

/** 发起生成并等待任务结束，返回任务。 */
export async function generate(t: HostedTestWeb, wall: Wall, owner: HostedOwner) {
  const response = await post(t, owner.session, `/w/${wall.id}/me/generate`);
  const location = response.headers.get('location') ?? '';
  await t.web.deps.hosted?.idle();
  const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(location)?.[1];
  return { response, location, job: jobId ? t.repos.jobs.findById(jobId) : null };
}

export async function edit(t: HostedTestWeb, wall: Wall, owner: HostedOwner, fields: { revisionId: string; block?: string; request: string }) {
  const response = await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId: fields.revisionId, block: fields.block ?? '', request: fields.request });
  const location = response.headers.get('location') ?? '';
  await t.web.deps.hosted?.idle();
  const jobId = /\/jobs\/(gen_[a-z2-7]+)/.exec(location)?.[1];
  return { response, location, job: jobId ? t.repos.jobs.findById(jobId) : null };
}

export { createUser, get, post };
