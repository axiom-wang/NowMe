import { test, expect } from '@playwright/test';
import { pageAudit } from './a11y-audit.js';
import { login, createWall, uniqueEmail } from './helpers.js';

test('外观跟随系统、跨页面持久保存、同步标签页，且不依赖可写存储', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 22, 18)');
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 240, 232)');
  await page.goto('/terms');
  await expect(page.getByRole('combobox', { name: '外观', exact: true })).toHaveValue('light');
  const second = await context.newPage();
  await second.goto('/privacy');
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('dark');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 240, 232)');
  await second.close();
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('unavailable'); };
  });
  await page.reload();
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 22, 18)');
});

test('所有功能页面在深浅两色下均可访问，手机无溢出，成员墙先于 AI 工具', async ({ page }, testInfo) => {
  await login(page, uniqueEmail('theme'), '外观测试');
  const { wallId } = await createWall(page, '外观验收墙');
  const paths = ['/', '/messages', '/account/data', '/account/ai', '/account/credits', '/account/delete', '/walls/new', '/skill', '/terms', '/privacy', '/missing-theme-page', `/w/${wallId}`, `/w/${wallId}/admin`, `/w/${wallId}/questions`, `/w/${wallId}/me`, `/w/${wallId}/me/create`, `/messages/wall/${wallId}`];
  const contrastProblems: string[] = [];
  for (const theme of ['light', 'dark']) {
    await page.locator('.account-menu > summary').click();
    await expect(page.locator('.account-menu__panel [data-theme-picker]')).toBeVisible();
    await expect(page.locator('.site-header__inner > .theme-picker')).toHaveCount(0);
    await page.getByRole('combobox', { name: '外观', exact: true }).selectOption(theme);
    await page.keyboard.press('Escape');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of paths) {
        const response = await page.goto(path);
        expect(response?.status(), `${theme} ${width} ${path}`).toBe(path.startsWith('/missing') ? 404 : 200);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width} ${path}`).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const contrasts = (await page.evaluate(pageAudit, { mobile: width < 640 })).filter(p => p.startsWith('contrast:'));
        contrastProblems.push(...contrasts.map(problem => `${theme} ${width} ${path}: ${problem}`));
        if ([390, 1440].includes(width) && ['/', `/w/${wallId}`, `/w/${wallId}/me/create`, '/account/data', '/messages'].includes(path)) {
          await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-${path.replaceAll('/', '_')}.png`), fullPage: true });
        }
      }
    }
  }
  expect(contrastProblems).toEqual([]);
  await page.goto(`/w/${wallId}`);
  expect(await page.locator('.wall-board').evaluate(el => !!(el.compareDocumentPosition(document.querySelector('.wall-assist')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
});
