/**
 * 按墙统计（W20）：`pnpm --filter @nowme/web stats <wallId> [--json]`
 *
 * 只输出聚合数字（见 src/services/stats.ts 的口径），不输出任何个人层面的数据。
 * 使用与主站相同的 `NOWME_DATA_DIR`（读仓库根 `.env`），主站运行时也可以执行。
 * 退出码：0 成功；1 参数不对或墙不存在。
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dataPaths, loadConfig, loadRepoDotEnv, WALL_ID_PATTERN } from '@nowme/contracts';
import { createRepos, openDatabase } from '../src/db/index.js';
import { computeWallStats, formatWallStats } from '../src/services/stats.js';

const USAGE = '用法：pnpm --filter @nowme/web stats <wallId> [--json]';

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(1);
}

function parse() {
  try {
    return parseArgs({ options: { json: { type: 'boolean', default: false } }, allowPositionals: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const parsed = parse();
const positionals = parsed.positionals.filter((value) => value !== '--');
const wallId = positionals[0];
if (!wallId || positionals.length > 1) fail('请给出一个墙 ID（wal_ 开头）');
if (!WALL_ID_PATTERN.test(wallId)) fail(`墙 ID 格式不对：${wallId}`);

loadRepoDotEnv();
const config = loadConfig();
const dbPath = dataPaths(config.dataDir).db;
if (!existsSync(dbPath)) fail(`找不到数据库：${dbPath}`);
const db = openDatabase(dbPath);
try {
  const stats = computeWallStats({ db, repos: createRepos(db) }, wallId);
  if (!stats) fail(`找不到这面墙：${wallId}`);
  process.stdout.write(parsed.values.json ? `${JSON.stringify(stats, null, 2)}\n` : formatWallStats(stats));
} finally {
  db.close();
}
