import { test, expect } from '@playwright/test';
import { createWall, exchangeToken, exampleFiles, generateInstruction, login, publishViaUi, submitFiles, uniqueEmail } from './helpers.js';

test('各页面与顶栏共用内容边界，桌面限制最大宽度，手机无横向溢出', async ({ page, browser }, testInfo) => {
  await login(page, uniqueEmail('layout'), '布局测试');
  const wallName = '布局检查墙'.repeat(8);
  const { wallId } = await createWall(page, wallName);
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
      if (width <= 375 && path.endsWith('/me/create')) {
        expect(headerBox!.height).toBeLessThanOrEqual(60);
        const crumbs = page.getByRole('navigation', { name: '当前位置' });
        const wallCrumb = crumbs.getByRole('link', { name: wallName });
        expect((await crumbs.boundingBox())!.height).toBe(44);
        await expect(wallCrumb).toHaveCSS('text-overflow', 'ellipsis');
        expect(await wallCrumb.evaluate((link) => link.scrollWidth > link.clientWidth)).toBe(true);
      }
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

test('展示模式保持 375 逻辑视口等比放大，手机不溢出，Esc 退出后还原布局', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, uniqueEmail('stage-layout'), '展示模式测试');
  const { wallId } = await createWall(page, '展示模式墙');
  const { token } = await generateInstruction(page, wallId);
  const credential = await exchangeToken(wallId, token);
  const submission = await submitFiles(credential, exampleFiles('hackathon-terminal'));
  expect(submission.status).toBe('accepted');
  await publishViaUi(page, wallId, { contactValue: 'stage@example.com', contactPublic: false });
  await page.goto(`/w/${wallId}`);
  const memberPath = await page.locator('.wall-card__link').first().getAttribute('href');
  expect(memberPath).toMatch(new RegExp(`^/w/${wallId}/p/pg_`));

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(memberPath!);
  await page.locator('[data-nm-stage-open]').click();
  await expect(page.locator('[data-nm-page-frame-root]')).toHaveClass(/page-frame--stage/);
  await expect(page.locator('html')).toHaveClass(/nm-stage-open/);
  const desktop = await page.locator('iframe[data-nm-page-frame]').evaluate((frame) => ({
    logicalWidth: frame.getAttribute('width'),
    logicalClientWidth: frame.clientWidth,
    height: frame.getBoundingClientRect().height,
    viewportHeight: innerHeight,
  }));
  expect(desktop.logicalWidth).toBe('375');
  expect(desktop.logicalClientWidth).toBe(375);
  expect(desktop.height).toBeGreaterThanOrEqual(desktop.viewportHeight * 0.85);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-nm-page-frame-root]')).not.toHaveClass(/page-frame--stage/);
  await expect(page.locator('html')).not.toHaveClass(/nm-stage-open/);
  await expect(page.locator('.member-layout__frame')).toHaveCSS('position', 'sticky');

  // 全屏会把浏览器窗口置为 fullscreen，无法再调整视口；手机尺寸另开一个上下文。
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  try {
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(memberPath!);
    await mobilePage.locator('[data-nm-stage-open]').click();
    await expect(mobilePage.locator('[data-nm-page-frame-root]')).toHaveClass(/page-frame--stage/);
    const mobile = await mobilePage.evaluate(() => {
      const phone = document.querySelector('.page-frame__phone')!.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, left: phone.left, right: phone.right, width: innerWidth };
    });
    expect(mobile.overflow).toBe(false);
    expect(mobile.left).toBeGreaterThanOrEqual(0);
    expect(mobile.right).toBeLessThanOrEqual(mobile.width);
    await mobilePage.keyboard.press('Escape');
    await expect(mobilePage.locator('html')).not.toHaveClass(/nm-stage-open/);
    await expect(mobilePage.locator('.member-layout__frame')).toHaveCSS('position', 'static');
  } finally {
    await mobileContext.close();
  }
});
