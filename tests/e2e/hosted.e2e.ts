/**
 * 平台托管路线（contracts 9 / hosted-route 9）：模型服务用假实现替代（NOWME_MODEL_FAKE=1），其余全部真实——
 * 采访（素材 + 点选 + 上传图片）→ 追问 → 确认“AI 眼中的你” → 生成（真实工具循环、validator、render 截图自查、平台重新校验）→
 * 沙箱预览 → 指定区块修改 → 新版本预览 → 发布确认 → 另一成员在墙上看到；组织者看不到 brief。
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EXAMPLES, PAGES_ORIGIN, createWall, joinWall, newUser, publishViaUi } from './helpers.js';

const SECRET = '凌晨四点去菜市场拍摊主的手';

/** 任务页每 3 秒自动刷新，等到出现“去预览”链接。 */
async function waitForJob(page: Page, label: string): Promise<void> {
  await expect(page).toHaveURL(/\/me\/jobs\/gen_/);
  await expect(page.getByRole('link', { name: label })).toBeVisible({ timeout: 90_000 });
}

test('平台托管：采访、生成、预览、修改、发布', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const organizerContext = await browser.newContext();
  const organizer = await newUser(organizerContext, 'hosted-org', '组织者');
  const { wallId, inviteUrl } = await createWall(organizer.page, 'e2e 托管黑客松');

  const aContext = await browser.newContext();
  const a = await newUser(aContext, 'hosted-a', '阿柚');
  await joinWall(a.page, inviteUrl);

  // 1. 工作区里“在这里创作”与本地 Agent 指令并列
  await a.page.goto(`/w/${wallId}/me`);
  await expect(a.page.getByRole('heading', { name: '在这里创作' })).toBeVisible();
  await expect(a.page.getByRole('button', { name: '生成 Agent 指令' })).toBeVisible();
  await a.page.getByRole('link', { name: '开始采访' }).click();

  // 2. 素材 + 点选 + 图片
  await expect(a.page.getByText('会发送给 AI 模型服务（测试用的假模型）')).toBeVisible();
  for (const width of [1440, 375, 320]) {
    await a.page.setViewportSize({ width, height: 1000 });
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 创作页不溢出`).toBe(true);
    await expect(a.page.getByRole('list', { name: '采访进度' }).locator('[aria-current="step"]')).toContainText('认识你');
    if (width !== 320) await a.page.screenshot({ path: testInfo.outputPath(`create-${width}.png`), fullPage: true });
  }
  await a.page.setViewportSize({ width: 1440, height: 1000 });
  await a.page.locator('textarea[name="material"]').fill(`我叫阿柚。做过 3 个校园小程序，负责前端。我总在${SECRET}。`);
  await expect(a.page.locator('[data-material-count]')).not.toHaveText('0 / 4000');
  const tooManyPhotos = Array.from({ length: 7 }, (_, i) => ({ name: `${i}.png`, mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) }));
  await a.page.locator('input[name="photos"]').setInputFiles(tooManyPhotos);
  await expect(a.page.locator('[data-photo-status]')).toContainText('图片最多 6 张');
  expect(await a.page.locator('input[name="photos"]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await a.page.locator('input[name="photos"]').setInputFiles(join(EXAMPLES, 'interest-film-zine', 'cover.png'));
  await expect(a.page.locator('[data-photo-list] img')).toBeVisible();
  await expect(a.page.locator('[data-photo-status]')).toContainText('已选择 1 张图片');
  expect(await a.page.locator('input[name="photos"]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  const writeIn = a.page.locator('fieldset').filter({ has: a.page.locator('input[name="q_role"]') }).locator('.create-writein');
  await expect(writeIn).not.toHaveAttribute('open');
  await a.page.locator('input[name="q_role"][data-write-in]').check();
  await expect(writeIn).toHaveAttribute('open', '');
  await a.page.locator('input[name="q_role"][value="0"]').check();
  await a.page.locator('input[name="q_teammate_0"]').check();
  await a.page.locator('input[name="style_hackathon-terminal"]').check();
  await a.page.locator('input[name="style_hackathon-poster"]').check();
  await a.page.locator('input[name="style_interest-vinyl"]').check();
  await expect(a.page.locator('[data-style-status]')).toContainText('最多选择 2 个参考');
  expect(await a.page.locator('input[name="style_hackathon-terminal"]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await a.page.locator('input[name="style_hackathon-poster"]').uncheck();
  await a.page.locator('input[name="style_interest-vinyl"]').uncheck();
  await expect(a.page.locator('[data-style-status]')).toHaveText('已选 1 / 2 个参考');
  await a.page.getByRole('button', { name: '下一步' }).click();

  // 3. 追问
  await expect(a.page.getByText('能说一个只属于你的具体细节吗？')).toBeVisible();
  await a.page.locator('input[name="f_f1_text"]').fill('会用五种方言说你吃了没');
  await a.page.getByRole('button', { name: '整理“AI 眼中的你”' }).click();

  // 4. 确认“AI 眼中的你”
  await expect(a.page.getByRole('heading', { name: '这是 AI 眼中的你' })).toBeVisible();
  await a.page.locator('input[name="ai_0"]').fill('你是阿柚，一个做小程序的前端。');
  await a.page.getByRole('button', { name: '确认，就是我' }).click();
  await expect(a.page.getByRole('heading', { name: 'brief 已确认' })).toBeVisible();
  await expect(a.page.getByText('使用你的 AI API，模型费用由服务商向你收取')).toBeVisible();

  // 5. 生成（真实工具循环 + 渲染截图 + 平台重新校验）
  await a.page.getByRole('button', { name: '开始生成页面' }).click();
  await waitForJob(a.page, '去预览第 1 版');
  await a.page.getByRole('link', { name: '去预览第 1 版' }).click();
  const frame = a.page.locator('iframe[data-nm-page-frame]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('src', new RegExp(`^${PAGES_ORIGIN}/v/`));
  await expect(a.page.frameLocator('iframe[data-nm-page-frame]').locator('h1')).toHaveText('阿柚');
  await expect(a.page.frameLocator('iframe[data-nm-page-frame]').locator('img')).toBeVisible(); // 上传的图片进了页面
  await expect(a.page.locator('.revision', { hasText: '第 1 版' })).toContainText('在这里创作');

  // 6. 指定区块修改
  const editPanel = a.page.locator('details.ws-hosted__edit');
  if (!(await editPanel.evaluate((element) => (element as HTMLDetailsElement).open))) await a.page.getByText('用日常语言修改第 1 版').click();
  await a.page.locator('form[action$="/me/edit"] select[name="block"]').selectOption('about');
  await a.page.locator('form[action$="/me/edit"] textarea[name="request"]').fill('再加一句我拿过校赛二等奖');
  await a.page.getByRole('button', { name: /按这个修改/ }).click();
  await waitForJob(a.page, '去预览第 2 版');
  await a.page.getByRole('link', { name: '去预览第 2 版' }).click();
  await expect(a.page.frameLocator('iframe[data-nm-page-frame]').locator('[data-nm-id="about"]')).toContainText('已按要求修改：再加一句我拿过校赛二等奖');
  await expect(a.page.getByText('免费次数')).toHaveCount(0);

  // 7. 发布确认（平台不会替主人发布）
  await publishViaUi(a.page, wallId, { contactValue: 'ayou_e2e', contactPublic: true });
  await expect(a.page.getByText('已发布').first()).toBeVisible();

  // 8. 另一成员在墙上看到并打开
  const bContext = await browser.newContext();
  const b = await newUser(bContext, 'hosted-b', '小白');
  await joinWall(b.page, inviteUrl);
  await b.page.goto(`/w/${wallId}`);
  const card = b.page.locator('.wall-card', { hasText: '阿柚' });
  await expect(card).toHaveCount(1);
  await card.locator('a.wall-card__link').click();
  await expect(b.page.frameLocator('iframe[data-nm-page-frame]').locator('[data-nm-id="about"]')).toContainText('校赛二等奖');
  expect(await b.page.content()).not.toContain('/create/assets/');

  // 9. 组织者看不到 brief：后台不含；自己的 brief 路径 404
  await organizer.page.goto(`/w/${wallId}/admin`);
  const adminHtml = await organizer.page.content();
  expect(adminHtml).not.toContain(SECRET);
  expect(adminHtml).not.toContain('brief');
  const briefResponse = await organizer.page.goto(`/w/${wallId}/me/brief`);
  expect(briefResponse?.status()).toBe(404);

  // 10. 主人在“我的资料”里能看到并删除 brief
  await a.page.goto('/account/data');
  await expect(a.page.getByText('e2e 托管黑客松')).toBeVisible();
  a.page.once('dialog', (dialog) => void dialog.accept());
  await a.page.locator('form[action="/account/briefs/delete"] button').click();
  await expect(a.page.getByText('brief 已删除')).toBeVisible();
});
