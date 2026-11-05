import { defineConfig } from '@playwright/test';

/**
 * e2e（`pnpm test:e2e`）。脚手架阶段只有冒烟用例：以源码方式启动主站与页面托管，用本机 Chromium 访问。
 * 使用与 `pnpm dev`（3000 / 4000）和 `nowme preview`（4100 / 4101）不同的端口，避免冲突。
 * T2.4 会把完整的 e2e 放到 tests/e2e 并调整 testDir。
 */
const WEB_ORIGIN = 'http://localhost:3200';
const PAGES_ORIGIN = 'http://127.0.0.1:4200';

const env = {
  NOWME_WEB_ORIGIN: WEB_ORIGIN,
  NOWME_PAGES_ORIGIN: PAGES_ORIGIN,
  NOWME_DATA_DIR: '.data/e2e',
  NOWME_TICKET_SECRET: 'e2e-ticket-secret-not-for-production-use',
  NODE_ENV: 'test',
};

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  reporter: 'list',
  fullyParallel: true,
  use: { baseURL: WEB_ORIGIN, browserName: 'chromium', headless: true },
  webServer: [
    {
      command: 'pnpm --filter @nowme/web start:source',
      url: `${WEB_ORIGIN}/`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @nowme/pages-host start:source',
      port: 4200,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
