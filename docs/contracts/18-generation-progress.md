# 18. 生成进度与完成通知

（T8.7，迁移 `015_notify_prefs.sql`；代码在 `services/workspace-stage.ts`、`services/progress.ts`、`services/job-notify.ts`、`routes/hosted.tsx`、`views/workspace.tsx`、`views/progress.tsx`、`static/progress.js`、`db/notify.ts`。）

## 18.1 从邀请到第一页、按阶段只突出一件事、默认路线

- **加入后直接进引导**：`POST /join/:inviteCode` 新加入（`joined`）→ `303 /w/:wallId/me/create?welcome=1`（网页内创作关闭时 → `/w/:wallId/me`）；采访页显示欢迎语与“先去墙上看看”。重新加入（`rejoined`）、已是成员仍回到墙。引导依次是：采访（素材、可选照片、点选）→ 追问 → 确认 AI 整理的资料 → 生成（实时进度）→ 自动跳到预览 → 确认发布。复用 hosted-route 的采访 / 生成 / 修改与 4.2 的发布，业务规则与安全规则不变。
- **阶段**（`workspaceStage`，纯函数，优先级从上到下）：`generating`（有排队 / 进行中的任务）→ `published`（墙上有这一页）→ `preview`（有做好的版本）→ `ready`（资料已确认）→ `review`（资料待确认）→ `interview`（`collecting` / `followups`）→ `start`。“我的页面”顶部只有一张“现在该做的事”卡片，每个阶段只有一个主要按钮：开始采访 / 继续采访 / 确认资料 / 生成页面 / 实时进度 / 发布到墙上 / 看看墙上的样子；已发布后又做好了新的一版时主要按钮是“用这一版更新”。修改（一句话告诉 AI）收在卡片里的折叠区。墙上的页面、公开链接、撤下、做过的每一版、更多方式、删除与退出都在卡片下方；还没发布过时不显示“墙上的页面 / 公开链接”。
- **步骤条**（`workspaceSteps`）：网页内创作为“采访 → 确认资料 → 生成页面 → 发布到墙上”，完成条件分别是资料已整理（`review` / `confirmed`）、资料已确认、有做好的版本、墙上有这一页；已有做好的版本（例如本地 AI 助手做的）时前两步算完成；只有失败版本时仍按资料状态判断。只有本地路线时为“交给 AI 助手 → 做好一版页面 → 发布到墙上”。
- **默认路线**（`creationRoute(aiStatus, kind)`）：自己配置了模型 Key → `own`；平台 AI 可用且这次点数够（`affordable`：个人余额或墙额度）→ `platform`，界面不出现“选路线”；平台 AI 可用但点数不够 → `credits`：说明价目与可用点数，主要按钮“去兑换点数”，并提示请组织者给墙充额度，仍可“先开始采访（不收点数）”；平台 AI 不可用且没有自己的 Key → `setup`：说明原因，主要按钮“填写自己的模型 Key”。“用自己的模型 Key”“用你自己电脑上的 AI 助手”收在“更多方式”（`details#more-ways`），`credits` / `setup`、已经在用本地路线、刚生成指令时默认展开。点数不够不显示错误码。实际计费仍按 12.3 的 `planJob`。
- **统一叫法**：做好的页面 / 一版页面（不说“通过校验的版本”）、墙上的小卡片（不说“缩略卡 / card.json”）、你自己电脑上的 AI 助手（不说“本地 Agent”）、资料（不说 brief；查看时 brief.md 的标题显示为“资料：”，存储的文件不变）。检查报告先写问题与怎么改，错误码、文件与行号收进“技术细节”。

## 18.2 实时进度（SSE，退回轮询）

| 路径 | 作用 |
| --- | --- |
| `GET /w/:wallId/me/jobs/:jobId/progress` | `text/event-stream`。先发 `event: ready`（`retry: 3000`），再按序号推 `event: stage`（`id` = `job_events.seq`，`data` = `{seq, stage, step, label, turn, maxTurns}`）；任务结束时推 `event: done`（`data` 另有 `done, status, next`）并关闭；被移除 / 页面删除时推 `event: gone` 并关闭。支持 `Last-Event-ID` 续传 |
| `GET /w/:wallId/me/jobs/:jobId/status` | 轮询用 JSON：与 `done` 的 `data` 相同 |
| `GET /w/:wallId/me/jobs/:jobId` | 任务页：服务端先按最近一条进度渲染，加载 `progress.js`；**不再用 meta refresh** |

