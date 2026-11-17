# NOWMe 本地开发计划（本地 Agent + 网页内自带 API）

> 总规划师维护。每完成一项更新状态并提交。
> 需求：[MVP 需求](product-mvp-community-wall.md)、[页面生成方案](page-generation-byo-agent.md)、[信息收集与 brief](brief-collection.md)。
> 接口约定：[contracts.md](contracts.md)（所有任务的共同依据）。
> 范围：本地 Agent + 网页内自带 API 创作。取消收费与免费次数；派生（W18）、部署不做（contracts 第 9 节）。

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
| M1 | Skill + Kit + 示例页 + `nowme validate` / `nowme preview` | 6 个示例页校验 0 错误，preview 产出封面且无渲染错误 | ✅ |
| M2 | 提交、服务端校验与沙箱展示 | `nowme fetch` → `nowme submit` → 主人在工作区的沙箱 iframe 中看到页面；S2、S3、S4 测试通过 | ✅ |
| M3 | 墙的闭环 | 登录 → 建墙 → 邀请 → 加入 → 提交 → 发布 → 浏览 → 想聊这个 → 组织者后台，e2e 通过；S1–S6 全部有测试；安全审查完成且高危问题已修复 | 🟡 |
| M4 | 端到端演练 | 子 Agent 扮演“用户的 Agent”按 Skill 完整走通，产出演练报告 | ⬜ |
| M5 | 平台托管路线（不收费） | 应用内采访 → brief 确认 → 托管生成（同一 Skill + 平台重新校验）→ 预览 → 按区块修改 → 发布；账号自带 API 与加密凭证；S7、S8 测试；假 Claude 客户端 e2e | 🟡 |
| M6 | 网页内自带 API 与取消收费 | 账号配置、加密凭证、用户隔离、删除/更换停止请求、旧库升级、取消次数额度、桌面/手机及生成发布回归 | ✅ |

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
| T1.3 渲染与 CLI validate / preview | 子 Agent（worktree） | `packages/render`、`packages/cli`（另：校验器两处小修、示例封面） | T1.1、T1.2 | ✅ |
| T1.4 M1 验收 | 总规划师 | — | T1.3 | ✅ |

验收标准：

- **T1.1**：contracts 2.2 的每个错误码至少有一个触发用例和一个不误报用例；合法示例 0 错误；`validatePage` 为纯函数（服务端可直接复用）；300 KB 页面校验 < 300 ms。
- **T1.2**：`nowme.css`（CSS 变量、字体变量、基础排版、若干动效与组件类，全部处理 `prefers-reduced-motion`）、`nowme.js`（`openLink`、`data-nm-href` 自动绑定、`reducedMotion`、少量组件）、`fonts.json`（全部为允许子集化与网页分发的开源授权）与字体下载脚本；`skill/SKILL.md` 完整覆盖采访 → brief 确认 → 生成 → validate → preview 自查 → 修改 → submit 的流程、隐私规则与禁止事项；4 份场景 JSON 通过 `SceneGuide` schema；6 个示例页（黑客松、兴趣社群、社团招新各 2 个，风格差异大）附设计思路；Kit 行为测试。
- **T1.3**：`nowme validate` 输出中文错误与修复指引、错误时退出码 1、自动补全 `extraChars`；`nowme preview` 用 contracts 的 CSP 构造函数与沙箱属性在双源本地服务器中渲染，产出 750×1000 `cover.png` 与整页截图，报告 2.3 的渲染问题，执行与平台一致的字体子集化；测试覆盖恶意页（CSP 违规、脚本异常）与子集化结果。
- **T1.4**：总规划师亲自对 6 个示例页运行 validate 与 preview，查看封面截图。

T1.1 验收记录（2026-11-06）：合并后 `pnpm typecheck`、`pnpm test`（27 文件 / 531 用例）、`pnpm test:security`（9 文件 / 240 用例）通过；总规划师用一份恶意页面手工抽查，外链、`window['local'+'Storage']`、`fetch`、凭证、缺少减少动效、`data-nm-id` 不足、card/manifest 非法均正确报出，中文提示可操作。遗留给 T1.3：校验器忽略 `.DS_Store` 等系统文件（contracts 1.4）。

