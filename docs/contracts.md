# NOWMe 接口约定（原型试跑 · 本地路线 + 平台托管路线）

> 本文是所有模块共同遵守的契约：页面输出契约、数据模型、API、校验规则、安全不变量。
> 需求来源：[MVP 需求](product-mvp-community-wall.md)、[页面生成方案](page-generation-byo-agent.md)、[信息收集与 brief](brief-collection.md)。
> 范围：原型试跑的**本地路线**，以及平台托管路线的应用内采访、托管生成、应用内修改与账号 AI 配置（第 9 节，正文见 [hosted-route.md](hosted-route.md)）；收费与免费次数方案已取消，派生（W18）不做。
> 修改本文需要总规划师同意；实现与本文冲突时，以本文为准并提出修改建议。
> 文中标 **[原型默认]** 的数值是需求文档里 [待定] 项的临时取值，统一放在 `packages/contracts` 的常量里，便于以后调整。

## 0. 技术基线

| 项 | 约定 |
| --- | --- |
| 运行时 | Node 22，TypeScript（ESM，`"type": "module"`，strict），pnpm workspace |
| 测试 | vitest（单元、集成）；Playwright（浏览器行为、渲染、e2e），使用本机已缓存的 Chromium |
| 主站 `apps/web` | Hono + `@hono/node-server`，服务端渲染（`hono/jsx`），原生 CSS，少量原生客户端 JS；中文界面，移动端优先 |
| 数据库 | SQLite（优先 `node:sqlite`，M0 验证在 vitest 下可用，否则用 `better-sqlite3`），SQL 迁移文件 |
| 页面托管 `apps/pages-host` | 独立进程、独立源，只做静态托管 + 票据校验 + 安全响应头，不读主站 cookie、不连数据库 |
| 本地数据 | `NOWME_DATA_DIR`（默认仓库根 `.data/`）：`db.sqlite`、`revisions/<revisionId>/`、`outbox.log`、`secret` |

### 0.1 源（origin）[原型默认]

| 用途 | 默认值 | 环境变量 |
| --- | --- | --- |
| 主站 | `http://localhost:3000` | `NOWME_WEB_ORIGIN` |
| 页面托管 | `http://127.0.0.1:4000` | `NOWME_PAGES_ORIGIN` |
| CLI 预览外壳 / 页面 | `http://localhost:4100` / `http://127.0.0.1:4101` | `nowme preview --port` |

主站和页面托管故意使用 `localhost` 与 `127.0.0.1` 两个不同的**站点**（cookie 不按端口隔离，同主机不同端口会共享 cookie）。

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

ID 一律为 `<前缀>_<16 字节随机 base32 小写>`；时间为 ISO 8601 UTC 字符串。一次性 token、页面凭证、会话令牌、登录验证码**只存 SHA-256 哈希**；邀请码与公开链接令牌是需要反复展示给组织者/主人的可分享链接，明文保存，可随时轮换。

| 令牌 | 格式 |
| --- | --- |
| 一次性 token | `nmt_` + 32 字节 base64url |
| 页面凭证 | `nmc_` + 32 字节 base64url |
| 会话令牌 | `nms_` + 32 字节 base64url |
| 邀请码 | `inv_` + 16 字节 base32 小写 |
| 公开链接令牌 | `pub_` + 24 字节 base64url（注意与 publication ID 前缀区分：publication ID 用 `pbl_`） |

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `users` | `id usr_`、`email` 唯一（小写）、`nickname`、`created_at` | 首次登录时填写昵称 |
| `login_codes` | `id`、`email`、`code_hash`、`attempts`、`expires_at`、`used_at` | 6 位数字，10 分钟，最多 5 次尝试 |
| `sessions` | `id`（会话令牌哈希）、`user_id`、`csrf_token`、`created_at`、`expires_at` | 30 天 |
| `walls` | `id wal_`、`name`、`description`、`scene_type`、`organizer_note`、`organizer_id`、`invite_code`、`status open\|closed`、`created_at`、`closed_at` | |
| `memberships` | `id mem_`、`wall_id`、`user_id`、`role organizer\|member`、`status active\|left\|removed`、`joined_at`、`ended_at` | (`wall_id`,`user_id`) 唯一；组织者建墙时自动成为成员 |
| `pages` | `id pg_`、`membership_id` 唯一、`wall_id`、`owner_id`、`contact_channel`、`contact_value`、`contact_public`、`public_token`（空=未开启）、`created_at`、`updated_at` | 加入墙时创建 |
| `agent_tokens` | `id`、`page_id`、`token_hash`、`expires_at`、`used_at`、`created_at` | 一次性 token |
| `page_credentials` | `id`、`page_id`、`credential_hash`、`created_at`、`last_used_at`、`revoked_at`、`client_cli_version`、`client_skill_version`（T3.6，迁移 003：exchange 时 CLI 自报的版本，可空，只用于显示） | 每页同时最多一个有效凭证 |
| `revisions` | `id rev_`、`page_id`、`number`（页内递增）、`source`（`local-agent`）、`credential_id`、`status accepted\|rejected`、`report_json`、`card_json`、`manifest_json`、`rendered_text`、`render_json`、`created_at` | 文件存 `revisions/<id>/`；rejected 版本只存报告 |
| `publications` | `id pbl_`、`page_id`、`revision_id`、`card_json`（主人确认后的）、`contact_json`（发布时快照）、`published_at`、`ended_at`、`end_reason superseded\|withdrawn\|removed\|closed\|deleted` | 不可变快照；每页至多一个 `ended_at IS NULL` |
| `events` | `id evt_`、`type`、`wall_id`、`page_id`、`actor_id`、`props_json`、`created_at` | 只存类型、ID、数值/布尔属性，**不存内容** |

