/**
 * 问墙：用一句话找人（contracts 21，假模型）：在墙上问一句 → 原地回到“问墙”区块，看到找到的人与 TA 页面上的原话 →
 * 点示例问题，墙上没人写到时如实说“没找到” → “让 AI 帮我起个头”接到和 TA 聊什么。被找到的人看不到提问。
 */
import { expect, test, type Page } from '@playwright/test';
import { audit } from './a11y-audit.js';
import { createWall, exampleFiles, exchangeToken, generateInstruction, joinWall, newUser, publishViaUi, submitFiles } from './helpers.js';

async function putOnWall(page: Page, wallId: string, example: string, contact: string): Promise<void> {
  const { token } = await generateInstruction(page, wallId);
  const credential = await exchangeToken(wallId, token);
  const submitted = await submitFiles(credential, exampleFiles(example));
  expect(submitted.status, submitted.errors.join('\n')).toBe('accepted');
  await publishViaUi(page, wallId, { contactValue: contact, contactPublic: false });
}

test('问墙：问一句找到人和原话，没人写到时如实说明，起个头只预填', async ({ browser }, testInfo) => {
  const organizer = await newUser(await browser.newContext(), 'ask-org', '组织者');
  const { wallId, inviteUrl } = await createWall(organizer.page, 'e2e 问墙');

  const targets: { page: Page; name: string }[] = [];
  for (const [index, example] of ['hackathon-terminal', 'interest-vinyl', 'interest-film-zine'].entries()) {
    const member = await newUser(await browser.newContext(), `ask-t${index}`, `成员${index}`);
    await joinWall(member.page, inviteUrl);
    await putOnWall(member.page, wallId, example, `ask_t${index}`);
    targets.push({ page: member.page, name: ['林舟', '阿岚', '栗子'][index]! });
  }

  // 提问的人刚加入，还没有自己的页面：问墙不需要先做页面
  const viewer = await newUser(await browser.newContext(), 'ask-v', '新来的');
  await joinWall(viewer.page, inviteUrl);
  const errors: string[] = [];
  viewer.page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // 1. 问一句：回到“问墙”区块，找到栗子，附 TA 页面上的原话
  await viewer.page.goto(`/w/${wallId}`);
  await viewer.page.locator('.wall-assist__section > summary').filter({ hasText: '问问这面墙' }).click();
  const ask = viewer.page.locator('#ask');
  await expect(ask).toContainText('墙上 3 位成员');
  await ask.getByLabel('用一句话说你想找什么样的人').fill('谁喜欢胶片？');
  await ask.getByRole('button', { name: '问墙', exact: true }).click();
  await expect(viewer.page.locator('#ask.ask--ready')).toBeVisible({ timeout: 30_000 });
  await expect(viewer.page).toHaveURL(new RegExp(`/w/${wallId}#ask$`));
  await expect(ask.locator('.ask__asked-text')).toHaveText('谁喜欢胶片？');
  await expect(ask.locator('.ask-card')).toHaveCount(1);
  await expect(ask.locator('.ask-card')).toContainText('栗子');
  await expect(ask.locator('.ask-card q')).toContainText('胶片');
  await expect(ask).toContainText('只有你能看到这次提问和结果');
  for (const [width, mobile] of [[1280, false], [375, true]] as const) {
    await viewer.page.setViewportSize({ width, height: 900 });
    expect(await viewer.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 墙不溢出`).toBe(true);
    expect(await audit(viewer.page, { mobile }), `${width}px 墙页`).toEqual([]);
    await ask.scrollIntoViewIfNeeded();
    await viewer.page.screenshot({ path: testInfo.outputPath(`ask-${width}.png`), fullPage: false });
  }
  await viewer.page.setViewportSize({ width: 1280, height: 900 });

  // 2. 被找到的人看不到这次提问，也没有收到任何消息
  const found = targets.find((target) => target.name === '栗子')!;
  await found.page.goto(`/w/${wallId}`);
  await expect(found.page.locator('main')).not.toContainText('谁喜欢胶片？');
  await found.page.goto('/messages');
  await expect(found.page.locator('main')).not.toContainText('新来的');

  // 3. 起个头：接到对方页面的“和 TA 聊什么”，开场白只预填、不发送
  await ask.locator('.ask-card').getByRole('button', { name: '让 AI 帮我起个头' }).click();
  await expect(viewer.page.locator('#talk.talk--ready')).toBeVisible({ timeout: 30_000 });
  const opener = (await viewer.page.locator('.talk-opener__bubble').first().innerText()).trim();
  await viewer.page.locator('#talk').getByRole('button', { name: '用这句开聊' }).first().click();
  await expect(viewer.page).toHaveURL(/\/messages\/cnv_/);
  await expect(viewer.page.locator('textarea[name="text"]')).toHaveValue(opener);

  // 4. 点示例问题：墙上没人写到“做设计”，如实说没找到，并替换上一次提问
  await viewer.page.goto(`/w/${wallId}`);
  await viewer.page.locator('.wall-assist__section > summary').filter({ hasText: '问问这面墙' }).click();
  await ask.getByRole('button', { name: '谁会做设计？' }).click();
  await expect(ask.locator('.ask__asked-text')).toHaveText('谁会做设计？', { timeout: 30_000 });
  await expect(ask).toContainText('没有人写到这件事');
  await expect(ask.locator('.ask-card')).toHaveCount(0);

  // 5. 清除：提问消失，区块回到开始状态
  await ask.getByRole('button', { name: '清除这次提问' }).click();
  await expect(ask.locator('.ask__asked-text')).toHaveCount(0);
  await expect(ask).toContainText('墙上 3 位成员');
  expect(errors).toEqual([]);
});
