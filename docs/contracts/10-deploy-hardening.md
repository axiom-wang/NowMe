# 10. 部署与加固

配置由 `packages/contracts/src/config.ts` 的 `loadConfig()` 读取并校验（取值不合法抛 `ConfigError`，进程退出）；示例与注释见仓库根 `.env.example`。主站与页面托管启动时载入仓库根 `.env`，已在环境中设置的变量优先。

## 10.1 环境变量与生产启动检查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时关闭 `/dev/outbox`、拒绝假模型，并执行下面的启动检查 |
| `NOWME_WEB_ORIGIN` / `NOWME_PAGES_ORIGIN` | 见 0.1 | **对外的源**（用户在浏览器里看到的地址）；两者主机名不能相同 |
| `NOWME_ALLOW_SAME_IP_ORIGINS` | `0` | 例外开关：`1` 时允许两个源是**同一个 IP 字面量的不同端口**（没有域名、只能 IP 直连时的临时做法）。域名不放行，端口必须不同；生产启动检查会提醒。此时 cookie 不再按站点隔离，主站的会话 cookie 会随请求到达页面托管端口，隔离依靠页面文档的 `sandbox` CSP（S2）、会话 cookie 的 `HttpOnly`、页面托管不读不写 cookie、主站的 Host 校验（含端口）与表单来源检查 |
| `NOWME_WEB_LISTEN` / `NOWME_PAGES_LISTEN` | 由源推导 | **进程实际监听的地址**：`端口`、`主机:端口` 或 `[IPv6]:端口`（只写端口时主机沿用源的主机名）。部署在反向代理之后时，源写 https 域名，这里写例如 `0.0.0.0:3000` |
| `NOWME_TRUST_PROXY` | `0` | 进程前可信反向代理层数，0–5（10.3） |
| `NOWME_DATA_DIR` | `.data` | 相对路径按仓库根解析 |
| `NOWME_TICKET_SECRET` | 空 | ≥ 32 字符；空时两边共用 `<dataDir>/secret`（首次启动生成，0600） |
| `NOWME_AGENT_TOKEN_TTL_HOURS` | `72` | 1–720 |
| `NOWME_HOME` | `~/.nowme` | 仅 CLI |
| `NOWME_MAIL_TRANSPORT` / `NOWME_SMTP_URL` / `NOWME_MAIL_FROM` | `file` / 空 / 空 | 10.2 |
| `NOWME_AI_ENCRYPTION_KEY` | 空 | 用户模型 Key 的主密钥，64 位十六进制（hosted-route 1） |
| `NOWME_AI_ALLOW_LOCAL` | `0` | 仅非生产：允许回环模型地址 |
| `NOWME_HOSTED_MAX_TURNS` / `NOWME_HOSTED_DAILY_ATTEMPTS` / `NOWME_INTERVIEW_DAILY_CALLS` | `30` / `10` / `20` | 运行保护（hosted-route 3.4） |
| `NOWME_MODEL_FAKE`（旧名 `NOWME_CLAUDE_FAKE`） | 空 | 非生产假模型；生产拒绝 |
| `NOWME_PLATFORM_PROVIDER` / `_API_KEY` / `_BASE_URL` / `_MODEL` / `_INTERVIEW_MODEL` / `_VISION` | 空 | 平台 AI（12.1）；`PROVIDER` 不设则平台 AI 关闭 |
| `NOWME_PRICE_GENERATE` / `NOWME_PRICE_EDIT` | `10` / `4` | 价目（点数），0–10000，0 表示不收 |
| `NOWME_SIGNUP_CREDITS` | `0` | 注册赠送点数，0–10000 |
| `NOWME_PLATFORM_FREE_DAILY_CALLS` | `3000` | 平台 AI 免费调用的全站每日上限，1–1 000 000 |
| `NOWME_SKILL_MARKET_LABEL` / `NOWME_SKILL_MARKET_COMMAND` | 空 | 4.5，同时设置或都不设 |
| `NOWME_DEMO_URL` | 空 | 演示环境入口，https 绝对地址、不带账号口令，非法值启动报错。设置后正式站顶栏对访客和登录用户都显示“Demo”外链（`rel="noopener"`，窄屏登录用户收进账号菜单）；演示模式自身与未设置时不显示。只在正式环境设置，演示环境不设 |

密钥类变量（`NOWME_SMTP_URL`、`NOWME_AI_ENCRYPTION_KEY`、`NOWME_PLATFORM_API_KEY`）**不进配置对象**：主站入口只把它们作为 `secretEnv` 交给需要的模块；配置错误信息与日志里不出现它们的值。

**生产启动检查**（`assertProductionConfig(config, env, role)`，仅 `NODE_ENV=production`；主站 `role='web'`、页面托管 `role='pages'`）。一次列出全部问题；有错误就拒绝启动，提醒只打印。

| 级别 | 条件 | 适用 |
| --- | --- | --- |
| 错误 | `NOWME_WEB_ORIGIN` 或 `NOWME_PAGES_ORIGIN` 不是 `https://`（Secure cookie 与 HSTS 依赖它） | 两者 |
| 错误 | `NOWME_AI_ENCRYPTION_KEY` 不是 64 位十六进制 | 主站 |
| 错误 | 设置了 `NOWME_PLATFORM_PROVIDER` 但没有 `NOWME_PLATFORM_API_KEY` | 主站 |
| 错误 | `NOWME_MAIL_TRANSPORT=file`（真实用户收不到验证码） | 主站 |
| 提醒 | 主站与页面托管看起来在同一个可注册域名下（`registrableDomainGuess`，子域名属于同站；建议用户页面单独注册域名） | 两者 |
| 提醒 | 没有设置 `NOWME_TICKET_SECRET`（两个进程必须挂载同一个数据目录） | 两者 |
| 提醒 | `NOWME_TRUST_PROXY=0`（在代理之后时所有请求同一来源，按地址限流会误伤） | 两者 |

