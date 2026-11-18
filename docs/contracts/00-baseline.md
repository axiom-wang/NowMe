# 0. 技术基线

| 项 | 约定 |
| --- | --- |
| 运行时 | Node 22，TypeScript（ESM，`"type": "module"`，strict），pnpm workspace |
| 测试 | vitest（单元、集成）；Playwright（浏览器行为、渲染、e2e），使用本机已缓存的 Chromium |
| 主站 `apps/web` | Hono + `@hono/node-server`，服务端渲染（`hono/jsx`），原生 CSS，少量原生客户端 JS；中文界面，移动端优先 |
| 数据库 | SQLite（优先 `node:sqlite`，M0 验证在 vitest 下可用，否则用 `better-sqlite3`），SQL 迁移文件 |
| 页面托管 `apps/pages-host` | 独立源，只做静态托管 + 票据校验 + 安全响应头，不读主站 cookie、不连数据库；本地统一启动时与主站共用一个进程，也保留单独启动能力 |
| 本地数据 | `NOWME_DATA_DIR`（默认仓库根 `.data/`）：`db.sqlite`、`revisions/<revisionId>/`、`outbox.log`、`secret` |

## 0.1 源（origin）[原型默认]

| 用途 | 默认值 | 环境变量 |
| --- | --- | --- |
| 主站 | `http://localhost:3000` | `NOWME_WEB_ORIGIN` |
| 页面托管 | `http://127.0.0.1:4000` | `NOWME_PAGES_ORIGIN` |
| CLI 预览外壳 / 页面 | `http://localhost:4100` / `http://127.0.0.1:4101` | `nowme preview --port` |

主站和页面托管故意使用 `localhost` 与 `127.0.0.1` 两个不同的**站点**（cookie 不按端口隔离，同主机不同端口会共享 cookie）。

源是对外地址；进程默认监听源里的主机与端口，部署在反向代理之后时用 `NOWME_WEB_LISTEN` / `NOWME_PAGES_LISTEN` 单独指定（10.1）。

## 0.2 模块与目录归属

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
