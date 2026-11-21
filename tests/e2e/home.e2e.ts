import { test, expect } from '@playwright/test';
import { createWall, login, uniqueEmail } from './helpers.js';

test('模型设置页与主页顶栏一致，账号菜单可关闭且没有重复资料入口', async ({ page }) => {
  await login(page, uniqueEmail('header'), '小江');
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const homeHeader = await page.locator('.site-header').boundingBox();
    await page.locator('.account-menu > summary').click();
    await expect(page.locator('.account-menu__panel').getByRole('link', { name: '我的资料' })).toHaveCount(0);
    await page.getByRole('link', { name: 'AI 设置', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/ai$/);
    await expect(page.locator('.site-header')).toHaveClass('site-header');
    expect(await page.locator('.site-header').boundingBox()).toEqual(homeHeader);
    await expect(page.locator('.site-nav').getByRole('link', { name: '我的资料' })).toBeVisible();
    await expect(page.locator('.site-nav [aria-current]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.account-menu > summary').click();
    await expect(page.locator('.account-menu__panel').getByRole('link', { name: '我的资料' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.account-menu')).not.toHaveAttribute('open');
    await page.locator('.account-menu > summary').click();
    await page.locator('.site-main').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.account-menu')).not.toHaveAttribute('open');
    await page.locator('.site-nav').getByRole('link', { name: '墙', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

// 不调用模型：验证首页布局、真实封面上传和导航闭环。
test('首页分组、账号菜单、封面上传更换与恢复默认，在桌面和手机均可用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page, uniqueEmail('home'), '江予安');
  const { wallId } = await createWall(page, '周末共创实验室');
  const coverSettings = page.getByRole('region', { name: '墙封面', exact: true });
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 75 } });
  await expect(coverSettings.getByText('未选择图片')).toBeVisible();
  const [coverChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    coverSettings.getByText('选择图片', { exact: true }).click(),
  ]);
  await coverChooser.setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
  await expect(coverSettings.getByText('cover.png', { exact: true })).toBeVisible();
  await coverSettings.getByRole('button', { name: '保存封面' }).click();
  await expect(page.getByText('墙封面已更新，成员会在首页看到新封面。')).toBeVisible();
  const firstCover = await coverSettings.locator('img').getAttribute('src');
  expect((await page.request.get(firstCover!)).headers()['content-type']).toBe('image/webp');
  const adminImage = await coverSettings.locator('img').boundingBox();
  expect(adminImage!.width / adminImage!.height).toBeCloseTo(1, 2);
  await page.goto('/');
  await expect(page.locator('.home-wall__cover img')).toHaveAttribute('src', firstCover!);
  await expect(page.getByRole('heading', { name: /待完成的页面/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /让你的第一张页面上墙/ })).toBeVisible();
  await page.locator('.account-menu > summary').click();
  await expect(page.getByRole('link', { name: 'AI 设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).not.toHaveAttribute('open');
  for (const width of [1672, 1280, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `不应在 ${width}px 横向溢出`).toBe(true);
    const image = await page.locator('.home-wall__cover img').boundingBox();
    expect(image!.width / image!.height, `${width}px 的墙封面应为正方形`).toBeCloseTo(1, 2);
    await expect(page.locator('.home-wall').getByRole('link', { name: '继续创作' })).toBeVisible();
  }
  await page.locator('.home-wall').getByRole('link', { name: '继续创作' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${wallId}/me$`));
  await expect(page.getByRole('heading', { level: 1, name: '我的页面', exact: true })).toBeVisible();
  await expect(page.locator('.ws-hero').getByText('周末共创实验室', { exact: true })).toHaveCount(1);
  await page.goto(`/w/${wallId}/admin`);
  await page.getByLabel('更换封面图', { exact: true }).setInputFiles({ name: 'new-cover.png', mimeType: 'image/png', buffer: png });
  await coverSettings.getByRole('button', { name: '保存封面' }).click();
  await expect(coverSettings.locator('img')).not.toHaveAttribute('src', firstCover!);
  await coverSettings.getByRole('button', { name: '移除封面，恢复默认' }).click();
  await expect(coverSettings.locator('img')).toHaveAttribute('src', '/static/home-wall-laptop.svg');
  await page.goto('/');
  await expect(page.locator('.home-wall__cover img')).toHaveAttribute('src', '/static/home-wall-laptop.svg');
  const defaultImage = await page.locator('.home-wall__cover img').boundingBox();
  expect(defaultImage!.width / defaultImage!.height).toBeCloseTo(1, 2);

  await page.goto('/account/data');
  await page.getByText('编辑资料', { exact: true }).click();
  const avatar = page.getByLabel('头像', { exact: true });
  await page.getByLabel('昵称', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(avatar).toBeFocused();
  const [avatarChooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Space')]);
  const name = `${'我的新头像'.repeat(16)}.png`;
  await avatarChooser.setFiles({ name, mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('status').filter({ hasText: name })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByText('个人资料已保存。')).toBeVisible();
  await expect(page.locator('.profile-avatar img')).toBeVisible();
  await page.getByText('编辑资料', { exact: true }).click();
  const removeAvatar = page.getByRole('checkbox', { name: '移除当前头像，恢复昵称首字' });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const checkboxBox = (await removeAvatar.boundingBox())!;
    const textBox = (await page.locator('.profile-remove-avatar span').boundingBox())!;
    expect(checkboxBox.width, `${width}px 复选框保持正常大小`).toBe(20);
    expect(textBox.width, `${width}px 文字有足够空间`).toBeGreaterThan(120);
    expect(textBox.height, `${width}px 文字正常横排`).toBeLessThan(60);
    expect(textBox.x).toBeGreaterThan(checkboxBox.x + checkboxBox.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await removeAvatar.check();
  await expect(removeAvatar).toBeChecked();
  await removeAvatar.uncheck();

  expect(errors).toEqual([]);
});
