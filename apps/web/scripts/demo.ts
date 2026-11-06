/**
 * 演示：`pnpm demo`
 *
 * 用独立数据目录 `.data/demo`（每次运行先清空重建）种一面演示墙，然后在同一进程里启动主站（3000）与页面托管（4000），
 * 打印中文使用说明。Ctrl+C 同时关掉两个服务。登录用开发发件箱（`/dev/outbox`）里的验证码。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { dataPaths, loadConfig, loadRepoDotEnv, REPO_ROOT, resolveTicketSecret } from '@nowme/contracts';
import { hasKitFontSource, loadKitFonts } from '@nowme/kit';
import { createPagesApp } from '@nowme/pages-host';
import { SKILL_FILE } from '@nowme/skill';
import { createWebApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { seedDemo } from './demo-seed.js';

const DEMO_DATA_DIR = join(REPO_ROOT, '.data', 'demo');

function fail(message: string): never {
  console.error(`\n[demo] ${message}\n`);
  process.exit(1);
}

function portFree(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, hostname, () => probe.close(() => resolve(true)));
  });
}

function ensureFonts(): void {
  const missing = () => loadKitFonts().some((font) => Object.keys(font.files).some((weight) => !hasKitFontSource(font, Number(weight))));
  if (!missing()) return;
  console.log('[demo] Kit 字体缺失，正在下载（pnpm --filter @nowme/kit fonts:fetch）……');
  try {
    execFileSync('pnpm', ['--filter', '@nowme/kit', 'fonts:fetch'], { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch {
    fail('字体下载失败。请检查网络后手动运行：pnpm --filter @nowme/kit fonts:fetch');
  }
  if (missing()) fail('字体仍然不完整。请手动运行：pnpm --filter @nowme/kit fonts:fetch');
}

// 演示固定使用开发配置与独立数据目录（环境变量优先于 .env，所以先设置再载入）
process.env.NOWME_DATA_DIR = DEMO_DATA_DIR;
process.env.NODE_ENV = 'development';
process.env.NOWME_WEB_ORIGIN ??= 'http://localhost:3000';
process.env.NOWME_PAGES_ORIGIN ??= 'http://127.0.0.1:4000';
process.env.NOWME_TICKET_SECRET = '';
loadRepoDotEnv();
const config = loadConfig();
if (config.isProduction) fail('demo 只能在开发环境运行（NODE_ENV 不能是 production）。');

ensureFonts();

for (const [name, listen] of [
  ['主站', config.web],
  ['页面托管', config.pages],
] as const) {
  if (!(await portFree(listen.hostname, listen.port))) {
    fail(`${name}端口 ${listen.port} 已被占用。请先关掉占用它的进程（例如另一个 pnpm dev / pnpm demo），再重新运行 pnpm demo。`);
  }
}

console.log(`[demo] 将清空并重建演示数据目录：${DEMO_DATA_DIR}`);
rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
mkdirSync(DEMO_DATA_DIR, { recursive: true });

const db = openDatabase(dataPaths(config.dataDir).db);
const ticketSecret = resolveTicketSecret(config);
const web = createWebApp({ config: { ...config, ticketSecret }, db, log: () => {} });

console.log('[demo] 正在种演示数据（6 个示例页走真实提交管线：校验 + 渲染，大约需要几十秒）……');
const seed = await seedDemo(web, (message) => console.log(`[demo] ${message}`));

const webServer = serve({ fetch: web.fetch, port: config.web.port, hostname: config.web.hostname });
const pagesServer = serve({
  fetch: createPagesApp({ ...config, ticketSecret }).fetch,
  port: config.pages.port,
  hostname: config.pages.hostname,
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  console.log('\n[demo] 正在关闭服务……');
  setTimeout(() => process.exit(0), 5000).unref();
  webServer.close();
  pagesServer.close();
  web
    .close()
    .catch(() => undefined)
    .finally(() => {
      db.close();
      process.exit(0);
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const published = seed.members.filter((member) => member.published);
const draft = seed.members.filter((member) => !member.published);
const line = '─'.repeat(64);
const indent = (text: string) =>
  text
    .split('\n')
    .map((row) => `      ${row}`)
    .join('\n');

console.log(
  [
    '',
    line,
    ' NOWMe 演示已就绪',
    line,
    `  主站：      ${config.webOrigin}`,
    `  页面托管：  ${config.pagesOrigin}（页面在这个独立源的沙箱里运行，不用直接打开）`,
    `  演示墙：    ${seed.wall.name}`,
    `  数据目录：  ${config.dataDir}（每次运行 pnpm demo 都会清空重建）`,
    '',
    ' 登录方式',
    `  1. 打开 ${config.webOrigin}/login，输入下面任一邮箱，点“发送验证码”`,
    `  2. 打开 ${config.webOrigin}/dev/outbox（开发发件箱）复制 6 位验证码，回到登录页输入`,
    '',
    ' 可用账号',
    `  组织者：    ${seed.organizer.email}（${seed.organizer.nickname}）`,
    ...published.map(
      (member) => `  成员：      ${member.email}（${member.nickname}，已发布，联系方式${member.contactPublic ? '公开' : '不公开'}）`,
    ),
    ...draft.map((member) => `  成员：      ${member.email}（${member.nickname}，已提交、还没发布：对照用）`),
    `  新同学：    ${seed.newcomer.email}（已加入，还没做页面）`,
    '',
    ' 建议的浏览路线',
    `  1. 用成员账号（如 ${published[0]?.email ?? ''}）登录，进入「${seed.wall.name}」，看墙上 ${published.length} 张卡片`,
    '  2. 点一张卡片，看沙箱里运行的页面；点接话点旁的“想聊这个”，看联系方式与开场白',
    '     （联系方式不公开的成员，会提示 TA 没有公开联系方式）',
    `  3. 换组织者账号登录，进入墙右上角的“后台”：只能看到昵称、加入时间、发布状态，看不到任何人的页面内容；邀请链接：${seed.inviteUrl}`,
    `  4. 用 ${draft[0]?.email ?? '成员'} 登录，进“我的页面”（工作区）：预览已提交的版本，走一遍发布确认（改写介绍、选择是否公开联系方式）`,
    '  5. 发布后在工作区打开“公开链接”，用无痕窗口访问（未登录也能看到页面，但没有联系方式）；再试试“从墙上撤下”',
    '',
    ' 用你自己的 Agent 走一遍本地路线（新同学账号，已在墙里）',
    `  Skill 文件：${SKILL_FILE}（把它装到你的 Agent，或把纯文本说明直接发给它）`,
    '  在一个空目录里让 Agent 执行下面的指令（一次性，用过即失效；需要新的就在工作区点“重新生成指令”）：',
    indent(seed.newcomer.instruction.command),
    `  Agent 提交后，用 ${seed.newcomer.email} 登录，到「我的页面」预览并确认发布。`,
    '',
    '  按 Ctrl+C 退出（同时关闭主站与页面托管）。',
    line,
    '',
  ].join('\n'),
);

if (!existsSync(SKILL_FILE)) console.warn(`[demo] 提示：找不到 ${SKILL_FILE}`);
