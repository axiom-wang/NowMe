/**
 * 开发种子：`pnpm --filter @nowme/web seed [--email <邮箱>] [--nickname <昵称>] [--wall <墙名>] [--json]`
 *
 * 创建（或复用）一个用户、一面黑客松墙（该用户是组织者）、成员关系与页面，生成一条一次性 token（旧的未使用 token 作废），
 * 打印登录邮箱、`/dev/outbox` 地址、工作区地址与完整的 Agent 指令。`--json` 输出机器可读结果（e2e 用）。
 * 使用与主站相同的 `NOWME_DATA_DIR`（读仓库根 `.env`），主站运行时也可以执行。
 * M3 会有真正的建墙 / 邀请流程；这个脚本只为本地开发与 M2 验收。
 */
import { parseArgs } from 'node:util';
import { dataPaths, generateId, loadConfig, loadRepoDotEnv } from '@nowme/contracts';
import { createRepos, openDatabase } from '../src/db/index.js';
import { formatDateTime } from '../src/format.js';
import { normalizeEmail, nicknameProblem } from '../src/services/auth.js';
import { workspaceUrl } from '../src/services/agent.js';
import { createInstruction } from '../src/services/instruction.js';
import { addMember, createWall } from '../src/services/walls.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string', default: 'dev@nowme.test' },
    nickname: { type: 'string', default: '开发者' },
    wall: { type: 'string', default: 'NOWMe 开发黑客松' },
    json: { type: 'boolean', default: false },
  },
});

loadRepoDotEnv();
const config = loadConfig();
const email = normalizeEmail(values.email);
if (!email) throw new Error(`邮箱格式不对：${values.email}`);
const nickname = values.nickname.trim();
const problem = nicknameProblem(nickname);
if (problem) throw new Error(problem);

const db = openDatabase(dataPaths(config.dataDir).db);
const repos = createRepos(db);
const now = () => new Date();
const deps = { db, repos, now, config };

let user = repos.users.findByEmail(email);
if (!user) {
  user = repos.users.create({ id: generateId('usr'), email, nickname, createdAt: now().toISOString() });
} else if (!user.nickname) {
  repos.users.setNickname(user.id, nickname);
  user = { ...user, nickname };
}

let wall = repos.walls.findOpenByOrganizerAndName(user.id, values.wall);
if (!wall) {
  wall = createWall(deps, {
    organizerId: user.id,
    name: values.wall,
    description: '开发种子脚本创建的黑客松墙：周末 48 小时，找到能一起熬夜的队友。',
    sceneType: 'hackathon',
    organizerNote: '先挂上自己的一页，再去墙上找人聊',
  }).wall;
}
const membership = repos.memberships.findByWallAndUser(wall.id, user.id);
let page = membership ? repos.pages.findByMembership(membership.id) : null;
if (!membership) page = addMember(deps, wall, user.id, 'organizer').page;
if (!page) throw new Error('成员关系存在但缺少页面，数据库状态异常');

const instruction = createInstruction(deps, wall, page);
db.close();

const result = {
  dataDir: config.dataDir,
  email,
  nickname: user.nickname,
  userId: user.id,
  wallId: wall.id,
  wallName: wall.name,
  pageId: page.id,
  loginUrl: `${config.webOrigin}/login`,
  outboxUrl: `${config.webOrigin}/dev/outbox`,
  workspaceUrl: workspaceUrl(config.webOrigin, wall.id),
  token: instruction.token,
  tokenExpiresAt: instruction.expiresAt.toISOString(),
  command: instruction.command,
  plainText: instruction.plainText,
};

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const indent = (text: string) =>
    text
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
  console.log(
    [
      `NOWMe 开发种子已就绪（数据目录 ${result.dataDir}）`,
      '',
      `  登录邮箱：${result.email}（昵称：${result.nickname}）`,
      `  登录：    ${result.loginUrl} → 发送验证码后到 ${result.outboxUrl} 查看验证码`,
      `  墙：      ${result.wallName}（${result.wallId}）`,
      `  工作区：  ${result.workspaceUrl}`,
      '',
      `  Agent 指令（一次性，${formatDateTime(instruction.expiresAt)}（北京时间）前有效；再次运行本脚本会作废它并生成新的）：`,
      indent(result.command),
      '',
      '  给不支持 Skill 的 Agent 的纯文本说明：',
      indent(result.plainText),
      '',
    ].join('\n'),
  );
}
