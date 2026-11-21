/**
 * e2e 共用工具：登录（从发件箱文件取验证码）、建墙 / 加入 / 生成指令 / 发布（走真实页面表单）、CLI 子进程、探针服务器。
 * 数据目录 `.data/e2e` 由 playwright.config.ts 在启动服务前清空；每个用例用随机邮箱，互不干扰。
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const WEB_ORIGIN = process.env.NOWME_E2E_WEB_ORIGIN ?? 'http://localhost:3200';
export const PAGES_ORIGIN = process.env.NOWME_E2E_PAGES_ORIGIN ?? 'http://127.0.0.1:4200';
export const REPO = resolve(import.meta.dirname, '../..');
export const OUTBOX_FILE = join(REPO, process.env.NOWME_E2E_DATA_DIR ?? '.data/e2e', 'outbox.log');
export const EXAMPLES = join(REPO, 'skill/examples');

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}@e2e.test`;
}

export async function latestCode(email: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const messages = readFileSync(OUTBOX_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { to: string; body: string })
        .filter((message) => message.to === email);
      const code = messages.at(-1)?.body.match(/\d{6}/)?.[0];
      if (code) return code;
    } catch {
      // 文件还没有生成
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`发件箱里没有 ${email} 的验证码`);
}

/** 登录（首次登录会填昵称）。 */
export async function login(page: Page, email: string, nickname: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(email);
  await page.getByRole('button', { name: '发送验证码' }).click();
  await page.getByLabel('6 位验证码').fill(await latestCode(email));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => url.pathname !== '/login/verify' && url.pathname !== '/login');
  if (new URL(page.url()).pathname === '/welcome') {
    await page.getByLabel('昵称').fill(nickname);
    await page.locator('input[type="checkbox"][required]').check();
    await page.getByRole('button', { name: '进入 NOWMe' }).click();
  }
  await page.waitForURL((url) => url.pathname !== '/welcome');
}

export async function newUser(context: BrowserContext, prefix: string, nickname: string): Promise<{ page: Page; email: string }> {
  const page = await context.newPage();
  const email = uniqueEmail(prefix);
  await login(page, email, nickname);
  return { page, email };
}

/** 组织者建一面黑客松墙，返回墙 ID 与邀请链接。 */
export async function createWall(page: Page, name: string): Promise<{ wallId: string; inviteUrl: string }> {
  await page.goto('/walls/new');
  await page.getByLabel('墙的名称').fill(name);
  await page.getByLabel('简介').fill('e2e 测试墙');
  await page.getByRole('radio', { name: /黑客松/ }).check();
  await page.getByRole('button', { name: '建好了，去拿邀请链接' }).click();
  await page.waitForURL(/\/w\/wal_[^/]+\/admin/);
  const wallId = /\/w\/(wal_[^/]+)\//.exec(page.url())?.[1] ?? '';
  const inviteUrl = (await page.locator('#nm-invite-link').textContent())?.trim() ?? '';
  expect(inviteUrl).toContain('/join/');
  return { wallId, inviteUrl };
}

export async function joinWall(page: Page, inviteUrl: string): Promise<void> {
  await page.goto(inviteUrl);
  await page.getByRole('button', { name: '加入这面墙' }).click();
  // 新成员直接进入“做一页自己”的引导（contracts 18.1）
  await page.waitForURL(/\/w\/wal_[^/]+\/me\/create\?welcome=1$/);
}

/** 在“我的页面”的“更多方式”里生成给 AI 助手的指令，返回 token（指令格式：`/nowme-page <wallId> <token> --server <origin>`）。 */
/** 墙默认是逛墙空间：点海报在详情面板里展开，再从面板进入成员页。 */
export async function openFromWall(page: Page, link: Locator): Promise<void> {
  await link.click();
  await page.locator('[data-space-open]').click();
}

export async function generateInstruction(page: Page, wallId: string): Promise<{ command: string; token: string }> {
  await page.goto(`/w/${wallId}/me`);
  const more = page.locator('details#more-ways');
  if ((await more.count()) > 0 && !(await more.evaluate((element) => (element as HTMLDetailsElement).open))) await more.locator('summary').first().click();
  await page.getByRole('button', { name: '生成给 AI 助手的指令' }).click();
  const command = (await page.locator('#nm-instruction-command').textContent())?.trim() ?? '';
  const match = /^\/nowme-page (wal_\S+) (nmt_\S+) --server (\S+)$/.exec(command);
  expect(match, command).not.toBeNull();
  return { command, token: match?.[2] ?? '' };
}

/** 工作区发布确认：可改写一行介绍，选择是否公开联系方式。 */
export async function publishViaUi(
  page: Page,
  wallId: string,
  options: { tagline?: string; contactValue: string; contactPublic: boolean },
): Promise<void> {
  await page.goto(`/w/${wallId}/me`);
  if (options.tagline) await page.getByLabel('一行介绍').fill(options.tagline);
  await page.getByLabel('账号或号码').fill(options.contactValue);
  const publicBox = page.locator('input[name="contactPublic"]');
  if (options.contactPublic) await publicBox.check();
  else await publicBox.uncheck();
  await page.locator('input[name="confirm"]').check();
  await page.locator('form[action$="/me/publish"] button[type="submit"]').click();
  await expect(page.locator('.notice').first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// Agent API（不经 CLI 时使用）
// ---------------------------------------------------------------------------

export function exampleFiles(name: string): Record<string, string> {
  const dir = join(EXAMPLES, name);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    if (entry === 'DESIGN.md') continue;
    files[entry] = readFileSync(join(dir, entry)).toString('base64');
  }
  return files;
}

export async function exchangeToken(wallId: string, token: string): Promise<string> {
  const response = await fetch(`${WEB_ORIGIN}/api/agent/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallId, token }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { credential: string }).credential;
}

export async function submitFiles(credential: string, files: Record<string, string>): Promise<{ status: string; id: string; errors: string[] }> {
  const response = await fetch(`${WEB_ORIGIN}/api/agent/revisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ files }),
  });
  const body = (await response.json()) as { revision: { id: string; status: string; report: { errors: { code: string; message: string }[] } } };
  return { status: body.revision.status, id: body.revision.id, errors: body.revision.report.errors.map((e) => `${e.code} ${e.message}`) };
}

// ---------------------------------------------------------------------------
// CLI 子进程
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 运行 `pnpm nowme <args>`：INIT_CWD 指向工作目录，NOWME_HOME 指向临时目录。 */
export function runCli(args: string[], options: { cwd: string; home: string }): Promise<CliResult> {
  mkdirSync(options.home, { recursive: true });
  return new Promise((resolveRun) => {
    execFile(
      'pnpm',
      ['--silent', '--dir', REPO, 'nowme', ...args],
      { env: { ...process.env, INIT_CWD: options.cwd, NOWME_HOME: options.home, NO_COLOR: '1' }, cwd: options.cwd, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolveRun({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      },
    );
  });
}

export function writeFile(path: string, content: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

// ---------------------------------------------------------------------------
// 探针服务器：收到任何请求都记下来
// ---------------------------------------------------------------------------

export interface Probe {
  url: string;
  port: number;
  hits: string[];
  close(): Promise<void>;
}

export async function startProbe(): Promise<Probe> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.setHeader('access-control-allow-origin', '*');
    response.end('probe');
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
