/**
 * AI 介绍值得认识的人（contracts 20，假模型）：第一次进墙时区块自动生成并原地出现 → 看理由与依据 →
 * “让 AI 帮我起个头” → 用一句开聊，只预填不发送。被介绍的人看不到任何介绍。
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

test('AI 介绍：第一次进墙自动生成，起个头后只预填私聊', async ({ browser }, testInfo) => {
  const organizer = await newUser(await browser.newContext(), 'intro-org', '组织者');
  const { wallId, inviteUrl } = await createWall(organizer.page, 'e2e AI 介绍墙');

  const targets: { page: Page; name: string }[] = [];
  for (const [index, example] of ['hackathon-terminal', 'interest-vinyl', 'interest-film-zine'].entries()) {
    const member = await newUser(await browser.newContext(), `intro-t${index}`, `成员${index}`);
    await joinWall(member.page, inviteUrl);
    await putOnWall(member.page, wallId, example, `intro_t${index}`);
    targets.push({ page: member.page, name: ['林舟', '阿岚', '栗子'][index]! });
  }

  const viewer = await newUser(await browser.newContext(), 'intro-v', '苏晴');
  await joinWall(viewer.page, inviteUrl);
  await putOnWall(viewer.page, wallId, 'hackathon-poster', 'intro_v');

  // 1. 第一次进墙：不用点任何按钮，区块自动生成，原地换成结果（页面不跳转）
  const errors: string[] = [];
  viewer.page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await viewer.page.goto(`/w/${wallId}`);
  await viewer.page.getByRole('link', { name: 'AI 帮我找人', exact: true }).click();
  const intros = viewer.page.locator('#intros');
  await expect(viewer.page.locator('#intros.intros--ready')).toBeVisible({ timeout: 30_000 });
  await expect(viewer.page).toHaveURL(new RegExp(`/w/${wallId}#intros$`));
  await expect(intros.locator('.intro-card')).toHaveCount(3);
  for (const target of targets) await expect(intros).toContainText(target.name);
  await expect(intros).toContainText('只有你能看到这些介绍');
  await expect(intros.locator('.intro-quote').first()).toBeVisible();
  await expect(viewer.page.locator('.wall-card__talk--intro')).toHaveCount(3);
  for (const width of [1280, 375]) {
    await viewer.page.setViewportSize({ width, height: 900 });
    expect(await viewer.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 墙不溢出`).toBe(true);
    await intros.scrollIntoViewIfNeeded();
    await viewer.page.screenshot({ path: testInfo.outputPath(`intros-${width}.png`), fullPage: false });
  }

  // 2. 刷新：不会再自动生成（只有第一次是自动的）；有结果的墙页通过无障碍与手机端检查
  await viewer.page.reload();
  await expect(viewer.page.locator('form[data-intro-auto]')).toHaveCount(0);
  await expect(viewer.page.locator('#intros.intros--ready')).toBeVisible();
  await expect(viewer.page.locator('.wall-card__talk--intro')).toHaveCount(3);
  for (const [width, mobile] of [[1280, false], [375, true]] as const) {
    await viewer.page.setViewportSize({ width, height: 900 });
    await viewer.page.evaluate(() => document.getAnimations().forEach((animation) => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish(); }));
    for (const colorScheme of ['light', 'dark'] as const) {
      await viewer.page.emulateMedia({ colorScheme });
      expect(await audit(viewer.page, { mobile }), `${width}px ${colorScheme} 墙页`).toEqual([]);
    }
  }

  // 3. 让 AI 帮我起个头 → 成员页的“和 TA 聊什么”，顶部写着为什么介绍你们认识
  const first = intros.locator('.intro-card').first();
  const name = (await first.locator('.intro-card__name').innerText()).trim();
  await first.getByRole('button', { name: '让 AI 帮我起个头' }).click();
  await expect(viewer.page.locator('#talk.talk--ready')).toBeVisible({ timeout: 30_000 });
  await expect(viewer.page.locator('.talk__intro')).toContainText('AI 介绍你们认识');
  const opener = (await viewer.page.locator('.talk-opener__bubble').first().innerText()).trim();
  await viewer.page.locator('#talk').getByRole('button', { name: '用这句开聊' }).first().click();
  await expect(viewer.page).toHaveURL(/\/messages\/cnv_/);
  await expect(viewer.page.locator('textarea[name="text"]')).toHaveValue(opener);

  // 4. 被介绍的人没有收到任何消息：开场白没有被自动发出去，介绍也不会通知 TA
  const introduced = targets.find((target) => target.name === name)!;
  await introduced.page.goto('/messages');
  await expect(introduced.page.locator('main')).not.toContainText(opener.slice(0, 12));
  expect(errors).toEqual([]);
});
