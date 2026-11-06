# NOWMe 本地开发计划（原型试跑 · 本地路线）

> 总规划师维护。每完成一项更新状态并提交。
> 需求：[MVP 需求](product-mvp-community-wall.md)、[页面生成方案](page-generation-byo-agent.md)、[信息收集与 brief](brief-collection.md)。
> 接口约定：[contracts.md](contracts.md)（所有任务的共同依据）。
> 范围：只做本地路线；平台托管路线、付费、派生（W18）、部署不做（contracts 第 9 节）。

状态：⬜ 未开始 · 🟡 进行中 · ✅ 完成（已由总规划师亲自验收）· ⛔ 阻塞

## 工作方式

- 总规划师不写业务代码；实现由子 Agent 完成，总规划师写规划与文档、读代码、亲自运行测试做验收。
- 每个任务说明写清：读哪几节文档、只改哪些目录、验收标准、必须附带的测试。
- 并行任务各用独立 git worktree，按目录划分归属，合并回 `main` 后统一验收。
- 子 Agent 汇报完成不等于完成：总规划师亲自运行测试与命令，通过后才标 ✅。
- 安全不变量 S1–S6（contracts 第 5 节）必须有自动化测试，并由独立子 Agent 审查。
- 子 Agent 模型分配（2026-11-06 用户决定，节省额度）：机械性任务用 Sonnet——T2.2 页面托管、T2.3 CLI fetch/submit、T2.4 与 T3.3 中的 e2e 测试脚本；需要判断的任务用 Opus——规划、T1.2 Skill/示例页、T3.4 安全审查，以及其余未列出的任务。

## 里程碑总览

| 里程碑 | 目标 | 检查点 | 状态 |
| --- | --- | --- | --- |
| M0 | 接口约定、monorepo 架子、CLAUDE.md | `pnpm install && pnpm typecheck && pnpm test` 全绿 | ✅ |
| M1 | Skill + Kit + 示例页 + `nowme validate` / `nowme preview` | 6 个示例页校验 0 错误，preview 产出封面且无渲染错误 | 🟡 |
| M2 | 提交、服务端校验与沙箱展示 | `nowme fetch` → `nowme submit` → 主人在工作区的沙箱 iframe 中看到页面；S2、S3、S4 测试通过 | 🟡 |
| M3 | 墙的闭环 | 登录 → 建墙 → 邀请 → 加入 → 提交 → 发布 → 浏览 → 想聊这个 → 组织者后台，e2e 通过；S1–S6 全部有测试；安全审查完成且高危问题已修复 | ⬜ |
| M4 | 端到端演练 | 子 Agent 扮演“用户的 Agent”按 Skill 完整走通，产出演练报告 | ⬜ |

## M0 架子与 CLAUDE.md

| 任务 | 负责 | 范围（只改） | 验收标准 | 状态 |
| --- | --- | --- | --- | --- |
| T0.1 接口约定 | 总规划师 | `docs/contracts.md` | 覆盖页面输出契约、校验规则与错误码、数据模型、API、票据、CSP、安全不变量、事件、场景配置 | ✅ |
| T0.2 Monorepo 脚手架 + `packages/contracts` | 子 Agent | 根配置、`packages/*`、`apps/*` 骨架 | 见下 | ✅ |
| T0.3 CLAUDE.md | 总规划师 | `CLAUDE.md` | 命令经过亲自运行；写明目录归属、约定与安全红线 | ✅ |

T0.2 验收：

1. `pnpm install`、`pnpm typecheck`、`pnpm test`、`pnpm build` 在干净检出上通过。
2. `packages/contracts` 导出：常量（限制、源、TTL）、ID 前缀与生成、场景类型、错误码、`card.json` / `manifest.json` / `SceneGuide` 的 zod schema、API 请求响应类型、票据 `signTicket` / `verifyTicket`、`buildPageCsp`、`PAGE_IFRAME_SANDBOX = "allow-scripts"`、令牌哈希工具。
3. 单测：票据（正确、过期、篡改签名、篡改版本 ID、错误密钥）；CSP（逐项包含 contracts S2 的指令，不含 `unsafe-eval`）；schema（合法与非法样例）。
4. 冒烟测试：SQLite 驱动可在 vitest 中使用；Playwright 能启动本机 Chromium。
5. 每个包/应用有可运行的占位入口与至少一个测试。

T0.2 验收记录（2026-11-06，总规划师亲自运行）：`pnpm install --frozen-lockfile`、`pnpm typecheck`（8 个项目）、`pnpm test`（14 文件 / 203 用例）、`pnpm test:security`（40 用例）、`pnpm test:e2e`（2 用例）、`pnpm build`、`node packages/cli/dist/bin.js --help` 全部通过。SQLite 用 `node:sqlite`；Playwright 锁定 1.58.2（匹配本机 Chromium 1208）。采纳的实现细节记入 contracts 第 8 节。