页面的展示状态由数据推导：有活跃 publication → `published`；有 publication 历史但当前无 → `withdrawn`；否则 `unpublished`。

`revisions/<id>/` 布局：`original/`（提交的原文件）、`served/index.html`（注入字体 `@font-face` 后的版本）、`served/assets/...`、`served/_fonts/<fontId>-<weight>.woff2`、`cover.png`、`render/full.png`。

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
| `GET /dev/outbox` | 仅非生产环境 | 本地查看发出的验证码（代替真实邮件） |
| `GET /` | 登录用户 | “我的”：我加入的墙、每页发布状态、入口 |
| `GET /walls/new`、`POST /walls` | 登录用户 | 建墙：名称、简介、场景类型、可选一句话 |
| `GET /join/:inviteCode`、`POST /join/:inviteCode` | 登录用户 | 加入墙（已被移除的成员不能再加入；已关闭的墙不能加入） |
| `GET /w/:wallId` | 墙内有效成员 | 墙：名称、简介、随机排序的缩略卡网格、“我的页面”入口 |
| `GET /w/:wallId/p/:pageId` | 墙内有效成员 | 成员页面（沙箱 iframe）+ 接话点 + “想聊这个” |
| `POST /w/:wallId/p/:pageId/chat` | 墙内有效成员 | 记录事件，返回联系方式与开场白（主人未公开联系方式时不显示入口，且接口返回 404） |
| `GET /w/:wallId/me` | 页面主人 | 创作工作区：Agent 指令、连接状态、版本列表（含校验结果）、版本预览、发布确认 |
| `POST /w/:wallId/me/instruction` | 页面主人 | 生成新的一次性 token 与指令（旧的未使用 token 作废） |
| `POST /w/:wallId/me/disconnect` | 页面主人 | 吊销页面凭证 |
| `POST /w/:wallId/me/publish` | 页面主人 | `revisionId`、确认后的 `tagline`、`hooks[]`（text/opener）、联系方式、`contactPublic`、确认勾选 → 新 publication（旧的 `superseded`）。也用于“恢复旧版本” |
| `POST /w/:wallId/me/withdraw` | 页面主人 | 撤下 |
| `POST /w/:wallId/me/public-link` | 页面主人 | `enabled=1/0`；开启生成新链接，关闭立即使旧链接失效 |
| `POST /w/:wallId/me/delete` | 页面主人 | 先展示影响范围确认页，确认后删除所有版本文件与发布，保留成员关系 |
| `POST /w/:wallId/leave` | 成员（组织者除外） | 退出墙：撤下页面、吊销凭证 |
| `GET /w/:wallId/admin` | 组织者 | 邀请链接与二维码、成员列表（昵称、加入时间、发布状态）、移除、关闭墙 |
| `POST /w/:wallId/admin/remove`、`POST /w/:wallId/admin/close` | 组织者 | 移除成员（其页面立即下墙、凭证吊销）；关闭墙 |
| `GET /s/:publicToken` | 任何人 | 公开链接：只显示当前发布版本的页面，不显示联系方式与“想聊这个” |
| `GET /w/:wallId/covers/:pageId.png` | 墙内有效成员 | 已发布版本的封面图 |

无权访问时一律返回 `404`（不暴露墙或页面是否存在）；未登录访问需登录的页面重定向到 `/login?next=...`。

### 4.3 Agent 指令格式（W05）

```
/nowme-page wal_xxx nmt_xxx --server http://localhost:3000
```

工作区同时显示一段等价的纯文本说明，给不支持 Skill 的 Agent（第 0 步让它按 `/skill/install.md` 下载工具包，用里面的单文件 CLI，不需要装成 Skill）。工作区还始终显示「安装 NOWMe Skill」（4.5）：让 Agent 自己安装的一句话、重开会话、自检方法、`Unknown command` 的原因与解决办法；这块说明里没有 token，没连接过且没有版本时默认展开。已连接时连接状态显示 CLI 自报的 Skill 版本，落后于主站分发的版本时提示更新。token 有效期 [原型默认] 72 小时（覆盖“现场拿到、当晚执行”），`NOWME_AGENT_TOKEN_TTL_HOURS` 可调。

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

真实用户手里没有本仓库：主站托管 Skill 包，包里自带单文件 CLI（1.5），装好 Skill 就能用。所有地址都由 `NOWME_WEB_ORIGIN` 拼出，本地与上线走同一套代码。