T1.2 验收记录（2026-11-06）：合并后（解决 lockfile 与重复 catalog 键冲突，根 vitest 加入 `skill` 项目）`pnpm typecheck`、`pnpm test`（34 文件 / 987 用例）、`pnpm test:security`（11 文件 / 509 用例）通过；`fonts:fetch` 24 个 OFL 字体文件就位。总规划师用合并后的真实校验器跑 6 个示例页：**全部 0 错误**；警告为 `IGNORED_FILE`（`DESIGN.md`，预期）和 `FONT_NOT_IN_KIT`（Kit 新增的角色变量 `--nm-font-display` 等校验器不认识）。遗留给 T1.3：校验器识别 Kit 角色变量（contracts 1.1 已更新）。

T1.3 / T1.4 验收记录（2026-11-06）：合并后 `pnpm typecheck`、`pnpm test`（48 文件 / 1151 用例）、`pnpm test:security`（16 文件 / 575 用例）通过。总规划师逐个运行 `pnpm nowme validate` 与 `pnpm nowme preview` 于 6 个示例：全部“通过”，唯一警告为 `DESIGN.md` 的 `IGNORED_FILE`（预期），0 个 `RENDER_*` 问题；查看 6 张封面，字体生效、风格差异明显、场景侧重正确。已知小问题：club-senior-quest 封面截在打字机动画中途（“欢迎来到|”），建议之后封面改用减少动效下的静态终态。pages-host 测试字体已换成 T1.3 提交的 Noto Sans SC 子集（OFL-1.1，附授权文件）。

## M2 提交、校验与沙箱展示

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T2.1 主站核心：数据库、登录、Agent API、提交管线、工作区预览 | 子 Agent（worktree A） | `apps/web`（另：`packages/contracts` 的 `buildWebCsp`） | M1 | ✅ |
| T2.2 页面托管 | 子 Agent（worktree，Sonnet） | `apps/pages-host` | T0.2、T1.2（只依赖 contracts 与 Kit，提前与 T1.3 并行） | ✅ |
| T2.3 CLI fetch / submit / status / event | 子 Agent（worktree C，Sonnet） | `packages/cli` | M1 | ✅ |
| T2.4 M2 集成与浏览器沙箱测试 | — | 并入 T3.3（见决策记录） | — | ➡️ |

验收标准：

- **T2.1**：迁移建出 contracts 第 3 节全部表；邮箱验证码登录（dev outbox）、会话、CSRF 与 Origin 校验；Agent API 四个接口；提交时服务端重新校验 + 渲染 + 字体子集 + 按约定布局存储；rejected 不影响已有版本；工作区显示指令、版本与校验报告、沙箱 iframe 预览；开发种子脚本；S3、S4 集成测试。
- **T2.2**：S2 响应头逐项测试；票据缺失/伪造/过期/篡改 → 拒绝；路径穿越测试；只提供 `served/` 与 Kit；不设 cookie。
- **T2.3**：对模拟服务器的测试：凭证写入 `NOWME_HOME/credentials`（权限 0600），从不写入 `page/`；提交前先本地校验，只上传白名单文件；422 报告可读输出；事件上报不含内容、失败不影响主流程。
- T2.2 验收记录（2026-11-06）：合并后 `pnpm typecheck`、`pnpm test`（38 文件 / 1031 用例）、`pnpm test:security`（15 文件 / 549 用例）、pages-host 自身 47 用例通过。总规划师实际启动 pages-host 冒烟：真实票据 200 且 CSP 与 contracts S2 逐项一致、无 `Set-Cookie`；伪造票据、`../`、`%2e%2e` 穿越均 404；Kit 返回正确 content-type。遗留：`apps/pages-host/test/fixtures/test-font.woff2` 来源授权未核实，T1.3 合并后换成其提交的开源授权测试字体。
- T2.3 验收记录（2026-11-06）：合并后 `pnpm typecheck` 通过，CLI 包 76 用例、`pnpm test:security`（17 文件 / 582 用例）通过；凭证文件 0600/目录 0700、输出统一脱敏、`page/` 内拒绝运行。与真实服务端的联调放在 T2.1 合并后由总规划师亲自走一遍。
- T2.1 验收记录（2026-11-06）：合并后 `pnpm typecheck`、`pnpm test`（62 文件 / 1301 用例）、`pnpm test:security`（22 文件 / 645 用例）通过。总规划师亲自端到端：启动 `pnpm dev` → 种子脚本 → 在临时工作目录用真实 CLI `nowme fetch`（凭证 0600，`nowme.json`/`context.json` 无凭证）→ 复制示例页并夹带 `brief.md` 后 `nowme submit`（第 1 版通过，`brief.md`/`DESIGN.md` 未上传）→ 再用同一 token `fetch` 被拒 → Chromium 登录（outbox 验证码）打开工作区：iframe `sandbox="allow-scripts"`、src 指向 127.0.0.1:4000、页面字体与版式正确、iframe 内读 cookie 抛 `SecurityError`、主站 0 个控制台错误。
- **T2.4**：`pnpm test:e2e`：种子 → `nowme fetch` → `nowme submit` 示例页 → 浏览器打开工作区 → iframe 属性与 CSP 断言；恶意页在 iframe 内的 S1 探测全部失败。

