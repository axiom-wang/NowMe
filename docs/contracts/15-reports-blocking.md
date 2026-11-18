# 15. 举报、拉黑与处理

2026-11-15 确认（T8.3）。实现：迁移 `012_moderation.sql`、`apps/web/src/db/moderation.ts`、`services/moderation.ts`、`routes/moderation.tsx`、`services/moderation-cli.ts`。

## 15.1 举报

| 对象 | 谁能举报 | 去向 |
| --- | --- | --- |
| 页面 | 同墙有效成员，对象是**别人的、当前在墙上可见**的页面（与成员页同一授权：`findPublishedMemberPage`）；自己的页面、未发布 / 已撤下的页面 404 | 这面墙的组织者 + 平台运营 |
| 私信 | 一对一私聊的参与者（会话对他可见）；群聊不能举报 | **只到平台运营**，组织者永远看不到 |

- 表单：`reason` 必选，取值 `harassment`（骚扰）/ `inappropriate`（不当内容）/ `impersonation`（冒充他人）/ `spam`（垃圾广告）/ `other`（其他）；`note` 可选，统一换行、去首尾空白后最多 500 字，拒绝控制字符（允许换行、制表符），空串存 null。不合法时 303 回原页 `?safety=invalid`，不写库。
- 同一举报人对同一页面 / 同一段私信只有一行（部分唯一索引），重复举报只更新原因与补充说明。已被处理（忽略或已处理）的举报：页面只有换了一次发布（`publication_id` 变了）、私信只有出现了新消息后再举报才重新回到待处理，免得一个人对同一内容反复刷到组织者面前。
- 举报页面记录当时的 `publication_id`；举报私信记录当时最后一条消息的序号 `last_sequence`，平台运营只看到这条为止的内容。私信不复制到举报表。
- 状态：`open` → `dismissed`（忽略）或 `actioned`（已处理），同时记 `resolved_by organizer|platform` 与 `resolved_at`。
- 补充说明**只给平台运营**：它最容易暴露举报人是谁（“就是我在活动上……”），组织者只需要原因类别与次数就能决定是否下墙。界面在填写处说明这一点。

## 15.2 组织者能看到与能做的

组织者后台 `GET /w/:wallId/admin` 新增“待处理举报”区块（`#reports`）：只列**当前仍在墙上可见**的被举报页面，每页显示页面名（发布快照里的 `displayName`，链接到墙上的成员页——组织者作为成员本来就能看到）、各原因的次数、最近一次时间，按总次数倒序。不显示举报人（昵称、ID、邮箱、头像）、补充说明、举报时间以外的任何明细；不显示私信举报；**不显示针对组织者自己页面的举报**（这类只由平台处理，组织者也不能处理）。

- “请这一页下墙”：复用撤下语义——活跃发布以 `withdrawn` 结束（主人之后可以修改后重新发布，重新发布后再被举报会重新出现），这一页全部待处理举报记为 `actioned / organizer`，`moderation_actions` 追加 `takedown`（带 `publication_id`），事件 `withdraw`（`props.byOrganizer = true`）。主人在工作区的“已撤下”说明里看到“有成员举报了这一页，组织者请它先下墙”，看不到原因与举报人。
- “忽略”：页面留在墙上，待处理举报记为 `dismissed / organizer`，追加 `dismiss`。
- 只能处理这面墙上可见、不是自己、且有待处理举报的页面；否则 404、不改变状态。更强的处理仍是既有的“移出成员”。

## 15.3 拉黑

账号之间的关系（`blocks`，单向记录），对**所有共同的墙**生效，任一方向存在即双向生效：

- 墙上互相看不到对方的卡片（`loadWallModel` 过滤）；对方的成员页、封面、想聊这个、查看联系方式、直接私信、举报 / 拉黑入口、“和 TA 聊什么”（生成、用开场白开聊、清除）全部 404——它们都经过 `findPublishedMemberPage`，那里加了拉黑检查。
- 不能新建私信（`openDirect` 返回 null → 404）；已有私信保留历史、双方仍可阅读（便于举报），但发送返回 `403 {error:"现在没法在这段对话里发消息了。"}`，两边看到同一句中性说明；拉黑的一方额外看到“你已拉黑 TA，可以在我的资料里解除”，输入框隐藏。
- 对方不会收到任何通知；“我的资料”只列**我拉黑的人**，不列谁拉黑了我。解除拉黑（`POST /account/blocks/remove`）立即恢复可见与私信。
- 不影响：全员群聊的消息与成员列表、组织者后台成员列表（组织者的管理职责不受拉黑影响）、公开链接 `/s/:publicToken`。

