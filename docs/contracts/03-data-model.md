# 3. 数据模型（SQLite）

ID 一律为 `<前缀>_<16 字节随机 base32 小写>`；时间为 ISO 8601 UTC 字符串。一次性 token、页面凭证、会话令牌、登录验证码、兑换码（第 12 节）**只存 SHA-256 哈希**；邀请码与公开链接令牌是需要反复展示给组织者/主人的可分享链接，明文保存，可随时轮换。

| 令牌 | 格式 |
| --- | --- |
| 一次性 token | `nmt_` + 32 字节 base64url |
| 页面凭证 | `nmc_` + 32 字节 base64url |
| 会话令牌 | `nms_` + 32 字节 base64url |
| 邀请码 | `inv_` + 16 字节 base32 小写 |
| 公开链接令牌 | `pub_` + 24 字节 base64url（注意与 publication ID 前缀区分：publication ID 用 `pbl_`） |

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `users` | `id usr_`、`email` 唯一（小写）、`nickname`、`avatar_webp`、`avatar_version`、`created_at` | 首次登录时填写昵称；资料页可修改昵称和头像，头像只存重编码后的 WebP |
| `login_codes` | `id`、`email`、`code_hash`、`attempts`、`expires_at`、`used_at` | 6 位数字，10 分钟，最多 5 次尝试 |
| `sessions` | `id`（会话令牌哈希）、`user_id`、`csrf_token`、`created_at`、`expires_at` | 30 天 |
| `walls` | `id wal_`、`name`、`description`、`scene_type`、`organizer_note`、`organizer_id`、`invite_code`、`status open\|closed`、`created_at`、`closed_at` | |
| `wall_covers` | `wall_id` 主键 / 外键、`version`、`image` BLOB、`updated_at` | 组织者设置的墙封面；独立于成员页面的封面，统一重编码为静态 WebP，不保存上传原图或文件名 |
| `memberships` | `id mem_`、`wall_id`、`user_id`、`role organizer\|member`、`status active\|left\|removed`、`joined_at`、`ended_at` | (`wall_id`,`user_id`) 唯一；组织者建墙时自动成为成员 |
| `pages` | `id pg_`、`membership_id` 唯一、`wall_id`、`owner_id`、`contact_channel`、`contact_value`、`contact_public`、`public_token`（空=未开启）、`created_at`、`updated_at` | 加入墙时创建 |
| `agent_tokens` | `id`、`page_id`、`token_hash`、`expires_at`、`used_at`、`created_at` | 一次性 token |
| `page_credentials` | `id`、`page_id`、`credential_hash`、`created_at`、`last_used_at`、`revoked_at`、`client_cli_version`、`client_skill_version`（T3.6，迁移 003：exchange 时 CLI 自报的版本，可空，只用于显示） | 每页同时最多一个有效凭证 |
| `revisions` | `id rev_`、`page_id`、`number`（页内递增）、`source`（`local-agent`）、`credential_id`、`status accepted\|rejected`、`report_json`、`card_json`、`manifest_json`、`rendered_text`、`render_json`、`created_at` | 文件存 `revisions/<id>/`；rejected 版本只存报告 |
| `publications` | `id pbl_`、`page_id`、`revision_id`、`card_json`（主人确认后的）、`contact_json`（发布时快照）、`published_at`、`ended_at`、`end_reason superseded\|withdrawn\|removed\|closed\|deleted` | 不可变快照；每页至多一个 `ended_at IS NULL` |
| `events` | `id evt_`、`type`、`wall_id`、`page_id`、`actor_id`、`props_json`、`created_at` | 只存类型、ID、数值/布尔属性，**不存内容** |
| `conversations` | `id cnv_`、`wall_id`、`kind group\|direct`、`user_a`、`user_b`、`created_at` | 每墙唯一群；私聊用户 ID 排序后与墙组成唯一键；群 ID 复用墙 ID 的随机后缀 |
| `chat_messages` | `sequence` 整数递增主键、`conversation_id`、`sender_id`、`client_id`、`body`、`created_at` | `(conversation_id,sender_id,client_id)` 唯一，消息按 sequence 排序；正文只存纯文字 |
| `chat_reads` | `conversation_id`、`user_id`、`last_sequence` | 联合主键；已读位置仅允许单调前进 |

| `icebreakers` | `id ice_`、`wall_id`、`viewer_id`、`page_id`、`publication_id`、`result_json`、`created_at` | “和 TA 聊什么”的结果，只属于查看者（迁移 `008_icebreakers.sql`，第 11 节） |
| `wall_questions`、`wall_answers`、`wall_reminders`、`wall_portraits`；`users.reminder_emails` | 见 19.5 | 必答题与回答、提醒记录、墙的群像、提醒邮件开关（迁移 `020_organizer_tools.sql`，第 19 节） |
| `credit_balances`、`credit_entries`、`redeem_codes`、`wall_sponsorships` | 见 12.2 | 点数余额、只追加的流水、兑换码哈希、墙额度每人上限（迁移 `009_credits.sql`，第 12 节） |

平台托管路线的表（`user_model_settings`、`profile_entries`、`briefs`、`brief_assets`、`generation_jobs`）见 [hosted-route.md 第 4 节](../hosted-route.md)。

页面的展示状态由数据推导：有活跃 publication → `published`；有 publication 历史但当前无 → `withdrawn`；否则 `unpublished`。

`revisions/<id>/` 布局：`original/`（提交的原文件）、`served/index.html`（注入字体 `@font-face` 后的版本）、`served/assets/...`、`served/_fonts/<fontId>-<weight>.woff2`、`cover.png`、`render/full.png`。

## 3.1 账号资料与头像

头像上传接受静态 PNG / JPEG / WebP，按文件魔数识别并实际解码，拒绝 SVG、GIF、多帧图片、损坏图片。单张不超过 2 MB，请求不超过 2 MB + 64 KB，解码不超过 1600 万像素。自动按 EXIF 旋转、居中裁成正方形（最长 256px，小图不放大），重新编码为 WebP 并剥离元数据；不保存原图、文件名或外部图片 URL。删除头像清空位图与版本号。资料卡、主站导航使用当前会话头像，未设置时显示昵称首字；不改写已生成的用户页面或长期画像。
