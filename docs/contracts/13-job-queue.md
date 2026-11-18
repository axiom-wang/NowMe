# 13. 后台任务进程与任务队列

（T8.1，迁移 `010_job_queue.sql`；代码在 `apps/web/src/worker/`、`db/job-queue.ts`、`hosted/job-runner.ts`。）

## 13.1 进程划分

| 进程 | 入口 | 负责 | 不做 |
| --- | --- | --- | --- |
| 主站 | `src/main.ts`（`start` / `start:source`） | 网页请求、表单、Agent API、采访与“和 TA 聊什么”（同步的模型调用）；校验额度、扣点、把任务写进队列、等待渲染结果 | separate 模式下不启动浏览器、不跑生成 Agent 循环 |
| worker | `src/worker.ts`（`worker` 源码方式；`start:worker` 运行 `dist/worker.js`） | 提交渲染（`POST /api/agent/revisions`）、远程预览（`POST /api/agent/previews`）、网页内 AI 生成 / 修改（含平台重新校验与渲染） | 不监听端口、不处理网页请求 |
| 页面托管 | `apps/pages-host` | 不变（第 4.4 节） | — |

- 主站与 worker 共享同一个 `NOWME_DATA_DIR`：SQLite（WAL，`busy_timeout` 5 秒，写事务一律 `BEGIN IMMEDIATE`，事务内不 await）、`revisions/`、`jobs/`。两边读取同样的 `NOWME_AI_ENCRYPTION_KEY` 与 `NOWME_PLATFORM_*`；worker 不需要邮件配置。
- 浏览器（Playwright）只在 worker 的处理器、远程预览渲染器、生成预览器里懒启动。worker 内所有渲染经过同一条串行“渲染通道”：同一时刻只渲染一页（含 AI 任务里的 `preview_page` 截图与平台重新校验的渲染）。
- 可以运行多个 worker：租约保证同一个任务同一时刻只有一个执行者。

## 13.2 任务表与租约

两类任务、一套租约规则；表里只存类型、状态、ID、计数与时间，**不存页面文件、模型输出或用户内容**；不建外键（按时间清理，注销时可按 `page_id` 删除）。

- **AI 生成 / 修改**：复用 `generation_jobs`（状态仍是 `queued / running / succeeded / failed / needs_input`，不另建一套状态），新增列 `attempts`、`lease_owner`、`lease_expires_at`、`model_source`（`own | platform`）、`model_version`。主站在创建任务的同一个事务里扣点（第 12 节）、写入模型来源与用户模型配置的版本号（随机 UUID，不是 Key）。worker 按它取模型：排队期间主人删除或更换了配置，任务以 `MODEL_CONFIG` 失败并退点，不会改用新配置（S8）。
- **提交渲染、远程预览**：`render_jobs(id job_*, kind submission|preview, status queued|running|done|failed, page_id, credential_id, attempts, max_attempts, lease_owner, lease_expires_at, outcome stored|rendered|rate_limited|credential_invalid, revision_id, error_code, created_at, started_at, finished_at)`。上传的文件先按白名单过滤（第 3 节），暂存到 `<dataDir>/jobs/<id>/files/`（目录 0700、文件 0600），worker 读回时再过滤一次；预览结果写 `<dataDir>/jobs/<id>/result.json`（先写临时文件再改名）。
- **领取**：`BEGIN IMMEDIATE` 事务里取最早的 `queued` 任务改成 `running`，写入 `lease_owner`（进程内随机 worker ID）、`lease_expires_at`（默认 60 秒后）、`attempts + 1`。
- **续约**：执行中每 1/3 租期续约一次（`WHERE lease_owner = 自己 AND status = 'running'`）。续约失败说明租约已被回收：取消这个任务。数据库暂时忙不算丢失租约。
- **结束**：所有结果写入都带租约条件。提交渲染把“写版本 + 结束任务”放在同一个事务里；AI 任务把“结算点数 + 结束任务”放在同一个事务里；成功时“写版本 + 结算 + 结束任务”是同一个事务（存下了新版本就保留扣点，没存下才全额退回，不会出现版本存下又退点），写版本前确认仍持有租约。租约被回收后旧 worker 的结果一律作废。
- **回收**：worker 每次轮询（默认 1 秒）回收别人持有、已经过期的 `running` 任务（见 13.4）。
- **等待**：Agent API 是同步的。主站入队后等待 `render_jobs` 结束（inline 模式由同进程通知唤醒，separate 模式每 250 毫秒读一次）；提交最多等 3 分钟、预览 2 分钟。超时时还在排队的任务标记 `failed / ABANDONED` 不再执行，返回 500 `INTERNAL_ERROR`（“渲染服务现在太忙”）；已经在执行的让它做完（提交的结果照常保存）。渲染出错返回 500 `INTERNAL_ERROR`。
- **远程预览什么都不留**：主站取走结果后立即删除任务行与暂存目录；只留第 4.1 节的 `remote_preview` 事件。
- **清理**（worker 启动时与每 10 分钟）：退回“扣了点、已失败、未退”的任务；删除结束超过 7 天的提交任务行、遗留超过 10 分钟的预览任务行、超过 30 天的进度事件；删除没有对应任务或任务已结束、超过 10 分钟的暂存目录。

## 13.3 进度事件

