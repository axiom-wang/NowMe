# 19. 组织者工具：必答题、完成度与提醒、墙的群像

组织者是获客入口：这一节的三件事替代组织者原来要在群里做的接龙、问卷与催进度。代码：`apps/web/src/services/wall-questions.ts`、`services/reminders.ts`、`services/portrait.ts`、`hosted/portrait.ts`、`db/organizer-tools.ts`、`routes/organizer-tools.tsx`（成员一侧）、`routes/admin.tsx`（组织者一侧）、`views/organizer-tools.tsx`，迁移 `020_organizer_tools.sql`（`025_text_questions.sql` 加填空题）；取值常量在 `apps/web/src/constants.ts`（`WALL_QUESTION_LIMITS`、`REMINDER_LIMITS`、`PORTRAIT_LIMITS`）；ID 前缀 `wqn_`（`wallQuestion`）、`rmd_`（`wallReminder`）与事件类型在 `packages/contracts`。

## 19.1 必答题

- **设置**：建墙页（`POST /walls`，与墙的字段同一张表单，任何一处不合格都不建墙）或组织者后台（`POST /w/:wallId/admin/questions`）。每面墙 0–3 道；题目 2–30 字、单行；题型 `single`（单选）/ `multi`（多选）/ `text`（填空）；选择题的选项 2–12 个、每个 1–12 字，按换行、逗号、顿号、分号拆开，忽略大小写与空白去重；填空题没有选项（表单里的 `q<i>_options` 忽略，只写了选项没写题目的填空题块视为空白）。题目与选项过内容安全检查（kind `wall`，命中 422、不保存）。建墙页有“用例子填”（比赛的技能 / 组队、社团的部门、兴趣的程度、通用的来意、填空的想做的项目 / 专业年级；需要脚本）。
- **编辑器**（`QuestionEditor`）：每道题是题目、三选一的题型按钮、选项（选择题）或回答预览（填空题）；按题型切换用 CSS `:has()`，没有脚本也能用（选项是每行一个的文本框）。有脚本时（`static/app.js`）选项换成一行一个的列表（回车加下一个、空行退格删除、粘贴多行自动拆开、单独删除、显示个数），内容实时写回文本框，提交字段不变；只显示有内容的题和一道空题，“再加一道题”展开下一道，每道题可以一键清空（保存时删除）。
- **编辑语义**（一个事务）：表单里带着本墙题目 ID（`q<i>_id`）的视为编辑，其余为新题，不在表单里的旧题删除（回答级联删除）。**改了题目文字或题型（含选择题与填空题互改）→ 这道题的回答全部作废**；只改选项时保留回答，读取时只认仍然存在的选项（`effectiveChoices`：单选必须正好剩一个，多选至少剩一个，否则视为没答；填空题只认第一项非空文字）。
- **必答**：有题目时，没答完的有效成员（含组织者自己）打开 `GET /w/:wallId`、`GET /w/:wallId/p/:pageId`、`GET /w/:wallId/me` 先 303 到 `/w/:wallId/questions?next=<原路径>`（`questionsGate`）。组织者后台、POST 路由不拦。组织者之后新加的题，已经在墙里的人下次打开时同样要答。
- **回答**：`GET /w/:wallId/questions` 显示表单（已答过时是“修改我的回答”，墙上“我的页面”区块有入口）；`POST` 字段：单选 `a<位置>=<选项序号>`，多选 `a<位置>_<选项序号>=1`，填空 `a<位置>=<文字>`（空白合并为一个空格，1–30 字、单行，`hasContact` 命中的链接 / 邮箱 / 长串数字 400，再过内容安全检查 kind `answer`，命中 422；都不保存），`qv` 为题目版本（题目 ID 与更新时间的哈希）。题目在作答期间变了 → 400 提示再看一眼，不保存；漏答 → 400、保留已选。保存后 303 到 `next`，`next` 只接受这面墙内的站内路径，否则回墙。记 `wall_answer`（`props: { questions }`）。
- **可见范围**：回答是墙内公开信息，回答页写明“组织者能看到你的回答；页面上墙后，墙上的人也能看到并按回答筛选”。
  - 组织者后台：每道题的选项人数（统计全部有效成员）、成员列表里每个人的回答、`GET /w/:wallId/admin/members.csv`（昵称、角色、加入时间、发布状态、各题回答；UTF-8 BOM；以 `= + - @` 制表符开头的单元格前加 `'`；`private, no-store`；没有邮箱）。
  - 填空题：后台每题列出有效成员写的话（最多 30 条，其余看成员列表与 CSV）；墙上是卡片上的一个标签（`answer-tag--text`），进搜索文字，**不进筛选条、不进群像的人数条与“发到群里”的统计**，但作为这个人公开的回答进入 S9 / S14 / S15 / 群像的模型输入（与选择题的回答相同的“题目：回答”一行）。
  - 墙上：只有**已上墙**的卡片带回答标签；筛选条只列墙上（按查看者过滤拉黑之后）至少 1 张卡片选了的选项和人数；同一题内“任一”、不同题之间“同时满足”，与搜索叠加，在浏览器里完成（`static/wall.js`），回答也进搜索文字。没上墙的人的回答不出现在墙上。
  - 退出、被移出的成员的回答不再出现在任何地方（查询只认有效成员）；注销时删除。

