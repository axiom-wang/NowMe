/**
 * 点数运营脚本（contracts 12）：`pnpm --filter @nowme/web credits <命令>`
 *
 *   codes --count 20 --credits 100 [--batch "2026-12 招新"] [--expires 2027-03-01]
 *       生成一批兑换码。明文只在这里输出一次（库里只存哈希），请立刻保存；一行一个，可以直接发给用户。
 *   grant --email someone@example.com --credits 50
 *       给某个账号直接发放点数。
 *   balance --email someone@example.com
 *       查看某个账号的余额。
 *
 * 直接读写 `NOWME_DATA_DIR` 下的数据库（WAL，可以在主站运行时执行）。
 */
import { dataPaths, loadConfig, loadRepoDotEnv } from '@nowme/contracts';
import { createRepos, openDatabase } from '../src/db/index.js';
import { normalizeEmail } from '../src/services/auth.js';
import { createRedeemCodes, grantCredits, userAccount } from '../src/services/billing.js';

function fail(message: string): never {
  console.error(`[credits] ${message}`);
  process.exit(1);
}

function options(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined) fail(`参数格式不对：${name ?? ''}`);
    result[name.slice(2)] = value;
  }
  return result;
}

function integer(value: string | undefined, name: string): number {
  if (!value || !/^-?\d+$/.test(value)) fail(`--${name} 应为整数`);
  return Number(value);
}

loadRepoDotEnv();
const config = loadConfig();
const [command, ...rest] = process.argv.slice(2);
const args = options(rest);
const db = openDatabase(dataPaths(config.dataDir).db);
const deps = { db, repos: createRepos(db), now: () => new Date() };

function userByEmail(raw: string | undefined) {
  const email = normalizeEmail(raw);
  const user = email ? deps.repos.users.findByEmail(email) : null;
  if (!user) fail('没有这个邮箱的账号（需要对方先登录过一次）');
  return user;
}

try {
  switch (command) {
    case 'codes': {
      const codes = createRedeemCodes(deps, { count: integer(args.count, 'count'), credits: integer(args.credits, 'credits'), batch: args.batch ?? null, expiresAt: args.expires ?? null });
      console.error(`[credits] 已生成 ${codes.length} 个兑换码，每个 ${args.credits} 点。明文只显示这一次：`);
      for (const code of codes) console.log(code);
      break;
    }
    case 'grant': {
      const user = userByEmail(args.email);
      const entry = grantCredits(deps, user.id, integer(args.credits, 'credits'));
      console.log(`已发放 ${entry.delta} 点，余额 ${entry.balanceAfter}`);
      break;
    }
    case 'balance': {
      const user = userByEmail(args.email);
      console.log(String(deps.repos.credits.balanceOf(userAccount(user.id))));
      break;
    }
    default:
      fail('用法：credits codes --count N --credits N [--batch 备注] [--expires 日期] | grant --email 邮箱 --credits N | balance --email 邮箱');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
