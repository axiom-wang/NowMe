/**
 * 主站测试工具：临时数据目录 + 内存数据库 + 可控时钟 + 内存发件箱 + 假的提交处理器（真实静态校验，不启动浏览器）。
 * 需要真实渲染的测试见 submission-render.test.ts。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'parse5';
import {
  generateId,
  hashToken,
  loadConfig,
  PAGE_INDEX_FILE,
  SESSION_COOKIE_NAME,
  SKILL_MIN_NODE_VERSION,
  skillArchiveFileName,
  type ExchangeResponse,
} from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { EXAMPLES_DIR } from '@nowme/skill';
import { validatePage } from '@nowme/validator';
import { createWebApp, type WebApp, type WebConfig } from '../src/app.js';
import { openDatabase, type Database } from '../src/db/index.js';
import type { Repos } from '../src/db/index.js';
import { createInstruction, type AgentInstruction } from '../src/services/instruction.js';
import { createMemoryOutbox, type OutboxMessage } from '../src/services/outbox.js';
import type { ProcessedSubmission, SubmissionProcessor } from '../src/services/processor.js';
import type { RemoteRenderer, RemoteRenderResult } from '../src/services/remote-preview.js';
import { addMember, createWall, type MemberPage } from '../src/services/walls.js';
import type { Wall } from '../src/db/walls.js';
import type { ClaudeClient } from '../src/hosted/claude.js';
import type { PagePreviewer } from '../src/hosted/tools.js';

export const TEST_SECRET = 'test-ticket-secret-0123456789abcdefghijklmnop';
export const START = new Date('2026-11-06T08:00:00.000Z');
export const KIT_FONTS = loadKitFonts();

/** 1×1 PNG（假处理器的截图）。 */
export const TINY_PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64'),
);

/** 测试用 Skill 包的版本（与真实 SKILL_VERSION 无关）。 */
export const TEST_SKILL_VERSION = '0.1.0';

/**
 * 写一个测试用的 Skill 包目录（`manifest.json` + 内容任意的“归档”，sha256 与大小一致），返回目录。
 * 主站测试不依赖 `skill/dist-package/` 是否已经打包；真实打包在 skill 包的测试里覆盖。
 */
export function writeTestSkillPackage(version: string = TEST_SKILL_VERSION): string {
  const dir = mkdtempSync(join(tmpdir(), 'nowme-skill-pkg-'));
  const archive = Buffer.from(`fake nowme-page ${version} archive`);
  const file = skillArchiveFileName(version);
  writeFileSync(join(dir, file), archive);
  const manifest = {
    name: 'nowme-page',
    version,
    file,
    sha256: createHash('sha256').update(archive).digest('hex'),
    bytes: archive.byteLength,
    minNode: SKILL_MIN_NODE_VERSION,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

let sharedSkillPackageDir: string | null = null;
function defaultTestSkillPackageDir(): string {
  sharedSkillPackageDir ??= writeTestSkillPackage();
  return sharedSkillPackageDir;
}

export interface StaticRemoteRenderer extends RemoteRenderer {
  calls: number;
}

/** 假的远程预览渲染器：真实的静态校验，不启动浏览器；有 index.html 就返回 TINY_PNG 截图。 */
export function createStaticRemoteRenderer(): StaticRemoteRenderer {
  const renderer: StaticRemoteRenderer = {
    calls: 0,
    async render(files, kitFonts): Promise<RemoteRenderResult> {
      renderer.calls += 1;
      const report = validatePage(files, { kitFonts });
      const rendered = files.has(PAGE_INDEX_FILE);
      return {
        report,
        rendered,
        cover: rendered ? TINY_PNG : null,
        full: rendered ? TINY_PNG : null,
        reducedMotion: rendered ? TINY_PNG : null,
        blocks: rendered ? [{ id: 'hero', top: 0, height: 100, png: TINY_PNG }] : [],
      };
    },
    async close() {},
  };
  return renderer;
}

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
  set(date: Date): void;
}

export function createClock(start: Date = START): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (date) => {
      current = date.getTime();
    },
  };
}

export const HOUR = 3600 * 1000;
export const MINUTE = 60 * 1000;

export interface StaticProcessor extends SubmissionProcessor {
  calls: number;
}

/** 假处理器：真实的静态校验（validatePage），不渲染；通过时把 index.html 与 assets/ 当作 served/。 */
export function createStaticProcessor(): StaticProcessor {
  const processor: StaticProcessor = {
    calls: 0,
    async process({ files, kitFonts }): Promise<ProcessedSubmission> {
      processor.calls += 1;
      const report = validatePage(files, { kitFonts });
      if (!report.ok) {
        return { report, served: new Map(), cover: null, fullScreenshot: null, renderedText: '', render: null };
      }
      const served = new Map([...files].filter(([path]) => path === PAGE_INDEX_FILE || path.startsWith('assets/')));
      return {
        report,
        served,
        cover: files.get('cover.png') ?? TINY_PNG,
        fullScreenshot: TINY_PNG,
        renderedText: '渲染后的文字',
        render: { fake: true },
      };
    },
    async close() {},
  };
  return processor;
}

