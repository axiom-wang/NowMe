import { defineConfig } from '@playwright/test';

/**
 * e2e（`pnpm test:e2e`）。脚手架阶段只有冒烟用例（现已有完整 e2e）：以源码方式启动主站与页面托管，用本机 Chromium 访问。
 * 使用与 `pnpm dev`（3000 / 4000）和 `nowme preview`（4100 / 4101）不同的端口，避免冲突。
 * 用例在 tests/e2e：冒烟、全流程、安全（沙箱探测）、平台托管路线（假模型客户端）。每次运行前清空 .data/e2e。
 */
const WEB_ORIGIN = 'http://localhost:3200';
const PAGES_ORIGIN = 'http://127.0.0.1:4200';

const env = {
  NOWME_WEB_ORIGIN: WEB_ORIGIN,
  NOWME_PAGES_ORIGIN: PAGES_ORIGIN,
  NOWME_DATA_DIR: '.data/e2e',
  NOWME_TICKET_SECRET: 'e2e-ticket-secret-not-for-production-use',
  NODE_ENV: 'test',
  // 不让本机 .env 里的演示入口地址影响 e2e（它必须是 https，写成 http 会让服务起不来）
  NOWME_DEMO_URL: '',
  // 平台托管路线用确定性的假模型客户端（contracts 9 / hosted-route D8）；工具循环、校验、渲染都是真实的
  NOWME_MODEL_FAKE: '1',
  NOWME_AI_ENCRYPTION_KEY: 'ab'.repeat(32),
};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './test-results',
  reporter: 'list',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: { baseURL: WEB_ORIGIN, browserName: 'chromium', headless: true },
  webServer: [
    {
      command: 'rm -rf .data/e2e && pnpm --filter @nowme/web start:source',
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