## M1 Skill + Kit + 示例页 + validate / preview

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T1.1 页面校验器 | 子 Agent（worktree） | `packages/validator` | T0.2 | ✅ |
| T1.2 Kit + Skill + 示例页 | 子 Agent（worktree） | `packages/kit`、`skill/` | T0.2 | ✅ |
| T1.3 渲染与 CLI validate / preview | 子 Agent（worktree） | `packages/render`、`packages/cli`（另：校验器两处小修、示例封面） | T1.1、T1.2 | 🟡 |
| T1.4 M1 验收 | 总规划师 | — | T1.3 | ⬜ |

验收标准：

- **T1.1**：contracts 2.2 的每个错误码至少有一个触发用例和一个不误报用例；合法示例 0 错误；`validatePage` 为纯函数（服务端可直接复用）；300 KB 页面校验 < 300 ms。
- **T1.2**：`nowme.css`（CSS 变量、字体变量、基础排版、若干动效与组件类，全部处理 `prefers-reduced-motion`）、`nowme.js`（`openLink`、`data-nm-href` 自动绑定、`reducedMotion`、少量组件）、`fonts.json`（全部为允许子集化与网页分发的开源授权）与字体下载脚本；`skill/SKILL.md` 完整覆盖采访 → brief 确认 → 生成 → validate → preview 自查 → 修改 → submit 的流程、隐私规则与禁止事项；4 份场景 JSON 通过 `SceneGuide` schema；6 个示例页（黑客松、兴趣社群、社团招新各 2 个，风格差异大）附设计思路；Kit 行为测试。
- **T1.3**：`nowme validate` 输出中文错误与修复指引、错误时退出码 1、自动补全 `extraChars`；`nowme preview` 用 contracts 的 CSP 构造函数与沙箱属性在双源本地服务器中渲染，产出 750×1000 `cover.png` 与整页截图，报告 2.3 的渲染问题，执行与平台一致的字体子集化；测试覆盖恶意页（CSP 违规、脚本异常）与子集化结果。
- **T1.4**：总规划师亲自对 6 个示例页运行 validate 与 preview，查看封面截图。

T1.1 验收记录（2026-11-06）：合并后 `pnpm typecheck`、`pnpm test`（27 文件 / 531 用例）、`pnpm test:security`（9 文件 / 240 用例）通过；总规划师用一份恶意页面手工抽查，外链、`window['local'+'Storage']`、`fetch`、凭证、缺少减少动效、`data-nm-id` 不足、card/manifest 非法均正确报出，中文提示可操作。遗留给 T1.3：校验器忽略 `.DS_Store` 等系统文件（contracts 1.4）。

T1.2 验收记录（2026-11-06）：合并后（解决 lockfile 与重复 catalog 键冲突，根 vitest 加入 `skill` 项目）`pnpm typecheck`、`pnpm test`（34 文件 / 987 用例）、`pnpm test:security`（11 文件 / 509 用例）通过；`fonts:fetch` 24 个 OFL 字体文件就位。总规划师用合并后的真实校验器跑 6 个示例页：**全部 0 错误**；警告为 `IGNORED_FILE`（`DESIGN.md`，预期）和 `FONT_NOT_IN_KIT`（Kit 新增的角色变量 `--nm-font-display` 等校验器不认识）。遗留给 T1.3：校验器识别 Kit 角色变量（contracts 1.1 已更新）。

## M2 提交、校验与沙箱展示

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T2.1 主站核心：数据库、登录、Agent API、提交管线、工作区预览 | 子 Agent（worktree A） | `apps/web` | M1 | ⬜ |
| T2.2 页面托管 | 子 Agent（worktree，Sonnet） | `apps/pages-host` | T0.2、T1.2（只依赖 contracts 与 Kit，提前与 T1.3 并行） | ✅ |
| T2.3 CLI fetch / submit / status / event | 子 Agent（worktree C） | `packages/cli` | M1 | ⬜ |
| T2.4 M2 集成与浏览器沙箱测试 | 子 Agent | `tests/e2e`、根脚本 | T2.1–T2.3 | ⬜ |

验收标准：

- **T2.1**：迁移建出 contracts 第 3 节全部表；邮箱验证码登录（dev outbox）、会话、CSRF 与 Origin 校验；Agent API 四个接口；提交时服务端重新校验 + 渲染 + 字体子集 + 按约定布局存储；rejected 不影响已有版本；工作区显示指令、版本与校验报告、沙箱 iframe 预览；开发种子脚本；S3、S4 集成测试。
- **T2.2**：S2 响应头逐项测试；票据缺失/伪造/过期/篡改 → 拒绝；路径穿越测试；只提供 `served/` 与 Kit；不设 cookie。
- **T2.3**：对模拟服务器的测试：凭证写入 `NOWME_HOME/credentials`（权限 0600），从不写入 `page/`；提交前先本地校验，只上传白名单文件；422 报告可读输出；事件上报不含内容、失败不影响主流程。
- T2.2 验收记录（2026-11-06）：合并后 `pnpm typecheck`、`pnpm test`（38 文件 / 1031 用例）、`pnpm test:security`（15 文件 / 549 用例）、pages-host 自身 47 用例通过。总规划师实际启动 pages-host 冒烟：真实票据 200 且 CSP 与 contracts S2 逐项一致、无 `Set-Cookie`；伪造票据、`../`、`%2e%2e` 穿越均 404；Kit 返回正确 content-type。遗留：`apps/pages-host/test/fixtures/test-font.woff2` 来源授权未核实，T1.3 合并后换成其提交的开源授权测试字体。
- **T2.4**：`pnpm test:e2e`：种子 → `nowme fetch` → `nowme submit` 示例页 → 浏览器打开工作区 → iframe 属性与 CSP 断言；恶意页在 iframe 内的 S1 探测全部失败。

