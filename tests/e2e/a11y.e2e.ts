/**
 * 无障碍与手机端（T8.10）：主要页面在桌面（1280）与手机（390）宽度下检查——
 * 无横向溢出、每页一个 h1 且层级不跳级、landmark 与“跳到主内容”、所有表单控件 / 按钮 / 链接有可访问名称、图片有 alt、iframe 有 title、
 * 文字对比度（AA）、手机端点击区域 ≥ 44×44，以及用键盘 Tab 走完整页时每个元素都有可见的焦点提示。
 * 检查逻辑在 a11y-audit.ts（不依赖 axe）。设置 `NOWME_A11Y_SHOTS=<目录>` 会顺便把每页截图存到该目录。
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { audit, auditFocus } from './a11y-audit.js';
import { createWall, exampleFiles, exchangeToken, generateInstruction, joinWall, newUser, publishViaUi, submitFiles, uniqueEmail } from './helpers.js';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'm390', width: 390, height: 844, mobile: true },
] as const;

const SHOTS = process.env.NOWME_A11Y_SHOTS;

/** 每个样式文件里出现过的 class 选择器（用来查“页面用了某个 class，却只在没加载的样式文件里有定义”）。 */
const STATIC_DIR = join(import.meta.dirname, '../../apps/web/static');
const CSS_CLASSES = new Map<string, Set<string>>(
  readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => [name, new Set([...readFileSync(join(STATIC_DIR, name), 'utf8').matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]!))]),
);

/** 页面上用到的 class 里，只在没有加载的样式文件里定义过的（样式映射漏了）。 */
async function missingStyleBundles(page: Page): Promise<string[]> {
  const { loaded, classes } = await page.evaluate(() => ({
    loaded: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => new URL(link.href).pathname.split('/').pop()!.replace(/\.[0-9a-f]{10}\.css$/, '.css')),
    classes: [...new Set([...document.querySelectorAll('[class]')].flatMap((el) => [...el.classList]))],
  }));
  const problems: string[] = [];
  for (const name of classes) {
    if ([...CSS_CLASSES].some(([file, set]) => loaded.includes(file) && set.has(name))) continue;
    const elsewhere = [...CSS_CLASSES].filter(([file, set]) => !loaded.includes(file) && set.has(name)).map(([file]) => file);
    if (elsewhere.length) problems.push(`styles: .${name} 只在没加载的 ${elsewhere.join(' / ')} 里有样式（已加载：${loaded.join(' ')}）`);
  }
  return problems;
}

interface Visit {
  label: string;
  /** 访问路径；省略时检查当前页（调用方已经导航好）。 */
  path?: string;
  /** 在检查前做的事（展开折叠、触发错误等）。 */
  prepare?: (page: Page) => Promise<void>;
  /** 检查前把页面上所有折叠（菜单除外）都展开，覆盖折叠里的内容。 */
  expand?: boolean;
  /** 跳过的检查项。 */
  skip?: string[];
}

let problems: string[] = [];
test.beforeEach(() => {
  problems = [];
});

async function check(page: Page, visit: Visit, viewport: (typeof VIEWPORTS)[number], index: number): Promise<void> {
  if (visit.path) await page.goto(visit.path);
  await visit.prepare?.(page);
  if (visit.expand) await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>('details:not([data-dismissable])').forEach((details) => (details.open = true)));
  const label = `${viewport.name} ${visit.label}`;
  const started = Date.now();
  const found = await audit(page, { mobile: viewport.mobile, skip: visit.skip });
  for (const problem of found) problems.push(`[${label}] ${problem}`);
  if (!visit.skip?.includes('styles')) for (const problem of await missingStyleBundles(page)) problems.push(`[${label}] ${problem}`);
  const focus = await auditFocus(page);
  for (const problem of focus.problems) problems.push(`[${label}] ${problem}`);
  if (focus.visited === 0) problems.push(`[${label}] focus: Tab 键没有聚焦到任何元素`);
  if (process.env.NOWME_A11Y_VERBOSE) console.log(`[a11y] ${label} ${Date.now() - started}ms focus=${focus.visited} problems=${found.length + focus.problems.length}`);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.screenshot({ path: `${SHOTS}/${viewport.name}-${String(index).padStart(2, '0')}-${visit.label.replace(/[^\w一-龥]+/g, '_')}.png`, fullPage: true });
  }
}

async function runAll(page: Page, visits: Visit[]): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const [index, visit] of visits.entries()) await check(page, visit, viewport, index);
  }
}

