import { defineConfig } from 'vitest/config';

// 根配置只负责聚合各包；每个包/应用有自己的 vitest.config.ts（共用 vitest.shared.ts）。
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'skill'],
  },
});
