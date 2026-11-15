# NOWMe

刚进入新圈子的年轻人，和 AI 一起做一页有个性的自己，挂在这个圈子共同的墙上；看到对的人，AI 帮你找到话题、起个头。

当前阶段（2026-11-14 起）：**按计划正式上线、面向真实用户的产品来做**，不再按黑客松原型的标准。2026-11-15 起的系统性改造在分支 `feat/production-overhaul` 上（任务见 `docs/build-plan.md` 的 M8）；`main` 与 `feat/production-readiness` 不要直接改；黑客松参赛版本见标签 `hackathon-2026`。仓库为私有，`docs/` 纳入 git。

## 先读什么

| 文档 | 用途 |
| --- | --- |
| `docs/contracts.md` | **接口约定，所有实现的唯一依据**：页面输出契约、校验规则与错误码、数据模型、API、票据、CSP、安全不变量 S1–S6；第 10 节部署与加固、第 11 节“和 TA 聊什么”（S9）、第 12 节点数与平台 AI（S10）；第 13–18 节为 M8 新增（任务队列、注销与导出、举报拉黑、内容安全与协议、运维、生成进度）；第 19 节组织者工具（必答题、完成度与提醒、墙的群像，S13） |
| `docs/hosted-route.md` | contracts 第 9 节：平台托管路线（采访、自带 API 生成、修改、用户凭证、S7/S8） |
| `docs/build-plan.md` | 里程碑、任务、验收标准与状态 |
| `docs/product-mvp-community-wall.md` | 产品需求（功能编号 W01–W21） |
| `docs/page-generation-byo-agent.md` | Skill、页面生成、凭证、安全与托管 |
| `docs/brief-collection.md` | 采访流程、场景指南、brief 结构、本地隐私规则 |

范围：

- 创作有三条路：本地 Agent；网页内用自己的模型 Key（不收点数）；网页内用平台 AI（`NOWME_PLATFORM_*`，采访与“和 TA 聊什么”不收点数，生成 / 修改扣点数）。平台 AI 没配置时，行为与只有前两条路时相同。
- 点数：个人余额（兑换码、运营发放）与墙的额度（组织者为成员买单，可设每人上限）。还没有接支付渠道。
- “和 TA 聊什么”：成员在别人的页面上请 AI 找连接点、起草开场白（contracts 11）。
- 组织者工具（contracts 19）：建墙时设 0–3 道必答题、墙上按回答筛选；后台看完成度并一键邮件提醒；AI 生成全墙可见的“墙的群像”。
- 登录只做邮箱验证码；`NOWME_MAIL_TRANSPORT=smtp` 时真实投递，本地默认写文件。
- 用户自己的 Key 按账号加密保存（需要 `NOWME_AI_ENCRYPTION_KEY`），可跨设备管理与删除。
- 还不做：派生到新墙（W18）、支付渠道、举报与拉黑、注销账号、组织者数据看板。

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
pnpm --filter @nowme/skill pack:skill    # 打 Skill 包（含单文件 CLI）到 skill/dist-package/，本地镜像；公开安装走 GitHub；dev / start:source 会先自动打包
pnpm --filter @nowme/skill publish:github --publish # 同步完整成品到 axiom-wang/nowme-skill 并发布版本；默认不带 --publish 时只导出
pnpm --filter @nowme/web credits codes --count 20 --credits 100   # 生成兑换码（明文只输出一次）；另有 grant / balance
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

子 Agent 只改任务说明里列出的目录。需要改 `packages/contracts` 或 `docs/` 时，先在汇报里提出，由总规划师决定。

## 约定

- TypeScript strict + ESM；依赖版本写在 `pnpm-workspace.yaml` 的 catalog 中。不引入 Next.js、ORM、ESLint。
- 界面文字、错误信息、校验提示用中文；代码标识符、提交信息用英文（conventional commits）。
- 每个功能附带测试；安全相关测试放在路径含 `security` 的文件里，使 `pnpm test:security` 能单独运行。
- hono/jsx 不会自动输出 `<!doctype html>`，布局里要手动写。
- `node:sqlite` 会打印 ExperimentalWarning，可用 `--disable-warning=ExperimentalWarning` 去掉。
- 主站用 `localhost`，页面托管用 `127.0.0.1`：两个不同站点，cookie 不会互相携带。不要把两者改成同一主机名。

## 安全红线（contracts 第 5 节，改动前必须有测试守住）

- 展示用户页面的 iframe 只能是 `sandbox="allow-scripts"`（用 `PAGE_IFRAME_SANDBOX` 常量），**永远不加 `allow-same-origin`**、`allow-top-navigation*`、`allow-forms`、`allow-popups*`。
- 页面文档的 CSP 只能用 `buildPageCsp()` 生成，不加 `'unsafe-eval'`、`'self'`、`*`，`connect-src 'none'`。
- 一次性 token 只能换一次；页面凭证只能拉情境、提交版本、上报事件，**不能发布**；主站表单路由忽略 `Authorization` 头。
- 令牌、凭证、会话、验证码只存哈希；凭证不打印、不写进 `page/`、不随提交上传。
- 组织者只能看到成员昵称、加入时间、发布状态，以及成员在墙内公开回答的必答题；看不到任何人的版本、草稿、未公开联系方式、邮箱。
- 无权访问一律 404；非成员看不到墙；被移除的成员立即失去访问，其页面立即下墙。
- 本地路线的 brief 与画像从不上传；提交只接受白名单文件。

- 用户模型配置仅主人可管理；Key 使用 AES-256-GCM 认证加密，主密钥不入库；删除或更换后旧任务停止后续请求。自定义服务只允许公网 HTTPS，逐次解析 DNS 并固定连接地址，拒绝重定向。
- “和 TA 聊什么”（S9）：只把查看者自己的资料和对方已经公开在墙上的内容交给模型；结果只属于查看者；连接点的依据必须是两边资料里的原文（服务端核对）；开场白只预填、从不代发；输出里不允许出现链接与联系方式。
- 点数与平台 AI（S10）：平台模型的 Key 只来自环境变量，不入库、不写日志、不在页面出现；余额不为负，流水只追加；任务只扣一次，没做出新版本全额退回；兑换码只存哈希；组织者只看到墙额度的总数，看不到任何成员用了多少。
- 组织者工具（S13）：只有组织者能改题、提醒、生成群像、下载名单；墙上只出现已上墙成员的回答；提醒邮件是固定模板，不发给关闭提醒、与组织者之间有拉黑、停用的账号；群像只读墙上公开的发布快照与回答，不给模型名字，输出里不允许链接、名字与数字人数。
- 没有登录态的入口按来源地址限流；只有声明了 `NOWME_TRUST_PROXY` 才读 `X-Forwarded-For`。生产环境启动前检查配置，不完整就拒绝启动。
