# NOWMe

刚进入新圈子的年轻人，和 AI 一起做一页有个性的自己，挂在这个圈子共同的墙上；看到对的人，AI 帮你找到话题、起个头。

组织者（社团、黑客松、兴趣社群的负责人）建一面墙、把邀请发到群里；成员通过邀请加入，几分钟做好自己的一页，确认后才上墙，然后在墙上互相认识。

## 功能

- **墙与邀请**：组织者建墙（黑客松 / 创业营、兴趣社群、社团招新、通用），用邀请链接或二维码拉人；可以移除成员、关闭墙。墙只对成员可见。
- **做自己的一页**：三条路任选。
  - 本地 Agent：用自己的编程 Agent（Claude Code、Codex 等）装上 NOWMe Skill，采访与画像都留在本机；
  - 网页内用自己的模型 Key：采访、生成、修改都在网页里完成，Key 按账号加密保存；
  - 网页内用平台 AI：采访免费，生成与修改扣点数。
- **本人确认才发布**：页面先预览、可以反复修改，主人点发布才上墙，随时可撤下；也可以单独开一个墙外的公开链接。
- **和 TA 聊什么**：在别人的页面上，请 AI 从两边公开的资料里找连接点、起草开场白，只预填、从不代发。
- **问墙**：在墙上问一句（“谁会剪视频？”），AI 从大家公开的页面里找出写到这件事的人，并附上 TA 页面上的原话；只有提问的人自己看得到。
- **消息**：墙内群聊与私聊。
- **点数**：个人余额（兑换码、运营发放）与墙的额度（组织者替成员买单，可设每人上限）。暂未接支付渠道。
- **账号**：只用邮箱验证码登录；可以导出个人数据、注销账号；支持举报与拉黑。

隐私与安全的硬性约定（用户页面在独立源的沙箱里运行、组织者看不到成员草稿等）见 `docs/contracts/05-security-invariants.md`。

## 本地开发

需要 Node.js 22（至少 22.13.0，见 `.nvmrc`）和 pnpm 12。

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # 渲染页面截图用
pnpm dev                                # 主站 + 页面沙箱，打开 http://localhost:3000
```

本地默认不发真实邮件，登录验证码在 <http://localhost:3000/dev/outbox> 查看。需要一些现成数据时：

```bash
pnpm --filter @nowme/web seed           # 开发种子：用户 + 一面墙 + 页面 + 一条 Agent 指令
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | 全部单元与集成测试（不需要先 build） |
| `pnpm test:security` | 只跑安全不变量相关测试 |
| `pnpm test:e2e` | Playwright 端到端测试 |
| `pnpm build` | 各包编译到 `dist/` |
| `pnpm nowme <命令>` | 源码方式运行 `nowme` 命令行 |
| `pnpm --filter @nowme/skill pack:skill` | 打 Skill 安装包 |
| `pnpm --filter @nowme/web credits codes --count 20 --credits 100` | 生成兑换码（明文只输出一次） |

环境变量清单见 `.env.example`。

## 生产部署

见 [docs/deploy.md](docs/deploy.md)：进程划分（web / pages / worker）、环境变量（`.env.production.example`）、反向代理与 HTTPS、备份与恢复。生产环境启动前会检查配置，不完整就拒绝启动。

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/web` | 主站（Hono SSR + `node:sqlite`） |
| `apps/pages-host` | 用户页面托管（独立源，只做静态托管 + 票据 + 安全头） |
| `packages/contracts` | 共享类型、校验 schema、常量、错误码、CSP 构造 |
| `packages/validator` | 页面静态校验 |
| `packages/kit` | NOWMe Kit（页面可用的 CSS / JS 与字体） |
| `packages/render` | 渲染、截图、字体子集化、本地预览 |
| `packages/cli` | `nowme` 命令行 |
| `skill/` | NOWMe Skill：生成规范、场景指南、模板、示例页 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/contracts/](docs/contracts/README.md) | 接口约定：页面输出契约、校验与错误码、数据模型、API、安全不变量 |
| [docs/hosted-route.md](docs/hosted-route.md) | 网页内创作（采访、生成、修改、用户凭证） |
| [docs/product-mvp-community-wall.md](docs/product-mvp-community-wall.md) | 产品需求 |
| [docs/page-generation-byo-agent.md](docs/page-generation-byo-agent.md) | Skill、页面生成、凭证与托管 |
| [docs/brief-collection.md](docs/brief-collection.md) | 采访流程、场景指南、本地隐私规则 |
| [docs/build-plan.md](docs/build-plan.md) | 里程碑与任务 |
| [docs/deploy.md](docs/deploy.md) | 部署与运维 |

## 演示模式（开发工具）

`pnpm demo` 启动一套带预置内容的本地实例：四面示例墙、示例页面和虚构聊天，首页换成一键身份登录（成员 / 组织者），不需要邮箱验证码。适合演示和手动走查界面，不用于生产。

- 数据在 `.data/demo`，与普通开发数据分开；重启保留，`pnpm demo --reset` 重建。
- AI 采访与生成需要模型配置，写在本机 `.env.local`（格式见 `.env.demo.example`），仓库里不放任何 Key。
- 预置内容说明见 [docs/demo-data.md](docs/demo-data.md)。
