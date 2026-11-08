# NOWMe

刚进入新圈子的年轻人，和自己的 AI Agent 一起做一页有个性的自己，挂在这个圈子共同的墙上。当前阶段：**本地开发原型试跑：本地 Agent 路线 + 网页内自带 API 创作（平台免费），不部署**。

## 先读什么

| 文档 | 用途 |
| --- | --- |
| `docs/contracts.md` | **接口约定，所有实现的唯一依据**：页面输出契约、校验规则与错误码、数据模型、API、票据、CSP、安全不变量 S1–S6 |
| `docs/hosted-route.md` | contracts 第 9 节：平台托管路线（采访、自带 API 生成、修改、用户凭证、S7/S8） |
| `docs/build-plan.md` | 里程碑、任务、验收标准与状态 |
| `docs/product-mvp-community-wall.md` | 产品需求（功能编号 W01–W21） |
| `docs/page-generation-byo-agent.md` | Skill、页面生成、凭证、安全与托管 |
| `docs/brief-collection.md` | 采访流程、场景指南、brief 结构、本地隐私规则 |

范围：本地 Agent 路线 + 网页内自带 API 创作（采访、生成、修改，见 `docs/hosted-route.md`）。取消所有收费与赠送次数方案。模型请求由服务器使用当前用户的 Key 发出，费用由服务商向用户收取；用户 Key 按账号加密保存，可跨设备管理与删除。主站需要 `NOWME_AI_ENCRYPTION_KEY`，不提供或回退到平台模型 Key。派生到新墙（W18）、真实邮件、部署都不做。

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
- 组织者只能看到成员昵称、加入时间、发布状态；看不到任何人的版本、草稿、未公开联系方式。
- 无权访问一律 404；非成员看不到墙；被移除的成员立即失去访问，其页面立即下墙。
- 本地路线的 brief 与画像从不上传；提交只接受白名单文件。

- 用户模型配置仅主人可管理；Key 使用 AES-256-GCM 认证加密，主密钥不入库；删除或更换后旧任务停止后续请求。自定义服务只允许公网 HTTPS，逐次解析 DNS 并固定连接地址，拒绝重定向。