## 15.4 停用账号（只有平台运营）

`user_suspensions` 有记录即停用：同一事务里删除该账号全部会话、结束其全部页面的活跃发布（`withdrawn`）、吊销本地 Agent 凭证与未用 token，追加 `suspend`。之后 `loadSession` 对停用账号返回 null（即使还有会话也无效），验证码正确也不签发会话（`verifyLoginCode` 返回 `suspended`，登录页提示“这个账号已被平台停用”），别人不能向 TA 新建私信、不能在已有私信里给 TA 发消息。解除停用只删除记录并追加 `unsuspend`，页面不会自动回到墙上。

## 15.5 数据模型（迁移 `012_moderation.sql`）

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `reports` | `id rpt_`、`reporter_id`、`target_kind page\|conversation`、`wall_id`、`reported_user_id`、`page_id`、`publication_id`、`conversation_id`、`last_sequence`、`reason`、`note`（≤500）、`status open\|dismissed\|actioned`、`resolved_by organizer\|platform`、`resolved_at`、`created_at`、`updated_at` | (`reporter_id`,`page_id`) 与 (`reporter_id`,`conversation_id`) 各自部分唯一；不能举报自己 |
| `moderation_actions` | `id mda_`、`actor organizer\|platform`、`actor_user_id`（组织者才有）、`action takedown\|dismiss\|resolve\|suspend\|unsuspend`、`wall_id`、`page_id`、`publication_id`、`report_id`、`user_id`、`note`、`created_at` | 只追加 |
| `blocks` | `blocker_id`、`blocked_id`、`created_at` | 主键 (`blocker_id`,`blocked_id`)，不能拉黑自己 |
| `user_suspensions` | `user_id` 主键、`reason`、`suspended_at` | |

`rpt_`（`report`）/ `mda_`（`moderationAction`）在 `packages/contracts` 的 `ID_PREFIXES` 中，用 `generateId` 生成；举报 ID 的格式检查用 `REPORT_ID_PATTERN`。

## 15.6 路由

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

## 15.7 平台运营命令

`pnpm --filter @nowme/web moderation <命令>`，直接读写 `NOWME_DATA_DIR` 下的数据库（可在主站运行时执行）。只有运营能看到举报人、补充说明与私信内容。每次执行先删除到期的注销证据（14.7）。

被举报的人注销账号时，他的页面与消息按第 14 节删除，但**待处理**举报的被举报内容转存为只有运营能看到的证据（14.7），举报处理完或 180 天后删除。

| 命令 | 作用 |
| --- | --- |
| `list [--status open\|dismissed\|actioned\|all] [--kind page\|conversation] [--limit N]` | 默认待处理，最近更新在前 |
| `show --id rpt_... [--evidence-png 文件]` | 举报人与被举报人（昵称 + 邮箱）、原因、补充说明、同一对象的举报数；页面：被举报时的缩略卡与页面文字（前 2000 字）；私信：到举报时为止的最近 50 条。被举报人已注销时另显示注销时转存的证据（14.7），截图可写到文件 |
| `resolve --id rpt_... --as dismissed\|actioned [--note]` | 只结束这一条举报 |
| `hide-page --page pg_... [--note]` | 页面下墙（`withdrawn`），这一页全部待处理举报记为 `actioned / platform` |
| `suspend --email ... [--note]` / `unsuspend --email ... [--note]` | 停用 / 解除（15.4） |

## 15.8 安全不变量 S12

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S12 | 举报人身份不暴露给组织者和被举报人：组织者只看到页面、原因类别与次数，补充说明只给平台运营；私信举报只到平台运营，组织者看不到私信内容与私信举报；组织者看不到、处理不了针对自己页面的举报，非组织者与凭证不能处理举报。拉黑后双向不可见、不可联系（卡片、成员页、封面、和 TA 聊什么、想聊这个、发起私信、已有私信发送均不可用），被拉黑的人看不出是谁拉黑了自己。停用账号立即失效：已有会话失效、不能再登录、页面下墙、凭证吊销 | `test/security/moderation.security.test.ts`：组织者后台 HTML 不含举报人昵称 / ID / 邮箱、补充说明、私信内容与会话 ID；被举报人各页面不含举报痕迹；拉黑后两个方向逐个路由 404 / 403；停用后旧会话重定向登录、验证码登录 400、Agent 凭证 401 |
