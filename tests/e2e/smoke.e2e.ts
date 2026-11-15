import { expect, test } from '@playwright/test';

import { PAGES_ORIGIN } from './helpers.js';

test('主站可在 Chromium 中打开（未登录看到首页，登录页可用），带主站 CSP，没有 CSP 违规', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('link', { name: '建一面墙' }).first()).toBeVisible();
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain(`frame-src ${PAGES_ORIGIN}`);
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // 外部样式生效（主站不用内联样式）
  const background = await page.locator('body').evaluate((body) => body.ownerDocument.defaultView?.getComputedStyle(body).backgroundColor);
  expect(background).toBe('rgb(243, 240, 232)');
  await page.goto('/login');
  await expect(page).toHaveTitle('登录 · NOWMe');
  expect(violations).toEqual([]);
});

test('页面托管在独立源上运行，响应带安全头且不设 cookie', async ({ request }) => {
  const response = await request.get(`${PAGES_ORIGIN}/`);
  expect(response.status()).toBe(404);
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['set-cookie']).toBeUndefined();
});
