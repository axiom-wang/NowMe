import type { ViteUserConfig } from 'vitest/config';

/**
 * 各包 vitest.config.ts 共用的解析设置：
 * 优先使用 workspace 包 package.json exports 中的 "source" 条件（指向 src/*.ts），
 * 这样 `pnpm test` 不需要先 build。
 */
const conditions = ['source', 'module', 'node', 'development|production'];

export const sourceResolve = {
  resolve: { conditions },
  ssr: { resolve: { conditions } },
} satisfies Pick<ViteUserConfig, 'resolve' | 'ssr'>;

/** 各包测试文件位置：`test/` 目录下的 `*.test.ts(x)`。e2e 用 `*.e2e.ts`，不会被 vitest 收集。 */
export const testInclude = ['test/**/*.test.{ts,tsx}'];
