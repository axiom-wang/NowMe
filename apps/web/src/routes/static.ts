/**
 * 主站静态文件（`apps/web/static/` → `/static/<文件名>`）：样式与脚本都是外部文件（主站 CSP 不允许内联）。
 * 只提供该目录第一层、文件名合规、扩展名已知的普通文件；每次请求读取（开发时改了就能看到）。
 */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_PATH_PREFIX } from '../constants.js';
import type { AppHono } from '../context.js';

/** 本文件位于 `src/routes/` 或 `dist/routes/`，向上两级即包根。 */
export const STATIC_DIR = fileURLToPath(new URL('../../static/', import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.(css|js|svg|png|ico)$/;

export function registerStaticRoutes(app: AppHono, staticDir: string = STATIC_DIR): void {
  app.get(`${STATIC_PATH_PREFIX}:name`, async (c) => {
    const name = c.req.param('name');
    const match = NAME_PATTERN.exec(name);
    if (!match) return c.notFound();
    const file = join(staticDir, name);
    try {
      const info = await lstat(file);
      if (!info.isFile()) return c.notFound();
      const body = await readFile(file);
      return c.body(new Uint8Array(body), 200, {
        'Content-Type': CONTENT_TYPES[match[1]!] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    } catch {
      return c.notFound();
    }
  });
}
