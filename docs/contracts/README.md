# NOWMe 接口约定（本地路线 + 平台托管路线）

> 本目录是所有模块共同遵守的契约：页面输出契约、数据模型、API、校验规则、安全不变量。每一节一个文件，节号与文件名前缀一致；代码与文档里的“contracts 第 N 节”“contracts N.M”指的就是 `NN-*.md`。
> 需求来源：[MVP 需求](../product-mvp-community-wall.md)、[页面生成方案](../page-generation-byo-agent.md)、[信息收集与 brief](../brief-collection.md)。
> 范围：原型试跑的**本地路线**，以及平台托管路线的应用内采访、托管生成、应用内修改与账号 AI 配置（第 9 节，正文见 [hosted-route.md](../hosted-route.md)）；部署与加固（第 10 节）、“和 TA 聊什么”（第 11 节）、点数与平台 AI（第 12 节）；派生（W18）不做。
> 修改约定需要总规划师同意；实现与约定冲突时，以约定为准并提出修改建议。
> 文中标 **[原型默认]** 的数值是需求文档里 [待定] 项的临时取值，统一放在 `packages/contracts` 的常量里，便于以后调整。

**按任务只读相关的节，不要通读。** 几乎所有任务都要守 [05 安全不变量](05-security-invariants.md)；新增节号顺延（下一节为 22）。

| 节 | 内容 |
| --- | --- |
| [00](00-baseline.md) | 技术基线：主站 / 页面托管的源、模块与目录归属 |
| [01](01-page-output.md) | 页面输出契约：`page/` 目录、`index.html`、`card.json`、`manifest.json`、封面与资源、本地工作目录与 `nowme` 命令 |
| [02](02-validation.md) | 页面校验规则与错误码、服务端渲染阶段额外检查 |
| [03](03-data-model.md) | SQLite 数据模型（基础表）、账号资料与头像 |
| [04](04-api.md) | API：Agent API、主站页面与表单、墙内聊天、Agent 指令格式、页面托管、Skill 分发 |
| [05](05-security-invariants.md) | 安全不变量 S1–S6、`nowme.openLink`、iframe 自我导航、展示模式与连播 |
| [06](06-events.md) | 事件（W20） |
| [07](07-scene-guides.md) | 场景指南配置 `skill/scenes/<sceneType>.json` |
| [08](08-implementation-notes.md) | 已采纳的实现细节（T0.2） |
| [09](09-hosted-route.md) | 平台托管路线（正文在 [hosted-route.md](../hosted-route.md)，S7 / S8） |
| [10](10-deploy-hardening.md) | 部署与加固：环境变量与生产启动检查、邮件投递、来源地址与限流、安全头、健康检查 |
| [11](11-chat-starters.md) | 和 TA 聊什么（S9） |
| [12](12-credits-platform-ai.md) | 点数与平台 AI（S10）：余额与流水、扣点与退回、兑换码、墙的额度 |
| [13](13-job-queue.md) | 后台任务进程与任务队列：进程划分、租约、进度事件、重启语义 |
| [14](14-account-deletion-export.md) | 账号注销与数据导出（S11） |
| [15](15-reports-blocking.md) | 举报、拉黑、停用账号与平台运营命令（S12） |
| [16](16-content-safety-terms.md) | 内容安全检查、AI 协助生成标识、用户协议 / 隐私政策与年龄确认 |
| [17](17-operations.md) | 运维：容器、备份与日志（细节见 [deploy.md](../deploy.md)） |
| [18](18-generation-progress.md) | 生成进度与完成通知：默认路线、SSE 实时进度、完成提醒邮件 |
| [19](19-organizer-tools.md) | 组织者工具（S13）：必答题、完成度与提醒、墙的群像 |
| [20](20-ai-intros.md) | AI 介绍值得认识的人（S14） |
| [21](21-ask-wall.md) | 问墙：用一句话找人（S15） |
