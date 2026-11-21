import { seedDemoAvatars } from './demo-avatars.js';
/**
 * 演示：`pnpm demo`
 *
 * 独立数据目录 `.data/demo`（默认保留，`--reset` 才清空重建），四面墙、23 个页面版本、模拟聊天与一键测试登录。
 * 同时启动主站（3000）与页面托管（4000），Ctrl+C 同时关闭；不部署，使用维护者预置的真实账号模型。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths, loadConfig, loadRepoDotEnv, REPO_ROOT, resolveTicketSecret } from '@nowme/contracts';
import { hasKitFontSource, loadKitFonts } from '@nowme/kit';
import { SKILL_FILE } from '@nowme/skill';
import { createWebApp } from '../src/app.js';
import { createDemoModelLookup } from './demo-network.js';
import { provisionDemoModels } from './demo-models.js';
import { openDatabase } from '../src/db/index.js';
import { ensureDemoClubPages, seedDemo } from './demo-seed.js';
import { DEMO_ACCOUNTS, DEMO_MODEL_MISSING, DEMO_MODEL_READY } from '../src/demo-access.js';
import { checkLocalPorts, handleLocalShutdown, startLocalServers } from './local-server.js';
import { prepareDemoDirectory } from './demo-data.js';

const DEMO_DATA_DIR = join(REPO_ROOT, '.data', 'demo');

function fail(message: string): never {
  console.error(`\n[demo] ${message}\n`);
  process.exit(1);
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
loadRepoDotEnv(join(REPO_ROOT, '.env.local'));
loadRepoDotEnv();
// 演示模型配置只来自本机 .env.local / .env 或环境变量（NOWME_DEMO_*，见 .env.demo.example）；仓库里不放任何 Key。
const config = loadConfig();
if (config.hosted.fake) fail('评审演示不能启用 NOWME_MODEL_FAKE / NOWME_CLAUDE_FAKE，请移除后重启。');
if (config.isProduction) fail('demo 只能在开发环境运行（NODE_ENV 不能是 production）。');

ensureFonts();

try { await checkLocalPorts(config); } catch (error) { fail((error as Error).message); }
const reuse = prepareDemoDirectory(DEMO_DATA_DIR, process.argv.includes('--reset'));
console.log(reuse ? '[demo] 复用已有演示数据，不会清空。' : '[demo] 正在初始化演示数据……');

const db = openDatabase(dataPaths(config.dataDir).db);
const ticketSecret = resolveTicketSecret(config);
// 演示输出保持简洁，只打印托管任务结果（错误码、轮数、HTTP 状态码，不含模型响应或 Key）。
// 网页创作始终可见，真实模型使用用户账号配置；环境只提供凭证加密密钥。
const web = createWebApp({ config: { ...config, ticketSecret }, db, demo: { dataDir: DEMO_DATA_DIR }, log: (message) => { if (message.startsWith('[web] 托管任务')) console.log(message); }, secretEnv: process.env, modelLookup: createDemoModelLookup(process.env) });

if (!reuse) {
  console.log('[demo] 正在准备 4 面墙、23 个页面版本，首次启动需要几分钟……');
  await seedDemo(web, (message) => console.log(`[demo] ${message}`));
} else if (DEMO_ACCOUNTS.some((account) => !web.deps.repos.users.findByEmail(account.email))) {
  fail('现有数据缺少体验账号。数据已保留，请备份后运行 pnpm demo --reset 重建。');
}

if (reuse) await ensureDemoClubPages(web, (message) => console.log(`[demo] ${message}`));
seedDemoAvatars(web.deps);
// 复用的演示数据也更新展示文案，不必清空重建墙和页面。
db.prepare("UPDATE walls SET description = replace(description, ?, '') WHERE instr(description, ?) > 0")
  .run('演示人物均为虚构。', '演示人物均为虚构。');

let modelReady = false;
try { modelReady = provisionDemoModels(web, process.env); } catch { fail('演示模型预置失败。请检查 .env.local 或服务端环境变量及 NOWME_AI_ENCRYPTION_KEY；不会输出 Key。'); }

const servers = await startLocalServers({ ...config, ticketSecret }, web);
handleLocalShutdown(async () => {
  console.log('\n[demo] 正在关闭 NOWMe……');
  await servers.close();
  try { await web.close(); } finally { db.close(); }
});

const walls = db.prepare("SELECT name FROM walls WHERE status = 'open' ORDER BY created_at").all() as { name: string }[];
const line = '─'.repeat(64);
console.log([
  '', line, ' NOWMe 黑客松评审演示已就绪', line,
  `  主站：${config.webOrigin}（首页点“体验”或打开 /login 均可一键登录）`,
  '  页面沙箱已在同一进程启动，无需打开其他地址。',
  `  演示墙：${walls.map((wall) => wall.name).join('、')}`,
  `  数据目录：${config.dataDir}（重启保留；pnpm demo --reset 清空重建）`,
  '', ' 两个体验身份',
  '  以成员身份体验：先点首页“体验”，登录后从黑客松墙卡片进入创作工作区，可浏览、采访、生成、修改、预览和本人确认发布。',
  '  以组织者身份体验：先点首页“体验”，登录后从黑客松墙卡片进入组织者后台，可管理成员与邀请，不能查看他人草稿和采访资料。',
  '  顶部“切换身份”直接替换会话；“退出登录”结束当前会话。背景人物不开放登录。',
  '', ' 网页内创作',
  `  ${modelReady ? DEMO_MODEL_READY : DEMO_MODEL_MISSING}`,
  '  维护者配置：见 docs/demo.md 与 .env.demo.example；配置通过环境或未跟踪的 .env.local 提供。',
  '  无假模型回退，模型失败会显示中文原因并允许重试；体验身份不能改写或删除预置配置。',
  '', ' 建议路线',
  '  成员体验后点顶部“我的”可浏览全部四面墙；点“消息”可查看并继续群聊与私聊。',
  '  成员入口 → 浏览墙与人物页面 → 返回工作区开始采访 → 确认资料 → 真实生成 → 预览 → 修改 → 确认发布。',
  '  AI 介绍值得认识的人：成员身份进入已有自己页面的墙（摄影社；或刚发布过的墙），顶部区块自动生成介绍与理由 →',
  '    “让 AI 帮我起个头”→ 用一句开聊（只预填，不发送）。还没有页面的墙会提示先做页面，做完回墙即自动出现。',
  '  问墙：任意一面墙的“墙上的人”上面，问一句（如“谁喜欢胶片？”）或点示例问题 → 找到的人与 TA 页面上的原话；没人写到会如实说没找到。',
  '  切换组织者 → 查看成员发布状态与邀请 → 退出。',
  `  本地 Agent 路线保留，Skill 文件：${SKILL_FILE}；在工作区生成一次性指令。`,
  '  按 Ctrl+C 关闭两个服务。不部署。', line, '',
].join('\n'));

if (!existsSync(SKILL_FILE)) console.warn(`[demo] 提示：找不到 ${SKILL_FILE}`);
