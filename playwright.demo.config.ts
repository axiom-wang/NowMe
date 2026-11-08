import { defineConfig } from '@playwright/test';

/** 只连接维护者已启动的演示，不启动假模型；真实请求可能计费。 */
if (!process.env.NOWME_DEMO_E2E_ORIGIN) throw new Error('请先启动已配置真实模型的 pnpm demo，并设置 NOWME_DEMO_E2E_ORIGIN');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'demo.e2e.ts',
  workers: 1,
  reporter: 'list',
  outputDir: './test-results/demo-real',
  use: { browserName: 'chromium', headless: true, actionTimeout: 300_000, navigationTimeout: 300_000 },
});
