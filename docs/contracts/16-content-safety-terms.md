# 16. 内容安全、AI 生成说明与用户协议

## 16.1 内容安全检查

统一入口 `checkText(kind, text)`（`apps/web/src/services/content-safety.ts`，挂在 `deps.contentSafety`，另有 `checkTexts`）。**在路由 / 服务边界、写入或交给模型之前调用**，不深入 `hosted/service.ts` 内部。检查点类型 `ContentKind`（`packages/contracts/src/content-safety.ts`）：

| kind | 检查什么 | 位置 | 命中时 |
| --- | --- | --- | --- |
| `wall` | 墙名称、简介、组织者的话 | `POST /walls` | 422，字段上的提示，不建墙 |
| `nickname` | 昵称 | `POST /welcome`、`POST /account/profile` | 422 / 400，不保存 |
| `interview` | 采访素材与选项补充、追问回答、重做备注、确认时改写的“AI 眼中的你”与接话点 / 开场白 | `/me/create/start`、`followups`、`revise`、`confirm` | 422，回到创作页并提示，不建 brief、不请求模型 |
| `edit` | 修改要求 | `POST /me/edit` | 400，提示页，不建任务 |
| `message` | 站内消息（群聊与私聊） | `POST /messages/:id/send`（会话可见且没被限流才检查） | 400（JSON 或页面），消息不入库 |
| `page` | 发布时版本的渲染文字（`revisions.rendered_text`）加确认表单里的名字、一行介绍、接话点、开场白 | `POST /me/publish` | 400，提示页，不发布 |

规则按顺序：

1. **内置规则** `B01`–`B05`（诈骗引流、赌博、色情招揽、违禁品交易、拉人头），只放几乎不可能是正常内容的写法；匹配前做 NFKC、小写、去掉空白与分隔符。不是敏感词大全，更多靠 2、3 补充。
2. **外部词表**（`NOWME_BLOCKLIST_FILE`，可选）：每行一个词（忽略空白与标点地匹配）或 `/正则/标志`（标志只允许 `i u s m`），`#` 注释；规则编号 `F<行号>`；最多 5000 条、每条 200 字符、文件 512 KB。启动时读入并校验，**读不到或任何一行不合法都拒绝启动**（错误信息只带行号，不带词）。
3. **外部审核接口**（`NOWME_MODERATION_URL`，可选，默认关闭）：只允许 https（不含账号密码），连接时复用 `security/model-network.ts` 的 `createModelFetch`（逐次解析 DNS、任何非公网地址拒绝、固定连接地址、拒绝重定向）。主站 `POST` JSON `{ "kind", "text" }`（文字最多 8000 字符），可选 `NOWME_MODERATION_API_KEY` 以 `Authorization: Bearer` 发送；期望返回 JSON `{ "allowed": boolean, "rule"?: string }`（规则编号只留 `[A-Za-z0-9_.-]{1,32}`，显示为 `M:<编号>`，否则 `M01`）。超时（3 秒）、非 2xx、格式不对、网络或地址校验失败都算“接口不可用”，按 `NOWME_MODERATION_ON_FAILURE`：`allow`（默认）放行并记日志，`block` 拦截（编号 `M00`）。本地规则已命中时不调用接口。

拦截提示是中文、友好、不说教，形如“这条消息里有我们没法放行的内容，换个说法再发一次吧。（提示编号 B01；如果觉得是误判，改写后再提交即可。）”。**日志只记检查点类型与规则编号**（`[safety] 拦截 kind=message rule=B01`、`[safety] 审核接口不可用 kind=… reason=… action=…`），不记原文，也不记审核接口密钥。

配置：`NOWME_BLOCKLIST_FILE`、`NOWME_MODERATION_URL`、`NOWME_MODERATION_API_KEY`（只从环境变量读，不进配置对象）、`NOWME_MODERATION_ON_FAILURE`（`allow` | `block`）、`NOWME_CONTACT_EMAIL`（协议页上的联系邮箱，可选）；定义与校验在 `packages/contracts/src/config.ts` 的 `loadModerationConfig`、`loadContactEmail`。启用审核接口后，隐私政策自动写明“文字会发给第三方审核服务”。

不做：图片内容识别；本地 Agent 路线提交页面时的即时检查（发布是统一关口）；对已发布内容的回溯扫描。

## 16.2 用户页面的生成说明

页面是 AI 和本人一起做的，由本人确认后发布。该说明保留在用户协议中，墙卡片、成员页、工作区预览与公开链接页不再显示“✦ AI 协助生成”提示。主站不向用户页面文件或 iframe 内容注入生成标识，页面文件、`served/`、沙箱与 CSP 不变。

## 16.3 用户协议、隐私政策与年龄确认

- 公开页面 `GET /terms`、`GET /privacy`（`routes/legal.tsx`、`views/legal.tsx`，不需要登录，所有页面页脚与公开链接页有链接）。文字必须与代码实际存的数据和做法一致（存什么、为什么、谁能看到、存多久、怎么删除；注销与导出入口写“我的资料”页）；改数据模型、保存期限、可见范围或对外发送的服务时同步改文字并升版本。
- 版本常量在 `packages/contracts/src/legal.ts`：`LEGAL_VERSION`（两份文档共用一个日期版本号，当前 `2026-11-15`）、`LEGAL_EFFECTIVE_DATE`、`MIN_USER_AGE = 18`、表单字段 `CONSENT_FIELD_NAME = 'agree'`。
- 迁移 `013_consent.sql`：`users.terms_version`、`users.terms_accepted_at`（只存最近一次确认；迁移前注册的老用户为空）。
- 首次登录：`/welcome` 昵称表单增加必选勾选“我已年满 18 岁，并同意《用户协议》和《隐私政策》”（链接在新标签页打开）。不勾选 → 400，昵称和同意记录都不写；勾选 → 同一次提交里写昵称并记录 `LEGAL_VERSION` 与时间。
- 重新确认：登录后站内页面检查 `terms_version === LEGAL_VERSION`，不是就 `303 /consent?next=…`（`requireUser` / `requireForm` / 消息的 JSON 接口 403；`security/session.ts` 的 `onboardingStep`）。`/consent` 是中间页，勾选后记录新版本并回到 `next`（只允许站内路径）；不同意可退出登录。`/consent`、`/terms`、`/privacy`、`/logout` 不被拦。`/api/`（页面凭证）不加载会话，不受影响。演示模式的固定账号不走这一步；开发与演示种子账号直接记为已确认。
- 安全测试：`apps/web/test/security/consent.security.test.ts`（未同意被导向确认页、表单不执行、版本升级重新确认、`next` 只允许站内、`/api/` 不受影响）与 `content-safety.security.test.ts`（日志不含原文、审核接口只走公网 HTTPS、被拦内容不写库不交给模型）。