/** 创作各阶段：采访 → 追问 → 确认 → 生成进度 → 预览与发布（假模型，真实流程）。每个视口一个新成员。 */
test('创作工作区各阶段：采访、追问、确认、生成进度、预览发布', async ({ browser }) => {
  test.setTimeout(300_000);
  const organizerContext = await browser.newContext();
  const organizer = await newUser(organizerContext, 'a11y-flow-org', '组织者');
  const { wallId, inviteUrl } = await createWall(organizer.page, '创作流程墙');
  const contexts: BrowserContext[] = [organizerContext];
  try {
    for (const [index, viewport] of VIEWPORTS.entries()) {
      const context = await browser.newContext();
      contexts.push(context);
      const member = await newUser(context, `a11y-flow-${viewport.name}`, `创作者${viewport.name}`);
      const page = member.page;
      await joinWall(page, inviteUrl);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // 加入后的引导与采访（第一步）
      await check(page, { label: '采访·认识你（欢迎）' }, viewport, 40);
      await page.locator('textarea[name="material"]').fill('我叫阿柚。做过 3 个校园小程序，负责前端。');
      await page.locator('input[name="q_role"][value="0"]').check();
      await page.locator('input[name="q_teammate_0"]').check();
      await page.getByText('风格与动效（可以看到草稿后再调）', { exact: true }).click();
      await page.locator('input[name="style_hackathon-terminal"]').check();
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByText(/^补一个例子：/).first().click();
      await expect(page.locator('input[name="f_f1_text"]')).toBeVisible();
      await check(page, { label: '采访·追问' }, viewport, 41);
      await page.locator('input[name="f_f1_text"]').fill('会用五种方言说你吃了没');
      await page.getByRole('button', { name: '用补充内容重新整理' }).click();
      await expect(page.getByRole('heading', { name: '这是 AI 眼中的你' })).toBeVisible();
      await check(page, { label: '采访·确认 AI 眼中的你' }, viewport, 42);
      await page.locator('.hosted-aiview details summary').first().click();
      await page.getByRole('textbox', { name: '第 1 句', exact: true }).fill('你是阿柚，一个做小程序的前端。');
      await page.getByRole('button', { name: '确认，就是我' }).click();
      await expect(page.getByRole('heading', { name: '资料确认好了' })).toBeVisible();
      await check(page, { label: '采访·资料确认好了' }, viewport, 43);
      // 生成进度：拦住进度与状态请求，让页面停在“正在做”（不然做好后会自动跳走）
      await page.route('**/me/jobs/*/progress', (route) => route.abort());
      await page.route('**/me/jobs/*/status', (route) => route.abort());
      await page.getByRole('button', { name: '生成页面' }).click();
      await expect(page).toHaveURL(/\/me\/jobs\/gen_/);
      await expect(page.locator('[data-job-progress]')).toBeVisible();
      await check(page, { label: '生成进度' }, viewport, 44);
      await page.unroute('**/me/jobs/*/progress');
      await page.unroute('**/me/jobs/*/status');
      await expect(page).toHaveURL(/\/me\?rev=rev_/, { timeout: 90_000 });
      await check(page, { label: '预览与发布（未发布）' }, viewport, 45);
      await page.goto(`/w/${wallId}/me`);
      await check(page, { label: '我的页面（有版本，未发布）' }, viewport, 46);
      void index;
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
  expect(problems.join('\n')).toBe('');
});

test('主要页面：桌面与 390 宽下的无障碍与手机端检查', async ({ browser }) => {
  test.setTimeout(360_000);
  const guestContext = await browser.newContext();
  const organizerContext = await browser.newContext();
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  const newcomerContext = await browser.newContext();
  const contexts: BrowserContext[] = [guestContext, organizerContext, aContext, bContext, newcomerContext];
  try {
    // ---- 访客与登录流程 ----
    const guest = await guestContext.newPage();
    await runAll(guest, [
      { label: '首页（访客）', path: '/' },
      { label: '登录', path: '/login' },
      { label: '用户协议', path: '/terms' },
      { label: '隐私政策', path: '/privacy' },
      { label: '安装 Skill', path: '/skill' },
      { label: '404', path: '/no-such-page', skip: ['h1', 'heading-order'] },
      {
        label: '登录·邮箱格式错误',
        path: '/login',
        prepare: async (page) => {
          await page.getByLabel('邮箱').fill('not-an-email');
          await page.getByLabel('邮箱').evaluate((input: HTMLInputElement) => input.removeAttribute('type'));
          await page.getByRole('button', { name: '发送验证码' }).click();
          await expect(page.locator('[role="alert"], .notice--bad, .field__error').first()).toBeVisible();
        },
      },
    ]);

    // 验证码页与欢迎页要走真实流程（每个视口一个新邮箱）
    for (const viewport of VIEWPORTS) {
      await guest.setViewportSize({ width: viewport.width, height: viewport.height });
      const email = uniqueEmail(`a11y-${viewport.name}`);
      await guest.goto('/login');
      await guest.getByLabel('邮箱').fill(email);
      await guest.getByRole('button', { name: '发送验证码' }).click();
      await expect(guest.getByLabel('6 位验证码')).toBeVisible();
      await check(guest, { label: '验证码' }, viewport, 20);
      await check(guest, { label: '验证码·错误', prepare: async (page) => {
        await page.getByLabel('6 位验证码').fill('000000');
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.locator('[role="alert"], .notice--bad, .field__error').first()).toBeVisible();
      } }, viewport, 21);
      const { readFileSync } = await import('node:fs');
      const { OUTBOX_FILE } = await import('./helpers.js');
      const code = readFileSync(OUTBOX_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { to: string; body: string }).filter((m) => m.to === email).at(-1)?.body.match(/\d{6}/)?.[0] ?? '';
      await guest.getByLabel('6 位验证码').fill(code);
      await guest.getByRole('button', { name: '登录', exact: true }).click();
      await guest.waitForURL('**/welcome');
      await check(guest, { label: '欢迎与同意' }, viewport, 22);
      await guest.context().clearCookies();
    }

    // ---- 组织者、成员 ----
    const organizer = await newUser(organizerContext, 'a11y-org', '组织者');
    const { wallId, inviteUrl } = await createWall(organizer.page, '无障碍检查墙：一个名字很长很长的墙 Extraordinarily-Long-Wall-Name-Without-Spaces');
    const a = await newUser(aContext, 'a11y-a', 'ExtraordinarilyLongName1');
    await joinWall(a.page, inviteUrl);
    const { token } = await generateInstruction(a.page, wallId);
    const credential = await exchangeToken(wallId, token);
    const submitted = await submitFiles(credential, exampleFiles('hackathon-terminal'));
    expect(submitted.errors).toEqual([]);
    await publishViaUi(a.page, wallId, { tagline: '想找一位会做视觉和交互的搭档', contactValue: 'a11y_e2e', contactPublic: true });
    const b = await newUser(bContext, 'a11y-b', '成员B');
    await joinWall(b.page, inviteUrl);
    await b.page.goto(`/w/${wallId}`);
    const memberHref = (await b.page.locator('a.wall-card__link').first().getAttribute('href')) ?? '';
    expect(memberHref).toContain(`/w/${wallId}/p/`);
    // B 发起一段私聊，之后 /messages 与会话页都有内容
    await b.page.goto(memberHref);
    await b.page.getByRole('button', { name: /想聊这个|发消息|私聊/ }).first().click().catch(() => {});

    // 登录后的首页、我的、各设置页（以组织者身份）
    await runAll(organizer.page, [
      { label: '我的（有墙）', path: '/' },
      { label: '建墙', path: '/walls/new' },
      { label: '墙·组织者', path: `/w/${wallId}` },
      { label: '组织者后台', path: `/w/${wallId}/admin` },
      { label: '组织者后台（全部展开）', path: `/w/${wallId}/admin`, expand: true },
      { label: '必答题', path: `/w/${wallId}/questions` },
      { label: '点数', path: '/account/credits' },
      { label: 'AI 设置', path: '/account/ai' },
      { label: 'AI 设置（全部展开）', path: '/account/ai', expand: true },
      { label: '我的资料', path: '/account/data' },
      { label: '我的资料（编辑资料展开）', path: '/account/data', expand: true },
      { label: '注销账号', path: '/account/delete' },
      { label: '消息', path: '/messages' },
      { label: '墙群聊', path: `/messages/wall/${wallId}` },
    ]);

    // 成员 A：工作区各阶段
    await runAll(a.page, [
      { label: '我的页面（已发布）', path: `/w/${wallId}/me` },
      { label: '我的页面（全部展开）', path: `/w/${wallId}/me`, expand: true },
      { label: '创作·采访', path: `/w/${wallId}/me/create` },
      { label: '创作·采访（全部展开）', path: `/w/${wallId}/me/create`, expand: true },
      { label: '删除我的页面', path: `/w/${wallId}/me/delete` },
      { label: '离开这面墙', path: `/w/${wallId}/leave` },
    ]);

    // 成员 B：墙、成员页（含 iframe）、私聊
    await runAll(b.page, [
      { label: '墙·成员', path: `/w/${wallId}` },
      { label: '成员页', path: memberHref },
      { label: '成员页（举报与拉黑展开）', path: memberHref, expand: true },
      { label: '消息·成员', path: '/messages' },
    ]);

    // 新用户：加入页
    const newcomer = await newUser(newcomerContext, 'a11y-new', '新来的');
    await runAll(newcomer.page, [{ label: '加入这面墙', path: inviteUrl.replace(/^https?:\/\/[^/]+/, '') }]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
  expect(problems.join('\n')).toBe('');
});