## M3 墙的闭环

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T3.1 墙、邀请、加入、浏览、想聊这个、组织者后台、统计 | 子 Agent（worktree A） | `apps/web` 中墙与组织者相关路由/视图 | M2 | ✅ |
| T3.2 工作区闭环：发布确认、撤下、恢复、公开链接、断开、退出、删除 | 子 Agent（worktree B） | `apps/web` 中工作区与公开链接相关路由/视图 | M2 | ✅ |
| T3.3 安全不变量测试集 + 全流程 e2e + `pnpm demo` | 子 Agent（Sonnet） | `tests/`、`apps/web/test/security`、`apps/web/scripts`、根脚本 | T3.1、T3.2 | ✅ |
| ⏸ 用户预览检查点 | 总规划师 | 准备 `pnpm demo`（演示墙 + 6 个示例页已发布）并停下来，等用户看过预览效果再继续 | T3.3 | ⏸ 等待用户 |
| T3.4 独立安全审查 | 子 Agent（只读） | `docs/security-review.md` | 用户预览检查点 | ⬜ |
| T3.5 修复审查问题 | 子 Agent | 按问题所在目录 | T3.4 | ⬜ |
| T3.6 Skill 分发：GitHub 独立仓库分发 Skill 包 + 内置单文件 CLI + 服务端预览 + 通用安装说明 | 总规划师（本会话直接实现） | `packages/contracts`、`packages/cli`、`skill/`、`apps/web`、`tests/e2e`、`docs/` | M3 | 🟡 待用户验收 |

验收标准：

