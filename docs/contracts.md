# NOWMe 接口约定（本地路线 + 平台托管路线）

> 本文是所有模块共同遵守的契约：页面输出契约、数据模型、API、校验规则、安全不变量。
> 需求来源：[MVP 需求](product-mvp-community-wall.md)、[页面生成方案](page-generation-byo-agent.md)、[信息收集与 brief](brief-collection.md)。
> 范围：原型试跑的**本地路线**，以及平台托管路线的应用内采访、托管生成、应用内修改与账号 AI 配置（第 9 节，正文见 [hosted-route.md](hosted-route.md)）；部署与加固（第 10 节）、“和 TA 聊什么”（第 11 节）、点数与平台 AI（第 12 节）；派生（W18）不做。
> 修改本文需要总规划师同意；实现与本文冲突时，以本文为准并提出修改建议。
> 文中标 **[原型默认]** 的数值是需求文档里 [待定] 项的临时取值，统一放在 `packages/contracts` 的常量里，便于以后调整。

## 0. 技术基线

| 项 | 约定 |
| --- | --- |
| 运行时 | Node 22，TypeScript（ESM，`"type": "module"`，strict），pnpm workspace |
| 测试 | vitest（单元、集成）；Playwright（浏览器行为、渲染、e2e），使用本机已缓存的 Chromium |
| 主站 `apps/web` | Hono + `@hono/node-server`，服务端渲染（`hono/jsx`），原生 CSS，少量原生客户端 JS；中文界面，移动端优先 |
| 数据库 | SQLite（优先 `node:sqlite`，M0 验证在 vitest 下可用，否则用 `better-sqlite3`），SQL 迁移文件 |
| 页面托管 `apps/pages-host` | 独立源，只做静态托管 + 票据校验 + 安全响应头，不读主站 cookie、不连数据库；本地统一启动时与主站共用一个进程，也保留单独启动能力 |
| 本地数据 | `NOWME_DATA_DIR`（默认仓库根 `.data/`）：`db.sqlite`、`revisions/<revisionId>/`、`outbox.log`、`secret` |

### 0.1 源（origin）[原型默认]

| 用途 | 默认值 | 环境变量 |
| --- | --- | --- |
| 主站 | `http://localhost:3000` | `NOWME_WEB_ORIGIN` |
| 页面托管 | `http://127.0.0.1:4000` | `NOWME_PAGES_ORIGIN` |
| CLI 预览外壳 / 页面 | `http://localhost:4100` / `http://127.0.0.1:4101` | `nowme preview --port` |

主站和页面托管故意使用 `localhost` 与 `127.0.0.1` 两个不同的**站点**（cookie 不按端口隔离，同主机不同端口会共享 cookie）。

源是对外地址；进程默认监听源里的主机与端口，部署在反向代理之后时用 `NOWME_WEB_LISTEN` / `NOWME_PAGES_LISTEN` 单独指定（10.1）。

### 0.2 模块与目录归属

| 目录 | 内容 | 依赖 |
| --- | --- | --- |
| `packages/contracts` | 本文的类型、zod schema、常量、错误码；安全原语：票据签发/校验、页面 CSP 构造、沙箱属性常量 | 无 |
| `packages/validator` | 页面静态校验（纯函数，不碰浏览器、不碰网络） | contracts |
| `packages/kit` | NOWMe Kit：`nowme.css`、`nowme.js`、组件、`fonts.json`、字体下载脚本 | contracts |
| `packages/render` | 无头渲染（Playwright）、截图、渲染后文字提取、CSP 违规检测、字体子集化、本地双源预览服务器；入口 `buildRevision()`（`mode: 'submit' \| 'preview'`）、`createRenderer()` | contracts, validator, kit |
| `packages/cli` | `nowme` 命令行：fetch / validate / preview / submit / status / event | contracts, validator, render |
| `skill/` | `SKILL.md`、场景指南 JSON、brief 与画像模板、自查清单、示例页 | （内容，引用 kit 的类名与 API） |
| `apps/pages-host` | 用户页面托管 | contracts, kit |
| `apps/web` | 主站：登录、墙、邀请、创作工作区、发布、浏览、想聊这个、组织者后台、Agent API | contracts, validator, render |

## 1. 页面输出契约（`page/` 目录）

```
page/
├── index.html      # 必需。自包含单文件，HTML/CSS/JS 内联
├── card.json       # 必需。缩略卡
├── manifest.json   # 必需。版本与声明
├── cover.png       # 可选。缺省时由 preview / 平台截图生成
└── assets/         # 可选。页面用到的图片
```

只有上面这些路径会被提交；`page/` 里的其他文件（例如 `brief.md`、草稿）校验时给警告，**提交时不上传**。

### 1.1 `index.html`

- 必须有 `<!doctype html>`、`<meta charset="utf-8">`、`<meta name="viewport" content="width=device-width, ...">`；建议 `<html lang="zh-CN">`。
- 体积 ≤ **300 KB**（307 200 字节，含内联 base64 图片，不含 `assets/` 与字体）。
- 只能引用：
  - 相对路径 `assets/<file>`；
  - Kit：`/_nowme/kit/v1/nowme.css`、`/_nowme/kit/v1/nowme.js` 及 `/_nowme/kit/v1/` 下其他文件（以根路径引用）；
  - `data:image/*` 图片、页内锚点 `#...`、运行时生成的 `blob:`。
- 外部链接**只能**通过 Kit：元素属性 `data-nm-href="https://..."`（Kit 自动绑定点击）或脚本调用 `nowme.openLink("https://...")`。只允许 `https:`。
- 主要区块带稳定标识 `data-nm-id`：至少 **3** 个，值匹配 `^[a-z][a-z0-9-]{0,39}$`，页面内唯一。
- 动效与 `prefers-reduced-motion`：
  - `nowme.css` 内置全局规则：`@media (prefers-reduced-motion: reduce)` 下关闭所有 CSS `animation` 与 `transition`。因此**引入了 `nowme.css` 的页面，CSS 动效视为已处理**。
  - 没有引入 `nowme.css` 而使用 CSS 动效（`@keyframes`、`animation`、`transition`）时，页面自己必须写 `prefers-reduced-motion` 媒体查询。
  - 脚本动效（`requestAnimationFrame`、`.animate(`、Canvas/WebGL 循环）必须检查 `nowme.reducedMotion` 或 `matchMedia('(prefers-reduced-motion: reduce)')`，减少动效时给出静态画面。
- 字体：只按名称选用 Kit 字体清单中的字体，不写 `@font-face`，不内联字体。Kit 为清单中每款字体提供变量 `--nm-font-<fontId>`（例如 `--nm-font-lxgw-wenkai`，值为该字体 family 名加系统回退）；页面使用该变量或直接写 family 名。Kit 的角色变量 `--nm-font-sans` / `--nm-font-serif` / `--nm-font-mono` / `--nm-font-body` / `--nm-font-display` / `--nm-font-code` / `--nm-font-hand` 默认只指向系统字体栈，不引用清单字体；页面可以把它们改成清单字体（例如 `--nm-font-display: var(--nm-font-lxgw-wenkai)`），校验器通过这类赋值得知用了哪款清单字体。校验器把这些角色变量视为已知，不报 `FONT_NOT_IN_KIT`。
- 移动端优先：以 375px 宽为基准。

### 1.2 `card.json`

```json
{
  "schemaVersion": 1,
  "displayName": "阿柚",
  "tagline": "做过 3 个校园小程序的前端，想找能一起熬夜的设计",
  "hooks": [
    { "id": "help-frontend", "kind": "can-help", "text": "我能帮你把原型变成能点的页面", "opener": "你好！我在墙上看到你说能把原型变成能点的页面，我们队正好缺前端，想聊聊吗？" },
    { "id": "find-designer", "kind": "looking-for", "text": "找会做视觉的队友", "opener": "嗨，我是做设计的，看到你在找会做视觉的队友～" }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `displayName` | 1–24 字符 |
| `tagline` | 1–40 字符，一行介绍 |
| `hooks` | 2–3 个；`id` 匹配 `^[a-z][a-z0-9-]{0,39}$` 且唯一；`text` 2–32 字符；`opener` 1–80 字符（开场白，由 Agent 起草，主人在应用内确认或改写）；`kind` 可选，取场景指南中的接话点类型 |

### 1.3 `manifest.json`

```json
{
  "schemaVersion": 1,
  "sceneType": "hackathon",
  "kitVersion": "1",
  "motionLevel": "medium",
  "fonts": [{ "id": "lxgw-wenkai", "weights": [400] }],
  "extraChars": "",
  "blocks": ["hero", "projects", "teammate"],
  "generator": { "agent": "claude-code", "skillVersion": "0.1.0" }
}
```

| 字段 | 规则 |
| --- | --- |
| `sceneType` | `hackathon` / `interest` / `club` / `general` |
| `kitVersion` | 目前只有 `"1"` |
| `motionLevel` | 三档：`calm` / `medium` / `lively` |
| `fonts` | 只能是 Kit `fonts.json` 中的 `id` 与其支持的字重；**中文字体每个字重计 1 款，合计 ≤ 2** |
| `extraChars` | 脚本动态生成、静态 HTML 中没有的字；`nowme validate` 自动补全 |
| `blocks` | 可选；给出时应与页面中 `data-nm-id` 一致（不一致为警告） |
| `generator` | 可选，自由填写 |

### 1.4 `cover.png` 与 `assets/` [原型默认]

- `cover.png`：PNG，750×1000（375×500 CSS 像素、DPR 2 的首屏截图），≤ 600 KB。
- `assets/`：系统文件（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`）一律忽略、不上传、不报错；其余只允许 `png` / `jpg` / `jpeg` / `webp` / `gif`；文件名匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，最多一层子目录；单个 ≤ 2 MB，合计 ≤ 8 MB，最多 20 个。字体文件、SVG、HTML、脚本一律拒绝（SVG 请内联在 `index.html`）。

### 1.5 本地工作目录与 `nowme` 命令

```
<工作目录>/                 # 主人为这面墙新建的目录，例如 ~/nowme/<墙名>/
├── nowme.json              # 关联信息 { server, wallId, pageId }，不含任何密钥
├── context.json            # nowme fetch 拉取的墙情境（AgentContext）
├── brief.md                # 主人确认后的 brief，只在本地，永不上传
└── page/                   # 第 1 节的输出契约
~/.nowme/profile.md         # 长期画像，只在本地，永不上传
~/.nowme/credentials        # 页面凭证（JSON，按 pageId 索引），目录 0700、文件 0600
```

`~/.nowme` 可用环境变量 `NOWME_HOME` 改到别处（测试与演练用）。

| 命令 | 作用 |
| --- | --- |
| `nowme fetch <wallId> <token> [--server URL]` | 用一次性 token 换取页面凭证，写 `nowme.json`、`context.json`、凭证；上报 `fetch` 事件（请求体 `type: "fetch"`，服务端存为 `agent_fetch`） |
| `nowme fetch` | 已有凭证时刷新 `context.json` |
| `nowme validate [dir=page] [--json] [--no-fix]` | 静态校验；默认自动补全 `manifest.extraChars`；有 error 时退出码 1 |
| `nowme preview [dir=page] [--serve] [--cover] [--remote]` | 双源本地沙箱渲染、截图（缺 `cover.png` 或带 `--cover` 时写入 750×1000 封面）、渲染检查、字体子集化；`--serve` 保持服务器供主人在浏览器中查看；`--remote` 改由服务端渲染（`POST /api/agent/previews`，产物写在同样的位置） |
| `nowme submit [dir=page]` | 先本地校验，再只上传白名单文件；打印版本号、校验结果与工作区链接，并提醒“发布需要你在应用内确认” |
| `nowme status` | 显示关联的墙、页面、凭证是否存在（不显示凭证内容） |
| `nowme event <type>` | 供 Skill 上报 `generate` 等事件，只带数字/布尔属性 |

所有命令默认输出中文的人类可读文本，`--json` 输出机器可读结果。凭证永远不打印完整内容。

**两种分发形式**（4.5）：

- 源码 / `dist/`（NOWMe 开发者在仓库里运行）：完整命令，`preview` 默认本机 Playwright 渲染；`nowme --version` 输出 `nowme <版本>（源码方式运行）`。
- 随 Skill 包分发的单文件 `scripts/nowme.mjs`（真实用户；`@nowme/cli/bundle` 用 esbuild 打出，只需要 Node ≥ 22.13）：不含 Playwright，`preview` 一律由服务端渲染；校验用 `context.json` 里的 `kit.fonts`（包里没有 fonts.json，没有 context.json 时提示先 fetch）；`--version` 输出 `nowme <CLI 版本> · NOWMe Skill <Skill 版本>`；exchange 时自报版本（4.1），`fetch` 发现 `context.skill.version` 更新时提示主人更新（只提示，不报错）。

## 2. 校验规则（`packages/validator`）

### 2.1 接口

```ts
type PageFiles = Map<string, Uint8Array>;           // key 为 page/ 内的相对路径，用 "/" 分隔
interface ValidationIssue {
  code: string;                // 见 2.2，大写蛇形
  severity: 'error' | 'warning';
  file: string;                // 例如 "index.html"
  line?: number;               // 1 起
  message: string;             // 中文：哪里有什么问题
  hint: string;                // 中文：怎么修（W19：给出修复指引或替代方案）
}
interface ValidationReport {
  ok: boolean;                 // 没有 error 即为 true
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: {
    indexHtmlBytes: number; assetBytes: number; assetCount: number;
    blocks: string[]; fontsUsed: string[]; cjkFontCount: number;
    scriptOnlyChars: string;   // 脚本字符串里出现、静态文本里没有的中文字符
    ignoredFiles: string[];    // 不会上传的文件
  };
  validatorVersion: string;
}
validatePage(files: PageFiles, opts?: { kitFonts?: KitFont[] }): ValidationReport;  // 纯函数，服务端复用；kitFonts 由调用方从 @nowme/kit 传入
computeExtraChars(files: PageFiles): string;                                        // 供 nowme validate 自动补全 manifest.extraChars
readPageDir(dir: string): Promise<PageFiles>;                                         // node 辅助
```

静态校验是**尽早发现问题**的手段，真正的安全边界是第 5 节的沙箱与 CSP；校验宁可多报警告，也不能因启发式误判放过明确违规。

### 2.2 规则与错误码

