/**
 * 平台托管路线（contracts 9 / hosted-route 9）：模型服务用假实现替代（NOWME_MODEL_FAKE=1），其余全部真实——
 * 采访（素材 + 点选 + 上传图片）→ 追问 → 确认“AI 眼中的你” → 生成（真实工具循环、validator、render 截图自查、平台重新校验）→
 * 沙箱预览 → 指定区块修改 → 新版本预览 → 发布确认 → 另一成员在墙上看到；组织者看不到 brief。
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EXAMPLES, PAGES_ORIGIN, createWall, joinWall, newUser, publishViaUi } from './helpers.js';

const SECRET = '凌晨四点去菜市场拍摊主的手';

/** 任务页实时显示进度（SSE），做好后自动跳到预览（contracts 18.2）。 */
async function waitForJob(page: Page, revisionNumber: number): Promise<void> {
  await expect(page).toHaveURL(/\/me\/jobs\/gen_/);
  await expect(page.locator('[data-job-progress] [data-progress-label]')).toBeVisible();
  await expect(page).toHaveURL(/\/me\?rev=rev_/, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: `预览：第 ${revisionNumber} 版` })).toBeVisible();
}

test('平台托管：采访、生成、预览、修改、发布', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const organizerContext = await browser.newContext();
  const organizer = await newUser(organizerContext, 'hosted-org', '组织者');
  const { wallId, inviteUrl } = await createWall(organizer.page, 'e2e 托管黑客松');

  const aContext = await browser.newContext();
  const a = await newUser(aContext, 'hosted-a', '阿柚');
  await joinWall(a.page, inviteUrl);

  // 1. 加入后直接进入引导；我的页面里只突出“开始采访”，其他方式收在“更多方式”里
  await expect(a.page.getByText('欢迎加入「e2e 托管黑客松」')).toBeVisible();
  await a.page.goto(`/w/${wallId}/me`);
  await expect(a.page.getByRole('heading', { name: '先聊几句，让 AI 认识你' })).toBeVisible();
  await expect(a.page.getByRole('button', { name: '生成给 AI 助手的指令' })).toBeHidden();
  await a.page.getByRole('link', { name: '开始采访' }).click();

  // 2. 素材 + 点选 + 图片
  await expect(a.page.getByText('会发送给 AI 模型服务（测试用的假模型）')).toBeVisible();
  await expect(a.page.locator('[data-interview]')).not.toContainText(/没有就回复|回复编号增减/);
  for (const width of [1440, 375, 320]) {
    await a.page.setViewportSize({ width, height: width === 1440 ? 1000 : 667 });
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 创作页不溢出`).toBe(true);
    await expect(a.page.getByRole('list', { name: '采访进度' }).locator('[aria-current="step"]')).toContainText('认识你');
    if (width <= 375) await expect(a.page.locator('input[name="quick_snapshot"]').first()).toBeInViewport({ ratio: 1 });
    if (width !== 320) await a.page.screenshot({ path: testInfo.outputPath(`create-${width}.png`), fullPage: false });
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
  await expect.poll(() => a.page.locator('[data-photo-list] img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(a.page.locator('[data-photo-status]')).toContainText('已选择 1 张图片');
  expect(await a.page.locator('input[name="photos"]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  const writeIn = a.page.locator('fieldset').filter({ has: a.page.locator('input[name="q_role"]') }).locator('.create-writein');
  await expect(writeIn).not.toHaveAttribute('open');
  await a.page.locator('input[name="q_role"][data-write-in]').check();
  await expect(writeIn).toHaveAttribute('open', '');
  const role = a.page.getByRole('group', { name: /你这次主要担任什么角色/ });
  await role.getByRole('radio', { name: '跳过', exact: true }).check();
  await expect(role.getByRole('radio', { name: '其他：一句话说明' })).not.toBeChecked();
  await a.page.locator('input[name="q_teammate_0"]').check();
  await a.page.getByText('风格与动效（可以看到草稿后再调）', { exact: true }).click();
  await a.page.locator('input[name="style_hackathon-terminal"]').check();
  await a.page.locator('input[name="style_hackathon-poster"]').check();
  await a.page.locator('input[name="style_interest-vinyl"]').check();
  await expect(a.page.locator('[data-style-status]')).toContainText('最多选择 2 个参考');
  expect(await a.page.locator('input[name="style_hackathon-terminal"]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await a.page.locator('input[name="style_hackathon-poster"]').uncheck();
  await a.page.locator('input[name="style_interest-vinyl"]').uncheck();
  await expect(a.page.locator('[data-style-status]')).toHaveText('已选 1 / 2 个参考');
  await a.page.setViewportSize({ width: 375, height: 667 });
  await a.page.getByRole('button', { name: '下一步' }).click();

  // 3. 追问
  await expect(a.page.getByRole('complementary', { name: '创作流程' })).toContainText('02 / 03');
  await expect(a.page).toHaveURL(/\/create#create-step$/);
  await expect(a.page.locator('#create-step')).toBeFocused();
  await expect(a.page.getByRole('heading', { name: '先确认名字与展示边界', exact: true })).toBeVisible();
  await expect(a.page.getByRole('heading', { name: '这是 AI 眼中的你', exact: true })).toBeVisible();
  await expect(a.page.locator('input[name="f_f1"]:checked')).toHaveCount(0);
  await a.page.getByText(/^补一个例子：/).first().click();
  await a.page.locator('input[name="f_f1_text"]').fill('会用五种方言说你吃了没');
  await a.page.getByRole('button', { name: '用补充内容重新整理' }).click();

  // 4. 确认“AI 眼中的你”
  await expect(a.page.getByRole('complementary', { name: '创作流程' })).toContainText('02 / 03');
  await expect(a.page.getByRole('heading', { name: '这是 AI 眼中的你', exact: true })).toBeVisible();
  await a.page.locator('.hosted-aiview details summary').first().click();
  await a.page.locator('.hosted-hooks details summary').first().click();
  await a.page.setViewportSize({ width: 320, height: 667 });
  const sentence = a.page.getByRole('textbox', { name: '第 1 句', exact: true });
  const opener = a.page.locator('textarea[name="hook_0_opener"]');
  const originalOpener = await opener.inputValue();
  for (const [field, length] of [[sentence, 120], [opener, 80]] as const) {
    await field.fill('这是需要逐句核对的内容'.repeat(12).slice(0, length));
    await expect(field).toHaveAttribute('maxlength', String(length));
    await expect(field).toBeEditable();
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await opener.fill(originalOpener);
  await sentence.fill('你是阿柚，一个做小程序的前端。');
  await a.page.screenshot({ path: testInfo.outputPath('interview-review-mobile.png'), fullPage: true });
  await a.page.getByRole('button', { name: '确认，就是我' }).click();
  await expect(a.page.getByRole('heading', { name: '资料确认好了' })).toBeInViewport({ ratio: 1 });
  await expect(a.page.getByText('使用你的 AI API，模型费用由服务商向你收取')).toBeVisible();
  await a.page.setViewportSize({ width: 1440, height: 1000 });

  // 5. 生成（真实工具循环 + 渲染截图 + 平台重新校验）；做好后自动跳到预览
  await a.page.getByRole('button', { name: '生成页面' }).click();
  await waitForJob(a.page, 1);
  await expect(a.page.getByRole('heading', { name: '第 1 版做好了' })).toBeVisible();
  const frame = a.page.locator('iframe[data-nm-page-frame]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('src', new RegExp(`^${PAGES_ORIGIN}/v/`));
  await expect(a.page.frameLocator('iframe[data-nm-page-frame]').locator('h1')).toHaveText('阿柚');
  await expect(a.page.frameLocator('iframe[data-nm-page-frame]').locator('img')).toBeVisible(); // 上传的图片进了页面
  await expect(a.page.locator('.revision', { hasText: '第 1 版' })).toContainText('在 NOWMe 上做的');

  // 6. 指定区块修改
  const editPanel = a.page.locator('details.ws-hosted__edit');
  if (!(await editPanel.evaluate((element) => (element as HTMLDetailsElement).open))) await a.page.getByText('想改一改？用一句话告诉 AI').click();
  await a.page.locator('form[action$="/me/edit"] select[name="block"]').selectOption('about');
  await a.page.locator('form[action$="/me/edit"] textarea[name="request"]').fill('再加一句我拿过校赛二等奖');
  await a.page.getByRole('button', { name: /按这个修改/ }).click();
  await waitForJob(a.page, 2);
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

  // 8b. 和 TA 聊什么（contracts 11）：小白请 AI 找话题 → 结果只在小白这里 → 用一句开聊，只预填不发送
  const talk = b.page.locator('#talk');
  await expect(talk.getByRole('heading', { name: /和\s*阿柚\s*聊什么/ })).toBeVisible();
  await talk.getByRole('button', { name: '帮我找话题' }).click();
  await expect(b.page.locator('#talk.talk--ready')).toBeVisible({ timeout: 30_000 });
  await expect(talk.getByText('可以这样开口')).toBeVisible();
  await expect(talk.getByText('只有你能看到')).toBeVisible();
  for (const width of [1280, 375]) {
    await b.page.setViewportSize({ width, height: 900 });
    expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 成员页不溢出`).toBe(true);
    await talk.scrollIntoViewIfNeeded();
    await b.page.screenshot({ path: testInfo.outputPath(`talk-${width}.png`), fullPage: false });
  }
  const firstOpener = (await talk.locator('.talk-opener__bubble').first().innerText()).trim();
  expect(firstOpener.length).toBeGreaterThan(6);
  await talk.getByRole('button', { name: '用这句开聊' }).first().click();
  await expect(b.page).toHaveURL(/\/messages\/cnv_/);
  await expect(b.page.locator('textarea[name="text"]')).toHaveValue(firstOpener);
  await expect(b.page.locator('main')).not.toContainText('发送失败');
  // 阿柚那边没有收到任何消息：开场白没有被自动发出去
  await a.page.goto('/messages');
  await expect(a.page.locator('main')).not.toContainText(firstOpener.slice(0, 12));
  // 阿柚自己看自己的页面，没有这个区块；也看不到小白得到的建议
  await a.page.goto(new URL(b.page.url()).searchParams.get('pageId') ? `/w/${wallId}/p/${new URL(b.page.url()).searchParams.get('pageId')}` : `/w/${wallId}`);
  await expect(a.page.locator('#talk')).toHaveCount(0);
  expect(await a.page.content()).not.toContain(firstOpener.slice(0, 12));

  // 9. 组织者看不到 brief：后台不含；自己的 brief 路径 404
  await organizer.page.goto(`/w/${wallId}/admin`);
  const adminHtml = await organizer.page.content();
  expect(adminHtml).not.toContain(SECRET);
  expect(adminHtml).not.toContain('brief');
  const briefResponse = await organizer.page.goto(`/w/${wallId}/me/brief`);
  expect(briefResponse?.status()).toBe(404);

  // 10. 主人在“我的资料”里能看到并删除 brief
  await a.page.goto('/account/data');
  await expect(a.page.getByRole('heading', { name: 'e2e 托管黑客松', exact: true })).toBeVisible();
  a.page.once('dialog', (dialog) => void dialog.accept());
  await a.page.locator('form[action="/account/briefs/delete"] button').click();
  await expect(a.page.getByText('资料已删除')).toBeVisible();
});