- **T3.1**：W02 建墙（3 分钟内、只点选场景）、邀请链接与二维码；W04 加入；W13 随机排序网格；成员页沙箱展示；W14 想聊这个（未公开联系方式时无入口）；W03 组织者后台（无 context/草稿/版本入口；移除后立即下墙）；关闭墙；W20 事件与按墙统计脚本。
- **T3.2**：W11 缩略卡确认（未确认不上墙）；W12 发布确认联系方式与公开范围；W10 恢复旧版本；W15 公开链接开关（关闭后旧链接失效）；W16 撤下、退出、删除（删除前说明影响范围）；断开本地 Agent 立即吊销凭证。
- T3.1 / T3.2 验收记录（2026-11-07）：两个任务的原子 Agent 被额度上限中断后，由新 Agent 在原 worktree 接手完成。合并后无冲突；`pnpm typecheck`、`pnpm test`（69 文件 / 1404 用例）、`pnpm test:security`（25 文件 / 682 用例）通过；核对发布快照 `{channel, value}` 与墙页解析一致。遗留：工作区/公开页手机框在 375px 宽下超出卡片（`app.css`），交给 T3.3 修。删除页面暂记 `withdraw` + `public_link_off`（带 `pageDeleted`）；版本墓碑以 `report_json.validatorVersion = "deleted"` 标记、发布墓碑 `card_json = {"deleted":true}`；退出墙时同时关闭公开链接；被移除成员打开邀请链接得到 403 友好提示。
- **T3.3**：`pnpm test:security` 覆盖 S1–S6 的全部最低测试要求；`pnpm test:e2e` 走通完整闭环。
- **用户预览检查点**（2026-11-06 用户要求）：M3 安全审查（T3.4）和 M4 之前停下，由用户亲自看预览效果再决定。需要一条命令启动可浏览的演示：主站 + 页面托管 + 一面演示墙（组织者 + 6 名成员，各自发布一个 Skill 示例页），并给出登录方式。
- T3.3 验收记录（2026-11-07）：合并后 `pnpm typecheck`、`pnpm test`（71 文件 / 1406 用例）、`pnpm test:security`（26 文件 / 683 用例）、`pnpm test:e2e`（5 用例：全流程、S1/S2 恶意页探测、5.2 自我导航拦截、2 冒烟）全部通过。S1–S6 覆盖表见 T3.3 汇报，未发现需标记的真实缺陷。补充发现：服务端渲染阶段已会拒绝加载即自我导航或触发 CSP 违规的页面。总规划师亲自运行 `pnpm demo`（种子约 40 秒）并用 Chromium 走路线：墙上 5 张卡片（周一鸣未发布未出现）、成员页沙箱渲染正常、“想聊这个”显示邮箱与开场白、组织者后台只有昵称/加入时间/发布状态且 HTML 不含 `rev_` 与联系方式、0 个控制台错误。
- **T3.4**：审查报告逐条对照 S1–S6 与 OWASP 常见问题，给出严重度、位置、复现方式。审查范围包含 T3.6 新增的公开路由（`/skill*`）与 `POST /api/agent/previews`。
- **T3.5**：高、中危问题修复并补测试；低危问题记录在案。
- **T3.6**（2026-11-07 用户提出：工作区要让用户知道怎么安装 Skill；用户进一步要求面向上线后的真实用户、通用于各种 Agent）：
  - 工作区始终显示「安装 NOWMe Skill」：让 Agent 自己安装的一句话（主站真实地址）、重开会话、自检方法、不支持 Skill 时用纯文本说明、`Unknown command` 的原因与解决办法；不含 token；不点名任何 Agent 产品。
  - 公开仓库 `axiom-wang/nowme-skill` 与 GitHub Releases 分发完整成品，主站保留安装入口与离线镜像（`/skill`、`/skill/install.md`、`/skill/manifest.json`、归档），sha256 可核对、可复现；可配置市场渠道。
  - Skill 包自带单文件 CLI（只需 Node 22），`preview` 由服务端渲染（`POST /api/agent/previews`，不存任何东西、按页限流）；纯文本说明第 0 步也指向同一工具包。
  - 连接后工作区显示 CLI 自报的 Skill 版本，落后时提示更新；`nowme fetch` 也会提示。
  - 验收：`pnpm typecheck`、`pnpm test`、`pnpm test:security`、`pnpm test:e2e`（新增 `skill-install.e2e.ts`：从主站下载、核对、解压，用 Skill 自带的 CLI 走完 fetch → validate → 服务端预览 → submit）全部通过。

## M4 端到端演练

| 任务 | 负责 | 范围（只改） | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| T4.1 用户 Agent 演练 | 子 Agent（扮演用户的 Agent） | 临时工作目录；报告 `docs/m4-drill-report.md` | M3 | ⬜ |
| T4.2 演练验收与汇报 | 总规划师 | `docs/build-plan.md` | T4.1 | ⬜ |

验收标准：

- **T4.1**：只凭工作区给出的指令与 `skill/`，完成 fetch → 采访（按给定人设回答）→ brief 确认 → 生成 → validate → preview 自查 → 至少一轮修改 → submit；之后在应用内发布、另一成员浏览并使用想聊这个、组织者后台看到发布状态；报告记录卡点、Skill 不清楚的地方和改进建议。
- **T4.2**：总规划师亲自复核演练产物，汇总后停下来汇报。

## M5 平台托管路线（contracts 9 / [hosted-route.md](hosted-route.md)）

| 任务 | 负责 | 范围（只改） | 状态 |
| --- | --- | --- | --- |
| T5.0 contracts 提案与确认 | 总规划师 | `docs/hosted-route.md`、`docs/contracts.md` | ✅（2026-11-07 确认 D1–D8） |
| T5.1 配置、迁移、仓储 | — | `packages/contracts`（config、常量、ID 前缀、事件、校验码）、`apps/web/migrations/002_hosted.sql`、`apps/web/src/db/hosted.ts` | ✅ |
| T5.2 采访与 brief | — | `apps/web/src/hosted/{model-client,prompts,interview,brief}.ts`、路由与视图 | ✅ |
| T5.3 托管生成与修改、运行限制 | — | `apps/web/src/hosted/{tools,runner,previewer,service}.ts`、`services/submissions.ts`（共用存储） | ✅ |
| T5.4 隐私：查看与删除 | — | `apps/web/src/hosted/data.ts`、`/account/*`、删除页面时清除 | ✅ |
| T5.5 测试与 e2e、演示社团墙 | — | `apps/web/test/hosted*.ts`、`apps/web/test/security/hosted.security.test.ts`、`tests/e2e/hosted.e2e.ts`、`apps/web/scripts/demo*.ts` | ✅ |
| T5.6 M5 验收 | 总规划师 | — | 🟡 |