## 19.2 完成度与一键提醒

- **完成度**（后台 `#progress`）：已发布 / 有效成员、答完必答题 / 有效成员，“还没发布”（从没发布过）与“还没答完必答题”的昵称；撤下了页面的人只给人数，不提醒。
- **一键提醒**（`POST /w/:wallId/admin/remind`，无参数）：对象是“从没发布过”或“没答完必答题”的有效成员，排除组织者自己；**跳过**关闭了提醒邮件（`users.reminder_emails = 0`）、与组织者之间有拉黑（任一方向）、账号停用或注销的人——这几类合并显示为“N 人不接收提醒邮件”，看不出谁拉黑了谁；**限额**：同一面墙里每人 48 小时内最多一封、总共最多 3 封（`REMINDER_LIMITS`），超出的显示为“N 人最近已经提醒过”。
- 流程：一个事务里重新算名单、每人插一行 `wall_reminders(status = pending)` 占住限额、记 `wall_remind`（`props: { count, limited, declined }`）；然后在后台逐封投递，改为 `sent` / `failed`（失败只记日志里的数量）。并发两次点击不会重复提醒。303 回 `admin?reminded=<人数>#progress`。
- 邮件是**固定模板**的纯文本：主题 `「<墙名>」还差你的一页 / 还差你的回答 / 还差你的一页和回答`；正文有成员昵称、组织者昵称、缺什么（几道题）、墙的链接、关闭提醒的说明与 `/account/data#notifications`。组织者不能写正文，看不到任何人的邮箱。
- 另给一段“发到群里”的文字（只含昵称、人数与墙的链接），组织者自己复制。
- **开关**：“我的资料”的 `#notifications`，`POST /account/notifications`（`reminders=1/0`，表单先放 `0` 的隐藏字段再放复选框）。

## 19.3 墙的群像

- **谁能生成**：只有组织者（`POST /w/:wallId/admin/portrait`，后台与墙上的群像区块都有按钮），墙上至少 3 页（`too-few`，不调用模型）。模型按 `interview` 角色解析组织者的配置，没有时用平台 AI，**不收点数**，计入全站免费调用上限（12.1）。每面墙每滚动 24 小时 6 次（`wall_portrait_generate` 事件计数，成功失败都算，`daily`），同一面墙并发 1（`busy`），总时限 90 秒（`timeout`）。错误只显示 `PORTRAIT_ERROR_TEXT` 的固定文案。
- **输入**：墙上可见的全部发布（不按拉黑过滤：群像对全墙一样，且只有聚合内容），超过 150 页取最近发布的；每页只给编号 `page_N`、发布快照的一行介绍（≤80）、前 4 个接话点（各 ≤50）与这个人在墙内公开的必答题回答。**不给**名字、渲染文字、草稿、采访、画像、联系方式，没上墙的人一概不进。资料用 `untrusted()` 包成块。
- **输出**（工具 `submit_portrait`，zod 校验，不合格或收紧后为空时重试一次）：`summary`（≤80）与 `themes[]`（`title` ≤12、`detail` ≤36、`members` 为页面编号）。平台核对（`groundPortrait`）：主题人数 = 去重后、在 1..N 内的编号个数，少于 2 的主题丢弃；任何字段含链接 / 联系方式（`hasContact`）、某位成员的卡片名或昵称（≥2 字，规范化后包含）、“数字 + 个/位/名/人/成/%”的人数写法 → 主题丢弃、`detail` 或 `summary` 清空；按人数排序，最多 5 个。**准确人数只来自必答题统计**：生成时按当时墙上的人由服务端计算，随群像一起保存。
- **存储与展示**：`wall_portraits` 每墙一行（替换）。全墙有效成员在墙上看到“墙的群像”：一句话、话题与人数、各题的人数条、“发到群里”的可复制文字（墙名、上墙人数、一句话、各题前 6 个选项人数、话题人数、墙的链接）。界面说明“话题人数是 AI 归类的结果”。**展示条件**：保存的每一条来源发布都还在墙上，或只是被同一页的新版本替换（`superseded`，显示“生成后有 N 位成员更新了页面”）；任何一条因撤下、移出、退出、注销、关闭等结束或已不存在，群像停止展示，后台提示重新生成。关闭墙时删除。

