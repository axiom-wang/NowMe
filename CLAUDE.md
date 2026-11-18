# NOWMe

刚进入新圈子的年轻人，和 AI 一起做一页有个性的自己，挂在这个圈子共同的墙上；看到对的人，AI 帮你找到话题、起个头。

当前阶段（2026-11-14 起）：**按正式上线、面向真实用户的产品来做**，不按黑客松原型的标准。`main` 与 `feat/production-readiness` 不要直接改，在功能分支上做；黑客松参赛版本见标签 `hackathon-2026`。仓库为私有，`docs/` 纳入 git。

## 文档：按任务查，不要通读

`docs/` 合计十万字以上，**只读与任务相关的节**。接口约定在 `docs/contracts/`，一节一个文件（`NN-*.md`），是所有实现的唯一依据；代码与文档里写的“contracts N / N.M”就是 `docs/contracts/NN-*.md`。目录与每节摘要见 `docs/contracts/README.md`。

| 任务涉及 | 读 |
| --- | --- |
| 任何改动（先看） | `contracts/05-security-invariants.md`，加上下表对应节里的 S 不变量小节 |
| 页面文件、Kit、校验、渲染、CLI | `contracts/01`、`02`；Skill 本身见 `skill/` |
| 数据库、路由、Agent API、页面托管、Skill 分发 | `contracts/03`、`04` |
| 网页内采访 / 生成 / 修改、用户模型 Key、长期画像（S7/S8） | `contracts/09` → `docs/hosted-route.md`；采访内容另见 `docs/brief-collection.md` |
| 和 TA 聊什么（S9） / 点数与平台 AI（S10） | `contracts/11` / `contracts/12` |
| 后台任务队列、生成进度与通知 | `contracts/13`、`18` |
| 注销导出（S11） / 举报拉黑（S12） / 内容安全与协议 | `contracts/14` / `15` / `16` |
| 组织者工具（S13） / AI 介绍（S14） / 问墙（S15） | `contracts/19` / `20` / `21` |
| 主人直接改页面文字（S16） | `contracts/22` |
| 部署、环境变量、运维 | `contracts/10`、`17`，`docs/deploy.md` |
| 产品需求（功能编号 W01–W23）、页面生成方案 | `docs/product-mvp-community-wall.md`、`docs/page-generation-byo-agent.md`（只在需要产品背景时读） |
| 当前任务与状态 | `docs/build-plan.md` |

`docs/archive/` 是已完成里程碑的历史记录，除非要追查过去的决定，不要读。新增约定时在 `docs/contracts/` 加下一个编号的文件，并更新 `docs/contracts/README.md` 与上表。

## 范围

- 创作三条路：本地 Agent；网页内用自己的模型 Key（不收点数）；网页内用平台 AI（`NOWME_PLATFORM_*`，生成 / 修改扣点数）。平台 AI 没配置时只有前两条路。
- 已有：邮箱验证码登录（`NOWME_MAIL_TRANSPORT=smtp` 真实投递，本地写文件）、点数（个人余额与墙的额度，未接支付）、和 TA 聊什么、AI 介绍值得认识的人、问墙、直接改文字（不用 AI、不扣点数）、组织者工具（必答题、完成度提醒、墙的群像）、举报拉黑、注销导出、内容安全与协议。
- 部署：主站、页面托管、后台 worker 三个进程（`NOWME_WORKER_MODE=separate`）；没有域名时单台服务器 IP 直连见 `deploy/` 与 `docs/deploy.md`。
- 还不做：派生到新墙（W18）、支付渠道、组织者数据看板、AI 质量评测、数据埋点、上线地区的备案 / 实名等合规。

## 命令

```bash
pnpm install            # pnpm 12，Node 22（.nvmrc）
pnpm typecheck          # 根配置 + 各包 tsc
pnpm test               # 全部 vitest（不需要先 build，按 "source" 条件解析 TS 源码）
pnpm test:security      # 路径含 security 的测试（安全不变量）
pnpm test:e2e           # Playwright（用 3200/4200 端口自起服务）
pnpm build              # 各包编译到 dist/
pnpm dev                # 单服务进程启动主站与页面沙箱（带 watch），只需打开 localhost:3000
pnpm nowme <命令>        # 源码方式运行 CLI，例如 pnpm nowme validate skill/examples/<名>
pnpm --filter @nowme/web seed [--json]   # 开发种子：用户 + 黑客松墙 + 页面 + 一条 Agent 指令
pnpm --filter @nowme/skill pack:skill    # 打 Skill 包（含单文件 CLI）到 skill/dist-package/；dev / start:source 会先自动打包
pnpm --filter @nowme/skill publish:github --publish # 同步成品到 axiom-wang/nowme-skill 并发布版本；不带 --publish 只导出
pnpm --filter @nowme/web credits codes --count 20 --credits 100   # 生成兑换码（明文只输出一次）；另有 grant / balance
pnpm --filter @nowme/web worker      # 后台任务进程（源码方式；生产用 start:worker）
pnpm --filter @nowme/web backup      # 在线备份数据库与页面文件；restore 恢复到空目录
pnpm --filter @nowme/web moderation list   # 平台运营处理举报；另有 show / resolve / hide-page / suspend / unsuspend
pnpm --filter @nowme/<包> test   # 只测一个包
```

