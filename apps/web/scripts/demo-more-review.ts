/**
 * 第二批演示人物（demo-more）的本地视觉验收：`pnpm --filter @nowme/web exec tsx --conditions=source scripts/demo-more-review.ts [目录名…]`
 *
 * 在 `.data/demo-more-review-*` 隔离目录里跑完整种子（真实校验 + 渲染 + 发布），起主站与页面托管，
 * 以体验成员登录，逐页在 375 / 390 / 768 / 960 宽度量横向溢出、h1 是否在首屏、CSP 违规与脚本错误，
 * 汇总全部问题后再报告（不在第一处失败就停）。产物：每页封面与 375 / 960 整页截图、按墙的封面总览、report.json。
 * 不调用模型，不碰正在运行的 demo 数据。
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { dataPaths, loadConfig, REPO_ROOT, resolveTicketSecret } from '@nowme/contracts';
import { createPagesApp } from '@nowme/pages-host';
import { createWebApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { seedDemo } from './demo-seed.js';
import { DEMO_ADDITIONS, type DemoAdditionWall } from './demo-more.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

const only = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));
const root = join(REPO_ROOT, '.data');
mkdirSync(root, { recursive: true });
const dataDir = mkdtempSync(join(root, 'demo-more-review-'));
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

const seed = await seedDemo(web, (message) => { if (!message.startsWith('  ')) console.log(`[验收] ${message}`); });
const webServer = serve({ fetch: web.fetch, port: webPort, hostname: '127.0.0.1' });
const pagesServer = serve({ fetch: createPagesApp(config, { log: () => {} }).fetch, port: pagesPort, hostname: '127.0.0.1' });
const browser = await chromium.launch();
const problems: { dir: string; width?: number; problem: string }[] = [];
const measurements: unknown[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  await context.addInitScript("globalThis.__nmViolations = []; document.addEventListener('securitypolicyviolation', (event) => globalThis.__nmViolations.push(event.violatedDirective + ' ' + event.blockedURI));");
  await context.route('**/*', (route) => {
    const origin = new URL(route.request().url()).origin;
    return [config.webOrigin, config.pagesOrigin].includes(origin) ? route.continue() : route.abort();
  });
  const tab = await context.newPage();
  await tab.goto(`${config.webOrigin}/login`);
  await tab.getByRole('button', { name: '以成员身份体验', exact: true }).click();
  await tab.waitForURL(`${config.webOrigin}/`);

  const wallIds: Record<DemoAdditionWall, string> = {
    hackathon: seed.wall.id, club: seed.club.wall.id, ai: seed.extraWalls[0]!.wall.id, trail: seed.extraWalls[1]!.wall.id,
  };
  for (const wall of Object.keys(wallIds) as DemoAdditionWall[]) {
    const expected = DEMO_ADDITIONS.filter((person) => person.wall === wall).length;
    if (seed.additions[wall].length !== expected) problems.push({ dir: wall, problem: `上墙 ${seed.additions[wall].length} 页，应为 ${expected}` });
  }
  const cells: Record<string, string[]> = {};
  for (const person of DEMO_ADDITIONS) {
    if (only.size && !only.has(person.dir)) continue;
    const member = seed.additions[person.wall].find((entry) => entry.exampleDir === person.dir);
    if (!member) { problems.push({ dir: person.dir, problem: '没有上墙' }); continue; }
    const revision = web.deps.repos.revisions.findById(member.revisionId)!;
    for (const issue of [...revision.report.errors, ...revision.report.warnings]) problems.push({ dir: person.dir, problem: `${issue.code} ${issue.message}` });
    copyFileSync(join(dataDir, 'revisions', revision.id, 'cover.png'), join(artifacts, `${person.dir}-cover.png`));
    (cells[person.wall] ??= []).push(`<figure><img src="${person.dir}-cover.png"><figcaption>${person.name} · ${person.dir}</figcaption></figure>`);

    await tab.goto(`${config.webOrigin}/w/${wallIds[person.wall]}/p/${member.pageId}`);
    const source = await tab.locator('iframe[data-nm-page-frame]').getAttribute('src');
    if (!source) { problems.push({ dir: person.dir, problem: '页面 iframe 没有地址' }); continue; }
    const doc = await context.newPage();
    const errors: string[] = [];
    doc.on('pageerror', (error) => errors.push(error.message));
    for (const width of [375, 390, 768, 960]) {
      await doc.setViewportSize({ width, height: 900 });
      await doc.goto(source);
      await doc.evaluate('document.fonts.ready');
      const m = await doc.evaluate<{ scrollWidth: number; overflowing: string[]; h1: string[]; h1Bottom: number | null; violations: string[]; smallText: number }>(`(() => {
        const overflowing = Array.from(document.body.querySelectorAll('*')).filter(el => {
          const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll') return false; }
          return r.right > innerWidth + 1 || r.left < -1;
        }).slice(0, 6).map(el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
        const h1 = Array.from(document.querySelectorAll('h1'));
        const smallText = Array.from(document.body.querySelectorAll('*')).filter(el => Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 6) && parseFloat(getComputedStyle(el).fontSize) < 11).length;
        return { scrollWidth: document.documentElement.scrollWidth, overflowing, h1: h1.map(el => el.textContent.replace(/\s+/g, '')),
          h1Bottom: h1[0] ? h1[0].getBoundingClientRect().bottom + scrollY : null, violations: globalThis.__nmViolations, smallText };
      })()`);
      measurements.push({ dir: person.dir, width, ...m });
      if (m.scrollWidth > width) problems.push({ dir: person.dir, width, problem: `横向滚动：文档宽 ${m.scrollWidth}` });
      if (m.overflowing.length) problems.push({ dir: person.dir, width, problem: `元素超出视口：${m.overflowing.join(', ')}` });
      if (m.violations.length) problems.push({ dir: person.dir, width, problem: `CSP 违规：${m.violations.join('; ')}` });
      if (width === 375) {
        if (m.h1.length !== 1 || !m.h1[0]!.includes(person.name)) problems.push({ dir: person.dir, width, problem: `h1 应恰好一个且含名字，实际：${JSON.stringify(m.h1)}` });
        else if (m.h1Bottom! > 500) problems.push({ dir: person.dir, width, problem: `h1 不在首屏（底边 ${Math.round(m.h1Bottom!)}px）` });
        if (m.smallText > 0) problems.push({ dir: person.dir, width, problem: `${m.smallText} 处成段文字小于 11px` });
      }
      if (width === 375 || width === 960) await doc.screenshot({ path: join(artifacts, `${person.dir}-${width}.png`), fullPage: true });
    }
    for (const error of errors) problems.push({ dir: person.dir, problem: `脚本错误：${error}` });
    await doc.close();
  }
  for (const [wall, list] of Object.entries(cells)) {
    const file = join(artifacts, `overview-${wall}.html`);
    writeFileSync(file, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#ddd;font:15px sans-serif}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:18px}figure{margin:0}img{width:100%;display:block}figcaption{padding:6px 0}</style><div class="grid">${list.join('')}</div></html>`);
    const overview = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await overview.goto(pathToFileURL(file).href);
    await overview.screenshot({ path: join(artifacts, `overview-${wall}.png`), fullPage: true });
    await overview.close();
  }
} finally {
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify({ problems, measurements }, null, 2));
  await browser.close();
  webServer.close();
  pagesServer.close();
  await web.close();
  db.close();
}
console.log(JSON.stringify({ result: problems.length ? '有问题' : '通过', problems, artifacts }, null, 2));