## 19.4 S13 不变量（`apps/web/test/security/organizer-tools.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S13 | 只有这面墙的组织者能改必答题、一键提醒、生成群像、下载成员名单；回答只在墙内可见（组织者看全部有效成员，墙上只有已上墙的人），墙外、退出、被移出的人看不到也答不了；提醒邮件是固定模板，组织者看不到邮箱、不能写正文，不发给关闭提醒、与组织者之间有拉黑、停用的账号，且看不出谁拉黑了谁；群像只读墙上公开的发布快照与公开的回答，不含名字、草稿、渲染文字、联系方式与没上墙的人，输出里没有链接、名字与数字人数 | 成员 / 墙外的人请求后台工具 404 且不改不发不调模型；缺 CSRF、外站来源 403，页面凭证无效；墙外与被移出的人回答页 404；墙上 HTML 不含没上墙的人的回答、后台不含邮箱；提醒邮件不含组织者写的内容与任何邮箱，拉黑 / 停用的人收不到，人数合并显示；模型请求不含草稿、渲染文字、联系方式、没上墙的人与其回答，保存的结果不含名字 |

## 19.5 数据模型（迁移 `020_organizer_tools.sql`）

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `wall_questions` | `id wqn_`、`wall_id`、`position 0–2`、`prompt`、`kind single\|multi\|text`、`options_json`（填空题为 `[]`）、`created_at`、`updated_at` | `025` 重建表以放宽 `kind` 的 CHECK（回答先挪到临时表，避免级联删除） |
| `wall_answers` | (`question_id`,`user_id`) 主键、`wall_id`、`choices_json`（选中的选项文字；填空题是只有一项的数组）、`updated_at` | 删题级联删除 |
| `wall_reminders` | `id rmd_`、`wall_id`、`organizer_id`、`user_id`、`reason publish\|answer\|both`、`status pending\|sent\|failed`、`created_at` | 只用于限额与后台显示，不存邮件内容与邮箱 |
| `wall_portraits` | `wall_id` 主键、`result_json`（`summary`、`themes[{title,detail,count}]`、`stats`）、`sources_json`（来源发布 ID）、`page_count`、`created_by`、`created_at` | |
| `users.reminder_emails` | `0 / 1`，默认 1 | |

注销（第 14 节）时删除他的全部回答、与他有关的提醒记录、他生成的群像；导出包含 `wallAnswers` 与 `receivesReminderEmails`。

## 19.6 路由

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /w/:wallId/questions` | 墙内有效成员 | 回答 / 修改；没有题目时 303 回 `next` |
| `POST /w/:wallId/questions` | 同上 | 保存回答（19.1）；漏答 / 不合格 400，填空题内容安全命中 422 |
| `POST /w/:wallId/admin/questions` | 这面墙的组织者 | 保存必答题 → 303 `admin?notice=questions-saved#questions`；不合格 400、内容安全 422 |
| `POST /w/:wallId/admin/remind` | 同上 | 一键提醒（19.2） |
| `POST /w/:wallId/admin/portrait` | 同上 | 生成 / 刷新群像 → 303 `admin?notice=portrait-ready#portrait` 或 `?portrait=<错误>#portrait` |
| `GET /w/:wallId/admin/members.csv` | 同上 | 成员名单 |
| `POST /account/notifications` | 登录用户 | 提醒邮件开关 → 303 `/account/data?notice=reminders-on\|reminders-off#notifications` |

POST 均为会话 + CSRF + Origin 的表单路由，忽略 `Authorization`；无权访问与不存在一律 404。演示模式同样可用（提醒邮件写进演示发件箱）。

事件（只有数字与布尔）：`wall_questions_save`（`questions、added、changed、removed、reset`，建墙时 `created`）、`wall_answer`、`wall_remind`、`wall_portrait_generate`（`ok、durationMs、pages、themes` 与 token 数）。
