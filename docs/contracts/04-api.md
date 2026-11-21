# 4. API

## 4.1 Agent API（CLI 使用，JSON）

认证：`Authorization: Bearer nmc_...`（页面凭证）。错误统一 `{"error": {"code": "...", "message": "中文说明"}}`。

| 方法与路径 | 认证 | 请求 | 响应 |
| --- | --- | --- | --- |
| `POST /api/agent/exchange` | 无 | `{ wallId, token, client? }`；`client = { cliVersion, skillVersion \| null }`（版本号 `主.次.修订[-预发布]`；格式不对时 `400 BAD_REQUEST` 且 token 不被使用） | `200 { credential, page: {id}, context }`；失败 `401 TOKEN_INVALID`（不存在、已用、过期、墙不匹配一律同一码，`message` 可区分原因） |
| `GET /api/agent/context` | 凭证 | — | `200 context` |
| `POST /api/agent/revisions` | 凭证 | `{ files: { "<相对路径>": "<base64>" } }`，体积上限 12 MB | 通过 `201 { revision }`；校验不通过 `422 { revision }`（`status: "rejected"`，含报告） |
| `POST /api/agent/events` | 凭证 | `{ type, props? }`；`type ∈ fetch / validate / preview / generate / submit`；`props` 只接受数字和布尔值 | `204` |
| `POST /api/agent/previews` | 凭证 | 与 `/revisions` 相同（体积上限、白名单过滤） | `200 RemotePreviewResponse`：服务端用与提交相同的沙箱渲染管线（`mode: 'preview'`）渲染并返回报告与截图，**什么都不存**（不建版本、不写文件，只记一条不含内容的 `remote_preview` 事件）；每页每 24 小时 [原型默认] 100 次，超出 `429 RATE_LIMITED` |

```ts
interface AgentContext {
  wall: { id: string; name: string; description: string; sceneType: SceneType; organizerNote: string | null };
  page: { id: string; revisionCount: number; lastSubmittedAt: string | null; workspaceUrl: string };
  kit: { version: '1'; basePath: '/_nowme/kit/v1/'; fonts: KitFont[] };
  limits: { htmlMaxBytes: number; assetMaxBytes: number; assetsTotalMaxBytes: number; assetsMaxCount: number; maxCjkFonts: number };
  skill: { version: string; installUrl: string } | null; // 主站分发的 Skill 版本与安装页（4.5）；没有 Skill 包时为 null
}
interface RemotePreviewResponse {
  report: ValidationReport; rendered: boolean;
  cover: string | null; full: string | null; reducedMotion: string | null; // PNG base64
  blocks: { id: string; top: number; height: number; png: string }[];     // 最多 12 块
}
interface RevisionSummary { id: string; number: number; status: 'accepted' | 'rejected'; report: ValidationReport; createdAt: string; workspaceUrl: string }
```

规则：

- exchange 成功：token 标记已用；该页已有的有效凭证全部吊销；签发新凭证（明文只在这次响应中出现）。
- 凭证在以下情况吊销：主人在应用内断开、重新生成指令并被换取、主人退出墙、页面被删除、主人被移除、墙被关闭。
- 墙已关闭或成员关系不再有效时，所有 Agent API 返回 `401 CREDENTIAL_INVALID`。
- 提交时服务端只接受第 1 节白名单路径；忽略其他路径；重新运行全部静态校验（不信任客户端结果）与渲染检查；任何一步失败都存为 `rejected`，不影响已有的 `accepted` 版本与发布。
- 每页每日提交上限 [原型默认] 50 次，超出 `429 RATE_LIMITED`。

## 4.2 主站页面与表单（服务端渲染，会话 cookie 认证）