test('画像管理与第二面墙快速采访：手动添加、合并、只填意图直接确认', async ({ page }, testInfo) => {
  const owner = await newUser(page.context(), 'profile-fast', '阿柚');
  await createWall(owner.page, '画像的第一面墙');
  const facts = [
    '我做过一个独立游戏，负责前端和剧情设计',
    '我每个周末会用胶片拍街头招牌，已经持续了一整年',
    '我能连讲十分钟手冲咖啡的萃取方法和豆子风味',
    '我做过一个独立小游戏，负责前端和剧情设计',
  ];
  await owner.page.goto('/account/data');
  for (const text of facts) {
    await owner.page.getByText('手动添加一条画像', { exact: true }).click();
    const form = owner.page.locator('form[action="/account/profile/entry"]').filter({ has: owner.page.getByRole('button', { name: '添加画像', exact: true }) });
    await form.locator('[name="text"]').fill(text);
    await form.locator('[name="scope"]').selectOption('all');
    await form.getByRole('button', { name: '添加画像', exact: true }).click();
    await expect(owner.page.getByRole('heading', { name: /长期画像/ })).toBeVisible();
  }
  const row = owner.page.locator('.profile-row').filter({ has: owner.page.locator('p').filter({ hasText: facts[0]! }) });
  await row.locator('.profile-menu > summary').click();
  await row.getByText('编辑或合并', { exact: true }).click();
  await row.locator('[name="mergeId"]').selectOption({ label: facts[3]! });
  await row.locator('[name="text"]').fill('我做过一个独立小游戏，负责前端、剧情和音效');
  await row.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '长期画像（3 条）' })).toBeVisible();
  const { wallId } = await createWall(owner.page, '画像的第二面墙');
  await owner.page.setViewportSize({ width: 375, height: 780 });
  await owner.page.goto(`/w/${wallId}/me/create`);
  await expect(owner.page.getByRole('heading', { name: '这次只说你想突出的那一面' })).toBeVisible();
  await expect(owner.page.locator('[name="material"]')).toBeHidden();
  await owner.page.locator('[name="intent"]').fill('这次想突出我做独立游戏的一面');
  await owner.page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '先确认名字与展示边界' })).toBeVisible();
  await expect(owner.page.locator('.progress__step[aria-current="step"]')).toContainText('确认资料');
  await owner.page.screenshot({ path: testInfo.outputPath('fast-interview-review.png'), fullPage: true });
  await owner.page.getByRole('button', { name: '确认，就是我', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '资料确认好了' })).toBeVisible();
});
