import { test, expect } from '@playwright/test';
import { createWall, login, uniqueEmail } from './helpers.js';

test('各页面与顶栏共用内容边界，桌面限制最大宽度，手机无横向溢出', async ({ page, browser }, testInfo) => {
  await login(page, uniqueEmail('layout'), '布局测试');
  const { wallId } = await createWall(page, '布局检查墙');
  const paths = ['/', '/messages', '/account/data', '/account/ai', '/walls/new', '/skill', `/w/${wallId}`, `/w/${wallId}/me`, `/w/${wallId}/me/create`, `/w/${wallId}/admin`, `/messages/wall/${wallId}`];
  for (const width of [1920, 1440, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    let baseline: { x: number; width: number } | undefined;
    let headerBaseline: { x: number; y: number; width: number; height: number } | undefined;
    for (const path of paths) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const layout = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>('.site-header__inner')!;
        const main = document.querySelector<HTMLElement>('.site-main')!;
        const content = main.firstElementChild!;
        const headerBox = header.getBoundingClientRect();
        const contentBox = content.getBoundingClientRect();
        const gutter = parseFloat(getComputedStyle(header).paddingLeft);
        return {
          x: contentBox.x,
          width: contentBox.width,
          expectedX: headerBox.x + gutter,
          expectedWidth: headerBox.width - 2 * gutter,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const label = `${width}px ${path}`;
      await expect(page.locator('.site-header')).toHaveClass('site-header');
      await expect(page.locator('.site-header__nav')).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const headerBox = await page.locator('.site-header').boundingBox();
      headerBaseline ??= headerBox!;
      expect(headerBox, label).toEqual(headerBaseline);
      await page.locator('.account-menu > summary').click();
      await expect(page.locator('.account-menu__panel').getByRole('link', { name: 'AI 设置', exact: true })).toBeVisible();
      await expect(page.locator('.account-menu__panel a[href="/account/data"]')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.account-menu')).not.toHaveAttribute('open');
      expect(layout.x, label).toBeCloseTo(layout.expectedX, 1);
      expect(layout.width, label).toBeCloseTo(layout.expectedWidth, 1);
      expect(layout.width, label).toBeLessThanOrEqual(1240);
      expect(layout.overflow, label).toBe(false);
      baseline ??= { x: layout.x, width: layout.width };
      expect({ x: layout.x, width: layout.width }, label).toEqual(baseline);
      if ([1440, 375].includes(width) && ['/', '/messages', '/account/data', '/account/ai'].includes(path)) {
        await page.screenshot({ path: testInfo.outputPath(`${path.replaceAll('/', '-') || 'home'}-${width}.png`), fullPage: true });
      }
    }
  }

  const anonymous = await browser.newContext();
  try {
    const loginPage = await anonymous.newPage();
    for (const width of [1440, 375, 320]) {
      await loginPage.setViewportSize({ width, height: 1000 });
      await loginPage.goto('/login');
      await expect(loginPage.locator('.site-header')).toHaveClass('site-header');
      await expect(loginPage.locator('.site-nav, .account-menu')).toHaveCount(0);
      const shell = await loginPage.locator('.site-main').boundingBox();
      expect(await loginPage.locator('.site-header__inner').boundingBox()).toMatchObject({ x: shell!.x, width: shell!.width });
      expect(await loginPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await anonymous.close();
  }
});