会话：cookie `nowme_session`（IP 直连且主站使用非默认端口时为 `nowme_session_<端口>`，由 `sessionCookieName()` 派生，避免正式站和 Demo 互相覆盖登录），`HttpOnly; SameSite=Lax; Path=/`，host-only（不设 `Domain`）。所有改变状态的请求必须是 `POST`，并同时满足：有效会话、表单字段 `_csrf` 与会话一致、`Origin`（或 `Referer`）等于 `NOWME_WEB_ORIGIN`。**这些路由一律忽略 `Authorization` 头**，页面凭证在这里无效。

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /login`、`POST /login`、`POST /login/verify`、`POST /logout` | 任何人 | 邮箱 + 6 位验证码；首次登录填昵称 |
| `GET/POST /welcome` | 登录用户 | 首次登录填写昵称 |
| `POST /account/profile` | 登录用户，会话 + Origin + CSRF | multipart：`nickname`（去空白后 1–24 字，不含控制字符）、可选单张 `avatar`、`removeAvatar=1` 移除头像；仅更新会话本人，忽略用户 ID 和 Authorization；昵称与头像原子保存，失败保留原资料 |
| `GET /account/avatar` | 登录用户 | 仅返回会话本人的头像，忽略用户 ID；无头像 404，`image/webp`、`private, no-store`、`nosniff`；`v` 参数用于页面刷新后更换图片地址，不决定授权 |
| `GET /dev/outbox` | 仅非生产、非演示且 `NOWME_MAIL_TRANSPORT=file` | 本地查看发出的验证码（10.2） |
| `GET /` | 登录用户 | 创作工作台：有效墙的统计、待完成 / 已发布分组；`filter=all\|pending\|published` 筛选（未知值按 all）；已撤下归入待完成；已结束的墙只显示状态 |
| `GET /walls/new`、`POST /walls` | 登录用户 | 建墙：名称、简介、场景类型、可选一句话 |
| `GET /join/:inviteCode`、`POST /join/:inviteCode` | 登录用户 | 加入墙（已被移除的成员不能再加入；已关闭的墙不能加入） |
| `GET /w/:wallId` | 墙内有效成员 | 墙：名称、简介、随机排序的缩略卡网格、“我的页面”入口 |
| `GET /w/:wallId/cover` | 墙内有效成员 | 当前墙封面（WebP）；不存在、非成员、已退出 / 移出或墙关闭均 404；`Cache-Control: private, no-store`，每次检查权限 |
| `POST /w/:wallId/admin/cover` | 组织者 | multipart 表单 `_csrf` + 单个 `cover` 文件；JPG / PNG / WebP、最多 5 MiB、最多 4000 万像素；按内容识别、完整解码、自动转正、按 1:1 居中裁切至最多 1200×1200、去除元数据并重编码为静态 WebP；拒绝 SVG、动图、伪造 / 损坏图片；成功后替换旧封面，失败保留原图 |
| `POST /w/:wallId/admin/cover/delete` | 组织者 | 删除自定义墙封面，首页与后台恢复场景默认插画 |
| `GET /w/:wallId/p/:pageId` | 墙内有效成员 | 成员页面（沙箱 iframe）+ 接话点 + “想聊这个”；别人的页面另有“和 TA 聊什么”（第 11 节，路由见 11.5）；PageFrame 提供展示模式与墙内连播 |
| `GET /w/:wallId/p/:pageId/stage` | 与成员页相同（含必答题门槛） | 墙内连播 JSON：`pageId, displayName, tagline, src, position, total, prevId, nextId`；固定发布顺序首尾循环，过滤拉黑与未发布；`src` 只签当前发布版本；非自己的页记 `page_open`；无权访问一律 404 |
| `POST /w/:wallId/p/:pageId/chat` | 墙内有效成员 | `hookId` 取当前发布快照；记录事件，303 进入私聊并预填开场白，不自动发送；不依赖外部联系方式 |
| `POST /w/:wallId/p/:pageId/direct` | 墙内有效成员 | 303 进入与页面主人的同墙私聊；自己页面或未发布页面返回 404 |
| `POST /w/:wallId/p/:pageId/contact` | 墙内有效成员 | `hookId` 或 `contactHookId`；只返回发布快照中公开的联系方式和开场白；未公开时返回 404 |
| `GET /w/:wallId/me` | 页面主人 | 创作工作区：Agent 指令、连接状态、版本列表（含校验结果）、版本预览、发布确认 |
| `POST /w/:wallId/me/instruction` | 页面主人 | 生成新的一次性 token 与指令（旧的未使用 token 作废） |
| `POST /w/:wallId/me/disconnect` | 页面主人 | 吊销页面凭证 |
| `POST /w/:wallId/me/publish` | 页面主人 | `revisionId`、确认后的 `tagline`、`hooks[]`（text/opener）、联系方式、`contactPublic`、确认勾选 → 新 publication（旧的 `superseded`）。也用于“恢复旧版本” |
| `POST /w/:wallId/me/withdraw` | 页面主人 | 撤下 |
| `POST /w/:wallId/me/public-link` | 页面主人 | `enabled=1/0`；开启生成新链接，关闭立即使旧链接失效 |
| `POST /w/:wallId/me/delete` | 页面主人 | 先展示影响范围确认页，确认后删除所有版本文件与发布，保留成员关系 |
| `POST /w/:wallId/leave` | 成员（组织者除外） | 退出墙：撤下页面、吊销凭证 |
| `GET /w/:wallId/admin` | 组织者 | 邀请链接与二维码、完成度与提醒、必答题、墙的群像、成员列表（昵称、加入时间、发布状态、必答题的回答）、移除、关闭墙（第 19 节） |
| `GET/POST /w/:wallId/questions`、`POST /w/:wallId/admin/questions`、`/admin/remind`、`/admin/portrait`、`GET /w/:wallId/admin/members.csv`、`POST /account/notifications` | 见 19.6 | 组织者工具 |
| `POST /w/:wallId/admin/remove`、`POST /w/:wallId/admin/close` | 组织者 | 移除成员（其页面立即下墙、凭证吊销）；关闭墙 |
| `GET /s/:publicToken` | 任何人 | 公开链接：只显示当前发布版本的页面，不显示联系方式与“想聊这个” |
| `GET /w/:wallId/covers/:pageId.png` | 墙内有效成员 | 已发布版本的封面图 |
| `GET /account/credits` 等 | 见 12.6 | 点数、兑换码、墙额度 |
| `GET /healthz`、`GET /readyz` | 任何人（不经过 Host 校验） | 健康检查（10.5） |

无权访问时一律返回 `404`（不暴露墙或页面是否存在）；未登录访问需登录的页面重定向到 `/login?next=...`。

## 4.2.1 墙内聊天（2026-11-07）

本次需求替代原“不提供站内聊天”的范围限制。共享类型与常量见 `packages/contracts/src/chat.ts`。主站 cookie 认证；聊天接口位于 `/messages`，不改变 `/api/agent` 的凭证认证。

每墙自动拥有唯一全员群，迁移 `005_chat.sql` 回填已有墙，新墙在创建事务内建群。群成员实时取墙内 `active` 成员，无独立群成员状态。私聊双方必须都是同墙有效成员，且只有双方可读写；组织者无额外权限。退出、移除后该用户不能读取该墙会话、历史、摘要、未读数或继续发送；墙关闭后所有人不可访问。私聊任一方成员关系失效后，该私聊不可访问。公开链接与页面沙箱不提供聊天数据。

| 路由 | 输入 | 返回 |
| --- | --- | --- |
| `GET /messages` | 可选 `before=<lastSequence>:<conversationId>` | 会话列表页面；每页 50 个 |
| `GET /messages/list` | 可选 `before`（同上）与 `limit`（50–500 的整数，缺省 50；客户端展开更多会话后，轮询用它覆盖已展开的部分） | `{conversations: ConversationSummary[], hasMore}`；按最后消息序号倒序、ID 倒序排列；摘要正文最多 100 字符；参数不合法返回 400 |
| `GET /messages/unread` | 无 | `{unread: number}`，仅计有权访问会话中的他人未读消息 |
| `GET /messages/wall/:wallId` | 无 | 303 进入墙内全员群 |
| `POST /messages/direct` | 表单 `_csrf, wallId, userId` | 幂等创建或复用私聊，303 进入会话；不允许自己与自己聊天 |
| `GET /messages/:id` | 可选 `pageId, hookId` | 聊天页面；仅从当前会话对方在该墙的有效发布快照解析开场白，作为未发送草稿 |
| `GET /messages/:id/items` | 可选 `before` 或 `after`，不能同时使用 | `{messages: ChatMessage[], hasMore}`；每页最多 50 条，响应内按 sequence 升序排列；默认最近 50 条，before 取更早消息，after 取之后最早一批消息 |
| `POST /messages/:id/send` | 表单 `_csrf, clientId, text` | `Accept: application/json` 时返回 `{message: ChatMessage}`；普通表单成功 303 返回会话；失败保留草稿 |
| `POST /messages/:id/read` | 表单 `_csrf, sequence` | `{ok:true}`；序号必须为 0 或属于该会话的真实消息，不能倒退 |

`ConversationSummary`：`id, wallId, wallName, kind, title, unread, lastSequence, lastText, lastAt`。`ChatMessage`：`sequence, conversationId, senderId, senderName, clientId, text, createdAt`，不包含邮箱、私密联系方式或页面创作数据。序号为非负安全整数，不接受负数、浮点或超过安全整数范围的游标。

`text` 统一换行并去除首尾空白后须为 1–2000 个 Unicode 码点，拒绝控制字符（允许换行与制表符）。`clientId` 为 16–100 位字母、数字、下划线或短横线；相同会话、发送者与标识重试返回原消息，正文不一致返回 409。所有 POST 沿用同源、会话和 CSRF 校验、64KB 主站请求体上限。JSON 数据读取未登录返回 401；来源或 CSRF 错误 403；无权访问与不存在统一 404；字段或游标无效 400。认证中间件的错误响应沿用主站错误页，其余聊天数据接口错误返回 `{error:string}`；客户端按状态码处理认证失败。

会话与消息列表每 2500ms 增量轮询；导航未读总数最多每 30 秒请求一次。隐藏时暂停、恢复后从上次序号补齐，hasMore 时连续取下一批；401 / 403 / 404 停止轮询；不依赖整页刷新。只有页面可见、有焦点且滚动到消息底部时标记已读。阅读旧消息时不抢滚动位置。消息在 SSR 中转义，客户端使用 textContent，不执行 HTML；脚本和样式为同源静态资源，不改变 iframe 沙箱或 CSP。动态数据响应均 `no-store`。

## 4.2.2 本地评审演示例外

仅服务端演示启动器可显式启用，配置必须绑定演示数据目录，生产与普通 `pnpm dev` 不开放。`POST /login/demo` 检查来源，字段只接受固定的 `identity=member|organizer`，分别映射已有 `newbie@demo.nowme.test` 和 `organizer@demo.nowme.test`，创建正常服务端会话；切换销毁当前会话，两个身份登录后均进入首页，首页不展示身份切换卡片；需要时从顶部“切换身份”进入选择页。邮箱验证码路径与会话加载同样禁止登录背景人物。S1–S8 与组织者权限保持不变。

评审模式允许维护者在启动时将自己的真实模型配置通过现有账号加密机制预置给体验成员，费用由演示提供者承担；体验身份不可通过 AI 设置界面或 HTTP 接口改写、删除预置配置。只在演示启动读取专属环境变量，预置配置不作为普通账号的回退（普通账号的平台 AI 只由 `NOWME_PLATFORM_*` 决定，第 12 节），演示不接受假模型；演示模式没有点数页面。完整流程与配置见 演示说明（已从仓库删除，见标签 `hackathon-2026` 中的 docs/demo.md） 与 [hosted-route.md 第 8 节](../hosted-route.md#8-演示数据与评审模式)。

## 4.2.3 同墙成员头像展示

`GET /w/:wallId/members/:userId/avatar` 仅向该墙有效成员返回另一位有效成员的账号头像；墙关闭、任意一方退出或被移除、目标无头像均返回 404。返回 `image/webp`、`private, no-store` 和 `nosniff`，不返回邮箱、画像或 brief。聊天摘要可含 `avatarUrl`，消息可含 `senderAvatarUrl`，组织者成员列表可含头像地址；客户端轮询与服务端初始渲染均展示头像，无头像继续显示原占位。账号头像是同圈可见的身份信息，账号资料与私密采访内容仍由原授权规则保护。资料与头像的上传规则见 3.1。

## 4.3 Agent 指令格式（W05）

```
/nowme-page wal_xxx nmt_xxx --server http://localhost:3000
```

工作区同时显示一段等价的纯文本说明，给不支持 Skill 的 Agent（第 0 步让它按公开 GitHub 仓库的 `install.md` 下载工具包，用里面的单文件 CLI，不需要装成 Skill）。工作区还始终显示「安装 NOWMe Skill」（4.5）：让 Agent 自己安装的一句话、重开会话、自检方法、`Unknown command` 的原因与解决办法；这块说明里没有 token，没连接过且没有版本时默认展开。已连接时连接状态显示 CLI 自报的 Skill 版本，落后于主站分发的版本时提示更新。token 有效期 [原型默认] 72 小时（覆盖“现场拿到、当晚执行”），`NOWME_AGENT_TOKEN_TTL_HOURS` 可调。

## 4.4 页面托管（`apps/pages-host`）

| 路径 | 说明 |
| --- | --- |
| `GET /v/:ticket/` 与 `GET /v/:ticket/index.html` | 返回该版本的 `served/index.html` |
| `GET /v/:ticket/assets/*`、`GET /v/:ticket/_fonts/*` | 该版本的图片与字体子集 |
| `GET /_nowme/kit/v1/*` | Kit 静态文件（公开） |
| 其他 | `404`；非 GET/HEAD 返回 `405` |

`/v/:ticket`（无结尾斜杠）`308` 重定向到 `/v/:ticket/`。页面、图片、字体响应 `Cache-Control: no-store`；Kit `public, max-age=300`。

**票据**：`<revisionId>.<expUnix>.<sig>`，`sig = base64url(HMAC-SHA256(secret, "<revisionId>.<expUnix>"))`，有效期 [原型默认] 30 分钟；共享密钥 `NOWME_TICKET_SECRET`（开发默认读写 `.data/secret`）。主站只在授权检查通过后签发：主人 → 自己页面的任意 `accepted` 版本；墙内有效成员 → 当前发布版本；公开链接 → 当前发布版本。签发与校验函数在 `packages/contracts`，两边共用。

## 4.5 Skill 分发（T3.6）

真实用户手里没有本仓库：Skill 源码留在 NOWMe 主仓库 `skill/`，完整成品同步到公开仓库 `https://github.com/axiom-wang/nowme-skill`。GitHub Releases 提供带版本号的归档与清单；默认安装命令为 `npx skills add axiom-wang/nowme-skill --skill nowme-page -g`。包里自带单文件 CLI（1.5），无需获取主项目。安装提示与纯文本说明使用 GitHub 上的 `install.md`，不会把 localhost 当成下载地址；主站 `/skill` 保留说明入口，本地归档路由只作为离线镜像。

| 路径 | 认证 | 内容 |
| --- | --- | --- |
| `GET /skill` | 无 | 给人看的安装页：让 Agent 自己安装的一句话（推荐）、市场渠道（配置了才显示）、手动下载与 sha256、重开会话、自检、不支持 Skill 时怎么办、常见问题 |
| `GET /skill/install.md` | 无 | 给 Agent 读的安装说明（`text/markdown`，`max-age=300`）：下载 → 核对 sha256 → 解压 → 以 `nowme-page` 为目录名放进**它自己的用户级 Skill 目录**（不确定就问用户，不要猜）→ 提醒重开会话 → `node <目录>/scripts/nowme.mjs --version` 自检 |
| `GET /skill/manifest.json` | 无 | `{ name: "nowme-page", version, file, sha256, bytes, minNode, url }`（`max-age=300`） |
| `GET /skill/nowme-page-<version>.tar.gz` | 无 | Skill 包（`application/gzip`，`max-age=31536000, immutable`）；文件名不对 `404` |

- **Skill 包**：`pnpm --filter @nowme/skill pack:skill` 打到 `skill/dist-package/`（`build` 与主站 `dev` / `start:source` 会先打包）。只含 `SKILL.md`、`reference/`、`scenes/`、`templates/`、`examples/` 与 `scripts/nowme.mjs`；根目录 `nowme-page/`；ustar + gzip，可复现（排序、固定时间戳）；打包时发现 token / 凭证样式的字符串就失败。主站启动时读取并核对 sha256，不一致或没有打包时本地 manifest/归档不可用，但页面仍提供公开 GitHub 安装入口。manifest 中的 `url` 指向 GitHub 对应版本的 Release 下载地址。
- **发布**：`pnpm --filter @nowme/skill publish:github --out <空目录>` 仅导出成品供检查；加 `--publish` 会自动构建、同步公开仓库、推送 `v<版本>` 标签并创建 Release（归档 + manifest）。仅导出打包白名单与生成的 README/install.md/manifest，不复制主项目或本机配置。已有版本拒绝覆盖；更新时先同步修改三个 Skill 版本位置。公开仓库是生成物，不手工维护第二份源码。
- **跨电脑连接**：Skill 下载不依赖 NOWMe 服务；运行 fetch/preview/submit 仍需要可访问的 `--server`。localhost 仅指当前电脑；主站部署见第 17 节与 [deploy.md](../deploy.md)。
- **版本**：`skill/package.json` 的 `version` = `SKILL_VERSION` = SKILL.md 里写的“Skill 版本”（测试保证一致）。
- **通用写法**：安装页、install.md、工作区都不写具体 Agent 的名字和 Skill 目录。
- **市场渠道**：`NOWME_SKILL_MARKET_LABEL` 与 `NOWME_SKILL_MARKET_COMMAND`（同时设置或都不设，一行、长度有上限）配置后，安装页与 install.md 多显示一种安装方式。
- **不含秘密**：这些路由与工作区的安装说明里没有任何 token 或凭证（安全测试守住）。
