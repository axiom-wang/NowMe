/** Local-only visual acceptance, with real submission/rendering and isolated data.
 * Invoked through demo-ai-review.ts or demo-trail-review.ts with optional --serve.
 * No model calls, credential provisioning, or changes to an existing running demo.
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { COVER_HEIGHT, COVER_MAX_BYTES, COVER_WIDTH, dataPaths, loadConfig, REPO_ROOT, resolveTicketSecret } from '@nowme/contracts';
import { createPagesApp } from '@nowme/pages-host';
import { pngSize } from '@nowme/render';
import { createWebApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { seedDemo } from './demo-seed.js';
import { DEMO_EXTRA_WALLS } from './demo-content.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForWallCovers(tab: import('playwright').Page, expected: number): Promise<void> {
  const covers = await tab.evaluate<{ width: number; height: number }[]>(`(async () => {
    const images = Array.from(document.querySelectorAll('.wall-card__cover img'));
    for (const image of images) image.loading = 'eager';
    await Promise.all(images.map(image => image.decode()));
    return images.map(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  })()`);
  if (covers.length !== expected || covers.some((cover) => cover.width !== COVER_WIDTH || cover.height !== COVER_HEIGHT)) {
    throw new Error(`墙上的 ${expected} 张封面没有全部正常加载`);
  }
}

export async function runDemoWallReview(wallSlug: 'ai' | 'trail'): Promise<void> {
  const wallTitle = wallSlug === 'ai' ? 'AI 共创' : '山野轻徒步';
  const root = join(REPO_ROOT, '.data');
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(join(root, `demo-${wallSlug}-review-`));
  const webPort = await freePort();
  const pagesPort = await freePort();
  const base = loadConfig({
    NODE_ENV: 'development', NOWME_DATA_DIR: dataDir,
    NOWME_WEB_ORIGIN: `http://localhost:${webPort}`, NOWME_PAGES_ORIGIN: `http://127.0.0.1:${pagesPort}`,
  });
  const config = { ...base, ticketSecret: resolveTicketSecret(base) };
  const db = openDatabase(dataPaths(dataDir).db);
  const web = createWebApp({ config, db, demo: { dataDir }, log: () => {}, secretEnv: {} });
  const artifacts = join(dataDir, 'visual');
  mkdirSync(artifacts);
  let webServer: ReturnType<typeof serve> | undefined;
  let pagesServer: ReturnType<typeof serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await browser?.close();
    webServer?.close();
    pagesServer?.close();
    await web.close();
    db.close();
  }
  process.on('SIGINT', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });

  try {
    const seed = await seedDemo(web, (message) => console.log(`[验收] ${message}`));
    const selected = seed.extraWalls[DEMO_EXTRA_WALLS.findIndex((plan) => plan.slug === wallSlug)]!;
    if (selected.members.filter((member) => member.published).length !== 6 || selected.members[0]!.revisionId !== null) {
      throw new Error('墙的页面数量或体验成员状态不符合约定');
    }
    webServer = serve({ fetch: web.fetch, port: webPort, hostname: '127.0.0.1' });
    pagesServer = serve({ fetch: createPagesApp(config, { log: () => {} }).fetch, port: pagesPort, hostname: '127.0.0.1' });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    await context.addInitScript("globalThis.__nmViolations = []; document.addEventListener('securitypolicyviolation', (event) => globalThis.__nmViolations.push(event.violatedDirective + ' ' + event.blockedURI));");
    const tab = await context.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    tab.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', (route) => {
      const origin = new URL(route.request().url()).origin;
      if ([config.webOrigin, config.pagesOrigin].includes(origin)) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const loginResponse = await tab.goto(`${config.webOrigin}/login`);
    if (loginResponse?.status() !== 200) throw new Error('验收登录页未正常打开，请在 @nowme/web 包目录使用其 tsconfig 启动');
    await tab.getByRole('button', { name: '以成员身份体验', exact: true }).click();
    await tab.waitForURL(`${config.webOrigin}/`);
    await tab.goto(`${config.webOrigin}/w/${selected.wall.id}`);
    // 第二批人物（demo-more）也在这面墙上，由 demo-more-review.ts 单独逐页验收；这里只验收原有六页。
    const wallCards = 6 + seed.additions[wallSlug].length;
    if (await tab.locator('.wall-card').count() !== wallCards) throw new Error(`墙上可见卡片应为 ${wallCards} 个`);
    await waitForWallCovers(tab, wallCards);
    await tab.screenshot({ path: join(artifacts, 'wall-desktop.png'), fullPage: true });
    const measurements: unknown[] = [];
    const pages: { name: string; url: string; cover: string }[] = [];
    for (const member of selected.members.filter((entry) => entry.published)) {
      const revision = web.deps.repos.revisions.findById(member.revisionId!)!;
      if (!revision.report.ok) throw new Error(`${member.nickname} 渲染未通过`);
      const prefix = member.exampleDir;
      const coverFile = join(dataDir, 'revisions', revision.id, 'cover.png');
      const cover = readFileSync(coverFile);
      const size = pngSize(cover);
      if (size?.width !== COVER_WIDTH || size.height !== COVER_HEIGHT || cover.byteLength > COVER_MAX_BYTES) throw new Error('封面尺寸或体积不符合要求');
      copyFileSync(coverFile, join(artifacts, `${prefix}-cover.png`));
      const url = `${config.webOrigin}/w/${selected.wall.id}/p/${member.pageId}`;
      pages.push({ name: member.nickname, url, cover: `${prefix}-cover.png` });
      await tab.goto(url);
      const iframe = tab.locator('iframe[data-nm-page-frame]');
      if (await iframe.getAttribute('sandbox') !== 'allow-scripts') throw new Error('页面沙箱属性错误');
      await tab.frameLocator('iframe[data-nm-page-frame]').locator('h1').waitFor();
      const source = await iframe.getAttribute('src');
      if (!source) throw new Error('页面 iframe 未加载');
      // The host intentionally fixes its phone viewer at 375px. Test the same signed,
      // served document in a separate tab to exercise real responsive viewports.
      const documentTab = await context.newPage();
      for (const width of [375, 390, 768, 960]) {
        await documentTab.setViewportSize({ width, height: 900 });
        await documentTab.goto(source);
        await documentTab.evaluate('document.fonts.ready');
        const measured = await documentTab.evaluate<{ width: number; scrollWidth: number; overflowing: string[]; blocks: string[]; loadedFonts: number; h1VisibleInCover: boolean; violations: string[] }>(`(() => {
          const root = document.documentElement;
          const blocks = Array.from(document.querySelectorAll('[data-nm-id]'));
          const overflowing = Array.from(document.querySelectorAll('main *')).filter(el => {
            const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
          }).map(el => el.tagName + '.' + el.className);
          return { width: innerWidth, scrollWidth: root.scrollWidth, overflowing,
            blocks: blocks.map(el => el.getAttribute('data-nm-id')),
            loadedFonts: Array.from(document.fonts).filter(font => font.status === 'loaded').length,
            h1VisibleInCover: document.querySelector('h1').getBoundingClientRect().bottom < 500,
            violations: globalThis.__nmViolations };
        })()`);
        measurements.push({ name: member.nickname, targetWidth: width, ...measured });
        if (measured.width !== width || measured.scrollWidth > measured.width || measured.overflowing.length || !measured.h1VisibleInCover || measured.loadedFonts < 1 || measured.violations.length) {
          throw new Error(`${member.nickname} 在 ${width}px 的布局或字体不符合要求：${JSON.stringify(measured)}`);
        }
        if (width === 375 || width === 960) {
          await documentTab.screenshot({ path: join(artifacts, `${prefix}-${width}.png`), fullPage: true });
        }
        const detail = documentTab.locator('details').first();
        if (width === 375 && await detail.count()) {
          await detail.locator('summary').focus();
          await documentTab.keyboard.press('Enter');
          if (!await detail.getAttribute('open').then((value) => value !== null)) throw new Error('展开笔记的键盘操作失败');
        }
      }
      await documentTab.close();
    }
    await tab.setViewportSize({ width: 375, height: 812 });
    await tab.goto(`${config.webOrigin}/w/${selected.wall.id}`);
    await waitForWallCovers(tab, wallCards);
    await tab.screenshot({ path: join(artifacts, 'wall-mobile.png'), fullPage: true });
    await tab.goto(`${config.webOrigin}/w/${selected.wall.id}/me`);
    if (!await tab.getByRole('link', { name: '开始采访', exact: true }).isVisible()) throw new Error('体验成员的空白工作区未保留');
    await tab.screenshot({ path: join(artifacts, 'empty-workspace.png'), fullPage: true });
    if (errors.length || external.length) throw new Error(`浏览器错误或外部请求：${JSON.stringify({ errors, external })}`);
    const report = { dataDir, origin: config.webOrigin, wallUrl: `${config.webOrigin}/w/${selected.wall.id}`,
      wallSlug, members: selected.members.length, wallCoversLoaded: wallCards, published: pages.length, chat: seed.chat, measurements, pages, errors, external };
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    const cells = pages.map((page) => `<figure><img src="${page.cover}"><figcaption>${page.name}</figcaption></figure>`).join('');
    writeFileSync(join(artifacts, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${wallTitle}视觉验收</title><style>body{margin:0;padding:28px;background:#eee;font:16px sans-serif}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}figure{margin:0}img{width:100%;display:block}figcaption{padding:10px 0}</style><h1>${wallTitle} · 六个不同的人</h1><div class="grid">${cells}</div></html>`);
    const overview = await browser.newPage({ viewport: { width: 1232, height: 1200 } });
    await overview.goto(pathToFileURL(join(artifacts, 'index.html')).href);
    await overview.screenshot({ path: join(artifacts, 'covers-overview.png'), fullPage: true });
    console.log(JSON.stringify({ result: '通过', report: join(artifacts, 'report.json'), wallUrl: report.wallUrl, artifacts }));
    await browser.close();
    browser = undefined;
    if (process.argv.includes('--serve')) console.log('独立预览保持运行；按 Ctrl+C 结束。');
    else await close();
  } catch (error) {
    await close();
    throw error;
  }

}
