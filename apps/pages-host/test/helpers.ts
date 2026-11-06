import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTicket } from '@nowme/contracts';
import { createPagesApp, type PagesHostConfig } from '../src/app.js';

export const SECRET = 'test-secret-'.padEnd(40, 'x');
export const WEB_ORIGIN = 'http://localhost:3000';
export const PAGES_ORIGIN = 'http://127.0.0.1:4000';
export const REV_A = 'rev_aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const REV_B = 'rev_bbbbbbbbbbbbbbbbbbbbbbbbbb';
export const FONT_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-font.woff2');
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function makeConfig(dataDir: string, overrides: Partial<PagesHostConfig> = {}): PagesHostConfig {
  return { dataDir, pagesOrigin: PAGES_ORIGIN, webOrigin: WEB_ORIGIN, ticketSecret: SECRET, ...overrides };
}

export function write(dataDir: string, rev: string, relative: string, content: string | Buffer): void {
  const file = join(dataDir, 'revisions', rev, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** 在临时 dataDir 里构造两个版本的 `revisions/<rev>/served/...` 夹具。 */
export function makeFixture(options: { html?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nowme-pages-'));
  for (const rev of [REV_A, REV_B]) {
    write(dataDir, rev, 'served/index.html', options.html ?? `<!doctype html><title>${rev}</title>`);
    write(dataDir, rev, 'served/assets/a.png', PNG_BYTES);
    write(dataDir, rev, 'served/assets/sub/b.jpg', 'jpgdata');
    write(dataDir, rev, 'served/assets/notes.txt', 'secret');
    mkdirSync(join(dataDir, 'revisions', rev, 'served/_fonts'), { recursive: true });
    copyFileSync(FONT_FIXTURE, join(dataDir, 'revisions', rev, 'served/_fonts/test-400.woff2'));
    write(dataDir, rev, 'original/index.html', 'ORIGINAL-SECRET');
    write(dataDir, rev, 'render/full.png', PNG_BYTES);
    write(dataDir, rev, 'cover.png', PNG_BYTES);
  }
  const app = createPagesApp(makeConfig(dataDir), { log: () => {} });
  const ticket = (rev = REV_A, ttlMs = 60_000) =>
    signTicket({ revisionId: rev, expiresAt: new Date(Date.now() + ttlMs), secret: SECRET });
  return { dataDir, app, ticket };
}