## 目录归属

| 目录 | 内容 |
| --- | --- |
| `packages/contracts` | 共享类型、zod schema、常量、错误码、票据、CSP 构造、沙箱属性。其他包只从这里取这些定义，不要各自重复 |
| `packages/validator` | 页面静态校验（纯函数，服务端复用） |
| `packages/kit` | NOWMe Kit（`static/` 下的 CSS/JS 由页面托管在 `/_nowme/kit/v1/` 提供）、`fonts.json` |
| `packages/render` | Playwright 渲染、截图、渲染检查、字体子集化、本地双源预览服务器 |
| `packages/cli` | `nowme` 命令行 |
| `skill/` | NOWMe Skill：`SKILL.md`、场景指南、模板、示例页 |
| `apps/web` | 主站（Hono SSR + `node:sqlite`） |
| `apps/pages-host` | 用户页面托管（独立源，只做静态托管 + 票据 + 安全头） |

子 Agent 只改任务说明里列出的目录，只读任务说明里列出的 contracts 节。需要改 `packages/contracts` 或 `docs/` 时，先在汇报里提出，由总规划师决定。

## 约定

- TypeScript strict + ESM；依赖版本写在 `pnpm-workspace.yaml` 的 catalog 中。不引入 Next.js、ORM、ESLint。
- 界面文字、错误信息、校验提示用中文；代码标识符、提交信息用英文（conventional commits）。
- 每个功能附带测试；安全相关测试放在路径含 `security` 的文件里，使 `pnpm test:security` 能单独运行。
- hono/jsx 不会自动输出 `<!doctype html>`，布局里要手动写。
- `node:sqlite` 会打印 ExperimentalWarning，可用 `--disable-warning=ExperimentalWarning` 去掉。
- 主站用 `localhost`，页面托管用 `127.0.0.1`：两个不同站点，cookie 不会互相携带，不要改成同一主机名。唯一例外是只能 IP 直连的部署显式设置 `NOWME_ALLOW_SAME_IP_ORIGINS=1`（contracts 10.1）；本地开发与测试不要用它。

## 安全红线（改动前必须有测试守住；细节见各节的 S 不变量小节）

- 展示用户页面的 iframe 只能是 `sandbox="allow-scripts"`（用 `PAGE_IFRAME_SANDBOX` 常量），**永远不加 `allow-same-origin`**、`allow-top-navigation*`、`allow-forms`、`allow-popups*`。
- 页面文档的 CSP 只能用 `buildPageCsp()` 生成，不加 `'unsafe-eval'`、`'self'`、`*`，`connect-src 'none'`。
- 一次性 token 只能换一次；页面凭证只能拉情境、提交版本、上报事件，**不能发布**；主站表单路由忽略 `Authorization` 头。
- 令牌、凭证、会话、验证码、兑换码只存哈希；凭证不打印、不写进 `page/`、不随提交上传。
- 组织者只能看到成员昵称、加入时间、发布状态、墙内公开的必答题回答、墙额度总数；看不到任何人的版本、草稿、未公开联系方式、邮箱、个人用量。
- 无权访问一律 404；非成员看不到墙；被移除的成员立即失去访问，其页面立即下墙。
- 本地路线的 brief 与画像从不上传；提交只接受白名单文件。
- 用户模型 Key 仅主人可管理，AES-256-GCM 加密、主密钥不入库，删除或更换后旧任务停止请求；自定义服务只允许公网 HTTPS，逐次解析 DNS 并固定连接地址，拒绝重定向。平台模型 Key 只来自环境变量，不入库、不写日志、不在页面出现。
- 点数（S10）：余额不为负，流水只追加；任务只扣一次，没做出新版本全额退回。
- 读别人内容的 AI 功能（S9 和 TA 聊什么、S14 AI 介绍、S15 问墙、S13 群像）共同规则：只给模型墙上对当前用户可见的已发布内容（S9 / S14 另加查看者自己的资料；S15 只加问题本身），不给候选名字；依据必须是原文且出自对应那一位（服务端核对）；输出不允许链接与联系方式；结果只属于发起的人，对方不收任何通知；只在同一面墙内。另外：S9 开场白只预填、从不代发；S15 事件不记问题原文；S13 只有组织者能改题、提醒、生成群像、下载名单，墙上只出现已上墙成员的回答，群像输出不许名字与数字人数，提醒邮件是固定模板，不发给关闭提醒、互相拉黑或停用的账号。
- 直接改文字（S16）：只有页面主人、只基于自己可用的版本；输入只能成为文字（转义），不能改标记、属性、样式与脚本；新版本照常校验、渲染与内容安全检查，不自动发布，不调用模型、不扣点数。
- 没有登录态的入口按来源地址限流；只有声明了 `NOWME_TRUST_PROXY` 才读 `X-Forwarded-For`。生产环境配置不完整就拒绝启动。
