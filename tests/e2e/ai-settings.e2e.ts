import { expect, test } from '@playwright/test';
import { login, newUser } from './helpers.js';

test('账号保存自己的 AI API、跨设备管理、隔离与删除（桌面与手机）', async ({ browser }, testInfo) => {
  const first = await browser.newContext();
  const owner = await newUser(first, 'byok-owner', '阿柚');
  const key = 'sk-e2e-user-secret-only';
  await owner.page.locator('.home-account > summary').click();
  await owner.page.getByRole('link', { name: 'AI 设置', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '使用自己的 AI 服务' })).toBeVisible();
  await owner.page.locator('#interview-provider').selectOption('deepseek');
  await expect(owner.page.locator('#interview-url')).toHaveValue('https://api.deepseek.com/v1');
  await expect(owner.page.locator('#interview-model')).toHaveValue('deepseek-chat');
  await expect(owner.page.locator('#generate-key')).toBeDisabled();
  await owner.page.locator('#interview-key').fill(key);
  await owner.page.getByRole('button', { name: '保存 AI 配置' }).click();
  await expect(owner.page.getByText('配置已保存。')).toBeVisible();
  await expect(owner.page.locator('#interview-key')).toHaveValue('');
  await expect(owner.page.locator('#generate-key')).toHaveValue('');
  expect(await owner.page.content()).not.toContain(key);
  await owner.page.screenshot({ path: testInfo.outputPath('ai-settings-desktop.png'), fullPage: true });

  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const phone = await mobile.newPage();
  await login(phone, owner.email, '阿柚');
  await phone.goto('/account/ai');
  await expect(phone.locator('#generate-model')).toHaveValue('deepseek-chat');
  await expect(phone.getByText('API Key（已加密保存，留空沿用）')).toHaveCount(2);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await phone.screenshot({ path: testInfo.outputPath('ai-settings-mobile.png'), fullPage: true });

  const strangerContext = await browser.newContext();
  const stranger = await newUser(strangerContext, 'byok-stranger', '另一成员');
  await stranger.page.goto('/account/ai');
  await expect(stranger.page.getByText('已加密保存')).toHaveCount(0);
  phone.once('dialog', (dialog) => dialog.accept());
  await phone.getByRole('button', { name: '删除 AI 配置与 Key' }).click();
  await expect(phone.getByText('AI 配置与加密 Key 已删除。')).toBeVisible();
  await owner.page.reload();
  await expect(owner.page.getByText('已加密保存')).toHaveCount(0);
  await Promise.all([first.close(), mobile.close(), strangerContext.close()]);
});