验收标准：`pnpm typecheck`、`pnpm test`、`pnpm test:security` 通过；S7、S8 的最低测试要求全部覆盖；`pnpm test:e2e` 中的托管用例走通采访、生成、预览、修改、发布；`pnpm demo` 多一面社团墙。

T5.1–T5.5 记录（2026-11-07）：`pnpm test`（74 文件 / 1447 用例）、`pnpm test:security`（27 文件 / 696 用例）、`pnpm test:e2e`（6 用例，含托管全流程）通过。`pnpm typecheck` 唯一的错误来自同一工作树里另一项进行中的工作（contracts 4.5 Skill 分发：`AgentContext.skill` 已加到类型，`services/agent.ts` 还没跟上），与 M5 无关。

## M6 用户自带 API（2026-11-07）

- 增加 `/account/ai`、账号隔离的 AES-256-GCM 凭证库与增量迁移 `004_user_models.sql`；主密钥来自 `NOWME_AI_ENCRYPTION_KEY`。
- 模型请求绑定当前用户及配置版本；删除、更换后停止旧任务后续请求；公网 HTTPS、DNS 固定连接、禁止重定向。
- 删除平台赠送次数、扣减及未来收费方案，保留运行保护限制、历史任务与页面数据。
- 验收覆盖账号设置、跨会话、凭证隔离/篡改、模拟模型全流程、删除/更换、超过原 3 次仍可创作，以及既有本地路线和沙箱。验收（2026-11-07）：`pnpm typecheck`、`pnpm build`、`pnpm test`（83 文件 / 1507 用例）、`pnpm test:security`（30 文件 / 716 用例）通过；完整 `pnpm test:e2e`（8 用例）通过，最终设置页与网页创作定向复验（2 用例）通过。模型服务均为模拟实现，未产生真实模型费用。

## 决策与偏差记录

| 日期 | 决策 |
| --- | --- |
| 2026-11-06 | 技术基线与源划分见 contracts 第 0 节；主站与页面托管使用不同站点（`localhost` / `127.0.0.1`） |
| 2026-11-06 | 页面访问用 HMAC 票据（30 分钟）放在路径中，未授权无法拿到页面内容；页面文档响应同时带 CSP `sandbox allow-scripts`，即使被直接打开也是不透明源 |
| 2026-11-06 | 开场白由 Agent 写进 `card.json`，主人在应用内确认；平台不调用模型，保持本地路线零模型费用 |
| 2026-11-06 | 公开链接只显示页面，不显示联系方式与“想聊这个” |
| 2026-11-06 | 被组织者移除的成员不能通过邀请重新加入；关闭的墙对所有人不可见 |
| 2026-11-06 | 采纳 T0.2 建议：主站 CSP 增加 `default-src`/`style-src`/`img-src`/`form-action`，主站校验 `Host` 头（contracts 第 5 节） |
| 2026-11-06 | T2.4 并入 T3.3：M2 的端到端已由总规划师亲自走通，T2.1 已含 openLink 与自我导航的浏览器测试；恶意页 S1 探测与 CLI 全流程 e2e 在 T3.3 中一次写全，节省一个子 Agent |
| 2026-11-06 | 删除页面：删除所有版本文件；版本与发布记录保留为“墓碑”（清空 card/contact/报告/渲染文字等内容，活跃发布以 `deleted` 结束）；清空公开链接、吊销凭证与 token；保留成员关系与页面行，可重新开始 |
| 2026-11-06 | 退出墙：成员关系 `left`、活跃发布以 `withdrawn` 结束、吊销凭证；之后可用邀请重新加入（重新激活原成员关系，页面保持未发布）。被移除（`removed`）不能重新加入 |
| 2026-11-06 | 首次登录填昵称用 `/welcome`；未登录的表单 POST 返回 401 页面；时间按 Asia/Shanghai 显示；`revisionCount` 含未通过版本 |
| 2026-11-06 | 用户要求：M3 安全审查与 M4 之前停下，先看预览效果 |
| 2026-11-06 | 子 Agent 模型分配：机械性任务用 Sonnet，规划、安全审查、Skill/示例页等需要判断的任务用 Opus（见“工作方式”） |
| 2026-11-06 | `nowme.css` 内置全局减少动效规则；每款 Kit 字体提供 `--nm-font-<id>` 变量；本地工作目录与 CLI 命令见 contracts 1.5 |
| 2026-11-07 | 用户要求托管路线不绑定 Claude：增加 OpenAI 兼容协议与 12 种服务预设（hosted-route 1.1），采访与生成可分别指定服务；`NOWME_CLAUDE_FAKE` 改名 `NOWME_MODEL_FAKE`（旧名兼容） |
| 2026-11-07 | 用户要求实现平台托管路线（不收费）：确认 hosted-route D1–D8；“我的资料”改用 `/account/` 前缀（`/me/data` 会被 S5 的“不含工作区链接”检查误判）；演示加一面社团墙 |
| 2026-11-07 | T3.6：Skill 由主站托管分发（不依赖外部市场，市场渠道只作为可选配置）；CLI 打成单文件随 Skill 包分发，真实用户只需 Node 22；本机没有 Playwright 时预览改由服务端渲染（不存储、限流 100 次/页/天） |

