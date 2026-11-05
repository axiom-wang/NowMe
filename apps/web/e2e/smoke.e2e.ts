import { expect, test } from '@playwright/test';

const PAGES_ORIGIN = 'http://127.0.0.1:4200';

test('主站占位页可在 Chromium 中打开，带主站 CSP', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('NOWMe');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain(`frame-src ${PAGES_ORIGIN}`);
  expect(csp).toContain("frame-ancestors 'none'");
});

test('页面托管在独立源上运行，响应带安全头且不设 cookie', async ({ request }) => {
  const response = await request.get(`${PAGES_ORIGIN}/`);
  expect(response.status()).toBe(404);
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['set-cookie']).toBeUndefined();
});
