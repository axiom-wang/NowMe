# 1. 页面输出契约（`page/` 目录）

```
page/
├── index.html      # 必需。自包含单文件，HTML/CSS/JS 内联
├── card.json       # 必需。缩略卡
├── manifest.json   # 必需。版本与声明
├── cover.png       # 可选。缺省时由 preview / 平台截图生成
└── assets/         # 可选。页面用到的图片
```

只有上面这些路径会被提交；`page/` 里的其他文件（例如 `brief.md`、草稿）校验时给警告，**提交时不上传**。

## 1.1 `index.html`

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

## 1.2 `card.json`

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

## 1.3 `manifest.json`

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

## 1.4 `cover.png` 与 `assets/` [原型默认]

- `cover.png`：PNG，750×1000（375×500 CSS 像素、DPR 2 的首屏截图），≤ 600 KB。
- `assets/`：系统文件（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`）一律忽略、不上传、不报错；其余只允许 `png` / `jpg` / `jpeg` / `webp` / `gif`；文件名匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，最多一层子目录；单个 ≤ 2 MB，合计 ≤ 8 MB，最多 20 个。字体文件、SVG、HTML、脚本一律拒绝（SVG 请内联在 `index.html`）。

## 1.5 本地工作目录与 `nowme` 命令

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