export interface TestWeb {
  web: WebApp;
  db: Database;
  repos: Repos;
  config: WebConfig;
  clock: TestClock;
  outbox: ReturnType<typeof createMemoryOutbox>;
  processor: SubmissionProcessor;
  dataDir: string;
  /** 以主站源发请求（path 以 / 开头）。 */
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export interface TestWebOptions {
  processor?: SubmissionProcessor;
  env?: Record<string, string>;
  clock?: TestClock;
  /** 平台托管路线（需要 env 里 `NOWME_CLAUDE_FAKE=1` 或 `ANTHROPIC_API_KEY` 才会开启）。 */
  claude?: ClaudeClient;
  previewer?: PagePreviewer;
  hostedTempRoot?: string;
  remoteRenderer?: RemoteRenderer;
  /** 默认一个共享的测试 Skill 包；null 表示没有 Skill 包。 */
  skillPackageDir?: string | null;
}

export function createTestWeb(options: TestWebOptions = {}): TestWeb {
  const dataDir = mkdtempSync(join(tmpdir(), 'nowme-web-'));
  const base = loadConfig({ NOWME_DATA_DIR: dataDir, NODE_ENV: 'test', ...options.env });
  const config: WebConfig = { ...base, ticketSecret: TEST_SECRET };
  const db = openDatabase(':memory:');
  const clock = options.clock ?? createClock();
  const outbox = createMemoryOutbox();
  const processor = options.processor ?? createStaticProcessor();
  const web = createWebApp({
    config,
    db,
    processor,
    clock: clock.now,
    outbox,
    kitFonts: KIT_FONTS,
    log: () => {},
    claude: options.claude,
    previewer: options.previewer,
    hostedTempRoot: options.hostedTempRoot,
    remoteRenderer: options.remoteRenderer ?? createStaticRemoteRenderer(),
    skillPackageDir: options.skillPackageDir === undefined ? defaultTestSkillPackageDir() : options.skillPackageDir,
  });
  return {
    web,
    db,
    repos: web.deps.repos,
    config,
    clock,
    outbox,
    processor,
    dataDir,
    request: (path, init) => Promise.resolve(web.request(`${config.webOrigin}${path}`, init)),
    async close() {
      await web.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 表单与会话
// ---------------------------------------------------------------------------

export interface FormRequestOptions {
  cookie?: string;
  /** 默认主站源；传 null 不带 Origin。 */
  origin?: string | null;
  referer?: string;
  headers?: Record<string, string>;
}

export function postForm(t: TestWeb, path: string, fields: Record<string, string>, options: FormRequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', ...options.headers };
  const origin = options.origin === undefined ? t.config.webOrigin : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.referer) headers.referer = options.referer;
  if (options.cookie) headers.cookie = options.cookie;
  return t.request(path, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
}

export function get(t: TestWeb, path: string, options: { cookie?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  return t.request(path, { headers });
}

/** 发件箱里发给某邮箱的最新验证码。 */
export function latestCode(t: TestWeb, email: string): string {
  const message = [...t.outbox.messages].reverse().find((item: OutboxMessage) => item.to === email);
  const code = message?.body.match(/\d{6}/)?.[0];
  if (!code) throw new Error(`发件箱里没有发给 ${email} 的验证码`);
  return code;
}

/** Set-Cookie 中的会话令牌。 */
export function sessionTokenFrom(response: Response): string | null {
  for (const header of response.headers.getSetCookie()) {
    const match = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]*)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return null;
}

export interface TestSession {
  userId: string;
  email: string;
  token: string;
  cookie: string;
  csrf: string;
}

export function csrfOf(t: TestWeb, token: string): string {
  const row = t.db.prepare('SELECT csrf_token FROM sessions WHERE id = ?').get(hashToken(token)) as { csrf_token: string } | undefined;
  if (!row) throw new Error('会话不存在');
  return row.csrf_token;
}

/** 走完整的登录流程（发码 → 验证 → 首次填昵称），返回会话。 */
export async function login(t: TestWeb, email: string, nickname = '测试用户'): Promise<TestSession> {
  const sent = await postForm(t, '/login', { email });
  if (sent.status !== 200) throw new Error(`发送验证码失败：${sent.status}`);
  const verified = await postForm(t, '/login/verify', { email, code: latestCode(t, email) });
  const token = sessionTokenFrom(verified);
  if (verified.status !== 303 || !token) throw new Error(`登录失败：${verified.status}`);
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const csrf = csrfOf(t, token);
  if (verified.headers.get('location')?.startsWith('/welcome')) {
    const welcomed = await postForm(t, '/welcome', { _csrf: csrf, nickname }, { cookie });
    if (welcomed.status !== 303) throw new Error(`填写昵称失败：${welcomed.status}`);
  }
  const user = t.repos.users.findByEmail(email.toLowerCase());
  if (!user) throw new Error('用户不存在');
  return { userId: user.id, email, token, cookie, csrf };
}

// ---------------------------------------------------------------------------
// 墙、页面与 Agent
// ---------------------------------------------------------------------------

export function createUser(t: TestWeb, email: string, nickname = '成员'): string {
  const id = generateId('usr');
  t.repos.users.create({ id, email, nickname, createdAt: t.clock.now().toISOString() });
  return id;
}

export function seedWall(t: TestWeb, organizerId: string, name = '测试黑客松'): { wall: Wall } & MemberPage {
  return createWall(t.web.deps, { organizerId, name, description: '测试用的墙', sceneType: 'hackathon', organizerNote: null });
}

export function seedMember(t: TestWeb, wall: Wall, userId: string): MemberPage {
  return addMember(t.web.deps, wall, userId);
}

export function issueInstruction(t: TestWeb, wall: Wall, page: MemberPage['page']): AgentInstruction {
  return createInstruction(t.web.deps, wall, page);
}

export function postJson(t: TestWeb, path: string, body: unknown, credential?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (credential) headers.authorization = `Bearer ${credential}`;
  return t.request(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

export function agentGet(t: TestWeb, path: string, credential: string): Promise<Response> {
  return t.request(path, { headers: { authorization: `Bearer ${credential}` } });
}

export async function exchange(t: TestWeb, wallId: string, token: string): Promise<Response> {
  return postJson(t, '/api/agent/exchange', { wallId, token });
}

/** 种一面墙、生成指令并换取凭证。 */
export async function connectAgent(t: TestWeb, wall: Wall, page: MemberPage['page']): Promise<string> {
  const instruction = issueInstruction(t, wall, page);
  const response = await exchange(t, wall.id, instruction.token);
  if (response.status !== 200) throw new Error(`exchange 失败：${response.status} ${await response.text()}`);
  return ((await response.json()) as ExchangeResponse).credential;
}

// ---------------------------------------------------------------------------
// 页面文件
// ---------------------------------------------------------------------------

/** skill/examples/<name> 的文件（相对路径 → base64），默认不含 DESIGN.md。 */
export function exampleFiles(name = 'hackathon-terminal', options: { includeCover?: boolean; extra?: boolean } = {}): Record<string, string> {
  const dir = join(EXAMPLES_DIR, name);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    if (entry === 'DESIGN.md' && !options.extra) continue;
    if (entry === 'cover.png' && options.includeCover === false) continue;
    files[entry] = readFileSync(join(dir, entry)).toString('base64');
  }
  return files;
}

export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** 一个校验不通过的页面（缺 card.json 与 manifest.json）。 */
export function brokenFiles(): Record<string, string> {
  return { 'index.html': b64('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>坏页面</body></html>') };
}

// ---------------------------------------------------------------------------
// HTML 与数据库检查
// ---------------------------------------------------------------------------

interface Parse5Node {
  nodeName: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Parse5Node[];
  content?: Parse5Node;
}

export interface ParsedElement {
  tag: string;
  attrs: Record<string, string>;
}

/** 解析 HTML，返回全部元素（含 template 内容）。 */
export function elements(html: string): ParsedElement[] {
  const result: ParsedElement[] = [];
  const walk = (node: Parse5Node) => {
    if (node.attrs) {
      result.push({ tag: node.nodeName, attrs: Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value])) });
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parse(html) as unknown as Parse5Node);
  return result;
}

export function iframesOf(html: string): Record<string, string>[] {
  return elements(html)
    .filter((element) => element.tag === 'iframe')
    .map((element) => element.attrs);
}

/** 整个数据库的快照（每张表的全部行），用于断言“数据库无变化”。 */
export function dumpDb(db: Database): Record<string, unknown[]> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

/** 数据目录下全部文件的相对路径。 */
export function listFiles(dir: string, prefix = ''): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(dir, prefix));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    let children: string[] | null = null;
    try {
      children = readdirSync(join(dir, rel));
    } catch {
      children = null;
    }
    if (children === null) out.push(rel);
    else out.push(...listFiles(dir, rel));
  }
  return out.sort();
}
