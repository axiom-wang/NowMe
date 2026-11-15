/**
 * 平台运营：举报与账号处理（contracts 15）：`pnpm --filter @nowme/web moderation <命令>`
 *
 *   list [--status open|dismissed|actioned|all] [--kind page|conversation] [--limit N]
 *   show --id rpt_... [--evidence-png 文件]   被举报的人已注销时显示转存的证据，截图可写到文件
 *   resolve --id rpt_... --as dismissed|actioned [--note 备注]
 *   hide-page --page pg_... [--note 备注]
 *   suspend --email 邮箱 [--note 备注]
 *   unsuspend --email 邮箱 [--note 备注]
 *
 * 直接读写 `NOWME_DATA_DIR` 下的数据库（WAL，可以在主站运行时执行）。实现见 src/services/moderation-cli.ts。
 */
import { dataPaths, loadConfig, loadRepoDotEnv } from '@nowme/contracts';
import { createRepos, openDatabase } from '../src/db/index.js';
import { runModerationCommand } from '../src/services/moderation-cli.js';

loadRepoDotEnv();
const config = loadConfig();
const db = openDatabase(dataPaths(config.dataDir).db);
let code = 0;
try {
  for (const line of runModerationCommand({ db, repos: createRepos(db), now: () => new Date() }, process.argv.slice(2))) console.log(line);
} catch (error) {
  console.error(`[moderation] ${error instanceof Error ? error.message : String(error)}`);
  code = 1;
} finally {
  db.close();
}
process.exit(code);