| 路径 | 认证 | 内容 |
| --- | --- | --- |
| `GET /skill` | 无 | 给人看的安装页：让 Agent 自己安装的一句话（推荐）、市场渠道（配置了才显示）、手动下载与 sha256、重开会话、自检、不支持 Skill 时怎么办、常见问题 |
| `GET /skill/install.md` | 无 | 给 Agent 读的安装说明（`text/markdown`，`max-age=300`）：下载 → 核对 sha256 → 解压 → 以 `nowme-page` 为目录名放进**它自己的用户级 Skill 目录**（不确定就问用户，不要猜）→ 提醒重开会话 → `node <目录>/scripts/nowme.mjs --version` 自检 |
| `GET /skill/manifest.json` | 无 | `{ name: "nowme-page", version, file, sha256, bytes, minNode, url }`（`max-age=300`） |
| `GET /skill/nowme-page-<version>.tar.gz` | 无 | Skill 包（`application/gzip`，`max-age=31536000, immutable`）；文件名不对 `404` |

- **Skill 包**：`pnpm --filter @nowme/skill pack:skill` 打到 `skill/dist-package/`（`build` 与主站 `dev` / `start:source` 会先打包）。只含 `SKILL.md`、`reference/`、`scenes/`、`templates/`、`examples/` 与 `scripts/nowme.mjs`；根目录 `nowme-page/`；ustar + gzip，可复现（排序、固定时间戳）；打包时发现 token / 凭证样式的字符串就失败。主站启动时读取并核对 sha256，不一致或没有打包时当作没有 Skill 包（安装页提示，manifest `404`）。
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
| S5 | 组织者看不到私密内容：组织者后台只有昵称、加入时间、发布状态；组织者无法访问他人的工作区、版本、未发布内容、未公开的联系方式；本地路线的 brief / 画像从不上传 | 组织者身份请求他人工作区、版本预览、票据签发 → 404；后台 HTML 不含版本 ID、未发布 card 内容、私密联系方式；提交接口丢弃白名单外文件 |
| S6 | 非成员看不到墙：未登录、非成员、已退出、已移除的用户访问墙、成员页、封面、chat 接口都拿不到内容；pages-host 无票据、票据伪造、过期、篡改版本 ID 时拒绝；被移除成员立即失去访问且其页面立即下墙；关闭的墙对所有人不可见；关闭公开链接后旧链接失效 | 集成测试覆盖每种身份 × 每个路由；pages-host 票据测试 |

主站自身也设 CSP：`default-src 'self'`、`frame-src <pages>`、`script-src 'self'`、`style-src 'self'`、`img-src 'self' data:`、`form-action 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`（主站不用内联脚本和内联样式）。主站校验 `Host` 头：不等于 `NOWME_WEB_ORIGIN` 的主机时返回 421 或重定向到 `NOWME_WEB_ORIGIN`（cookie 不按端口隔离，不能让主站在页面托管的主机名下签发 cookie）。

### 5.1 `nowme.openLink` 协议

Kit 调用 `parent.postMessage({ type: 'nowme:open-link', url }, '*')`。主站监听时校验 `event.source === iframe.contentWindow`、`url` 为 `https:`，弹出确认（显示目标域名），用户确认后 `window.open(url, '_blank', 'noopener,noreferrer')`。其他消息一律忽略。

### 5.2 iframe 自我导航

沙箱允许 iframe 导航它自己，CSP 也不管导航，所以页面脚本运行时拼出的 `location = '...'` 能把 iframe 带到外部网站（钓鱼、记录访客 IP）。主站展示页面时监听 iframe 的 `load` 事件：第一次加载之后再次触发 `load`，即视为页面自我导航，立即把 `src` 重置为空白页并在 iframe 外提示“这个页面试图跳转，已拦截”。需要浏览器测试覆盖。

## 6. 事件（W20）

| 来源 | 类型 |
| --- | --- |
| CLI（凭证上报，不含内容） | `agent_fetch`、`agent_validate`、`agent_preview`、`agent_generate`、`agent_submit` |
| 主站 | `wall_view`、`page_open`、`want_to_chat`、`publish`、`withdraw`、`public_link_on`、`public_link_off`、`join`、`leave`、`member_removed`、`wall_closed`；`remote_preview`（服务端远程预览，用于限流，4.1） |

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

正文见 [hosted-route.md](hosted-route.md)（2026-11-07 确认）：配置与模型、应用内采访、使用用户 API 的生成与修改、运行保护限制、加密凭证与数据模型（迁移 `002_hosted.sql` 和 `004_user_models.sql`）、主站路由、事件、安全不变量 S7（托管资料只属于主人）与 S8（生成环境隔离且结果不受信）。S7、S8 与第 5 节的 S1–S6 同等要求自动化测试。

## 10. 原型试跑不做

收费方案已取消；本期不做 W09 应用内素材管理、修改时把新信息写回画像、派生到新墙（W18）、真实邮件发送、外部内容审核接入（只保存渲染文字和截图供人工审核）、部署。
