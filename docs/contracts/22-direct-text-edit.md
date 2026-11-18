# 22. 直接改文字（S16）

> 状态：2026-11-18 起草并实现（分支 `feat/direct-text-edit`）。产品编号 W24。

名字写错、少一个字这类小改动，主人在工作区直接改页面上的文字，**不调用模型、不扣点数**，几秒出一个新版本，预览后照常发布。两条创作路线（本地 Agent、网页内创作）做出来的版本都能改，不要求开启托管功能。代码：`apps/web/src/services/text-edit.ts`（取字与替换，纯函数）、`apps/web/src/services/owner-edit.ts`（入队、等待、worker 一侧存版本）、`apps/web/src/routes/text-edit.tsx`、`apps/web/src/views/text-edit.tsx`，迁移 `024_owner_edit.sql`；常量 `TEXT_EDIT_LIMITS` 在 `packages/contracts`。

## 22.1 能改什么

- 基础版本：主人自己这一页、`accepted` 且未删除的版本（`isRevisionUsable`）。别人的、被拒绝的、已删除的版本 → 404。
- 取字（`extractTextSegments`）：用 parse5 解析基础版本 `original/index.html`（带源码位置），只走 `<body>` 里的元素，**跳过** `script`、`style`、`noscript`、`template`、`textarea`，以及 SVG 里的 `style`；只取文本节点，全是空白的跳过。每段记源码起止位置与前后空白，界面只显示去掉前后空白、解码实体后的文字。按最近的 `data-nm-id` 祖先分组，没有的归入“其他”。
- 最多列出 `TEXT_EDIT_LIMITS.segments`（300）段；之后的文字只能让 AI 改。用脚本输出的文字（打字机效果等）不在 HTML 文本节点里，界面写明“没找到的文字是动效生成的，请用一句话让 AI 改”。
- 名字、一行介绍、接话点和开场白在 `card.json` 里，仍在发布确认表单里改（W10）；本页给出说明与链接。
- **不能**改标签、属性、样式、脚本、图片，也不能增删区块。

## 22.2 替换与新版本

- `POST /w/:wallId/me/text`：`revisionId` 与 `t_<序号>`。服务端重新解析基础版本、重新取字（不信任表单里的序号以外的任何东西），只替换内容有变化的段。
- 每段新文字：去控制字符，换行合并为空格，≤ `TEXT_EDIT_LIMITS.segment`（500）码点，可以为空（删掉这段字）；写回时保留原来的前后空白，`&`、`<`、`>` 转义为实体——**输入只能成为文字，不能成为标记**。一段都没变 → 回到表单并提示“没有改动”。
- 改过的文字先过内容安全检查（16.1，`checkTexts('page', …)`），不通过不入队。
- 新版本的文件 = 基础版本 `original/` 的白名单文件，换上新的 `index.html`，**去掉 `cover.png`**（旧封面上是旧文字，由平台截图重新生成）。`card.json`、`manifest.json`、`assets/` 原样保留。
- 入队 `render_jobs`（`kind = 'owner-edit'`，`owner_id` = 主人，`credential_id` 为空），worker 里与其他提交一样：重新校验（第 2 节）、渲染检查、字体子集化（新加的字自动进子集）、写文件。写库前在事务里重新确认“主人仍拥有这一页、成员关系有效、墙未关闭”，否则不写。校验不通过（例如超过 300 KB）不存版本，表单回显错误。
- 存下的版本 `source = 'owner-edit'`，`credential_id` 为空，工作区显示“你自己改了文字”；**不自动发布**，303 到 `/w/:wallId/me?rev=<新版本>#preview-heading`。
- 计入每页每日 `REVISIONS_PER_PAGE_PER_DAY`（50）次的提交上限；超出返回 429。主站等待渲染最多 `SUBMISSION_WAIT_MS`，等不到时提示稍后在“做过的每一版”里查看。
- 不改 brief、画像，不建 `generation_jobs`，不记点数流水。日志只记 ID、状态与数字，不记文字。

## 22.3 路由

| 路径 | 谁能访问 | 作用 |
| --- | --- | --- |
| `GET /w/:wallId/me/text?rev=<revisionId>` | 页面主人 | 按区块列出可改的文字；缺 `rev` 时用当前选中 / 最新可用版本 |
| `POST /w/:wallId/me/text` | 页面主人 | 存新版本（见 22.2） |

会话 + CSRF + Origin 的表单路由，忽略 `Authorization`；无权访问一律 404，且不入队。工作区在“用一句话告诉 AI”的旁边、本地路线的预览卡片里，给出“直接改文字（不用 AI、不扣点）”入口。

## 22.4 S16 不变量（`apps/web/test/security/text-edit.security.test.ts`）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S16 | 只有页面主人能直接改文字，只能基于自己可用的版本；输入只能成为文本节点的文字，不能改动标记、属性、样式与脚本；新版本照常经过校验、渲染与内容安全检查，不自动发布；不调用模型、不扣点数 | 未登录、墙外、被移出、组织者、其他成员访问 GET / POST → 404 且没有任务与版本；缺 CSRF、外站来源无效，页面凭证无效；别人的版本、被拒绝 / 已删除的版本 → 404；输入 `<script>`、`<img onerror>`、`</p><a data-nm-href>` 只以转义后的文字出现在新 `index.html`，标签与属性集合与基础版本相同；`script` / `style` 里的内容不出现在表单、不能被改；没有点数流水与 AI 任务；新版本未发布；墙关闭 / 被移出后排队的任务不存版本 |