## 10.2 邮件投递（登录验证码）

| `NOWME_MAIL_TRANSPORT` | 行为 |
| --- | --- |
| `file`（默认） | 写进 `<dataDir>/outbox.log` 并打印到控制台；非生产且非演示时提供 `GET /dev/outbox` |
| `smtp` | 经 `NOWME_SMTP_URL` 真实发送；必须同时设置 `NOWME_MAIL_FROM`（一行，含发件邮箱，≤ 200 字符）；没有 `/dev/outbox`，登录页也不显示开发入口 |

- 连接串：`smtps://用户:密码@主机:465`（隐式 TLS）或 `smtp://用户:密码@主机:587`；用户名密码按 URL 规则百分号编码。`smtp://` 在生产环境强制 STARTTLS。连接池最多 3 个连接，连接 / 问候 / DNS 超时 10 s，套接字 20 s。
- 邮件：主题以验证码开头，正文与 HTML 都只有验证码与有效期，不含链接。
- 日志只记脱敏收件人（`a***@example.com`）与成功 / 失败，失败只记 nodemailer 错误类别（如 `EAUTH`），不记主题、正文、服务器回复原文、连接串。
- 发送失败：刚签发的验证码立即作废（仍计入同邮箱限流），`POST /login` 返回 `503` 与固定中文说明。

## 10.3 来源地址与限流

**来源地址**（`apps/web/src/security/client.ts` 的 `clientAddress`）：`NOWME_TRUST_PROXY=0` 时只用 TCP 对端地址，**忽略 `X-Forwarded-For`**；`=N` 时取 `X-Forwarded-For` 从右数第 N 个（头缺失、层数不够或不是 IP 时退回连接地址）。IPv4 映射的 IPv6 按 IPv4 记，IPv6 转小写；拿不到地址时记为 `unknown`。

**进程内限流**（`apps/web/src/security/rate-limit.ts`）：按“范围 + 键”的固定窗口计数，超过上限后不再累加；键数超过 5000 时清理过期记录。计数在进程内存，重启清零；多进程部署前要换共享存储。取值在 `apps/web/src/constants.ts` 的 `RATE_RULES`。

| 范围 | 键 | 上限 | 超出时 |
| --- | --- | --- | --- |
| `login-request`（`POST /login`） | 来源地址 | 120 次 / 10 分钟 | `429` + `Retry-After`，固定说明 |
| `login-verify`（`POST /login/verify`） | 来源地址 | 300 次 / 10 分钟 | 同上 |
| `agent-exchange`（`POST /api/agent/exchange`） | 来源地址 | 60 次 / 10 分钟 | `429 RATE_LIMITED` + `Retry-After` |
| `chat-send`（`POST /messages/:id/send`） | 用户 | 40 次 / 分钟（群聊 + 私聊合计） | `429` + `Retry-After`，草稿保留；无权访问的会话仍是 `404` |
| `redeem`（`POST /account/credits/redeem`） | 用户 | 10 次 / 10 分钟 | `429` |
| `platform-free`（平台 AI 免费调用） | 全站 | `NOWME_PLATFORM_FREE_DAILY_CALLS` / 24 小时 | `MODEL_UNAVAILABLE`（12.1） |

按地址的上限故意放宽（校园网同一出口）；它们只挡脚本批量发信、试验证码、试 token。持久的额度仍在数据库里按滚动窗口计算：同邮箱验证码 5 次 / 10 分钟、每页提交 50 次 / 24 小时、远程预览 100 次 / 24 小时、托管任务与采访（hosted-route 3.4）、和 TA 聊什么（11.5）。

## 10.4 补充安全头

主站所有响应（`apps/web/src/security/headers.ts`）：第 5 节末尾的 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Permissions-Policy`（`WEB_PERMISSIONS_POLICY`，与页面托管同一份关闭清单，唯一差异是主站 `fullscreen=(self)`，供 5.3 展示模式请求全屏；页面托管仍 `fullscreen=()`）、`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`；动态响应默认 `Cache-Control: no-store`。主站为 https 源时加 `Strict-Transport-Security: max-age=31536000`（不带 `includeSubDomains` / `preload`），会话 cookie 加 `Secure`。

## 10.5 健康检查

| 路径 | 服务 | 响应 |
| --- | --- | --- |
| `GET /healthz` | 主站、页面托管 | `200 ok`（纯文本） |
| `GET /readyz` | 主站 | 执行 `SELECT 1`：成功 `200 {"status":"ok"}`，失败 `503 {"status":"unavailable"}` |

主站的这两个路由放在 Host 头校验之前（探针常用 IP 访问），不读会话、不设 cookie、不返回业务信息，`Cache-Control: no-store`；其他路径仍做 Host 校验（421）。页面托管的 `/healthz` 不读文件。

容器、编排、备份与日志见第 17 节。

## 10.6 尚未做的事

已做：真实邮件投递（10.2）；收费以点数形式提供（第 12 节，尚未接支付渠道）。M8 进行中：注销与导出（第 14 节）、举报与拉黑（第 15 节）、内容安全与 AI 标识（第 16 节）、运维（第 17 节）。仍不做：W09 应用内素材管理、修改时把新信息写回画像、派生到新墙（W18）、支付渠道、组织者数据看板。
