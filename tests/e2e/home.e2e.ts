import { test, expect } from '@playwright/test';
import { createWall, login, uniqueEmail } from './helpers.js';

test('模型设置页与主页顶栏一致，账号菜单可关闭且没有重复资料入口', async ({ page }) => {
  await login(page, uniqueEmail('header'), '小江');
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const homeHeader = await page.locator('.site-header').boundingBox();
    await page.locator('.home-account > summary').click();
    await expect(page.locator('.home-account__menu').getByRole('link', { name: '我的资料' })).toHaveCount(0);
    await page.getByRole('link', { name: 'AI 设置', exact: true }).click();
    await expect(page).toHaveURL(/\/account\/ai$/);
    await expect(page.locator('.site-header')).toHaveClass('site-header home-header');
    expect(await page.locator('.site-header').boundingBox()).toEqual(homeHeader);
    await expect(page.locator('.home-nav').getByRole('link', { name: '我的资料' })).toBeVisible();
    await expect(page.locator('.home-nav [aria-current]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.home-account > summary').click();
    await expect(page.locator('.home-account__menu').getByRole('link', { name: '我的资料' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.home-account')).not.toHaveAttribute('open');
    await page.locator('.home-account > summary').click();
    await page.locator('.site-main').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.home-account')).not.toHaveAttribute('open');
    await page.locator('.home-nav').getByRole('link', { name: '我的', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

// 不调用模型：验证首页布局、真实封面上传和导航闭环。
test('首页筛选、账号菜单、封面上传更换与恢复默认，在桌面和手机均可用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page, uniqueEmail('home'), '江予安');
  const { wallId } = await createWall(page, '周末共创实验室');
  const coverSettings = page.getByRole('region', { name: '墙封面', exact: true });
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 75 } });
  await page.getByLabel('上传封面图', { exact: true }).setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
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
  await page.getByRole('link', { name: '已发布 0', exact: true }).click();
  await expect(page.locator('.home-group--pending')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /让你的第一张页面上墙/ })).toBeVisible();
  await page.getByRole('link', { name: '待完成 1', exact: true }).click();
  await expect(page.locator('.home-wall')).toHaveCount(1);
  await page.getByRole('link', { name: '全部 1', exact: true }).click();
  await page.locator('.home-account > summary').click();
  await expect(page.getByRole('link', { name: 'AI 设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.home-account')).not.toHaveAttribute('open');
  for (const width of [1672, 1280, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `不应在 ${width}px 横向溢出`).toBe(true);
    const image = await page.locator('.home-wall__cover img').boundingBox();
    expect(image!.width / image!.height, `${width}px 的墙封面应为正方形`).toBeCloseTo(1, 2);
    await expect(page.locator('.home-wall').getByRole('link', { name: '继续创作' })).toBeVisible();
  }
  await page.locator('.home-wall').getByRole('link', { name: '继续创作' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${wallId}/me$`));
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
  expect(errors).toEqual([]);
});