## M3 墙的闭环

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T3.1 墙、邀请、加入、浏览、想聊这个、组织者后台、统计 | 子 Agent（worktree A） | `apps/web` 中墙与组织者相关路由/视图 | M2 | ⬜ |
| T3.2 工作区闭环：发布确认、撤下、恢复、公开链接、断开、退出、删除 | 子 Agent（worktree B） | `apps/web` 中工作区与公开链接相关路由/视图 | M2 | ⬜ |
| T3.3 安全不变量测试集 + 全流程 e2e | 子 Agent | `tests/`、`apps/web/test/security` | T3.1、T3.2 | ⬜ |
| T3.4 独立安全审查 | 子 Agent（只读） | `docs/security-review.md` | T3.3 | ⬜ |
| T3.5 修复审查问题 | 子 Agent | 按问题所在目录 | T3.4 | ⬜ |

验收标准：

- **T3.1**：W02 建墙（3 分钟内、只点选场景）、邀请链接与二维码；W04 加入；W13 随机排序网格；成员页沙箱展示；W14 想聊这个（未公开联系方式时无入口）；W03 组织者后台（无 context/草稿/版本入口；移除后立即下墙）；关闭墙；W20 事件与按墙统计脚本。
- **T3.2**：W11 缩略卡确认（未确认不上墙）；W12 发布确认联系方式与公开范围；W10 恢复旧版本；W15 公开链接开关（关闭后旧链接失效）；W16 撤下、退出、删除（删除前说明影响范围）；断开本地 Agent 立即吊销凭证。
- **T3.3**：`pnpm test:security` 覆盖 S1–S6 的全部最低测试要求；`pnpm test:e2e` 走通完整闭环。
- **T3.4**：审查报告逐条对照 S1–S6 与 OWASP 常见问题，给出严重度、位置、复现方式。
- **T3.5**：高、中危问题修复并补测试；低危问题记录在案。

## M4 端到端演练

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T4.1 用户 Agent 演练 | 子 Agent（扮演用户的 Agent） | 临时工作目录；报告 `docs/m4-drill-report.md` | M3 | ⬜ |
| T4.2 演练验收与汇报 | 总规划师 | `docs/build-plan.md` | T4.1 | ⬜ |

验收标准：

- **T4.1**：只凭工作区给出的指令与 `skill/`，完成 fetch → 采访（按给定人设回答）→ brief 确认 → 生成 → validate → preview 自查 → 至少一轮修改 → submit；之后在应用内发布、另一成员浏览并使用想聊这个、组织者后台看到发布状态；报告记录卡点、Skill 不清楚的地方和改进建议。
- **T4.2**：总规划师亲自复核演练产物，汇总后停下来汇报。

## 决策与偏差记录

| 日期 | 决策 |
| --- | --- |
| 2026-11-06 | 技术基线与源划分见 contracts 第 0 节；主站与页面托管使用不同站点（`localhost` / `127.0.0.1`） |
| 2026-11-06 | 页面访问用 HMAC 票据（30 分钟）放在路径中，未授权无法拿到页面内容；页面文档响应同时带 CSP `sandbox allow-scripts`，即使被直接打开也是不透明源 |
| 2026-11-06 | 开场白由 Agent 写进 `card.json`，主人在应用内确认；平台不调用模型，保持本地路线零模型费用 |
| 2026-11-06 | 公开链接只显示页面，不显示联系方式与“想聊这个” |
| 2026-11-06 | 被组织者移除的成员不能通过邀请重新加入；关闭的墙对所有人不可见 |
| 2026-11-06 | 采纳 T0.2 建议：主站 CSP 增加 `default-src`/`style-src`/`img-src`/`form-action`，主站校验 `Host` 头（contracts 第 5 节） |
| 2026-11-06 | 子 Agent 模型分配：机械性任务用 Sonnet，规划、安全审查、Skill/示例页等需要判断的任务用 Opus（见“工作方式”） |
| 2026-11-06 | `nowme.css` 内置全局减少动效规则；每款 Kit 字体提供 `--nm-font-<id>` 变量；本地工作目录与 CLI 命令见 contracts 1.5 |
