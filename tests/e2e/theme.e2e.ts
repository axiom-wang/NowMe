import { test, expect, type Page } from '@playwright/test';
import { pageAudit } from './a11y-audit.js';
import { login, createWall, uniqueEmail } from './helpers.js';

const themeTrigger = (page: Page) => page.locator('.site-header [data-theme-picker] > summary');

async function chooseTheme(page: Page, label: string) {
  await themeTrigger(page).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}

test('外观跟随系统、跨页面持久保存、同步标签页，且不依赖可写存储', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 22, 18)');
  await expect(themeTrigger(page)).toHaveAccessibleName('外观：跟随系统');
  await chooseTheme(page, '浅色');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 240, 232)');
  await page.goto('/terms');
  await expect(themeTrigger(page)).toHaveAccessibleName('外观：浅色');
  const second = await context.newPage();
  await second.goto('/privacy');
  await themeTrigger(second).click();
  await chooseTheme(page, '深色');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(second.getByRole('button', { name: '深色', exact: true, pressed: true })).toBeVisible();
  await expect(themeTrigger(second).locator('[data-theme-icon="dark"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await chooseTheme(page, '跟随系统');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 240, 232)');
  await second.close();
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('unavailable'); };
  });
  await page.reload();
  await chooseTheme(page, '深色');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 22, 18)');
});

test('手机顶栏的外观按钮支持键盘选择、关闭与焦点归还', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/terms');
  const trigger = themeTrigger(page);
  const panel = page.getByRole('group', { name: '颜色主题' });
  await expect(trigger).toBeVisible();
  expect(await trigger.boundingBox()).toMatchObject({ width: 44, height: 44 });

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '跟随系统', pressed: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '浅色', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAccessibleName('外观：浅色');

  await page.keyboard.press('Space');
  const selected = page.getByRole('button', { name: '浅色', exact: true, pressed: true });
  await expect(selected.locator('.theme-picker__selection')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.locator('main').click({ position: { x: 8, y: 200 } });
  await expect(panel).toBeHidden();
});

test('所有功能页面在深浅两色下均可访问，手机无溢出，成员墙先于 AI 工具', async ({ page }, testInfo) => {
  await login(page, uniqueEmail('theme'), '外观测试');
  const { wallId } = await createWall(page, '外观验收墙');
  const paths = ['/', '/messages', '/account/data', '/account/ai', '/account/credits', '/account/delete', '/walls/new', '/skill', '/terms', '/privacy', '/missing-theme-page', `/w/${wallId}`, `/w/${wallId}/admin`, `/w/${wallId}/questions`, `/w/${wallId}/me`, `/w/${wallId}/me/create`, `/messages/wall/${wallId}`];
  const contrastProblems: string[] = [];
  for (const { theme, label } of [{ theme: 'light', label: '浅色' }, { theme: 'dark', label: '深色' }]) {
    await expect(themeTrigger(page)).toBeVisible();
    await page.locator('.account-menu > summary').click();
    await expect(page.locator('.account-menu__panel [data-theme-picker]')).toHaveCount(0);
    await chooseTheme(page, label);
    await expect(page.locator('.account-menu__panel')).toBeHidden();
    for (const width of [320, 360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of paths) {
        const response = await page.goto(path);
        expect(response?.status(), `${theme} ${width} ${path}`).toBe(path.startsWith('/missing') ? 404 : 200);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width} ${path}`).toBe(true);
        if (path === '/' && width < 640) {
          const controls = [themeTrigger(page), page.locator('.account-menu > summary'), ...await page.locator('.site-nav__link:visible').all()];
          for (const control of controls) {
            await control.click({ trial: true, timeout: 2_000 });
            expect((await control.boundingBox())!.width).toBeGreaterThanOrEqual(44);
          }
        }
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