`job_events(job_id, seq, stage, props_json, created_at)`，主键 `(job_id, seq)`；`job_id` 是 `gen_…` 或 `job_…`。序号在同一条 INSERT 语句里计算（同一任务从 1 起逐条递增）。

- 阶段 `stage`：`queued` 排队中、`reading` 读取资料、`designing` 设计（还没写过页面文件的轮次）、`generating` 生成中（第 n 轮）、`validating` 校验、`rendering` 渲染截图、`retrying` 重新排队、`succeeded` 完成、`needs_input` 需要补充说明、`failed` 失败。中文名见 `JOB_STAGE_LABELS`。
- `props_json` 只允许 `turn`、`attempt`、`maxTurns`、`files` 四个键，值是非负整数；不存模型输出、工具参数、文件名或任何用户内容。失败原因看任务行的 `error_code`。
- AI 任务：`queued`（入队事务内）→ `reading` → 每轮 `designing` / `generating {turn, maxTurns}`，工具 `validate_page` → `validating`、`preview_page` → `rendering` → 循环结束后 `validating`、`rendering`（平台重新校验与渲染）→ `succeeded` / `needs_input` / `failed`。提交渲染：`queued {files}` → `validating {attempt}` → `rendering {attempt}` → `succeeded`（accepted）/ `failed`。远程预览不写进度事件。
- 查询：`repos.jobEvents.listAfter(jobId, afterSeq, limit)` 按序号升序返回 `afterSeq` 之后的事件（最多 500 条），`latest(jobId)` 返回最后一条。**这两个函数不做授权**：第 18 节的实时进度推送必须先用 `repos.jobs.findForOwner(jobId, pageId, 当前用户)` 确认查看者是任务的主人，无权一律 404。

## 13.4 重启语义

| 情况 | AI 生成 / 修改 | 提交渲染 / 远程预览 |
| --- | --- | --- |
| 还在排队时进程重启 | 不受影响，下一个 worker 照常执行 | 不受影响 |
| 执行中进程崩溃（租约过期） | **不重试**（避免重复计费）：标记 `failed / INTERRUPTED`、全额退点，写 `failed` 事件 | 可重试（幂等）：`attempts < max_attempts`（提交 3、预览 2）时回到队列并写 `retrying`，否则 `failed / INTERRUPTED`；预览的第二次尝试不重复计入额度 |
| 优雅退出（SIGTERM） | 停止领取，等进行中的任务最多 `NOWME_WORKER_SHUTDOWN_GRACE_SECONDS` 秒；到时取消，按 `INTERRUPTED` 结束并退点 | 同样等待；到时交还租约（回到队列，这次不计入尝试次数），由下一个 worker 重做 |
| 处理器抛错 | — | 不重试：`failed / INTERNAL`，返回 500 |
| 迁移 010 之前入队、没有 `model_source` 的任务 | 按 `INTERRUPTED` 结束并退点 | — |
| 停用账号（第 15 节）/ 注销账号（第 14 节） | `cancelActiveJobsForUser`：排队中 / 执行中的任务立即标记失败（`SUSPENDED` / `PAGE_GONE`）、清掉租约、全额退点；执行它的 worker 在下一轮调用模型前或下一次续约时发现租约已不在，停止后续模型请求，结果作废 | 凭证随之失效：worker 写版本前重新确认凭证，返回 `credential_invalid` |
| 删除页面、退出墙、被移出、关闭墙 | `cancelActiveJobsForPage`：这一页排队中 / 执行中的任务立即以 `failed / PAGE_GONE` 结束并全额退点（关闭的墙退到组织者个人余额）；worker 每轮调用模型前还会确认页面与成员关系仍有效，失效即停止并按 `PAGE_GONE` 退点 | 凭证随之失效 |

主站重启不再打断任何任务（旧版本在启动时把所有排队 / 执行中的任务标记为失败）。崩溃时用户最多等一个租期（60 秒）才看到任务失败。

## 13.5 运行模式与配置

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `NOWME_WORKER_MODE` | `inline`（默认）/ `separate` | zod 校验（`workerModeSchema`）。inline：worker 循环在主站进程内运行，`pnpm dev`、`pnpm demo`、测试的行为与之前相同；separate：主站只入队，不创建处理器 / 渲染器 / 预览器 |
| `NOWME_WORKER_AI_CONCURRENCY` | 1–16，默认 2 | 同时执行的 AI 任务数；渲染始终串行 |
| `NOWME_WORKER_SHUTDOWN_GRACE_SECONDS` | 0–3600，默认 30 | 优雅退出的等待时间（编排里的停止超时应比它长） |

- 生产环境（`NODE_ENV=production`）主站使用 `inline` 时，`assertProductionConfig(..., 'web')` 给出提醒，不拒绝启动。worker 进程用 `assertProductionConfig(..., 'worker')`：要求 `NOWME_AI_ENCRYPTION_KEY`（设置了平台 AI 时还要 `NOWME_PLATFORM_API_KEY`），不检查邮件。
- inline 模式下同样可以另起 worker 进程分担任务（两边都会领取）；只想让 worker 执行时把主站设为 separate。
- 测试注入点不变：`createWebApp({ processor, previewer, remoteRenderer, model, platformModel, clock, hostedTempRoot })` 在 inline 模式下交给本进程的 worker；`WebApp.worker` 是这个 worker（separate 模式为 null），`deps.hosted.idle()` 等它空闲；`WebApp.close({ graceMs })` 停止领取并等待。