- **权限**：两个路由只对任务主人开放（`findOwnPage` + `repos.jobs.findForOwner`）；其他成员、组织者、非成员、未登录、格式不对一律 404（未登录也是 404，不跳登录）。SSE 每一轮重新确认成员关系与任务归属。
- **内容**：只有阶段名、给人看的一句话与数字；`next` 只在成功时给出站内相对路径（预览）。不含修改要求、资料、任务结果文字或模型输出。
- **阶段（给人看）**：排队中（`queued`、`retrying`）/ 整理资料（`reading`）/ 设计（`designing`）/ 生成中第 n 轮（`generating`）/ 检查（`validating`）/ 截图（`rendering`）/ 完成（三种结束状态）。是否结束以任务行的状态为准。
- **限制**（`ProgressSettings`，可在 `createWebApp({ progress })` 覆盖）：每 1 秒查一次新进度；15 秒一次心跳（`: keep-alive` 注释行）；单个连接最长 5 分钟，到时服务端关闭，浏览器带 `Last-Event-ID` 自动重连；每用户同时 3 个、全站 200 个连接，超出返回 429。
- **前端**（`static/progress.js`，`[data-job-progress]`）：先用 `EventSource`；浏览器不支持、被拒绝（404 / 429）或连续 3 次出错时改为每 3 秒轮询 `/status`（临时故障逐步放慢，最长 30 秒；401 / 403 / 404 或 SSE `gone` 则停止，提示重新登录或返回我的墙）；任务结束时成功跳到 `next`，否则重新载入这一页看原因。不插入任何 HTML。“我的页面”在 `generating` 阶段显示同一个组件。
- **主站 CSP 不变**：`default-src 'self'` 已允许同源的 `EventSource` / `fetch`，没有新增 `connect-src`，不放开任何外部源。页面 CSP（`buildPageCsp`，`connect-src 'none'`）不变。

## 18.3 完成提醒邮件

- 主站（worker 不发邮件）每 5 秒扫一次最近 30 分钟内结束、还没判定过的生成 / 修改任务（`createWebApp({ jobNotifyIntervalMs })`，`null` 不自动扫描；`WebApp.notifier.tick()` 手动扫）。每个任务先在 `job_notices` 里抢占（主键），所以最多发一封；判定结果：`present`（主人还在看）、`off`（关掉了）、`skipped`（账号注销 / 停用、页面已不在这面墙、任务因 `SUSPENDED` / `PAGE_GONE` 中止）、`sent`、`failed`（发送失败，不重试）。`job_notices` 只存任务 ID、结果与时间，30 天后清理。
- **“还在看”**：这个任务现在有进度连接，或最近 45 秒内有过进度连接 / 轮询 / 打开任务页或“我的页面”（`ProgressHub.present`）。只在本进程内计数：部署多个主站实例时，连在别的实例上的主人可能也会收到提醒。
- **内容**：主题“你的页面做好了，去看看”/“你的页面改好了，去看看”/“改页面之前，AI 想先问你一句”/“这次页面（修改）没有做成”；正文只有昵称、墙名、一句话、链接（成功 → 预览，其他 → 任务页；都需要登录且是主人）与关闭方法（`/account/data#notifications`），**不含页面内容、资料、修改要求或模型输出**。失败的邮件写明“如果用了点数，已经全额退回”。经 `outbox`（10.2）投递。
- **开关**：`users.notify_job_email`（默认 1），与组织者提醒的开关（`users.reminder_emails`，第 19 节）分开存。复用第 19 节的“我的资料 → 提醒邮件”与 `POST /account/notifications`（会话 + CSRF + Origin，忽略 `Authorization`）：表单里有 `jobEmail` 时按 `jobEmail=1` / `0` 设置这一项（同时有 `reminders` 时一并设置），303 `/account/data?notice=notify-saved#notifications`；只有 `reminders` 时行为与第 19 节相同。只改会话用户自己的设置。

## 18.4 安全要求（`apps/web/test/security/progress.security.test.ts`）

进度路由非主人 / 未登录 / 换墙 / 格式不对一律 404 且不占连接；被移除后正在推送的连接立即停止、之后 404；任务结束后连接关闭；推送与轮询的字段只有阶段名与数字，不含修改要求与模型输出；进度响应带主站 CSP，主站 CSP 没有新增 `connect-src`，页面 CSP 仍是 `connect-src 'none'`；邮件开关需要会话 + CSRF + Origin、只改自己；提醒邮件不含素材、资料、接话点、修改要求。功能测试：`workspace-stage.test.ts`、`progress.test.ts`、`job-notify.test.ts`。