| 码 | 级别 | 规则 |
| --- | --- | --- |
| `MISSING_FILE` | error | 缺 `index.html` / `card.json` / `manifest.json` |
| `HTML_TOO_LARGE` | error | `index.html` > 300 KB |
| `HTML_MISSING_VIEWPORT` / `HTML_MISSING_CHARSET` / `HTML_MISSING_DOCTYPE` | error | 见 1.1 |
| `HTML_MISSING_LANG` | warning | 缺 `lang` |
| `EXTERNAL_RESOURCE` | error | 资源属性（`src`、`href`、`srcset`、`poster`、`background`、`xlink:href`、`data`、`action`、`formaction`）或 CSS `url()` / `@import` 中出现 `http:`、`https:`、`//`、`ws:`、`file:` 等非允许引用 |
| `FORBIDDEN_LINK_HREF` | error | `<a href>` 不是 `#...`（外链请用 `data-nm-href` 或 `nowme.openLink`） |
| `INSECURE_OPEN_LINK` | error | `data-nm-href` / `openLink` 的地址不是 `https:` |
| `EXTERNAL_URL_IN_SCRIPT` | warning | 脚本字符串中有 `http(s)://`，且不在 `nowme.openLink(...)` 的参数里 |
| `FORBIDDEN_ELEMENT` | error | `<form>`、`<iframe>`、`<frame>`、`<object>`、`<embed>`、`<base>`、`<portal>`、`<meta http-equiv="refresh">`；`<link>` 除指向 Kit 的 `rel=stylesheet` 外一律禁止；`<script src>` 只能指向 Kit |
| `FORBIDDEN_API` | error | 脚本（含 `on*` 属性）中出现：`fetch(`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`、`RTCPeerConnection`、`WebTransport`、`localStorage`、`sessionStorage`、`indexedDB`、`caches.`、`document.cookie`、`cookieStore`、`window.open`、`window.top`、`top.location`、`parent.location`、`location.href =`、`location.assign`、`location.replace`、`serviceWorker`、`importScripts`、`new Worker`、`new SharedWorker`、动态 `import(`、`eval(`、`new Function`、`setTimeout("..."`、`getUserMedia`、`geolocation` |
| `JS_SYNTAX_ERROR` | error | 内联脚本无法解析 |
| `NM_ID_TOO_FEW` / `NM_ID_INVALID` / `NM_ID_DUPLICATE` | error | 见 1.1 |
| `NM_BLOCKS_MISMATCH` | warning | `manifest.blocks` 与页面 `data-nm-id` 不一致 |
| `MOTION_WITHOUT_REDUCED` | error | 按 1.1 的动效规则未处理 `prefers-reduced-motion`（没引入 `nowme.css` 的 CSS 动效；或脚本动效没有检查 `nowme.reducedMotion` / `prefers-reduced-motion`） |
| `FONT_FACE_FORBIDDEN` | error | 出现 `@font-face`、字体 data URI |
| `FONT_UNDECLARED` | error | 用了 Kit 字体但 `manifest.fonts` 未声明 |
| `FONT_NOT_IN_KIT` | warning | `font-family` 中出现既非 Kit 字体、也非通用族名 / 常见系统字体的名字（会回退到系统字体） |
| `FONT_TOO_MANY_CJK` | error | 中文字体字重合计 > 2 |
| `FONT_UNKNOWN` | error | `manifest.fonts` 中的 id 或字重不在 Kit 清单里 |
| `EXTRA_CHARS_MISSING` | warning | 脚本中的中文字符不在静态文本或 `extraChars` 中（`nowme validate` 会自动补全） |
| `CARD_INVALID` / `MANIFEST_INVALID` | error | JSON 解析失败或不符合 1.2 / 1.3 |
| `COVER_INVALID` | error | 不是 PNG、尺寸不对或超过体积 |
| `ASSET_TYPE_FORBIDDEN` / `ASSET_TOO_LARGE` / `ASSETS_TOO_MANY` / `ASSET_NAME_INVALID` | error | 见 1.4 |
| `ASSET_MISSING` | error | `index.html` 引用了不存在的 `assets/` 文件 |
| `ASSET_UNUSED` | warning | `assets/` 里有未被引用的文件 |
| `CREDENTIAL_LEAK` | error | 任意文件中出现形如 `nm[ct]_[A-Za-z0-9_-]{16,}` 的凭证，或出现名为 `credentials` 的文件 |
| `IGNORED_FILE` | warning | 不在 1 节白名单中的文件（不会上传） |

### 2.3 服务端额外检查（渲染阶段，`packages/render`）

| 码 | 级别 | 规则 |
| --- | --- | --- |
| `RENDER_SCRIPT_ERROR` | error | 渲染时出现未捕获异常 |
| `RENDER_CSP_VIOLATION` | error | 渲染时出现 `securitypolicyviolation` |
| `RENDER_CONSOLE_ERROR` | warning | `console.error` |
| `RENDER_SLOW` | warning | 375×667 视口下 `load` 超过 3000 ms [原型默认] |
| `RENDER_BLANK` | warning | 渲染后文字为空 |
| `RENDER_FAILED` | error | 渲染超时（10 s）或浏览器崩溃 |

## 3. 数据模型（SQLite）

ID 一律为 `<前缀>_<16 字节随机 base32 小写>`；时间为 ISO 8601 UTC 字符串。一次性 token、页面凭证、会话令牌、登录验证码、兑换码（第 12 节）**只存 SHA-256 哈希**；邀请码与公开链接令牌是需要反复展示给组织者/主人的可分享链接，明文保存，可随时轮换。

| 令牌 | 格式 |
| --- | --- |
| 一次性 token | `nmt_` + 32 字节 base64url |
| 页面凭证 | `nmc_` + 32 字节 base64url |
| 会话令牌 | `nms_` + 32 字节 base64url |
| 邀请码 | `inv_` + 16 字节 base32 小写 |
| 公开链接令牌 | `pub_` + 24 字节 base64url（注意与 publication ID 前缀区分：publication ID 用 `pbl_`） |

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `users` | `id usr_`、`email` 唯一（小写）、`nickname`、`avatar_webp`、`avatar_version`、`created_at` | 首次登录时填写昵称；资料页可修改昵称和头像，头像只存重编码后的 WebP |
| `login_codes` | `id`、`email`、`code_hash`、`attempts`、`expires_at`、`used_at` | 6 位数字，10 分钟，最多 5 次尝试 |
| `sessions` | `id`（会话令牌哈希）、`user_id`、`csrf_token`、`created_at`、`expires_at` | 30 天 |
| `walls` | `id wal_`、`name`、`description`、`scene_type`、`organizer_note`、`organizer_id`、`invite_code`、`status open\|closed`、`created_at`、`closed_at` | |
| `wall_covers` | `wall_id` 主键 / 外键、`version`、`image` BLOB、`updated_at` | 组织者设置的墙封面；独立于成员页面的封面，统一重编码为静态 WebP，不保存上传原图或文件名 |
| `memberships` | `id mem_`、`wall_id`、`user_id`、`role organizer\|member`、`status active\|left\|removed`、`joined_at`、`ended_at` | (`wall_id`,`user_id`) 唯一；组织者建墙时自动成为成员 |
| `pages` | `id pg_`、`membership_id` 唯一、`wall_id`、`owner_id`、`contact_channel`、`contact_value`、`contact_public`、`public_token`（空=未开启）、`created_at`、`updated_at` | 加入墙时创建 |
| `agent_tokens` | `id`、`page_id`、`token_hash`、`expires_at`、`used_at`、`created_at` | 一次性 token |
| `page_credentials` | `id`、`page_id`、`credential_hash`、`created_at`、`last_used_at`、`revoked_at`、`client_cli_version`、`client_skill_version`（T3.6，迁移 003：exchange 时 CLI 自报的版本，可空，只用于显示） | 每页同时最多一个有效凭证 |
| `revisions` | `id rev_`、`page_id`、`number`（页内递增）、`source`（`local-agent`）、`credential_id`、`status accepted\|rejected`、`report_json`、`card_json`、`manifest_json`、`rendered_text`、`render_json`、`created_at` | 文件存 `revisions/<id>/`；rejected 版本只存报告 |
| `publications` | `id pbl_`、`page_id`、`revision_id`、`card_json`（主人确认后的）、`contact_json`（发布时快照）、`published_at`、`ended_at`、`end_reason superseded\|withdrawn\|removed\|closed\|deleted` | 不可变快照；每页至多一个 `ended_at IS NULL` |
| `events` | `id evt_`、`type`、`wall_id`、`page_id`、`actor_id`、`props_json`、`created_at` | 只存类型、ID、数值/布尔属性，**不存内容** |
| `conversations` | `id cnv_`、`wall_id`、`kind group\|direct`、`user_a`、`user_b`、`created_at` | 每墙唯一群；私聊用户 ID 排序后与墙组成唯一键；群 ID 复用墙 ID 的随机后缀 |
| `chat_messages` | `sequence` 整数递增主键、`conversation_id`、`sender_id`、`client_id`、`body`、`created_at` | `(conversation_id,sender_id,client_id)` 唯一，消息按 sequence 排序；正文只存纯文字 |
| `chat_reads` | `conversation_id`、`user_id`、`last_sequence` | 联合主键；已读位置仅允许单调前进 |

| `icebreakers` | `id ice_`、`wall_id`、`viewer_id`、`page_id`、`publication_id`、`result_json`、`created_at` | “和 TA 聊什么”的结果，只属于查看者（迁移 `008_icebreakers.sql`，第 11 节） |
| `wall_questions`、`wall_answers`、`wall_reminders`、`wall_portraits`；`users.reminder_emails` | 见 19.5 | 必答题与回答、提醒记录、墙的群像、提醒邮件开关（迁移 `020_organizer_tools.sql`，第 19 节） |
| `credit_balances`、`credit_entries`、`redeem_codes`、`wall_sponsorships` | 见 12.2 | 点数余额、只追加的流水、兑换码哈希、墙额度每人上限（迁移 `009_credits.sql`，第 12 节） |

平台托管路线的表（`user_model_settings`、`profile_entries`、`briefs`、`brief_assets`、`generation_jobs`）见 [hosted-route.md 第 4 节](hosted-route.md)。

页面的展示状态由数据推导：有活跃 publication → `published`；有 publication 历史但当前无 → `withdrawn`；否则 `unpublished`。

`revisions/<id>/` 布局：`original/`（提交的原文件）、`served/index.html`（注入字体 `@font-face` 后的版本）、`served/assets/...`、`served/_fonts/<fontId>-<weight>.woff2`、`cover.png`、`render/full.png`。

### 3.1 账号资料与头像

头像上传接受静态 PNG / JPEG / WebP，按文件魔数识别并实际解码，拒绝 SVG、GIF、多帧图片、损坏图片。单张不超过 2 MB，请求不超过 2 MB + 64 KB，解码不超过 1600 万像素。自动按 EXIF 旋转、居中裁成正方形（最长 256px，小图不放大），重新编码为 WebP 并剥离元数据；不保存原图、文件名或外部图片 URL。删除头像清空位图与版本号。资料卡、主站导航使用当前会话头像，未设置时显示昵称首字；不改写已生成的用户页面或长期画像。

## 4. API

### 4.1 Agent API（CLI 使用，JSON）

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

### 4.2 主站页面与表单（服务端渲染，会话 cookie 认证）

会话：cookie `nowme_session`，`HttpOnly; SameSite=Lax; Path=/`，host-only（不设 `Domain`）。所有改变状态的请求必须是 `POST`，并同时满足：有效会话、表单字段 `_csrf` 与会话一致、`Origin`（或 `Referer`）等于 `NOWME_WEB_ORIGIN`。**这些路由一律忽略 `Authorization` 头**，页面凭证在这里无效。

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
| `GET /w/:wallId/p/:pageId` | 墙内有效成员 | 成员页面（沙箱 iframe）+ 接话点 + “想聊这个”；别人的页面另有“和 TA 聊什么”（第 11 节，路由见 11.5） |
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

### 4.2.1 墙内聊天（2026-11-07）

本次需求替代原“不提供站内聊天”的范围限制。共享类型与常量见 `packages/contracts/src/chat.ts`。主站 cookie 认证；聊天接口位于 `/messages`，不改变 `/api/agent` 的凭证认证。

每墙自动拥有唯一全员群，迁移 `005_chat.sql` 回填已有墙，新墙在创建事务内建群。群成员实时取墙内 `active` 成员，无独立群成员状态。私聊双方必须都是同墙有效成员，且只有双方可读写；组织者无额外权限。退出、移除后该用户不能读取该墙会话、历史、摘要、未读数或继续发送；墙关闭后所有人不可访问。私聊任一方成员关系失效后，该私聊不可访问。公开链接与页面沙箱不提供聊天数据。

| 路由 | 输入 | 返回 |
| --- | --- | --- |
| `GET /messages` | 可选 `before=<lastSequence>:<conversationId>` | 会话列表页面；每页 50 个 |
| `GET /messages/list` | 同上 | `{conversations: ConversationSummary[], hasMore}`；按最后消息序号倒序、ID 倒序排列；摘要正文最多 100 字符 |
| `GET /messages/unread` | 无 | `{unread: number}`，仅计有权访问会话中的他人未读消息 |
| `GET /messages/wall/:wallId` | 无 | 303 进入墙内全员群 |
| `POST /messages/direct` | 表单 `_csrf, wallId, userId` | 幂等创建或复用私聊，303 进入会话；不允许自己与自己聊天 |
| `GET /messages/:id` | 可选 `pageId, hookId` | 聊天页面；仅从当前会话对方在该墙的有效发布快照解析开场白，作为未发送草稿 |
| `GET /messages/:id/items` | 可选 `before` 或 `after`，不能同时使用 | `{messages: ChatMessage[], hasMore}`；每页最多 50 条，响应内按 sequence 升序排列；默认最近 50 条，before 取更早消息，after 取之后最早一批消息 |
| `POST /messages/:id/send` | 表单 `_csrf, clientId, text` | `Accept: application/json` 时返回 `{message: ChatMessage}`；普通表单成功 303 返回会话；失败保留草稿 |
| `POST /messages/:id/read` | 表单 `_csrf, sequence` | `{ok:true}`；序号必须为 0 或属于该会话的真实消息，不能倒退 |

`ConversationSummary`：`id, wallId, wallName, kind, title, unread, lastSequence, lastText, lastAt`。`ChatMessage`：`sequence, conversationId, senderId, senderName, clientId, text, createdAt`，不包含邮箱、私密联系方式或页面创作数据。序号为非负安全整数，不接受负数、浮点或超过安全整数范围的游标。

`text` 统一换行并去除首尾空白后须为 1–2000 个 Unicode 码点，拒绝控制字符（允许换行与制表符）。`clientId` 为 16–100 位字母、数字、下划线或短横线；相同会话、发送者与标识重试返回原消息，正文不一致返回 409。所有 POST 沿用同源、会话和 CSRF 校验、64KB 主站请求体上限。JSON 数据读取未登录返回 401；来源或 CSRF 错误 403；无权访问与不存在统一 404；字段或游标无效 400。认证中间件的错误响应沿用主站错误页，其余聊天数据接口错误返回 `{error:string}`；客户端按状态码处理认证失败。

前端每 2500ms 增量轮询，隐藏时暂停、恢复后从上次序号补齐，hasMore 时连续取下一批；不依赖整页刷新。只有页面可见、有焦点且滚动到消息底部时标记已读。阅读旧消息时不抢滚动位置。消息在 SSR 中转义，客户端使用 textContent，不执行 HTML；脚本和样式为同源静态资源，不改变 iframe 沙箱或 CSP。动态数据响应均 `no-store`。

### 4.2.2 本地评审演示例外

仅服务端演示启动器可显式启用，配置必须绑定演示数据目录，生产与普通 `pnpm dev` 不开放。`POST /login/demo` 检查来源，字段只接受固定的 `identity=member|organizer`，分别映射已有 `newbie@demo.nowme.test` 和 `organizer@demo.nowme.test`，创建正常服务端会话；切换销毁当前会话，两个身份登录后均进入首页，首页不展示身份切换卡片；需要时从顶部“切换身份”进入选择页。邮箱验证码路径与会话加载同样禁止登录背景人物。S1–S8 与组织者权限保持不变。

评审模式允许维护者在启动时将自己的真实模型配置通过现有账号加密机制预置给体验成员，费用由演示提供者承担；体验身份不可通过 AI 设置界面或 HTTP 接口改写、删除预置配置。只在演示启动读取专属环境变量，预置配置不作为普通账号的回退（普通账号的平台 AI 只由 `NOWME_PLATFORM_*` 决定，第 12 节），演示不接受假模型；演示模式没有点数页面。完整流程与配置见 演示说明（已从仓库删除，见标签 `hackathon-2026` 中的 docs/demo.md） 与 [hosted-route.md 第 8 节](hosted-route.md#8-演示数据与评审模式)。

### 4.2.3 同墙成员头像展示

`GET /w/:wallId/members/:userId/avatar` 仅向该墙有效成员返回另一位有效成员的账号头像；墙关闭、任意一方退出或被移除、目标无头像均返回 404。返回 `image/webp`、`private, no-store` 和 `nosniff`，不返回邮箱、画像或 brief。聊天摘要可含 `avatarUrl`，消息可含 `senderAvatarUrl`，组织者成员列表可含头像地址；客户端轮询与服务端初始渲染均展示头像，无头像继续显示原占位。账号头像是同圈可见的身份信息，账号资料与私密采访内容仍由原授权规则保护。资料与头像的上传规则见 3.1。

### 4.3 Agent 指令格式（W05）

```
/nowme-page wal_xxx nmt_xxx --server http://localhost:3000
```

工作区同时显示一段等价的纯文本说明，给不支持 Skill 的 Agent（第 0 步让它按公开 GitHub 仓库的 `install.md` 下载工具包，用里面的单文件 CLI，不需要装成 Skill）。工作区还始终显示「安装 NOWMe Skill」（4.5）：让 Agent 自己安装的一句话、重开会话、自检方法、`Unknown command` 的原因与解决办法；这块说明里没有 token，没连接过且没有版本时默认展开。已连接时连接状态显示 CLI 自报的 Skill 版本，落后于主站分发的版本时提示更新。token 有效期 [原型默认] 72 小时（覆盖“现场拿到、当晚执行”），`NOWME_AGENT_TOKEN_TTL_HOURS` 可调。

### 4.4 页面托管（`apps/pages-host`）

| 路径 | 说明 |
| --- | --- |
| `GET /v/:ticket/` 与 `GET /v/:ticket/index.html` | 返回该版本的 `served/index.html` |
| `GET /v/:ticket/assets/*`、`GET /v/:ticket/_fonts/*` | 该版本的图片与字体子集 |
| `GET /_nowme/kit/v1/*` | Kit 静态文件（公开） |
| 其他 | `404`；非 GET/HEAD 返回 `405` |

`/v/:ticket`（无结尾斜杠）`308` 重定向到 `/v/:ticket/`。页面、图片、字体响应 `Cache-Control: no-store`；Kit `public, max-age=300`。

**票据**：`<revisionId>.<expUnix>.<sig>`，`sig = base64url(HMAC-SHA256(secret, "<revisionId>.<expUnix>"))`，有效期 [原型默认] 30 分钟；共享密钥 `NOWME_TICKET_SECRET`（开发默认读写 `.data/secret`）。主站只在授权检查通过后签发：主人 → 自己页面的任意 `accepted` 版本；墙内有效成员 → 当前发布版本；公开链接 → 当前发布版本。签发与校验函数在 `packages/contracts`，两边共用。

### 4.5 Skill 分发（T3.6）

真实用户手里没有本仓库：Skill 源码留在 NOWMe 主仓库 `skill/`，完整成品同步到公开仓库 `https://github.com/axiom-wang/nowme-skill`。GitHub Releases 提供带版本号的归档与清单；默认安装命令为 `npx skills add axiom-wang/nowme-skill --skill nowme-page -g`。包里自带单文件 CLI（1.5），无需获取主项目。安装提示与纯文本说明使用 GitHub 上的 `install.md`，不会把 localhost 当成下载地址；主站 `/skill` 保留说明入口，本地归档路由只作为离线镜像。

| 路径 | 认证 | 内容 |
| --- | --- | --- |
| `GET /skill` | 无 | 给人看的安装页：让 Agent 自己安装的一句话（推荐）、市场渠道（配置了才显示）、手动下载与 sha256、重开会话、自检、不支持 Skill 时怎么办、常见问题 |
| `GET /skill/install.md` | 无 | 给 Agent 读的安装说明（`text/markdown`，`max-age=300`）：下载 → 核对 sha256 → 解压 → 以 `nowme-page` 为目录名放进**它自己的用户级 Skill 目录**（不确定就问用户，不要猜）→ 提醒重开会话 → `node <目录>/scripts/nowme.mjs --version` 自检 |
| `GET /skill/manifest.json` | 无 | `{ name: "nowme-page", version, file, sha256, bytes, minNode, url }`（`max-age=300`） |
| `GET /skill/nowme-page-<version>.tar.gz` | 无 | Skill 包（`application/gzip`，`max-age=31536000, immutable`）；文件名不对 `404` |

- **Skill 包**：`pnpm --filter @nowme/skill pack:skill` 打到 `skill/dist-package/`（`build` 与主站 `dev` / `start:source` 会先打包）。只含 `SKILL.md`、`reference/`、`scenes/`、`templates/`、`examples/` 与 `scripts/nowme.mjs`；根目录 `nowme-page/`；ustar + gzip，可复现（排序、固定时间戳）；打包时发现 token / 凭证样式的字符串就失败。主站启动时读取并核对 sha256，不一致或没有打包时本地 manifest/归档不可用，但页面仍提供公开 GitHub 安装入口。manifest 中的 `url` 指向 GitHub 对应版本的 Release 下载地址。
- **发布**：`pnpm --filter @nowme/skill publish:github --out <空目录>` 仅导出成品供检查；加 `--publish` 会自动构建、同步公开仓库、推送 `v<版本>` 标签并创建 Release（归档 + manifest）。仅导出打包白名单与生成的 README/install.md/manifest，不复制主项目或本机配置。已有版本拒绝覆盖；更新时先同步修改三个 Skill 版本位置。公开仓库是生成物，不手工维护第二份源码。
- **跨电脑连接**：Skill 下载不依赖 NOWMe 服务；运行 fetch/preview/submit 仍需要可访问的 `--server`。localhost 仅指当前电脑；主站部署见第 17 节与 [deploy.md](deploy.md)。
- **版本**：`skill/package.json` 的 `version` = `SKILL_VERSION` = SKILL.md 里写的“Skill 版本”（测试保证一致）。
- **通用写法**：安装页、install.md、工作区都不写具体 Agent 的名字和 Skill 目录。
- **市场渠道**：`NOWME_SKILL_MARKET_LABEL` 与 `NOWME_SKILL_MARKET_COMMAND`（同时设置或都不设，一行、长度有上限）配置后，安装页与 install.md 多显示一种安装方式。
- **不含秘密**：这些路由与工作区的安装说明里没有任何 token 或凭证（安全测试守住）。

## 5. 安全不变量（必须有自动化测试）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S1 | 展示用户页面的 iframe 只有 `sandbox="allow-scripts"`，不含 `allow-same-origin`、`allow-top-navigation*`、`allow-forms`、`allow-popups*`、`allow-modals`；`src` 指向 `NOWME_PAGES_ORIGIN` | 解析所有展示页面的路由（成员页、工作区预览、公开链接）输出的 HTML；**浏览器测试**：恶意页面在 iframe 内尝试读 cookie、`fetch` 主站与外部、`localStorage`、改 `top.location`、提交表单、`window.open`，全部失败，主站 URL 不变，探针服务器收不到请求；iframe 自我导航（`location = 'https://...'`）被主站检测并重置（见 5.2） |
| S2 | 页面托管对页面文档返回严格 CSP：`default-src 'none'`；`script-src 'unsafe-inline' <pages>/_nowme/kit/`；`style-src 'unsafe-inline' <pages>/_nowme/kit/`；`img-src <pages>/v/<ticket>/assets/ <pages>/_nowme/kit/ data: blob:`；`media-src` 同 `img-src`；`font-src <pages>/v/<ticket>/_fonts/`；`connect-src 'none'`；`form-action 'none'`；`base-uri 'none'`；`frame-ancestors <web>`（预览时为预览外壳源）；`sandbox allow-scripts`；无 `'unsafe-eval'`。字体子集响应（`/v/<ticket>/_fonts/*`）必须带 `Access-Control-Allow-Origin: *`（沙箱文档的源是 `null`，没有 CORS 头时 Chromium 拒绝加载字体）。另加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 禁用摄像头/麦克风/定位等、不设任何 cookie | 对 pages-host 响应头逐项断言；CSP 构造函数单测；渲染管线用同一构造函数 |
| S3 | 一次性 token：只能换取一次；过期无效；只对签发它的那一页、那一面墙有效；换取后该页旧凭证全部失效；数据库只存哈希 | API 集成测试覆盖每一条 |
| S4 | 页面凭证不能发布：凭证调用发布、恢复、撤下、公开链接、删除、组织者操作等任何主站路由都无效且不改变状态；凭证不能当会话用；凭证不写进 `page/`、不随提交上传；校验器拦截凭证字符串 | 用凭证逐个调用所有改变状态的主站路由并断言数据库无变化；CLI 测试断言 `page/` 中无凭证、上传内容无凭证 |
| S5 | 组织者看不到私密内容：组织者后台只有昵称、加入时间、发布状态，以及成员自己在墙内公开回答的必答题（第 19 节）；组织者无法访问他人的工作区、版本、未发布内容、未公开的联系方式；本地路线的 brief / 画像从不上传 | 组织者身份请求他人工作区、版本预览、票据签发 → 404；后台 HTML 不含版本 ID、未发布 card 内容、私密联系方式；提交接口丢弃白名单外文件 |
| S6 | 非成员看不到墙：未登录、非成员、已退出、已移除的用户访问墙、成员页、封面、chat 接口都拿不到内容；pages-host 无票据、票据伪造、过期、篡改版本 ID 时拒绝；被移除成员立即失去访问且其页面立即下墙；关闭的墙对所有人不可见；关闭公开链接后旧链接失效 | 集成测试覆盖每种身份 × 每个路由；pages-host 票据测试 |

S7、S8（第 9 节）、S9（第 11 节）、S10（第 12 节）与 S1–S6 同等要求自动化测试。

主站自身也设 CSP：`default-src 'self'`、`frame-src <pages>`、`script-src 'self'`、`style-src 'self'`、`img-src 'self' data:`、`form-action 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`（主站不用内联脚本和内联样式）。主站校验 `Host` 头：不等于 `NOWME_WEB_ORIGIN` 的主机时返回 421 或重定向到 `NOWME_WEB_ORIGIN`（cookie 不按端口隔离，不能让主站在页面托管的主机名下签发 cookie）。主站的其他安全头见 10.4。

### 5.1 `nowme.openLink` 协议

Kit 调用 `parent.postMessage({ type: 'nowme:open-link', url }, '*')`。主站监听时校验 `event.source === iframe.contentWindow`、`url` 为 `https:`，弹出确认（显示目标域名），用户确认后 `window.open(url, '_blank', 'noopener,noreferrer')`。其他消息一律忽略。

### 5.2 iframe 自我导航

沙箱允许 iframe 导航它自己，CSP 也不管导航，所以页面脚本运行时拼出的 `location = '...'` 能把 iframe 带到外部网站（钓鱼、记录访客 IP）。主站展示页面时监听 iframe 的 `load` 事件：第一次加载之后再次触发 `load`，即视为页面自我导航，立即把 `src` 重置为空白页并在 iframe 外提示“这个页面试图跳转，已拦截”。需要浏览器测试覆盖。

## 6. 事件（W20）

| 来源 | 类型 |
| --- | --- |
| CLI（凭证上报，不含内容） | `agent_fetch`、`agent_validate`、`agent_preview`、`agent_generate`、`agent_submit` |
| 主站 | `wall_view`、`page_open`、`want_to_chat`、`publish`、`withdraw`、`public_link_on`、`public_link_off`、`join`、`leave`、`member_removed`、`wall_closed`；`remote_preview`（服务端远程预览，用于限流，4.1） |
| 平台托管路线 | `hosted_interview_call`、`hosted_brief_confirm`、`hosted_generate`、`hosted_edit`、`brief_delete`、`profile_delete`（hosted-route 6） |
| 和 TA 聊什么 | `icebreaker_generate`（成功与失败都记，用于限流，11.5）；用开场白开聊记 `want_to_chat`，`props` 含 `ai: true`、`openerIndex` |
| 点数 | `credits_redeem`（`props: { credits }`）、`credits_sponsor`（`props: { credits, memberCap }`），不含兑换码（12.4、12.5） |

`props` 只含数字与布尔值（例如 `ok`、`durationMs`、`errorCount`）。按墙聚合统计由 `pnpm --filter @nowme/web stats <wallId>` 输出；组织者界面不提供个人层面的浏览轨迹。

## 7. 场景指南配置（`skill/scenes/<sceneType>.json`）

每个场景一份，主站与 Skill 读取同一份文件（主站只用 `id`、`label`、`defaults.contactPublic`、`hookKinds`）。

```ts
interface SceneGuide {
  id: SceneType; label: string; goal: string; interviewBudgetSeconds: number;
  assetPrompt: string;
  choiceQuestions: { id: string; question: string; options: string[]; multi: boolean; required: boolean }[];
  followUps: { direction: string; examples: string[] }[]; maxFollowUps: number;
  mustHave: { id: string; description: string }[];
  hookKinds: { kind: string; pattern: string }[];
  defaults: { showSchool: boolean; useNickname: boolean; contactPublic: boolean };
  pageGoal: string; suggestedBlocks: string[]; visualTone: string;
  examples: string[];            // skill/examples/ 下的目录名
}
```

内容取自[信息收集与 brief](brief-collection.md)第 4 节与[页面生成方案](page-generation-byo-agent.md)第 3 节。

## 8. 已采纳的实现细节（T0.2）

- `kitFontSchema` 用 `files`（字重 → 文件名）代替 `file`；授权限 OFL-1.1 / Apache-2.0 / MIT；family 只能是 ASCII；字重为 100–900 整百。
- 其他表的 ID 前缀：`login_codes` 用 `lgc_`、`agent_tokens` 用 `agt_`、`page_credentials` 用 `crd_`。
- 文本长度按 Unicode 码点计算，不能全为空白、不能含控制字符；所有 JSON 对象拒绝未知字段（`manifest.generator` 内部除外）；`manifest.fonts`（可为空数组）与 `extraChars`（可为空字符串）必填。
- 校验器（T1.1）额外拦截：`importmap` / `speculationrules` 脚本、`fencedframe`、`applet`、脚本动态创建的禁用元素、`ping` / `lowsrc` 等资源属性、`navigation.navigate`。`card.json` 中 hook 的 `kind` 不做场景匹配检查（自由文本）。SVG SMIL 动画暂不纳入减少动效规则（已知缺口）。
- API 错误码增加 `INTERNAL_ERROR`（500）；事件 `props` 最多 16 个键；一次提交最多 64 个文件。
- Kit（T1.2）：`fonts.json` 的 `sourceUrl` 要么是以 `/` 结尾的目录地址（文件地址 = `sourceUrl` + 文件名），要么是 `.zip`（按文件名解压）；字体源文件由 `pnpm --filter @nowme/kit fonts:fetch` 下载，不入库。场景指南中“默认勾选”的边界选项暂时写在选项文字里（`（默认勾选）`）。
- 字体子集的取字范围：`index.html` 源码中出现的全部字符（含属性和脚本）+ 渲染后文字 + `manifest.extraChars`。因此 `extraChars` 只需覆盖源码中完全没有出现的字。
- 系统文件（`isSystemFile`，在 `@nowme/validator` 导出）在提交时由 CLI 过滤、服务端丢弃，不算白名单路径。
- 渲染（T1.3）：页面自我导航和被拦截的请求目前归入 `RENDER_CSP_VIOLATION`；主站 CSP 的 `frame-src <pages>` 已能阻止 iframe 跳到外部地址，5.2 的 `load` 检测用于拦截页面源内部的跳转。服务端渲染不要用 Playwright 的 `serviceWorkers: 'block'`（在沙箱文档中会误报脚本异常）。
- 截图前调用 `nowme.revealAll()`，避免首屏以下的 `.nm-reveal` 内容在整页截图中不可见。
- `loadConfig` 拒绝主站与页面托管同主机名、TTL 只接受 1–720 小时、票据密钥至少 32 字符。

## 9. 平台托管路线

正文见 [hosted-route.md](hosted-route.md)（2026-11-07 确认）：配置与模型、应用内采访、使用用户 API 的生成与修改、运行保护限制、加密凭证与数据模型（迁移 `002_hosted.sql` 和 `004_user_models.sql`）、主站路由、事件、安全不变量 S7（托管资料只属于主人）与 S8（生成环境隔离且结果不受信）。S7、S8 与第 5 节的 S1–S6 同等要求自动化测试。平台 AI 与点数（`NOWME_PLATFORM_*`，迁移 `009_credits.sql`）见第 12 节；hosted-route 中“只能用用户自己的 Key”的说法已由第 12 节补充：没有自己配置的用户可以用平台 AI。

## 10. 部署与加固

配置由 `packages/contracts/src/config.ts` 的 `loadConfig()` 读取并校验（取值不合法抛 `ConfigError`，进程退出）；示例与注释见仓库根 `.env.example`。主站与页面托管启动时载入仓库根 `.env`，已在环境中设置的变量优先。

### 10.1 环境变量与生产启动检查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时关闭 `/dev/outbox`、拒绝假模型，并执行下面的启动检查 |
| `NOWME_WEB_ORIGIN` / `NOWME_PAGES_ORIGIN` | 见 0.1 | **对外的源**（用户在浏览器里看到的地址）；两者主机名不能相同 |
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

### 10.2 邮件投递（登录验证码）

| `NOWME_MAIL_TRANSPORT` | 行为 |
| --- | --- |
| `file`（默认） | 写进 `<dataDir>/outbox.log` 并打印到控制台；非生产且非演示时提供 `GET /dev/outbox` |
| `smtp` | 经 `NOWME_SMTP_URL` 真实发送；必须同时设置 `NOWME_MAIL_FROM`（一行，含发件邮箱，≤ 200 字符）；没有 `/dev/outbox`，登录页也不显示开发入口 |

- 连接串：`smtps://用户:密码@主机:465`（隐式 TLS）或 `smtp://用户:密码@主机:587`；用户名密码按 URL 规则百分号编码。`smtp://` 在生产环境强制 STARTTLS。连接池最多 3 个连接，连接 / 问候 / DNS 超时 10 s，套接字 20 s。
- 邮件：主题以验证码开头，正文与 HTML 都只有验证码与有效期，不含链接。
- 日志只记脱敏收件人（`a***@example.com`）与成功 / 失败，失败只记 nodemailer 错误类别（如 `EAUTH`），不记主题、正文、服务器回复原文、连接串。
- 发送失败：刚签发的验证码立即作废（仍计入同邮箱限流），`POST /login` 返回 `503` 与固定中文说明。

### 10.3 来源地址与限流

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

### 10.4 补充安全头

主站所有响应（`apps/web/src/security/headers.ts`）：第 5 节末尾的 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`、`Permissions-Policy`（与页面托管同一份关闭清单 `PERMISSIONS_POLICY`）、`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`；动态响应默认 `Cache-Control: no-store`。主站为 https 源时加 `Strict-Transport-Security: max-age=31536000`（不带 `includeSubDomains` / `preload`），会话 cookie 加 `Secure`。

### 10.5 健康检查

| 路径 | 服务 | 响应 |
| --- | --- | --- |
| `GET /healthz` | 主站、页面托管 | `200 ok`（纯文本） |
| `GET /readyz` | 主站 | 执行 `SELECT 1`：成功 `200 {"status":"ok"}`，失败 `503 {"status":"unavailable"}` |

主站的这两个路由放在 Host 头校验之前（探针常用 IP 访问），不读会话、不设 cookie、不返回业务信息，`Cache-Control: no-store`；其他路径仍做 Host 校验（421）。页面托管的 `/healthz` 不读文件。

容器、编排、备份与日志见第 17 节。

### 10.6 尚未做的事

已做：真实邮件投递（10.2）；收费以点数形式提供（第 12 节，尚未接支付渠道）。M8 进行中：注销与导出（第 14 节）、举报与拉黑（第 15 节）、内容安全与 AI 标识（第 16 节）、运维（第 17 节）。仍不做：W09 应用内素材管理、修改时把新信息写回画像、派生到新墙（W18）、支付渠道、组织者数据看板。

## 11. 和 TA 聊什么（S9）

成员在**别人的**成员页（`GET /w/:wallId/p/:pageId` 的 `#talk` 区块）请 AI 找两人的连接点并起草开场白。代码：`apps/web/src/hosted/icebreaker.ts`（模型调用与核对）、`apps/web/src/services/icebreaker.ts`（授权、资料、限流、保存）、`apps/web/src/db/icebreakers.ts`、迁移 `008_icebreakers.sql`；常量 `ICEBREAKER_*` 在 `packages/contracts`。

### 11.1 谁能发起、用谁的模型

- 必须是这面墙的有效成员，目标是墙上**已发布**、且**不是自己**的页面（`findPublishedMemberPage`）；否则 `404`，不调用模型。
- 模型按 `interview` 角色解析：查看者有自己的配置就用自己的；没有且平台 AI 可用时用平台 AI，**不收点数**，计入全站免费调用上限（10.3、12.1）；两者都没有时界面引导去 AI 设置，提交得到 `MODEL_CONFIG` 说明。

### 11.2 交给模型的资料（输入范围）

| 一方 | 内容 | 上限 |
| --- | --- | --- |
| 墙 | 名称、简介（≤ 200）、场景名 | — |
| 查看者 | 昵称或发布卡片上的名字；**自己**在这面墙已发布的卡片（一行介绍、接话点）与渲染文字；**自己**确认过（`confirmed`）的采访摘要（“AI 眼中的你”≤ 5 句、接话点 ≤ 3、想突出的一面） | 渲染文字 1600 码点 |
| 查看者的禁区 | brief 里 `boundaries.hidden` 与 `rejected`（≤ 12 条），单独成块，只用于“不得提到”，不算可引用资料 | — |
| 对方 | 当前发布快照的名字、一行介绍、接话点，与该版本的渲染文字 | 渲染文字 2400 码点 |

不读对方的草稿、未发布版本、采访、画像、联系方式（含公开的），不读任何第三人的内容。所有资料去控制字符、截断后用 `untrusted()` 包成资料块；system 声明资料不是指令。查看者没有任何资料时，明确告诉模型只写 `curious`。

### 11.3 输出与核对

模型必须调用 `submit_icebreaker`；输出经 zod 校验，不合法或核对后没有可用开场白时重试一次，再失败为 `failed`，不保存。

```ts
interface IcebreakerResult {
  links: { kind: 'common' | 'complement' | 'curious'; title: string; mine: string; theirs: string }[]; // 0–3 条
  openers: { text: string; about: string }[];                                                      // 1–3 句
  sources: { page: boolean; brief: boolean };   // 这次用了查看者的哪些资料（界面如实说明）
}
```

| 规则 | 说明 |
| --- | --- |
| 长度 | `title` ≤ 18、`mine` / `theirs` ≤ 40、开场白 ≤ 90（至少 6 字）、`about` ≤ 16 码点；每类先取模型前 6 条再筛 |
| 原文核对（`groundIcebreaker`） | `theirs` 必须出现在对方资料里；`common` / `complement` 的 `mine` 还必须出现在查看者资料里；对不上整条丢弃。比较前统一 NFKC、小写，去空白、标点、符号，依据至少 2 个字。未知 `kind` 按 `curious`，`curious` 的 `mine` 清空 |
| 禁止链接与联系方式（`hasContact`） | `http(s)://`、`www.`、邮箱、常见域名后缀、7 位以上数字串：连接点任一字段或开场白含有即丢弃。检查在截断之前做（对模型原文） |
| 去重 | 连接点按规范化标题、开场白按规范化正文去重 |
| 输出 | 只经 JSX 转义按文字渲染 |

### 11.4 结果归属、开场白与清除

- 表 `icebreakers`：`id ice_`、`wall_id`、`viewer_id`、`page_id`、`publication_id`、`result_json`、`created_at`。只保存成功的结果；同一查看者对同一页只保留最新一份（“换一批”替换）。
- **只属于查看者**：只按 `viewer_id` 读取；页面主人、组织者、其他成员都看不到；结果 ID 被别人拿到也不能用来开聊或清除。结果绑定对方当时的 `publication_id`：对方更新或撤下发布、ID 用在别的页上，一律视为不存在。
- 墙页上只对查看者自己给“找过话题”的卡片打标记，对方更新发布后消失。
- **只预填、不代发**：“用这句开聊”进入与对方的同墙私聊，把那一句作为未发送草稿放进输入框，不产生任何消息；发送仍由查看者本人完成（4.2.1）。
- 清除：查看者手动清除；对方删除页面（该页的全部结果）；查看者退出墙、被移除（他在这面墙的结果）；墙关闭（整面墙）；查看者删除自己的采访（他在那面墙的结果）。
- 模型调用结束后重新做一次授权检查：期间对方更新 / 撤下、任一方失去访问、墙关闭 → 不保存，返回 `gone`。

### 11.5 路由与限流

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `POST /w/:wallId/p/:pageId/icebreaker` | 墙内有效成员，非自己的已发布页 | 发起或“换一批”；303 回到 `#talk`，失败时带 `?ice=<错误>` |
| `POST /w/:wallId/p/:pageId/icebreaker/chat` | 同上 | `icebreakerId`、`opener`（0–2）；校验结果属于本人、本页、当前发布 → 303 `/messages/:id?pageId=&ice=&o=`；记 `want_to_chat`（`props: { ai: true, openerIndex }`） |
| `POST /w/:wallId/p/:pageId/icebreaker/clear` | 同上 | 清除本人对这一页的结果 |

均为会话 + CSRF + Origin 的表单路由，忽略 `Authorization`。`/messages/:id` 只在会话是与该页主人的私聊、且结果仍有效时解析 `ice` / `o` 草稿。

| 限制 | 取值 | 错误 |
| --- | --- | --- |
| 每位查看者（跨墙） | 40 次 / 滚动 24 小时 | `daily` |
| 同一查看者对同一页（含换一批） | 4 次 / 滚动 24 小时 | `target-daily` |
| 同一查看者并发 | 1 | `busy` |
| 单次总时限 | 60 s | `timeout` |

次数按 `icebreaker_generate` 事件计（成功与失败都记，`props` 只有 `ok`、`durationMs`、`links`、`openers`、`hasPage`、`hasBrief` 与 token 数）。其他错误：`MODEL_CONFIG` / `MODEL_AUTH` / `MODEL_RATE_LIMITED` / `MODEL_UNAVAILABLE`、`failed`、`gone`。界面只显示 `ICEBREAKER_ERROR_TEXT` 里的固定文案，不在名单里的 `ice` 参数不显示任何提示。

### 11.6 S9 不变量（`apps/web/test/security/icebreaker.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S9 | 只把查看者自己的资料和对方已公开在墙上的内容交给模型；结果只属于查看者；连接点的依据必须是两边资料里的原文（服务端核对）；开场白只预填、从不代发；输出里不允许出现链接与联系方式 | 未登录、墙外、自己的页、未发布的页不能发起且不调用模型；凭证 / 缺 CSRF 无效；被移除立即失效；模型请求里没有第三人、对方草稿与联系方式，禁区单独成块；主人、组织者、其他成员看不到结果，别人的结果 ID 不能开聊或清除，不能跨页使用；注入的链接与手机号、编造的共同点进不了结果，标记按文字输出；开聊不产生消息；删除页面、退出、移除、关闭墙、删除采访时结果一并删除；事件只有数字与布尔 |

## 12. 点数与平台 AI（S10）

没有自己模型 Key 的用户可以用平台的 AI。代码：`apps/web/src/hosted/platform-model.ts`、`apps/web/src/services/billing.ts`、`apps/web/src/db/credits.ts`、`apps/web/src/routes/credits.tsx`、`apps/web/scripts/credits.ts`、迁移 `009_credits.sql`；常量在 `packages/contracts`（`REDEEM_*`、`SPONSOR_*`、`CREDIT_HISTORY_LIMIT`）。

### 12.1 平台 AI

- 配置：`NOWME_PLATFORM_PROVIDER`（`model-providers.ts` 的预设之一）设置后开启。生成模型取 `NOWME_PLATFORM_MODEL` 或预设；采访模型取 `NOWME_PLATFORM_INTERVIEW_MODEL`、预设采访模型或生成模型，都没有时配置报错；OpenAI 兼容协议必须有地址（`NOWME_PLATFORM_BASE_URL` 或预设）；`NOWME_PLATFORM_VISION` 只能是 `0` / `1`。
- **Key 只来自 `NOWME_PLATFORM_API_KEY`**：不进配置对象、不入库、不进提示词与工具结果、不写日志、不在任何页面出现；只出现在发给模型服务的鉴权头里。没有 Key 时平台 AI 不可用，行为与没有配置平台 AI 时相同（生产环境则拒绝启动，10.1）。
- 出站与用户自带服务相同：只允许公网 HTTPS（不合法的地址在启动时报错），逐次解析 DNS 并固定连接地址，拒绝重定向。
- 平台模型出错时，用户只看到 `MODEL_UNAVAILABLE`；真实错误类别与 HTTP 状态只写服务端日志，不回显服务商回复。
- 选择顺序：用户有自己的配置 → 用自己的（不收点数，不占平台）；否则平台 AI 可用 → 用平台的；否则 `MODEL_CONFIG`。
- 免费调用：采访（hosted-route 2）与和 TA 聊什么（第 11 节）不收点数，受全站每日上限 `NOWME_PLATFORM_FREE_DAILY_CALLS` 约束（进程内计数，10.3），用完后返回 `MODEL_UNAVAILABLE`。
- 收费调用：生成、修改按价目扣点（12.3）。工作区与任务页写明“用的是 NOWMe 的 AI”、价目和可用点数，并给出“改用自己的 Key”入口。

### 12.2 账户、余额与流水

两类账户：个人（`user`，`account_id` = 用户 ID）与墙的额度（`wall`，`account_id` = 墙 ID）。

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `credit_balances` | (`account_kind`,`account_id`) 主键、`balance`（`CHECK >= 0`）、`updated_at` | 当前余额 |
| `credit_entries` | `id cre_`、`account_kind`、`account_id`、`delta`（≠ 0）、`balance_after`（≥ 0）、`reason`、`ref_id`、`actor_id`、`created_at` | 只追加的流水；触发器禁止 UPDATE / DELETE；对账以流水为准 |
| `redeem_codes` | `id rdc_`、`code_hash` 唯一、`credits`（1–100 000）、`batch`、`expires_at`、`redeemed_by`、`redeemed_at`、`created_at` | 兑换码只存哈希 |
| `wall_sponsorships` | `wall_id` 主键、`member_cap`（0–10 000，0 = 不限）、`updated_at` | 墙额度的每人上限 |

| `reason` | 含义 | `ref_id` |
| --- | --- | --- |
| `redeem` | 兑换码入账 | 兑换码 ID（唯一） |
| `grant` / `adjust` | 运营发放（只能为正）/ 调整（可为负，余额不能为负） | — |
| `signup` | 注册赠送（`NOWME_SIGNUP_CREDITS` > 0 时，每个账号唯一一次，在首次创建用户时） | 用户 ID |
| `sponsor_out` / `sponsor_in` | 组织者个人 → 墙 | 墙 ID |
| `sponsor_return` | 墙关闭时剩余额度退回组织者 | 墙 ID |
| `job` / `job_refund` | 任务扣点 / 退回 | 任务 ID（各自唯一） |

记账（`credits.post`）：先写流水再改余额，变动后余额为负时抛 `InsufficientCredits`、什么都不写；`(reason, ref_id)` 对 `job`、`job_refund`、`redeem` 唯一，重复记账被数据库拒绝。

### 12.3 扣点与退回

- **谁付**（`planJob`）：价目为 0 → 不收；否则先看这面墙还能为这位成员出多少（`wallAllowance` = min(墙余额, 每人上限 − 他已用掉的墙额度)，上限 0 表示只受墙余额限制），够就由墙付；不够再看个人余额；都不够 → 不开始任务（`credits` 错误，界面说明价目、个人余额与墙的可用额度）。不拆分支付。
- **扣点**（`chargeJob`）：与创建任务在**同一个事务**里，并再检查一次余额 / 墙额度；不够时事务回滚、任务不创建。并发的两个任务不会透支。
- **结算**（`settleJob`）：任务 `succeeded`（产出新的 accepted 版本）才保留扣点，`generation_jobs.charged = 1`；`failed`（校验不通过、超轮数、超时、API 错误）、`needs_input`（需要补充说明）全额退回，只退一次。墙已关闭时，原本由墙付的退点改退给组织者。
- 服务重启：遗留任务标记为 `INTERRUPTED` 失败后，`refundUnsettledJobs` 把扣过、未退的全部退回。
- 用自己 Key 的任务不产生任何流水。

### 12.4 兑换码

- 格式 `NM-XXXX-XXXX-XXXX-XXXX`：16 位 Crockford Base32（80 bit 随机）。输入时忽略大小写、空格、连字符与 `NM` 前缀，`O→0`、`I`/`L→1`。
- 只存 `hashToken(code)`；明文只在生成时由运营脚本输出一次。
- 兑换（`POST /account/credits/redeem`）：在一个事务里查哈希 → 已用 / 过期判断 → 标记 `redeemed_by` → 入账 → 记 `credits_redeem` 事件（`props` 只有 `credits`）。格式不对与不存在返回同一种错误；一个码只能入账一次。按用户限流 10 次 / 10 分钟（10.3）。错误页与提示不回显别人的码。

### 12.5 墙的额度

- 组织者把**个人**点数转给墙（`sponsor_out` + `sponsor_in`，同一事务），并设置每位成员上限；`credits` 为 0 表示只改上限。金额 0–100 000 的整数，不能超过自己的余额；负数、小数、超大数被拒（`bad-amount` / `bad-cap` / `insufficient`）。记 `credits_sponsor` 事件（`props: { credits, memberCap }`）。
- 墙额度只给这面墙的有效成员（发起任务本身要求成员关系有效）；被移除后立即用不到。
- 墙关闭时，剩余额度在关闭墙的事务里退回组织者个人余额。
- **组织者可见范围**：后台只显示墙额度的聚合数字（余额、已用、每人上限）和组织者自己的余额；看不到任何成员各自用了多少，也看不到成员的余额。

### 12.6 路由与运营脚本

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /account/credits` | 登录用户 | 自己的余额、价目、平台 AI 是否可用、最近 50 条流水、兑换码输入框 |
| `POST /account/credits/redeem` | 登录用户（会话 + CSRF + Origin） | `code`；成功 303 `/account/credits?redeemed=<点数>`，失败 `400` / `429` |
| `POST /w/:wallId/admin/credits` | 这面墙的组织者 | `credits`、`memberCap`；303 回到 `/w/:wallId/admin#credits`；非组织者 `404` |

演示模式（4.2.2）没有这些路由，后台也不显示墙额度区块；平台 AI 未开放时后台同样不显示。每个人只能看到自己的余额与流水。

运营脚本 `pnpm --filter @nowme/web credits <命令>`（直接读写 `NOWME_DATA_DIR` 的数据库，可在主站运行时执行）：`codes --count <1–1000> --credits <n> [--batch <备注>] [--expires <ISO 日期>]` 生成兑换码（明文只输出一次）；`grant --email <邮箱> --credits <n>` 发放；`balance --email <邮箱>` 查余额。目标账号必须先登录过一次。

### 12.7 S10 不变量（`apps/web/test/security/billing.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S10 | 平台模型的 Key 只来自环境变量，不入库、不写日志、不在页面出现；余额不为负，流水只追加；任务只扣一次，没做出新版本全额退回；兑换码只存哈希；组织者只看到墙额度的总数，看不到任何成员用了多少 | 扫描数据库、配置、日志、页面不含平台 Key，出错不回显服务商回复；无 Key 时不可用；内网地址启动时拒绝；免费调用上限生效；点数页只有本人数据，后台无成员明细；库里只有兑换码哈希，一码只能用一次，兑换需会话 / CSRF / Origin 且限流；只有组织者能充墙额度，不能透支或用非法金额；墙额度不给别墙成员与被移除成员；关闭墙退回组织者；并发任务不透支；余额表拒绝负数，流水拒绝非法原因与零变动；演示模式没有点数入口 |

## 13. 后台任务进程与任务队列

（T8.1，迁移 `010_job_queue.sql`；代码在 `apps/web/src/worker/`、`db/job-queue.ts`、`hosted/job-runner.ts`。）

### 13.1 进程划分

| 进程 | 入口 | 负责 | 不做 |
| --- | --- | --- | --- |
| 主站 | `src/main.ts`（`start` / `start:source`） | 网页请求、表单、Agent API、采访与“和 TA 聊什么”（同步的模型调用）；校验额度、扣点、把任务写进队列、等待渲染结果 | separate 模式下不启动浏览器、不跑生成 Agent 循环 |
| worker | `src/worker.ts`（`worker` 源码方式；`start:worker` 运行 `dist/worker.js`） | 提交渲染（`POST /api/agent/revisions`）、远程预览（`POST /api/agent/previews`）、网页内 AI 生成 / 修改（含平台重新校验与渲染） | 不监听端口、不处理网页请求 |
| 页面托管 | `apps/pages-host` | 不变（第 4.4 节） | — |

- 主站与 worker 共享同一个 `NOWME_DATA_DIR`：SQLite（WAL，`busy_timeout` 5 秒，写事务一律 `BEGIN IMMEDIATE`，事务内不 await）、`revisions/`、`jobs/`。两边读取同样的 `NOWME_AI_ENCRYPTION_KEY` 与 `NOWME_PLATFORM_*`；worker 不需要邮件配置。
- 浏览器（Playwright）只在 worker 的处理器、远程预览渲染器、生成预览器里懒启动。worker 内所有渲染经过同一条串行“渲染通道”：同一时刻只渲染一页（含 AI 任务里的 `preview_page` 截图与平台重新校验的渲染）。
- 可以运行多个 worker：租约保证同一个任务同一时刻只有一个执行者。

### 13.2 任务表与租约

两类任务、一套租约规则；表里只存类型、状态、ID、计数与时间，**不存页面文件、模型输出或用户内容**；不建外键（按时间清理，注销时可按 `page_id` 删除）。

- **AI 生成 / 修改**：复用 `generation_jobs`（状态仍是 `queued / running / succeeded / failed / needs_input`，不另建一套状态），新增列 `attempts`、`lease_owner`、`lease_expires_at`、`model_source`（`own | platform`）、`model_version`。主站在创建任务的同一个事务里扣点（第 12 节）、写入模型来源与用户模型配置的版本号（随机 UUID，不是 Key）。worker 按它取模型：排队期间主人删除或更换了配置，任务以 `MODEL_CONFIG` 失败并退点，不会改用新配置（S8）。
- **提交渲染、远程预览**：`render_jobs(id job_*, kind submission|preview, status queued|running|done|failed, page_id, credential_id, attempts, max_attempts, lease_owner, lease_expires_at, outcome stored|rendered|rate_limited|credential_invalid, revision_id, error_code, created_at, started_at, finished_at)`。上传的文件先按白名单过滤（第 3 节），暂存到 `<dataDir>/jobs/<id>/files/`（目录 0700、文件 0600），worker 读回时再过滤一次；预览结果写 `<dataDir>/jobs/<id>/result.json`（先写临时文件再改名）。
- **领取**：`BEGIN IMMEDIATE` 事务里取最早的 `queued` 任务改成 `running`，写入 `lease_owner`（进程内随机 worker ID）、`lease_expires_at`（默认 60 秒后）、`attempts + 1`。
- **续约**：执行中每 1/3 租期续约一次（`WHERE lease_owner = 自己 AND status = 'running'`）。续约失败说明租约已被回收：取消这个任务。数据库暂时忙不算丢失租约。
- **结束**：所有结果写入都带租约条件。提交渲染把“写版本 + 结束任务”放在同一个事务里；AI 任务把“结算点数 + 结束任务”放在同一个事务里，托管结果写版本前也要确认仍持有租约。租约被回收后旧 worker 的结果一律作废。
- **回收**：worker 每次轮询（默认 1 秒）回收别人持有、已经过期的 `running` 任务（见 13.4）。
- **等待**：Agent API 是同步的。主站入队后等待 `render_jobs` 结束（inline 模式由同进程通知唤醒，separate 模式每 250 毫秒读一次）；提交最多等 3 分钟、预览 2 分钟。超时时还在排队的任务标记 `failed / ABANDONED` 不再执行，返回 500 `INTERNAL_ERROR`（“渲染服务现在太忙”）；已经在执行的让它做完（提交的结果照常保存）。渲染出错返回 500 `INTERNAL_ERROR`。
- **远程预览什么都不留**：主站取走结果后立即删除任务行与暂存目录；只留第 4.1 节的 `remote_preview` 事件。
- **清理**（worker 启动时与每 10 分钟）：退回“扣了点、已失败、未退”的任务；删除结束超过 7 天的提交任务行、遗留超过 10 分钟的预览任务行、超过 30 天的进度事件；删除没有对应任务或任务已结束、超过 10 分钟的暂存目录。

### 13.3 进度事件

`job_events(job_id, seq, stage, props_json, created_at)`，主键 `(job_id, seq)`；`job_id` 是 `gen_…` 或 `job_…`。序号在同一条 INSERT 语句里计算（同一任务从 1 起逐条递增）。

- 阶段 `stage`：`queued` 排队中、`reading` 读取资料、`designing` 设计（还没写过页面文件的轮次）、`generating` 生成中（第 n 轮）、`validating` 校验、`rendering` 渲染截图、`retrying` 重新排队、`succeeded` 完成、`needs_input` 需要补充说明、`failed` 失败。中文名见 `JOB_STAGE_LABELS`。
- `props_json` 只允许 `turn`、`attempt`、`maxTurns`、`files` 四个键，值是非负整数；不存模型输出、工具参数、文件名或任何用户内容。失败原因看任务行的 `error_code`。
- AI 任务：`queued`（入队事务内）→ `reading` → 每轮 `designing` / `generating {turn, maxTurns}`，工具 `validate_page` → `validating`、`preview_page` → `rendering` → 循环结束后 `validating`、`rendering`（平台重新校验与渲染）→ `succeeded` / `needs_input` / `failed`。提交渲染：`queued {files}` → `validating {attempt}` → `rendering {attempt}` → `succeeded`（accepted）/ `failed`。远程预览不写进度事件。
- 查询：`repos.jobEvents.listAfter(jobId, afterSeq, limit)` 按序号升序返回 `afterSeq` 之后的事件（最多 500 条），`latest(jobId)` 返回最后一条。**这两个函数不做授权**：第 18 节的实时进度推送必须先用 `repos.jobs.findForOwner(jobId, pageId, 当前用户)` 确认查看者是任务的主人，无权一律 404。

### 13.4 重启语义

| 情况 | AI 生成 / 修改 | 提交渲染 / 远程预览 |
| --- | --- | --- |
| 还在排队时进程重启 | 不受影响，下一个 worker 照常执行 | 不受影响 |
| 执行中进程崩溃（租约过期） | **不重试**（避免重复计费）：标记 `failed / INTERRUPTED`、全额退点，写 `failed` 事件 | 可重试（幂等）：`attempts < max_attempts`（提交 3、预览 2）时回到队列并写 `retrying`，否则 `failed / INTERRUPTED`；预览的第二次尝试不重复计入额度 |
| 优雅退出（SIGTERM） | 停止领取，等进行中的任务最多 `NOWME_WORKER_SHUTDOWN_GRACE_SECONDS` 秒；到时取消，按 `INTERRUPTED` 结束并退点 | 同样等待；到时交还租约（回到队列，这次不计入尝试次数），由下一个 worker 重做 |
| 处理器抛错 | — | 不重试：`failed / INTERNAL`，返回 500 |
| 迁移 010 之前入队、没有 `model_source` 的任务 | 按 `INTERRUPTED` 结束并退点 | — |
| 停用账号（第 15 节）/ 注销账号（第 14 节） | `cancelActiveJobsForUser`：排队中 / 执行中的任务立即标记失败（`SUSPENDED` / `PAGE_GONE`）、清掉租约、全额退点；执行它的 worker 在下一轮调用模型前或下一次续约时发现租约已不在，停止后续模型请求，结果作废 | 凭证随之失效：worker 写版本前重新确认凭证，返回 `credential_invalid` |

主站重启不再打断任何任务（旧版本在启动时把所有排队 / 执行中的任务标记为失败）。崩溃时用户最多等一个租期（60 秒）才看到任务失败。

### 13.5 运行模式与配置

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `NOWME_WORKER_MODE` | `inline`（默认）/ `separate` | zod 校验（`workerModeSchema`）。inline：worker 循环在主站进程内运行，`pnpm dev`、`pnpm demo`、测试的行为与之前相同；separate：主站只入队，不创建处理器 / 渲染器 / 预览器 |
| `NOWME_WORKER_AI_CONCURRENCY` | 1–16，默认 2 | 同时执行的 AI 任务数；渲染始终串行 |
| `NOWME_WORKER_SHUTDOWN_GRACE_SECONDS` | 0–3600，默认 30 | 优雅退出的等待时间（编排里的停止超时应比它长） |

- 生产环境（`NODE_ENV=production`）主站使用 `inline` 时，`assertProductionConfig(..., 'web')` 给出提醒，不拒绝启动。worker 进程用 `assertProductionConfig(..., 'worker')`：要求 `NOWME_AI_ENCRYPTION_KEY`（设置了平台 AI 时还要 `NOWME_PLATFORM_API_KEY`），不检查邮件。
- inline 模式下同样可以另起 worker 进程分担任务（两边都会领取）；只想让 worker 执行时把主站设为 separate。
- 测试注入点不变：`createWebApp({ processor, previewer, remoteRenderer, model, platformModel, clock, hostedTempRoot })` 在 inline 模式下交给本进程的 worker；`WebApp.worker` 是这个 worker（separate 模式为 null），`deps.hosted.idle()` 等它空闲；`WebApp.close({ graceMs })` 停止领取并等待。

## 14. 账号注销与数据导出

用户可以随时导出属于自己的数据，也可以注销账号。代码：`apps/web/src/routes/account.tsx`、`apps/web/src/services/account-deletion.ts`、`apps/web/src/services/account-export.ts`、`apps/web/src/services/zip.ts`、`apps/web/src/db/account-data.ts`、`apps/web/src/services/deleted-emails.ts`、迁移 `011_account_deletion.sql` 与 `014_deletion_evidence.sql`（编号早于 012 / 013 但与它们互不依赖；已经执行过 012 / 013 的数据库会在下次启动时补执行 011）。入口在“我的资料”（`/account/data`）底部。演示模式（4.2.2）没有这些路由。

### 14.1 路由

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /account/export` | 登录用户 | 下载 `nowme-export-YYYYMMDD.zip`（`application/zip`、`attachment`、`private, no-store`）；按用户限流 5 次 / 小时（`RATE_RULES.accountExport`，超出 `429` + `Retry-After`） |
| `GET /account/delete` | 登录用户 | 说明注销后果；他还是某面**开放**墙的组织者时，只列出这些墙与组织者后台入口，不给发码按钮 |
| `POST /account/delete/code` | 登录用户（会话 + CSRF + Origin） | 向账号邮箱发注销确认码，显示输入框；`409` 有开放的墙、`429` 同邮箱发码超限、`503` 邮件发不出去 |
| `POST /account/delete` | 登录用户（会话 + CSRF + Origin） | `code` + `confirm=1`：校验并注销，清除会话 cookie，`200` 结果页；`400` 未勾选 / 确认码不对 / 过期 / 错误次数用完，`409` 有开放的墙 |

POST 路由忽略 `Authorization` 头（页面凭证在这里无效）。错误都是固定中文文案，不回显输入。

### 14.2 二次确认

- 注销前必须新发一个**注销用途**的确认码：与登录验证码同一张表 `login_codes`，迁移 011 增加 `purpose login|account_delete`（旧数据为 `login`）。规则相同：6 位数字、10 分钟、最多 5 次尝试（用完作废）、只存 `SHA-256("<id>.<code>")`、同一邮箱发码限流 5 次 / 10 分钟（两种用途合计）。
- 两种用途互不通用：登录只认 `login`，注销只认 `account_delete`。新发注销确认码时作废未使用的旧注销确认码；新发登录验证码时作废该邮箱全部未使用的验证码。
- 邮件主题 `<code> 是你注销 NOWMe 账号的确认码`，正文说明后果，不含链接。
- 前提：他不是任何一面 `open` 墙的组织者。没有转让功能，平台**不会**替他关闭墙；发码与注销时都检查（发码之后再建墙也会被拦下）。

### 14.3 注销范围与顺序

确认码校验通过后，在**一个数据库事务**里完成以下全部步骤，提交后才删文件：

0. 证据转存与邮箱哈希（14.7）：针对他的每一条待处理举报，先把被举报的内容转存进 `deletion_evidence`；记下邮箱的 HMAC。
1. 他的每一页（含已退出 / 被移除 / 墙已关闭的）按“删除页面”语义处理（build-plan 决策 2026-11-06）：版本行留墓碑（内容清空、报告换成 `validatorVersion = "deleted"` 的空报告），所有发布的 `card_json` 置为 `{"deleted":true}`、`contact_json` 清空，活跃发布以 `deleted` 结束（下墙），公开链接与联系方式清空，页面凭证吊销、未使用的指令删除；这一页的 brief、素材记录、任务内容（修改要求、结果说明）以及**别人针对这一页**的“和 TA 聊什么”删除。
2. 还在排队 / 运行的生成任务：以 `failed`（`PAGE_GONE`）结束并全额退点（12.3）；任务执行器之后写结果时因状态不再是排队 / 运行而作罢，提交版本前的 `stillValid` 检查也会失败。
3. 有效的成员关系全部结束（`left`，与退出墙相同），每面墙记一条 `leave` 事件（`props: { accountDeleted: true }`）。
4. 他发出的聊天消息正文替换为“该用户已注销”，已读位置删除；他得到的“和 TA 聊什么”结果删除。私聊因为他不再是成员，对方不再可见（4.2.1 的可见规则）。
5. 长期画像、模型配置（含加密的 Key，删除后旧任务停止后续请求）、全部会话、该邮箱的全部验证码记录删除；他组织过的（已关闭的）墙的封面删除。
   举报与拉黑（第 15 节）：拉黑关系双向删除（他拉黑的、拉黑他的）；他提交过的举报保留给平台运营处理，但补充说明 `note` 清空，举报人只剩墓碑账号 ID；针对他的举报、处理记录（`moderation_actions`）与停用记录保留。
6. 个人余额作废：余额大于 0 时记一笔 `account_deleted` 流水（迁移 011 为 `credit_entries.reason` 增加该值；重建表保留原有行、索引与只追加触发器）。流水不删除，此后只关联到墓碑账号 ID。
7. 用户行改为墓碑：`email = 'deleted:<用户 ID>'`（不是合法邮箱，登录表单永远匹配不到，也不保留原邮箱或它的哈希）、`nickname = '已注销用户'`、头像与协议同意记录（`terms_version`、`terms_accepted_at`，16.3）清空、`deleted_at` 置为当前时间（迁移 011 新增列）。

提交后删除版本目录 `revisions/<id>/` 与托管素材目录 `hosted/<pageId>/`；删除失败只记日志（数据库里已是墓碑，不会再签发票据）。主站每次启动时 `sweepDeletedAccounts` 幂等清理：已注销用户名下全部 accepted 版本的目录与全部页面的托管素材目录（进程在提交后崩溃、删除失败留下的），以及到期的证据。

### 14.4 保留的墓碑与之后的行为

| 保留 | 内容 |
| --- | --- |
| `users` 行 | 只有 ID、`deleted:<ID>`、“已注销用户”、创建与注销时间 |
| 成员关系、页面行、版本行、发布行、任务行 | 只有 ID、编号、状态与时间，没有内容 |
| 聊天消息行 | 发送者 ID、时间与固定正文“该用户已注销” |
| 点数流水、事件、兑换码的 `redeemed_by` | 只有 ID 与数字（流水只追加，S10） |
| 他提交的举报 | 对象、原因类别、状态与时间（补充说明已清空） |
| 针对他的举报、处理记录、停用记录 | 原样保留，供平台运营处理与留痕 |
| 举报证据 `deletion_evidence` | 只针对注销时仍待处理的举报；处理完或 180 天后删除（14.7） |
| 注销过的邮箱 `deleted_emails` | 只有 HMAC（14.7） |
| 他组织过的已关闭的墙 | 名称、简介（墙关闭后对所有人不可见） |

- 注销后，会话（所有设备）、页面凭证、一次性 token、成员页、封面、成员头像、公开链接、工作区一律失效：需要登录的页面跳到登录页，其余一律 `404`（与“无权访问一律 404”一致）。`loadSession` 对 `deleted_at` 非空的用户也不返回会话（防御）。
- 其他成员在群聊里看到“已注销用户：该用户已注销”；组织者后台的成员列表只有有效成员，不再列出他。
- 同一个邮箱之后可以重新登录，得到一个全新的账号（新的用户 ID，找不回原来的内容）；**不再**发注册赠送点数（14.7）。

### 14.5 导出内容

ZIP（标准格式，UTF-8 文件名，按需 deflate）：

```
README.txt                     说明
data.json                      { format: 'nowme-export', version: 1, exportedAt, account, walls, profile, icebreakers, conversations, credits, aiSettings }
avatar.webp                    头像（有的话）
pages/<墙 ID>/v<版本号>/...     每个未删除的 accepted 版本提交的原文件（original/）
interviews/<墙 ID>/<文件名>     采访时上传的图片
```

| 部分 | 内容 |
| --- | --- |
| `account` | ID、邮箱、昵称、注册时间 |
| `walls[]` | 墙的名称、简介、场景、组织者一句话、状态；自己的角色与成员状态；自己的页面：联系方式、公开链接是否开着（不含令牌）、版本元数据（编号、来源、状态、时间、校验问题、card）、发布记录（版本号、确认后的卡片、联系方式快照、起止与原因）、采访（答案、追问、brief、brief.md、图片）、AI 任务（类型、状态、修改要求、结果说明） |
| `profile` | 长期画像条目 |
| `icebreakers` | 当前仍会展示给他的“和 TA 聊什么”结果（对方仍在墙上、发布没变） |
| `wallAnswers`、`receivesReminderEmails` | 自己在各面墙的必答题回答（墙、题目、选项、时间）；是否接收组织者的提醒邮件（第 19 节） |
| `conversations` | 当前仍能看到的会话给全部消息（发送者显示为昵称）；已经看不到的（退出墙、对方离开）只给自己发的消息 |
| `credits` | 个人余额与全部流水（时间、变动、余额、原因） |
| `aiSettings` | 服务商、地址、模型、是否有 Key（不含 Key） |
| `blocked` | 自己拉黑的人（昵称与时间；不列出谁拉黑了他） |
| `reportsFiled` | 自己提交的举报（对象类型、墙、原因、自己写的说明、时间；不含处理结果） |

页面文件按版本从新到旧放入，总量超过 120 MiB 后更早的版本只给元数据（`files: null`、`filesOmitted: true`）。**不含**：任何令牌、凭证、会话、验证码（明文或哈希）、加密的 Key、邀请码、公开链接令牌；别人的草稿、未发布版本、采访、画像、未公开的联系方式、别人之间的私聊。

### 14.7 举报证据与重复领取（迁移 `014_deletion_evidence.sql`）

**举报证据**：注销时，针对他的每一条 `open` 举报转存一行 `deletion_evidence`（主键 `report_id`）：

| `kind` | 内容 |
| --- | --- |
| `page` | 被举报那一版（举报记录的 `publication_id`）的缩略卡 `card_json`、页面文字 `rendered_text`、整页截图（`render/full.png`，没有时用 `cover.png`，BLOB） |
| `conversation` | 那段私信里**他发的**消息，到举报时的 `last_sequence` 为止，最近 200 条：`[{ sequence, at, text }]` |

- 只给平台运营：只有 `moderation show` 读取（被举报人已注销时，私信里他的消息按原文显示并标注“注销前原文”，页面证据另列；`--evidence-png <文件>` 把截图写到文件，0600）。没有任何网页路由读这张表；组织者、举报人、其他成员都看不到；组织者后台的举报区块只列墙上可见的页面，注销后的页面已不在墙上。
- 清除：举报不再是 `open` 时由触发器 `deletion_evidence_cleared_on_resolve` 立即删除（组织者或平台的任何处理路径都生效）；`expires_at` = 注销时间 + 180 天，到期后读取时视为不存在，并在主站启动与每次执行运营命令时删除。
- 不转存：已处理的举报、注销时没有举报的内容、别人的消息（别人的消息本来就不会被替换）。

**重复领取赠送点数**：注销时把 `HMAC-SHA256(K, 小写邮箱)` 写进 `deleted_emails`，`K = HMAC-SHA256(票据密钥, "nowme:deleted-email:v1")`。新账号首次创建时如果邮箱命中，不发 `signup` 点数。库里没有邮箱本身；没有票据密钥无法比对。更换票据密钥后旧记录失效（最多让人重新领一次赠送）。

### 14.6 S11 不变量（`apps/web/test/security/account-deletion.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S11 | 注销需要新的注销用途验证码；有开放的墙的组织者不能注销；注销后不留可访问的个人数据；导出只给本人且不含凭证与别人的未公开内容 | 没发码、码不对、用登录验证码、缺 CSRF / 错误来源 / 只带页面凭证都不能注销且数据不变，错 5 次作废，注销确认码不能登录；组织者有开放的墙时不发码、不注销、不替他关墙；注销后两台设备的会话、凭证、未使用的 token、成员页、封面、成员头像、公开链接全部失效，文件删除，数据库里不再有他的邮箱、采访、画像、消息与 Key，余额作废记流水，对方的破冰结果删除，拉黑关系删除、他提交的举报说明清空而针对他的举报保留、协议同意记录清空，同一邮箱注册为新账号且拿不回内容，墓碑“邮箱”不能登录、塞回的会话无效；待处理举报的证据只有运营命令能看到、网页与组织者看不到，处理后或 180 天后删除；同一邮箱重新注册不再得到赠送点数、库里没有邮箱明文；启动清理删除残留文件且可重复执行；未登录 / 页面凭证不能导出，导出内容不含任何令牌、哈希、Key、邀请码与别人的未公开内容，导出按用户限流 |

## 15. 举报、拉黑与处理

2026-11-15 确认（T8.3）。实现：迁移 `012_moderation.sql`、`apps/web/src/db/moderation.ts`、`services/moderation.ts`、`routes/moderation.tsx`、`services/moderation-cli.ts`。

### 15.1 举报

| 对象 | 谁能举报 | 去向 |
| --- | --- | --- |
| 页面 | 同墙有效成员，对象是**别人的、当前在墙上可见**的页面（与成员页同一授权：`findPublishedMemberPage`）；自己的页面、未发布 / 已撤下的页面 404 | 这面墙的组织者 + 平台运营 |
| 私信 | 一对一私聊的参与者（会话对他可见）；群聊不能举报 | **只到平台运营**，组织者永远看不到 |

- 表单：`reason` 必选，取值 `harassment`（骚扰）/ `inappropriate`（不当内容）/ `impersonation`（冒充他人）/ `spam`（垃圾广告）/ `other`（其他）；`note` 可选，统一换行、去首尾空白后最多 500 字，拒绝控制字符（允许换行、制表符），空串存 null。不合法时 303 回原页 `?safety=invalid`，不写库。
- 同一举报人对同一页面 / 同一段私信只有一行（部分唯一索引），重复举报只更新原因与补充说明。已被处理（忽略或已处理）的举报：页面只有换了一次发布（`publication_id` 变了）、私信只有出现了新消息后再举报才重新回到待处理，免得一个人对同一内容反复刷到组织者面前。
- 举报页面记录当时的 `publication_id`；举报私信记录当时最后一条消息的序号 `last_sequence`，平台运营只看到这条为止的内容。私信不复制到举报表。
- 状态：`open` → `dismissed`（忽略）或 `actioned`（已处理），同时记 `resolved_by organizer|platform` 与 `resolved_at`。
- 补充说明**只给平台运营**：它最容易暴露举报人是谁（“就是我在活动上……”），组织者只需要原因类别与次数就能决定是否下墙。界面在填写处说明这一点。

### 15.2 组织者能看到与能做的

组织者后台 `GET /w/:wallId/admin` 新增“待处理举报”区块（`#reports`）：只列**当前仍在墙上可见**的被举报页面，每页显示页面名（发布快照里的 `displayName`，链接到墙上的成员页——组织者作为成员本来就能看到）、各原因的次数、最近一次时间，按总次数倒序。不显示举报人（昵称、ID、邮箱、头像）、补充说明、举报时间以外的任何明细；不显示私信举报；**不显示针对组织者自己页面的举报**（这类只由平台处理，组织者也不能处理）。

- “请这一页下墙”：复用撤下语义——活跃发布以 `withdrawn` 结束（主人之后可以修改后重新发布，重新发布后再被举报会重新出现），这一页全部待处理举报记为 `actioned / organizer`，`moderation_actions` 追加 `takedown`（带 `publication_id`），事件 `withdraw`（`props.byOrganizer = true`）。主人在工作区的“已撤下”说明里看到“有成员举报了这一页，组织者请它先下墙”，看不到原因与举报人。
- “忽略”：页面留在墙上，待处理举报记为 `dismissed / organizer`，追加 `dismiss`。
- 只能处理这面墙上可见、不是自己、且有待处理举报的页面；否则 404、不改变状态。更强的处理仍是既有的“移出成员”。

### 15.3 拉黑

账号之间的关系（`blocks`，单向记录），对**所有共同的墙**生效，任一方向存在即双向生效：

- 墙上互相看不到对方的卡片（`loadWallModel` 过滤）；对方的成员页、封面、想聊这个、查看联系方式、直接私信、举报 / 拉黑入口、“和 TA 聊什么”（生成、用开场白开聊、清除）全部 404——它们都经过 `findPublishedMemberPage`，那里加了拉黑检查。
- 不能新建私信（`openDirect` 返回 null → 404）；已有私信保留历史、双方仍可阅读（便于举报），但发送返回 `403 {error:"现在没法在这段对话里发消息了。"}`，两边看到同一句中性说明；拉黑的一方额外看到“你已拉黑 TA，可以在我的资料里解除”，输入框隐藏。
- 对方不会收到任何通知；“我的资料”只列**我拉黑的人**，不列谁拉黑了我。解除拉黑（`POST /account/blocks/remove`）立即恢复可见与私信。
- 不影响：全员群聊的消息与成员列表、组织者后台成员列表（组织者的管理职责不受拉黑影响）、公开链接 `/s/:publicToken`。

### 15.4 停用账号（只有平台运营）

`user_suspensions` 有记录即停用：同一事务里删除该账号全部会话、结束其全部页面的活跃发布（`withdrawn`）、吊销本地 Agent 凭证与未用 token，追加 `suspend`。之后 `loadSession` 对停用账号返回 null（即使还有会话也无效），验证码正确也不签发会话（`verifyLoginCode` 返回 `suspended`，登录页提示“这个账号已被平台停用”），别人不能向 TA 新建私信、不能在已有私信里给 TA 发消息。解除停用只删除记录并追加 `unsuspend`，页面不会自动回到墙上。

### 15.5 数据模型（迁移 `012_moderation.sql`）

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `reports` | `id rpt_`、`reporter_id`、`target_kind page\|conversation`、`wall_id`、`reported_user_id`、`page_id`、`publication_id`、`conversation_id`、`last_sequence`、`reason`、`note`（≤500）、`status open\|dismissed\|actioned`、`resolved_by organizer\|platform`、`resolved_at`、`created_at`、`updated_at` | (`reporter_id`,`page_id`) 与 (`reporter_id`,`conversation_id`) 各自部分唯一；不能举报自己 |
| `moderation_actions` | `id mda_`、`actor organizer\|platform`、`actor_user_id`（组织者才有）、`action takedown\|dismiss\|resolve\|suspend\|unsuspend`、`wall_id`、`page_id`、`publication_id`、`report_id`、`user_id`、`note`、`created_at` | 只追加 |
| `blocks` | `blocker_id`、`blocked_id`、`created_at` | 主键 (`blocker_id`,`blocked_id`)，不能拉黑自己 |
| `user_suspensions` | `user_id` 主键、`reason`、`suspended_at` | |

`rpt_`（`report`）/ `mda_`（`moderationAction`）在 `packages/contracts` 的 `ID_PREFIXES` 中，用 `generateId` 生成；举报 ID 的格式检查用 `REPORT_ID_PATTERN`。

### 15.6 路由

全部 `POST`，会话 + Origin + CSRF，忽略 `Authorization`；无权访问与不存在一律 404。

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `POST /w/:wallId/p/:pageId/report` | 墙内有效成员，别人的可见页面 | `reason`、`note` → 303 `?safety=reported\|report-updated#safety` |
| `POST /w/:wallId/p/:pageId/block` | 同上 | 拉黑页面主人 → 303 `/w/:wallId?notice=blocked` |
| `POST /messages/:id/report` | 一对一私聊参与者 | `reason`、`note` → 303 回会话 |
| `POST /messages/:id/block` | 同上 | 拉黑对方 → 303 回会话 `?safety=blocked` |
| `POST /account/blocks/remove` | 登录用户 | `userId`；只解除自己发出的拉黑，没有这条记录 404 → 303 `/account/data?notice=unblocked` |
| `POST /w/:wallId/admin/reports/takedown` | 这面墙的组织者 | `pageId` → 请这一页下墙 |
| `POST /w/:wallId/admin/reports/dismiss` | 这面墙的组织者 | `pageId` → 忽略 |

`GET /account/data`（“我的资料”）新增拉黑名单区块（`#blocks`）；成员页（别人的页面）底部、一对一私聊顶部新增折叠的“举报 / 拉黑”。

### 15.7 平台运营命令

`pnpm --filter @nowme/web moderation <命令>`，直接读写 `NOWME_DATA_DIR` 下的数据库（可在主站运行时执行）。只有运营能看到举报人、补充说明与私信内容。每次执行先删除到期的注销证据（14.7）。

被举报的人注销账号时，他的页面与消息按第 14 节删除，但**待处理**举报的被举报内容转存为只有运营能看到的证据（14.7），举报处理完或 180 天后删除。

| 命令 | 作用 |
| --- | --- |
| `list [--status open\|dismissed\|actioned\|all] [--kind page\|conversation] [--limit N]` | 默认待处理，最近更新在前 |
| `show --id rpt_... [--evidence-png 文件]` | 举报人与被举报人（昵称 + 邮箱）、原因、补充说明、同一对象的举报数；页面：被举报时的缩略卡与页面文字（前 2000 字）；私信：到举报时为止的最近 50 条。被举报人已注销时另显示注销时转存的证据（14.7），截图可写到文件 |
| `resolve --id rpt_... --as dismissed\|actioned [--note]` | 只结束这一条举报 |
| `hide-page --page pg_... [--note]` | 页面下墙（`withdrawn`），这一页全部待处理举报记为 `actioned / platform` |
| `suspend --email ... [--note]` / `unsuspend --email ... [--note]` | 停用 / 解除（15.4） |

### 15.8 安全不变量 S12

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S12 | 举报人身份不暴露给组织者和被举报人：组织者只看到页面、原因类别与次数，补充说明只给平台运营；私信举报只到平台运营，组织者看不到私信内容与私信举报；组织者看不到、处理不了针对自己页面的举报，非组织者与凭证不能处理举报。拉黑后双向不可见、不可联系（卡片、成员页、封面、和 TA 聊什么、想聊这个、发起私信、已有私信发送均不可用），被拉黑的人看不出是谁拉黑了自己。停用账号立即失效：已有会话失效、不能再登录、页面下墙、凭证吊销 | `test/security/moderation.security.test.ts`：组织者后台 HTML 不含举报人昵称 / ID / 邮箱、补充说明、私信内容与会话 ID；被举报人各页面不含举报痕迹；拉黑后两个方向逐个路由 404 / 403；停用后旧会话重定向登录、验证码登录 400、Agent 凭证 401 |

## 16. 内容安全、AI 生成标识与用户协议

### 16.1 内容安全检查

统一入口 `checkText(kind, text)`（`apps/web/src/services/content-safety.ts`，挂在 `deps.contentSafety`，另有 `checkTexts`）。**在路由 / 服务边界、写入或交给模型之前调用**，不深入 `hosted/service.ts` 内部。检查点类型 `ContentKind`（`packages/contracts/src/content-safety.ts`）：

| kind | 检查什么 | 位置 | 命中时 |
| --- | --- | --- | --- |
| `wall` | 墙名称、简介、组织者的话 | `POST /walls` | 422，字段上的提示，不建墙 |
| `nickname` | 昵称 | `POST /welcome`、`POST /account/profile` | 422 / 400，不保存 |
| `interview` | 采访素材与选项补充、追问回答、重做备注、确认时改写的“AI 眼中的你”与接话点 / 开场白 | `/me/create/start`、`followups`、`revise`、`confirm` | 422，回到创作页并提示，不建 brief、不请求模型 |
| `edit` | 修改要求 | `POST /me/edit` | 400，提示页，不建任务 |
| `message` | 站内消息（群聊与私聊） | `POST /messages/:id/send`（会话可见且没被限流才检查） | 400（JSON 或页面），消息不入库 |
| `page` | 发布时版本的渲染文字（`revisions.rendered_text`）加确认表单里的名字、一行介绍、接话点、开场白 | `POST /me/publish` | 400，提示页，不发布 |

规则按顺序：

1. **内置规则** `B01`–`B05`（诈骗引流、赌博、色情招揽、违禁品交易、拉人头），只放几乎不可能是正常内容的写法；匹配前做 NFKC、小写、去掉空白与分隔符。不是敏感词大全，更多靠 2、3 补充。
2. **外部词表**（`NOWME_BLOCKLIST_FILE`，可选）：每行一个词（忽略空白与标点地匹配）或 `/正则/标志`（标志只允许 `i u s m`），`#` 注释；规则编号 `F<行号>`；最多 5000 条、每条 200 字符、文件 512 KB。启动时读入并校验，**读不到或任何一行不合法都拒绝启动**（错误信息只带行号，不带词）。
3. **外部审核接口**（`NOWME_MODERATION_URL`，可选，默认关闭）：只允许 https（不含账号密码），连接时复用 `security/model-network.ts` 的 `createModelFetch`（逐次解析 DNS、任何非公网地址拒绝、固定连接地址、拒绝重定向）。主站 `POST` JSON `{ "kind", "text" }`（文字最多 8000 字符），可选 `NOWME_MODERATION_API_KEY` 以 `Authorization: Bearer` 发送；期望返回 JSON `{ "allowed": boolean, "rule"?: string }`（规则编号只留 `[A-Za-z0-9_.-]{1,32}`，显示为 `M:<编号>`，否则 `M01`）。超时（3 秒）、非 2xx、格式不对、网络或地址校验失败都算“接口不可用”，按 `NOWME_MODERATION_ON_FAILURE`：`allow`（默认）放行并记日志，`block` 拦截（编号 `M00`）。本地规则已命中时不调用接口。

拦截提示是中文、友好、不说教，形如“这条消息里有我们没法放行的内容，换个说法再发一次吧。（提示编号 B01；如果觉得是误判，改写后再提交即可。）”。**日志只记检查点类型与规则编号**（`[safety] 拦截 kind=message rule=B01`、`[safety] 审核接口不可用 kind=… reason=… action=…`），不记原文，也不记审核接口密钥。

配置：`NOWME_BLOCKLIST_FILE`、`NOWME_MODERATION_URL`、`NOWME_MODERATION_API_KEY`（只从环境变量读，不进配置对象）、`NOWME_MODERATION_ON_FAILURE`（`allow` | `block`）、`NOWME_CONTACT_EMAIL`（协议页上的联系邮箱，可选）；定义与校验在 `packages/contracts/src/config.ts` 的 `loadModerationConfig`、`loadContactEmail`。启用审核接口后，隐私政策自动写明“文字会发给第三方审核服务”。

不做：图片内容识别；本地 Agent 路线提交页面时的即时检查（发布是统一关口）；对已发布内容的回溯扫描。

### 16.2 AI 协助生成标识

页面是 AI 和本人一起做的、本人确认后发布，所以每个展示用户页面的主站界面都带一个低调标识“✦ AI 协助生成”（悬停说明“这一页由 AI 和页面主人一起做成，本人确认后发布”）：

- 墙上的页面卡片（`views/wall.tsx`，名字下方）；
- 页面框 `PageFrame`（`views/page-frame.tsx` 手机框下方）——成员页、公开链接页、创作工作区预览都用它；
- 公开链接页的外壳（经 `PageFrame`）。

组件在 `views/ai-badge.tsx`，元素带 `data-ai-badge`。**标识只在主站自己的 HTML 里，不往用户页面的文件或 iframe 内容里注入任何东西**（页面文件、`served/` 与 CSP 都不变）。

### 16.3 用户协议、隐私政策与年龄确认

- 公开页面 `GET /terms`、`GET /privacy`（`routes/legal.tsx`、`views/legal.tsx`，不需要登录，所有页面页脚与公开链接页有链接）。文字必须与代码实际存的数据和做法一致（存什么、为什么、谁能看到、存多久、怎么删除；注销与导出入口写“我的资料”页）；改数据模型、保存期限、可见范围或对外发送的服务时同步改文字并升版本。
- 版本常量在 `packages/contracts/src/legal.ts`：`LEGAL_VERSION`（两份文档共用一个日期版本号，当前 `2026-11-15`）、`LEGAL_EFFECTIVE_DATE`、`MIN_USER_AGE = 18`、表单字段 `CONSENT_FIELD_NAME = 'agree'`。
- 迁移 `013_consent.sql`：`users.terms_version`、`users.terms_accepted_at`（只存最近一次确认；迁移前注册的老用户为空）。
- 首次登录：`/welcome` 昵称表单增加必选勾选“我已年满 18 岁，并同意《用户协议》和《隐私政策》”（链接在新标签页打开）。不勾选 → 400，昵称和同意记录都不写；勾选 → 同一次提交里写昵称并记录 `LEGAL_VERSION` 与时间。
- 重新确认：登录后站内页面检查 `terms_version === LEGAL_VERSION`，不是就 `303 /consent?next=…`（`requireUser` / `requireForm` / 消息的 JSON 接口 403；`security/session.ts` 的 `onboardingStep`）。`/consent` 是中间页，勾选后记录新版本并回到 `next`（只允许站内路径）；不同意可退出登录。`/consent`、`/terms`、`/privacy`、`/logout` 不被拦。`/api/`（页面凭证）不加载会话，不受影响。演示模式的固定账号不走这一步；开发与演示种子账号直接记为已确认。
- 安全测试：`apps/web/test/security/consent.security.test.ts`（未同意被导向确认页、表单不执行、版本升级重新确认、`next` 只允许站内、`/api/` 不受影响）与 `content-safety.security.test.ts`（日志不含原文、审核接口只走公网 HTTPS、被拦内容不写库不交给模型）。

## 17. 运维：容器、备份与日志

细节与操作步骤见 [deploy.md](./deploy.md)。

**镜像与编排。** 根目录 `Dockerfile` 多阶段构建（安装依赖、下载 Kit 字体、`pnpm build`、打 Skill 包；运行阶段装 Playwright Chromium 与系统库，以非 root 的 `node` 用户运行）。`docker-compose.yml` 用同一个镜像起三个服务：`web`（主站）、`pages`（页面托管，数据卷只读）、`worker`（`start:worker`，13 节），共享数据卷 `/data`（`NOWME_DATA_DIR`）；端口只绑定本机回环地址，由反向代理对外。环境变量来自 `.env`（模板 `.env.production.example`）。页面托管只读挂载数据卷，所以生产必须显式设置 `NOWME_TICKET_SECRET`。

**备份与恢复。** `pnpm --filter @nowme/web backup` 把数据库（`VACUUM INTO` 在线一致性快照，主站运行时可执行）与 `revisions/` 打成 `NOWME_BACKUP_DIR/nowme-backup-<UTC 时间戳>.tar.gz`，保留最近 `NOWME_BACKUP_KEEP`（默认 7）份；先写 `.partial` 再改名。备份不含 `secret` 文件与 `NOWME_AI_ENCRYPTION_KEY`（后者必须单独保管）。`restore <文件> --to <目录>` 只写到不存在或为空的目录，校验归档内只有 `db.sqlite` 与 `revisions/`，恢复后执行 `PRAGMA integrity_check` 与 `foreign_key_check`，失败则清理目标。

**日志与请求 ID。** `NODE_ENV=production` 时主站与页面托管输出 JSON 行：`time`（ISO 8601）、`level`（`debug|info|warn|error`）、`service`（`web|pages`）、`msg`、`reqId`（请求内的日志才有），访问日志另有 `method`、`route`、`status`、`ms`；开发环境保持可读文本。JSON 日志里的邮箱与 `nmt_` 类 token 会被打码。每个响应带 `X-Request-Id`；只有声明了 `NOWME_TRUST_PROXY` 才接受上游传来的（须匹配 `^[A-Za-z0-9._-]{8,64}$`），否则自己生成。访问日志只记方法、路由模板（没有命中路由时只留前两段路径）、状态码、耗时，**不记录查询串、cookie、表单内容、邮箱**；页面托管路径里的票据一律写成 `/v/:ticket/...`。访问日志默认只在生产环境写。

**CI。** `.github/workflows/ci.yml`：push 与 pull_request 触发；Node 版本读 `.nvmrc`，pnpm 缓存；`test` 任务依次执行安装（`--frozen-lockfile`）、Playwright Chromium、Kit 字体、Skill 打包、`typecheck`、`test`、`build`；`e2e` 任务单独运行 `pnpm test:e2e`。

## 18. 生成进度与完成通知

<!-- T8.7 填写：进度推送方式、主站 CSP 变化、通知邮件 -->

## 19. 组织者工具：必答题、完成度与提醒、墙的群像

组织者是获客入口：这一节的三件事替代组织者原来要在群里做的接龙、问卷与催进度。代码：`apps/web/src/services/wall-questions.ts`、`services/reminders.ts`、`services/portrait.ts`、`hosted/portrait.ts`、`db/organizer-tools.ts`、`routes/organizer-tools.tsx`（成员一侧）、`routes/admin.tsx`（组织者一侧）、`views/organizer-tools.tsx`，迁移 `020_organizer_tools.sql`；取值常量在 `apps/web/src/constants.ts`（`WALL_QUESTION_LIMITS`、`REMINDER_LIMITS`、`PORTRAIT_LIMITS`）；ID 前缀 `wqn_`（`wallQuestion`）、`rmd_`（`wallReminder`）与事件类型在 `packages/contracts`。

### 19.1 必答题

- **设置**：建墙页（`POST /walls`，与墙的字段同一张表单，任何一处不合格都不建墙）或组织者后台（`POST /w/:wallId/admin/questions`）。每面墙 0–3 道；题目 2–30 字、单行；题型 `single` / `multi`；选项 2–12 个、每个 1–12 字，按换行、逗号、顿号、分号拆开，忽略大小写与空白去重。题目与选项过内容安全检查（kind `wall`，命中 422、不保存）。建墙页有“用例子填”（比赛的技能 / 组队、社团的部门、兴趣的程度、通用的来意；需要脚本）。
- **编辑语义**（一个事务）：表单里带着本墙题目 ID（`q<i>_id`）的视为编辑，其余为新题，不在表单里的旧题删除（回答级联删除）。**改了题目文字或题型 → 这道题的回答全部作废**；只改选项时保留回答，读取时只认仍然存在的选项（`effectiveChoices`：单选必须正好剩一个，多选至少剩一个，否则视为没答）。
- **必答**：有题目时，没答完的有效成员（含组织者自己）打开 `GET /w/:wallId`、`GET /w/:wallId/p/:pageId`、`GET /w/:wallId/me` 先 303 到 `/w/:wallId/questions?next=<原路径>`（`questionsGate`）。组织者后台、POST 路由不拦。组织者之后新加的题，已经在墙里的人下次打开时同样要答。
- **回答**：`GET /w/:wallId/questions` 显示表单（已答过时是“修改我的回答”，墙上“我的页面”区块有入口）；`POST` 字段：单选 `a<位置>=<选项序号>`，多选 `a<位置>_<选项序号>=1`，`qv` 为题目版本（题目 ID 与更新时间的哈希）。题目在作答期间变了 → 400 提示再看一眼，不保存；漏答 → 400、保留已选。保存后 303 到 `next`，`next` 只接受这面墙内的站内路径，否则回墙。记 `wall_answer`（`props: { questions }`）。
- **可见范围**：回答是墙内公开信息，回答页写明“组织者能看到你的回答；页面上墙后，墙上的人也能看到并按回答筛选”。
  - 组织者后台：每道题的选项人数（统计全部有效成员）、成员列表里每个人的回答、`GET /w/:wallId/admin/members.csv`（昵称、角色、加入时间、发布状态、各题回答；UTF-8 BOM；以 `= + - @` 制表符开头的单元格前加 `'`；`private, no-store`；没有邮箱）。
  - 墙上：只有**已上墙**的卡片带回答标签；筛选条只列墙上（按查看者过滤拉黑之后）至少 1 张卡片选了的选项和人数；同一题内“任一”、不同题之间“同时满足”，与搜索叠加，在浏览器里完成（`static/wall.js`），回答也进搜索文字。没上墙的人的回答不出现在墙上。
  - 退出、被移出的成员的回答不再出现在任何地方（查询只认有效成员）；注销时删除。

### 19.2 完成度与一键提醒

- **完成度**（后台 `#progress`）：已发布 / 有效成员、答完必答题 / 有效成员，“还没发布”（从没发布过）与“还没答完必答题”的昵称；撤下了页面的人只给人数，不提醒。
- **一键提醒**（`POST /w/:wallId/admin/remind`，无参数）：对象是“从没发布过”或“没答完必答题”的有效成员，排除组织者自己；**跳过**关闭了提醒邮件（`users.reminder_emails = 0`）、与组织者之间有拉黑（任一方向）、账号停用或注销的人——这几类合并显示为“N 人不接收提醒邮件”，看不出谁拉黑了谁；**限额**：同一面墙里每人 48 小时内最多一封、总共最多 3 封（`REMINDER_LIMITS`），超出的显示为“N 人最近已经提醒过”。
- 流程：一个事务里重新算名单、每人插一行 `wall_reminders(status = pending)` 占住限额、记 `wall_remind`（`props: { count, limited, declined }`）；然后在后台逐封投递，改为 `sent` / `failed`（失败只记日志里的数量）。并发两次点击不会重复提醒。303 回 `admin?reminded=<人数>#progress`。
- 邮件是**固定模板**的纯文本：主题 `「<墙名>」还差你的一页 / 还差你的回答 / 还差你的一页和回答`；正文有成员昵称、组织者昵称、缺什么（几道题）、墙的链接、关闭提醒的说明与 `/account/data#notifications`。组织者不能写正文，看不到任何人的邮箱。
- 另给一段“发到群里”的文字（只含昵称、人数与墙的链接），组织者自己复制。
- **开关**：“我的资料”的 `#notifications`，`POST /account/notifications`（`reminders=1/0`，表单先放 `0` 的隐藏字段再放复选框）。

### 19.3 墙的群像

- **谁能生成**：只有组织者（`POST /w/:wallId/admin/portrait`，后台与墙上的群像区块都有按钮），墙上至少 3 页（`too-few`，不调用模型）。模型按 `interview` 角色解析组织者的配置，没有时用平台 AI，**不收点数**，计入全站免费调用上限（12.1）。每面墙每滚动 24 小时 6 次（`wall_portrait_generate` 事件计数，成功失败都算，`daily`），同一面墙并发 1（`busy`），总时限 90 秒（`timeout`）。错误只显示 `PORTRAIT_ERROR_TEXT` 的固定文案。
- **输入**：墙上可见的全部发布（不按拉黑过滤：群像对全墙一样，且只有聚合内容），超过 150 页取最近发布的；每页只给编号 `page_N`、发布快照的一行介绍（≤80）、前 4 个接话点（各 ≤50）与这个人在墙内公开的必答题回答。**不给**名字、渲染文字、草稿、采访、画像、联系方式，没上墙的人一概不进。资料用 `untrusted()` 包成块。
- **输出**（工具 `submit_portrait`，zod 校验，不合格或收紧后为空时重试一次）：`summary`（≤80）与 `themes[]`（`title` ≤12、`detail` ≤36、`members` 为页面编号）。平台核对（`groundPortrait`）：主题人数 = 去重后、在 1..N 内的编号个数，少于 2 的主题丢弃；任何字段含链接 / 联系方式（`hasContact`）、某位成员的卡片名或昵称（≥2 字，规范化后包含）、“数字 + 个/位/名/人/成/%”的人数写法 → 主题丢弃、`detail` 或 `summary` 清空；按人数排序，最多 5 个。**准确人数只来自必答题统计**：生成时按当时墙上的人由服务端计算，随群像一起保存。
- **存储与展示**：`wall_portraits` 每墙一行（替换）。全墙有效成员在墙上看到“墙的群像”：一句话、话题与人数、各题的人数条、“发到群里”的可复制文字（墙名、上墙人数、一句话、各题前 6 个选项人数、话题人数、墙的链接）。界面说明“话题人数是 AI 归类的结果”。**展示条件**：保存的每一条来源发布都还在墙上，或只是被同一页的新版本替换（`superseded`，显示“生成后有 N 位成员更新了页面”）；任何一条因撤下、移出、退出、注销、关闭等结束或已不存在，群像停止展示，后台提示重新生成。关闭墙时删除。

### 19.4 S13 不变量（`apps/web/test/security/organizer-tools.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S13 | 只有这面墙的组织者能改必答题、一键提醒、生成群像、下载成员名单；回答只在墙内可见（组织者看全部有效成员，墙上只有已上墙的人），墙外、退出、被移出的人看不到也答不了；提醒邮件是固定模板，组织者看不到邮箱、不能写正文，不发给关闭提醒、与组织者之间有拉黑、停用的账号，且看不出谁拉黑了谁；群像只读墙上公开的发布快照与公开的回答，不含名字、草稿、渲染文字、联系方式与没上墙的人，输出里没有链接、名字与数字人数 | 成员 / 墙外的人请求后台工具 404 且不改不发不调模型；缺 CSRF、外站来源 403，页面凭证无效；墙外与被移出的人回答页 404；墙上 HTML 不含没上墙的人的回答、后台不含邮箱；提醒邮件不含组织者写的内容与任何邮箱，拉黑 / 停用的人收不到，人数合并显示；模型请求不含草稿、渲染文字、联系方式、没上墙的人与其回答，保存的结果不含名字 |

### 19.5 数据模型（迁移 `020_organizer_tools.sql`）

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `wall_questions` | `id wqn_`、`wall_id`、`position 0–2`、`prompt`、`kind single\|multi`、`options_json`、`created_at`、`updated_at` | |
| `wall_answers` | (`question_id`,`user_id`) 主键、`wall_id`、`choices_json`（选中的选项文字）、`updated_at` | 删题级联删除 |
| `wall_reminders` | `id rmd_`、`wall_id`、`organizer_id`、`user_id`、`reason publish\|answer\|both`、`status pending\|sent\|failed`、`created_at` | 只用于限额与后台显示，不存邮件内容与邮箱 |
| `wall_portraits` | `wall_id` 主键、`result_json`（`summary`、`themes[{title,detail,count}]`、`stats`）、`sources_json`（来源发布 ID）、`page_count`、`created_by`、`created_at` | |
| `users.reminder_emails` | `0 / 1`，默认 1 | |

注销（第 14 节）时删除他的全部回答、与他有关的提醒记录、他生成的群像；导出包含 `wallAnswers` 与 `receivesReminderEmails`。

### 19.6 路由

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /w/:wallId/questions` | 墙内有效成员 | 回答 / 修改；没有题目时 303 回 `next` |
| `POST /w/:wallId/questions` | 同上 | 保存回答（19.1） |
| `POST /w/:wallId/admin/questions` | 这面墙的组织者 | 保存必答题 → 303 `admin?notice=questions-saved#questions`；不合格 400、内容安全 422 |
| `POST /w/:wallId/admin/remind` | 同上 | 一键提醒（19.2） |
| `POST /w/:wallId/admin/portrait` | 同上 | 生成 / 刷新群像 → 303 `admin?notice=portrait-ready#portrait` 或 `?portrait=<错误>#portrait` |
| `GET /w/:wallId/admin/members.csv` | 同上 | 成员名单 |
| `POST /account/notifications` | 登录用户 | 提醒邮件开关 → 303 `/account/data?notice=reminders-on\|reminders-off#notifications` |

POST 均为会话 + CSRF + Origin 的表单路由，忽略 `Authorization`；无权访问与不存在一律 404。演示模式同样可用（提醒邮件写进演示发件箱）。

事件（只有数字与布尔）：`wall_questions_save`（`questions、added、changed、removed、reset`，建墙时 `created`）、`wall_answer`、`wall_remind`、`wall_portrait_generate`（`ok、durationMs、pages、themes` 与 token 数）。