| 2026-11-07 | 用户确认取消全部收费与免费次数方案，平台不提供模型 Key：服务器使用用户自带 API；Key 按账号加密保存、跨设备可用并支持删除。此前平台环境变量 Key / 免费额度决策由本条取代 |

T3.6 分发设计更新（2026-11-07）：用户授权创建公开 GitHub 仓库 `axiom-wang/nowme-skill`；主仓库维护源码，`publish:github --publish` 自动导出白名单、打包 CLI、同步仓库并创建版本 Release。工作区安装提示、纯文本说明与 `/skill` 下载入口使用 GitHub 地址，不依赖 localhost；主站服务继续本地开发。

T3.6 GitHub 发布验证（2026-11-07）：公开仓库与 v0.1.0 Release 已创建；匿名 HTTP 下载与 sha256 校验通过，解压后 CLI 可独立运行；skills 安装器能识别 nowme-page；相关 42 个 web 用例、Skill 338 个用例、安全 725 个用例与安装全流程 e2e 通过。全量测试另有 2 个演示数据用例报 motionLevel 枚举错误，发生在并行修改中的 demo-content.ts，未覆盖该工作。


## M7 黑客松评审演示（2026-11-07，完成）

- 首页与登录页仅开放体验成员 / 体验组织者两个入口；固定映射既有账号、同源 POST、真实会话与切换，邮箱路径及背景会话同样限制身份，普通开发行为不变。
- 演示启动绑定独立数据目录，将维护者真实模型配置经 `userModels.save()` 与 AES-256-GCM 预置到成员账号；两个体验身份不能通过界面或接口修改、删除配置。保留本地 Agent、原有示例、背景数据和重建规则，不部署。
- 类型检查通过；全量 1,548 项、安全 742 项、原有浏览器回归 3 项通过。DeepSeek 真实采访、确认、生成、沙箱预览、指定区块修改、本人发布与身份切换验收 2 项通过。配置和完整验收记录见 演示说明（已从仓库删除，见标签 `hackathon-2026` 中的 docs/demo.md）。

## 首页工作台与墙封面（2026-11-08）

- 按参考图重做登录首页：居中导航与账号菜单、创作统计、未发布提醒、状态筛选、待完成 / 已发布双栏、场景默认插画；手机与平板自适应。统计只包含有效墙，已撤下归入待完成，历史墙保留状态且没有访问入口。
- 组织者后台支持上传、更换、移除墙封面；增量迁移 `006_wall_covers.sql` 独立保存静态 WebP，首页优先使用上传封面。单张最多 5 MiB、4000 万像素，完整解码、自动转正、居中裁切并去除元数据；拒绝 SVG、损坏文件和动图。写入限组织者，读取限有效成员，移出 / 退出 / 关闭立即失效。
- 验证：全量 1,579 项用例、安全 750 项用例通过；首页浏览器用例覆盖上传 → 查看 → 更换 → 移除、筛选、账号菜单、创作入口和 320–1672px 无横向溢出。仅本地开发，无部署。
- 补充验证：类型检查与构建通过；整站浏览器回归 11 项通过、2 项真实模型演示未运行，消息页轮询用例首次出现未读数等待波动，单独重跑通过。按用户最新指示保留横向封面，未改为圆形群头像。
- 2026-11-08 后续调整：用户要求墙封面改为 1:1。首页与后台统一正方形显示，新上传按原图短边居中裁切至最多 1200×1200，不放大小图；已有图片按正方形居中显示。相关 8 项测试及首页浏览器验证通过。

