# 12. 点数与平台 AI（S10）

没有自己模型 Key 的用户可以用平台的 AI。代码：`apps/web/src/hosted/platform-model.ts`、`apps/web/src/services/billing.ts`、`apps/web/src/db/credits.ts`、`apps/web/src/routes/credits.tsx`、`apps/web/scripts/credits.ts`、迁移 `009_credits.sql`；常量在 `packages/contracts`（`REDEEM_*`、`SPONSOR_*`、`CREDIT_HISTORY_LIMIT`）。

## 12.1 平台 AI

- 配置：`NOWME_PLATFORM_PROVIDER`（`model-providers.ts` 的预设之一）设置后开启。生成模型取 `NOWME_PLATFORM_MODEL` 或预设；采访模型取 `NOWME_PLATFORM_INTERVIEW_MODEL`、预设采访模型或生成模型，都没有时配置报错；OpenAI 兼容协议必须有地址（`NOWME_PLATFORM_BASE_URL` 或预设）；`NOWME_PLATFORM_VISION` 只能是 `0` / `1`。
- **Key 只来自 `NOWME_PLATFORM_API_KEY`**：不进配置对象、不入库、不进提示词与工具结果、不写日志、不在任何页面出现；只出现在发给模型服务的鉴权头里。没有 Key 时平台 AI 不可用，行为与没有配置平台 AI 时相同（生产环境则拒绝启动，10.1）。
- 出站与用户自带服务相同：只允许公网 HTTPS（不合法的地址在启动时报错），逐次解析 DNS 并固定连接地址，拒绝重定向。
- 平台模型出错时，用户只看到 `MODEL_UNAVAILABLE`；真实错误类别与 HTTP 状态只写服务端日志，不回显服务商回复。
- 选择顺序：用户有自己的配置 → 用自己的（不收点数，不占平台）；否则平台 AI 可用 → 用平台的；否则 `MODEL_CONFIG`。
- 免费调用：采访（hosted-route 2）与和 TA 聊什么（第 11 节）不收点数，受全站每日上限 `NOWME_PLATFORM_FREE_DAILY_CALLS` 约束（进程内计数，10.3），用完后返回 `MODEL_UNAVAILABLE`。
- 收费调用：生成、修改按价目扣点（12.3）。工作区与任务页写明“用的是 NOWMe 的 AI”、价目和可用点数，并给出“改用自己的 Key”入口。

## 12.2 账户、余额与流水

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

## 12.3 扣点与退回

- **谁付**（`planJob`）：价目为 0 → 不收；否则先看这面墙还能为这位成员出多少（`wallAllowance` = min(墙余额, 每人上限 − 他已用掉的墙额度)，上限 0 表示只受墙余额限制），够就由墙付；不够再看个人余额；都不够 → 不开始任务（`credits` 错误，界面说明价目、个人余额与墙的可用额度）。不拆分支付。
- **扣点**（`chargeJob`）：与创建任务在**同一个事务**里，并再检查一次余额 / 墙额度；不够时事务回滚、任务不创建。并发的两个任务不会透支。
- **结算**（`settleJob`）：任务 `succeeded`（产出新的 accepted 版本）才保留扣点，`generation_jobs.charged = 1`；`failed`（校验不通过、超轮数、超时、API 错误）、`needs_input`（需要补充说明）全额退回，只退一次。墙已关闭时，原本由墙付的退点改退给组织者。
- 服务重启：遗留任务标记为 `INTERRUPTED` 失败后，`refundUnsettledJobs` 把扣过、未退的全部退回。
- 用自己 Key 的任务不产生任何流水。

## 12.4 兑换码

- 格式 `NM-XXXX-XXXX-XXXX-XXXX`：16 位 Crockford Base32（80 bit 随机）。输入时忽略大小写、空格、连字符与 `NM` 前缀，`O→0`、`I`/`L→1`。
- 只存 `hashToken(code)`；明文只在生成时由运营脚本输出一次。
- 兑换（`POST /account/credits/redeem`）：在一个事务里查哈希 → 已用 / 过期判断 → 标记 `redeemed_by` → 入账 → 记 `credits_redeem` 事件（`props` 只有 `credits`）。格式不对与不存在返回同一种错误；一个码只能入账一次。按用户限流 10 次 / 10 分钟（10.3）。错误页与提示不回显别人的码。

## 12.5 墙的额度

- 组织者把**个人**点数转给墙（`sponsor_out` + `sponsor_in`，同一事务），并设置每位成员上限；`credits` 为 0 表示只改上限。金额 0–100 000 的整数，不能超过自己的余额；负数、小数、超大数被拒（`bad-amount` / `bad-cap` / `insufficient`）。记 `credits_sponsor` 事件（`props: { credits, memberCap }`）。
- 墙额度只给这面墙的有效成员（发起任务本身要求成员关系有效）；被移除后立即用不到。
- 墙关闭时，剩余额度在关闭墙的事务里退回组织者个人余额。
- **组织者可见范围**：后台只显示墙额度的聚合数字（余额、已用、每人上限）和组织者自己的余额；看不到任何成员各自用了多少，也看不到成员的余额。

## 12.6 路由与运营脚本

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /account/credits` | 登录用户 | 自己的余额、价目、平台 AI 是否可用、最近 50 条流水、兑换码输入框 |
| `POST /account/credits/redeem` | 登录用户（会话 + CSRF + Origin） | `code`；成功 303 `/account/credits?redeemed=<点数>`，失败 `400` / `429` |
| `POST /w/:wallId/admin/credits` | 这面墙的组织者 | `credits`、`memberCap`；303 回到 `/w/:wallId/admin#credits`；非组织者 `404` |

演示模式（4.2.2）没有这些路由，后台也不显示墙额度区块；平台 AI 未开放时后台同样不显示。每个人只能看到自己的余额与流水。

运营脚本 `pnpm --filter @nowme/web credits <命令>`（直接读写 `NOWME_DATA_DIR` 的数据库，可在主站运行时执行）：`codes --count <1–1000> --credits <n> [--batch <备注>] [--expires <ISO 日期>]` 生成兑换码（明文只输出一次）；`grant --email <邮箱> --credits <n>` 发放；`balance --email <邮箱>` 查余额。目标账号必须先登录过一次。

## 12.7 S10 不变量（`apps/web/test/security/billing.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S10 | 平台模型的 Key 只来自环境变量，不入库、不写日志、不在页面出现；余额不为负，流水只追加；任务只扣一次，没做出新版本全额退回；兑换码只存哈希；组织者只看到墙额度的总数，看不到任何成员用了多少 | 扫描数据库、配置、日志、页面不含平台 Key，出错不回显服务商回复；无 Key 时不可用；内网地址启动时拒绝；免费调用上限生效；点数页只有本人数据，后台无成员明细；库里只有兑换码哈希，一码只能用一次，兑换需会话 / CSRF / Origin 且限流；只有组织者能充墙额度，不能透支或用非法金额；墙额度不给别墙成员与被移除成员；关闭墙退回组织者；并发任务不透支；余额表拒绝负数，流水拒绝非法原因与零变动；演示模式没有点数入口 |
