# 6. 事件（W20）

| 来源 | 类型 |
| --- | --- |
| CLI（凭证上报，不含内容） | `agent_fetch`、`agent_validate`、`agent_preview`、`agent_generate`、`agent_submit` |
| 主站 | `wall_view`、`page_open`、`want_to_chat`、`publish`、`withdraw`、`public_link_on`、`public_link_off`、`join`、`leave`、`member_removed`、`wall_closed`；`remote_preview`（服务端远程预览，用于限流，4.1） |
| 平台托管路线 | `hosted_interview_call`、`hosted_brief_confirm`、`hosted_generate`、`hosted_edit`、`brief_delete`、`profile_delete`（hosted-route 6） |
| 和 TA 聊什么 | `icebreaker_generate`（成功与失败都记，用于限流，11.5）；用开场白开聊记 `want_to_chat`，`props` 含 `ai: true`、`openerIndex` |
| 点数 | `credits_redeem`（`props: { credits }`）、`credits_sponsor`（`props: { credits, memberCap }`），不含兑换码（12.4、12.5） |

`props` 只含数字与布尔值（例如 `ok`、`durationMs`、`errorCount`）。按墙聚合统计由 `pnpm --filter @nowme/web stats <wallId>` 输出；组织者界面不提供个人层面的浏览轨迹。
