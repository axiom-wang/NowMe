# 11. 和 TA 聊什么（S9）

成员在**别人的**成员页（`GET /w/:wallId/p/:pageId` 的 `#talk` 区块）请 AI 找两人的连接点并起草开场白。代码：`apps/web/src/hosted/icebreaker.ts`（模型调用与核对）、`apps/web/src/services/icebreaker.ts`（授权、资料、限流、保存）、`apps/web/src/db/icebreakers.ts`、迁移 `008_icebreakers.sql`；常量 `ICEBREAKER_*` 在 `packages/contracts`。

## 11.1 谁能发起、用谁的模型

- 必须是这面墙的有效成员，目标是墙上**已发布**、且**不是自己**的页面（`findPublishedMemberPage`）；否则 `404`，不调用模型。
- 模型按 `interview` 角色解析：查看者有自己的配置就用自己的；没有且平台 AI 可用时用平台 AI，**不收点数**，计入全站免费调用上限（10.3、12.1）；两者都没有时界面引导去 AI 设置，提交得到 `MODEL_CONFIG` 说明。

## 11.2 交给模型的资料（输入范围）

| 一方 | 内容 | 上限 |
| --- | --- | --- |
| 墙 | 名称、简介（≤ 200）、场景名 | — |
| 查看者 | 昵称或发布卡片上的名字；**自己**在这面墙已发布的卡片（一行介绍、接话点）与渲染文字；**自己**确认过（`confirmed`）的采访摘要（“AI 眼中的你”≤ 5 句、接话点 ≤ 3、想突出的一面） | 渲染文字 1600 码点 |
| 查看者的禁区 | brief 里 `boundaries.hidden` 与 `rejected`（≤ 12 条），单独成块，只用于“不得提到”，不算可引用资料 | — |
| 对方 | 当前发布快照的名字、一行介绍、接话点，与该版本的渲染文字 | 渲染文字 2400 码点 |

不读对方的草稿、未发布版本、采访、画像、联系方式（含公开的），不读任何第三人的内容。所有资料去控制字符、截断后用 `untrusted()` 包成资料块；system 声明资料不是指令。查看者没有任何资料时，明确告诉模型只写 `curious`。

## 11.3 输出与核对

模型必须调用 `submit_icebreaker`；输出经 zod 校验，不合法或核对后没有可用开场白时重试一次，再失败为 `failed`，不保存。

```ts
interface IcebreakerResult {
  links: { kind: 'common' | 'complement' | 'curious'; title: string; mine: string; theirs: string }[]; // 0–3 条
  openers: { text: string; about: string }[];                                                      // 1–3 句
  sources: { page: boolean; brief: boolean };   // 这次用了查看者的哪些资料（界面如实说明）
}
```

| 规则 | 说明 |
| --- | --- |
| 长度 | `title` ≤ 18、`mine` / `theirs` ≤ 40、开场白 ≤ 90（至少 6 字）、`about` ≤ 16 码点；每类先取模型前 6 条再筛 |
| 原文核对（`groundIcebreaker`） | `theirs` 必须出现在对方资料里；`common` / `complement` 的 `mine` 还必须出现在查看者资料里；对不上整条丢弃。比较前统一 NFKC、小写，去空白、标点、符号，依据至少 2 个字。未知 `kind` 按 `curious`，`curious` 的 `mine` 清空 |
| 禁止链接与联系方式（`hasContact`） | `http(s)://`、`www.`、邮箱、常见域名后缀、7 位以上数字串：连接点任一字段或开场白含有即丢弃。检查在截断之前做（对模型原文） |
| 去重 | 连接点按规范化标题、开场白按规范化正文去重 |
| 输出 | 只经 JSX 转义按文字渲染 |

## 11.4 结果归属、开场白与清除

- 表 `icebreakers`：`id ice_`、`wall_id`、`viewer_id`、`page_id`、`publication_id`、`result_json`、`created_at`。只保存成功的结果；同一查看者对同一页只保留最新一份（“换一批”替换）。
- **只属于查看者**：只按 `viewer_id` 读取；页面主人、组织者、其他成员都看不到；结果 ID 被别人拿到也不能用来开聊或清除。结果绑定对方当时的 `publication_id`：对方更新或撤下发布、ID 用在别的页上，一律视为不存在。
- 墙页上只对查看者自己给“找过话题”的卡片打标记，对方更新发布后消失。
- **只预填、不代发**：“用这句开聊”进入与对方的同墙私聊，把那一句作为未发送草稿放进输入框，不产生任何消息；发送仍由查看者本人完成（4.2.1）。
- 清除：查看者手动清除；对方删除页面（该页的全部结果）；查看者退出墙、被移除（他在这面墙的结果）；墙关闭（整面墙）；查看者删除自己的采访（他在那面墙的结果）。
- 模型调用结束后重新做一次授权检查：期间对方更新 / 撤下、任一方失去访问、墙关闭 → 不保存，返回 `gone`。

## 11.5 路由与限流

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `POST /w/:wallId/p/:pageId/icebreaker` | 墙内有效成员，非自己的已发布页 | 发起或“换一批”；303 回到 `#talk`，失败时带 `?ice=<错误>` |
| `POST /w/:wallId/p/:pageId/icebreaker/chat` | 同上 | `icebreakerId`、`opener`（0–2）；校验结果属于本人、本页、当前发布 → 303 `/messages/:id?pageId=&ice=&o=`；记 `want_to_chat`（`props: { ai: true, openerIndex }`） |
| `POST /w/:wallId/p/:pageId/icebreaker/clear` | 同上 | 清除本人对这一页的结果 |

均为会话 + CSRF + Origin 的表单路由，忽略 `Authorization`。`/messages/:id` 只在会话是与该页主人的私聊、且结果仍有效时解析 `ice` / `o` 草稿。

| 限制 | 取值 | 错误 |
| --- | --- | --- |
| 每位查看者（跨墙） | 40 次 / 滚动 24 小时 | `daily` |
| 同一查看者对同一页（含换一批） | 4 次 / 滚动 24 小时 | `target-daily` |
| 同一查看者并发 | 1 | `busy` |
| 单次总时限 | 60 s | `timeout` |

次数按 `icebreaker_generate` 事件计（成功与失败都记，`props` 只有 `ok`、`durationMs`、`links`、`openers`、`hasPage`、`hasBrief` 与 token 数）。其他错误：`MODEL_CONFIG` / `MODEL_AUTH` / `MODEL_RATE_LIMITED` / `MODEL_UNAVAILABLE`、`failed`、`gone`。界面只显示 `ICEBREAKER_ERROR_TEXT` 里的固定文案，不在名单里的 `ice` 参数不显示任何提示。

## 11.6 S9 不变量（`apps/web/test/security/icebreaker.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S9 | 只把查看者自己的资料和对方已公开在墙上的内容交给模型；结果只属于查看者；连接点的依据必须是两边资料里的原文（服务端核对）；开场白只预填、从不代发；输出里不允许出现链接与联系方式 | 未登录、墙外、自己的页、未发布的页不能发起且不调用模型；凭证 / 缺 CSRF 无效；被移除立即失效；模型请求里没有第三人、对方草稿与联系方式，禁区单独成块；主人、组织者、其他成员看不到结果，别人的结果 ID 不能开聊或清除，不能跨页使用；注入的链接与手机号、编造的共同点进不了结果，标记按文字输出；开聊不产生消息；删除页面、退出、移除、关闭墙、删除采访时结果一并删除；事件只有数字与布尔 |