## M8 生产化改造（2026-11-15 起，分支 `feat/production-overhaul`）

用户要求按正式上线的产品标准系统性改造；本轮不考虑上线地区合规（备案、实名、生成式 AI 登记）与 AI 费用 / 支付；AI 质量评测与数据埋点（原计划第 4、5 阶段）暂不做。黑客松参赛版本保留为标签 `hackathon-2026`（4415984），`main` 与 `feat/production-readiness` 不动。仓库已转为私有，`docs/` 纳入 git。

| 任务 | 内容 | 执行 | 状态 |
| --- | --- | --- | --- |
| T8.0 | 分支与标签；删除仓库里的演示 Key 文件；找回 docs；CLAUDE.md | 总指挥 | 完成 |
| T8.0d | 按代码补写 contracts 第 10–12 节，核对其余章节 | Opus | 完成 |
| T8.1 | 后台任务进程 + 数据库任务队列 + 进度事件（contracts 13） | Opus | 完成 |
| T8.2 | 账号注销与数据导出（contracts 14） | Opus | 完成 |
| T8.3 | 举报、拉黑与处理（contracts 15） | Opus | 完成 |
| T8.4 | 内容安全、AI 生成标识、用户协议 / 隐私政策 / 年龄确认（contracts 16） | Sonnet | 完成 |
| T8.5 | Docker 与编排、备份与恢复、结构化日志、CI（contracts 17） | Sonnet | 完成 |
| T8.6 | 正式首页（组织者优先）与 README | Opus | 完成 |
| T8.7 | 从邀请到第一页的引导、工作区重排、默认平台 AI、实时进度与完成通知（contracts 18） | Opus | 完成 |
| T8.8 | 其余页面的文案、空状态与出错提示 | Sonnet | 完成 |
| T8.9 | 设计系统：令牌与组件、样式按页加载与资源指纹、各页面统一到墙的视觉 | Opus | 完成 |
| T8.10 | 无障碍与手机端检查 | Sonnet | 完成 |
| T8.11 | 全分支安全审查（S1–S10 与新增不变量） | Opus | 完成 |
| T8.12 | 组织者工具：必答题与按回答筛选、完成度与一键提醒、墙的群像（contracts 19、S13；分支 `feat/organizer-tools`，迁移 020） | Opus | 完成 |
| T8.13 | AI 介绍值得认识的人：首次进墙自动介绍、理由与原文依据、接到“和 TA 聊什么”；演示路线（contracts 20、S14、W22；分支 `feat/ai-intros`，迁移 021） | 总指挥 | 完成，待合并 |
| T8.14 | 问墙：用一句话找人——提问、原文依据、如实的“没找到”、接到“和 TA 聊什么”；演示路线（contracts 21、S15、W23；分支 `feat/ask-wall`，迁移 022） | 总指挥 | 完成，待合并 |
| T8.15 | 展示模式：375×667 逻辑视口等比放大 / 全屏，成员页墙内固定顺序连播（contracts 5.3；分支 `feat/stage-mode`） | 总指挥 | 完成，待合并 |


## M9 托管采访与长期画像（2026-11-16）

目标：已知信息减少提问；优先点选与填空；本次补充可供以后生成使用。分支 `codex/hosted-interview-context`。

- [x] 第一批：必答题 / 相关画像进入采访与预填；快速通道；一次整理草稿与可选追问；边界明示；重开保留输入。
- [x] 第二批：SceneGuide 快问快答与填空句、本地路线同步；修改原文与有依据事实写回、可选记忆；原图交给生成模型；风格快捷修改。
- [x] 第三批：画像范围 / 来源 / 编辑 / 手动添加 / 人工确认合并；发布后一问与二次确认；有效群像话题供主人选择。
- [x] 验证：类型与构建通过；全量 2,100 项、安全 925 项通过；托管完整流程与画像快速采访浏览器用例通过。整站既有 AI 设置页宽度断言不通过，源于基线改版，详情及逐项证据见 [验收记录](hosted-interview-verification.md)。
