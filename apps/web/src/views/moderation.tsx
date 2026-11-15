/**
 * 举报、拉黑与处理的界面片段（contracts 15、S12）。
 *
 * - `PageSafety`：成员页底部的“举报 / 拉黑”（只在别人的页面上出现）；
 * - `ConversationSafety`：一对一私聊里的“举报这段对话 / 拉黑”；
 * - `OrganizerReports`：组织者后台的“待处理举报”——只有页面、原因类别与次数，没有举报人、没有补充说明；
 * - `BlockedList`：“我的资料”里的拉黑名单，可以解除。
 */
import type { FC } from 'hono/jsx';
import { REPORT_REASONS } from '../db/moderation.js';
import type { BlockedUserRow } from '../db/moderation.js';
import { formatDateTime } from '../format.js';
import { REPORT_NOTE_MAX_LENGTH, REPORT_REASON_LABEL, type OrganizerReport } from '../services/moderation.js';
import { CsrfField, Notice, PostButton } from './forms.js';

export type SafetyNotice = 'reported' | 'report-updated' | 'blocked';

export const SAFETY_NOTICE_TEXT: Record<SafetyNotice, string> = {
  reported: '收到了，谢谢你告诉我们。组织者和对方都不会知道是你举报的。',
  'report-updated': '已更新你的举报。同一处只会记一次，不会重复计数。',
  blocked: '已拉黑。你们互相看不到对方的页面，也不能再私信；TA 不会收到通知。想反悔的话，可以在“我的资料”里解除。',
};

export function isSafetyNotice(value: string | undefined): value is SafetyNotice {
  return value !== undefined && Object.hasOwn(SAFETY_NOTICE_TEXT, value);
}

const ReportFields: FC<{ idPrefix: string; error?: string | null }> = ({ idPrefix, error }) => (
  <>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <fieldset class="field safety__reasons">
      <legend class="field__label">遇到了什么？</legend>
      {REPORT_REASONS.map((reason) => (
        <label class="check">
          <input type="radio" name="reason" value={reason} required />
          <span>{REPORT_REASON_LABEL[reason]}</span>
        </label>
      ))}
    </fieldset>
    <label class="field" for={`${idPrefix}-note`}>
      <span class="field__label">补充说明（可以不写）</span>
      <textarea id={`${idPrefix}-note`} name="note" rows={3} maxlength={REPORT_NOTE_MAX_LENGTH} placeholder="发生了什么、哪里让你不舒服……"></textarea>
      <span class="field__hint">最多 {REPORT_NOTE_MAX_LENGTH} 字。补充说明只有平台运营能看到，组织者看不到。</span>
    </label>
  </>
);

/** 成员页底部：举报这一页、拉黑页面主人。 */
export const PageSafety: FC<{ base: string; csrf: string; name: string; reported: boolean; notice: SafetyNotice | null; error: string | null }> = ({ base, csrf, name, reported, notice, error }) => (
  <section class="card safety" id="safety" aria-labelledby="safety-heading">
    {notice ? <Notice tone="success">{SAFETY_NOTICE_TEXT[notice]}</Notice> : null}
    <details class="safety__details" open={!!error}>
      <summary id="safety-heading">{reported ? '你已经举报过这一页（可以更新）' : '这一页有问题？举报或拉黑'}</summary>
      <form method="post" action={`${base}/report`} class="stack safety__form">
        <CsrfField token={csrf} />
        <p class="muted">举报会交给这面墙的组织者和平台处理。组织者只看到被举报的页面和原因，不知道是谁举报的；{name}也不会知道。</p>
        <ReportFields idPrefix="page-report" error={error} />
        <div>
          <button type="submit" class="btn btn--danger btn--small">{reported ? '更新举报' : '发送举报'}</button>
        </div>
      </form>
      <div class="safety__block">
        <p class="muted">拉黑后，你们在所有共同的墙上都互相看不到对方的页面，也不能私信；{name}不会收到通知。</p>
        <PostButton action={`${base}/block`} csrf={csrf} label={`拉黑${name}`} variant="danger" confirm={`确定拉黑${name}吗？之后可以在“我的资料”里解除。`} />
      </div>
    </details>
  </section>
);

/** 一对一私聊：举报这段对话（只给平台运营）、拉黑对方。 */
export const ConversationSafety: FC<{ conversationId: string; csrf: string; name: string; blockedByMe: boolean; closed: boolean; reported: boolean; notice: SafetyNotice | null; error: string | null }> = ({
  conversationId,
  csrf,
  name,
  blockedByMe,
  closed,
  reported,
  notice,
  error,
}) => (
  <div class="safety safety--chat" id="safety">
    {notice ? <Notice tone="success">{SAFETY_NOTICE_TEXT[notice]}</Notice> : null}
    {closed ? <Notice tone="info">{blockedByMe ? `你已拉黑${name}，这段对话不能再发消息。想恢复的话，可以在“我的资料”里解除。` : '现在没法在这段对话里发消息了。'}</Notice> : null}
    <details class="safety__details" open={!!error}>
      <summary>{reported ? '你已经举报过这段对话（可以更新）' : '举报这段对话或拉黑'}</summary>
      <form method="post" action={`/messages/${conversationId}/report`} class="stack safety__form">
        <CsrfField token={csrf} />
        <p class="muted">私信举报只交给平台运营查看，组织者永远看不到你们的私信；{name}不会知道是你举报的。</p>
        <ReportFields idPrefix="chat-report" error={error} />
        <div>
          <button type="submit" class="btn btn--danger btn--small">{reported ? '更新举报' : '发送举报'}</button>
        </div>
      </form>
      {blockedByMe ? null : (
        <div class="safety__block">
          <p class="muted">拉黑后你们不能再私信，在共同的墙上也互相看不到页面；{name}不会收到通知。</p>
          <PostButton action={`/messages/${conversationId}/block`} csrf={csrf} label={`拉黑${name}`} variant="danger" confirm={`确定拉黑${name}吗？之后可以在“我的资料”里解除。`} />
        </div>
      )}
    </details>
  </div>
);

/** 组织者后台：待处理举报。 */
export const OrganizerReports: FC<{ wallId: string; csrf: string; reports: OrganizerReport[] }> = ({ wallId, csrf, reports }) => (
  <section class="card reports" id="reports" aria-labelledby="reports-heading">
    <h2 id="reports-heading">待处理举报{reports.length > 0 ? `（${reports.length}）` : ''}</h2>
    {reports.length === 0 ? (
      <p class="muted">现在没有待处理的举报。成员遇到问题时，可以在别人页面的底部举报；你会在这里看到被举报的页面和原因（看不到是谁举报的）。</p>
    ) : (
      <>
        <p class="muted">这里只显示被举报的页面、原因和次数，不显示是谁举报的。私信里的举报由平台处理，不会出现在这里。</p>
        <ul class="reports__list">
          {reports.map((item) => (
            <li class="reports__item">
              <div>
                <h3>
                  <a href={item.href}>{item.displayName}</a>
                </h3>
                <p class="muted">
                  {item.reasons.map((reason) => `${reason.label} ${reason.count} 次`).join(' · ')} · 最近 {formatDateTime(item.lastAt)}
                </p>
              </div>
              <div class="reports__actions">
                <PostButton
                  action={`/w/${wallId}/admin/reports/takedown`}
                  csrf={csrf}
                  label="请这一页下墙"
                  variant="danger"
                  fields={{ pageId: item.pageId }}
                  confirm={`让「${item.displayName}」的页面立即从墙上撤下？TA 可以修改后重新发布。`}
                />
                <PostButton action={`/w/${wallId}/admin/reports/dismiss`} csrf={csrf} label="忽略" fields={{ pageId: item.pageId }} />
              </div>
            </li>
          ))}
        </ul>
      </>
    )}
  </section>
);

/** “我的资料”：我拉黑的人。 */
export const BlockedList: FC<{ csrf: string; blocked: BlockedUserRow[] }> = ({ csrf, blocked }) => (
  <section class="profile-card profile-blocks" id="blocks" aria-labelledby="blocks-heading">
    <h2 id="blocks-heading">拉黑名单（{blocked.length} 人）</h2>
    {blocked.length === 0 ? (
      <div class="profile-empty">
        <p>你还没有拉黑任何人</p>
        <span>在别人的页面或私信里都可以拉黑。拉黑后你们互相看不到页面，也不能私信，对方不会收到通知。</span>
      </div>
    ) : (
      <ul class="profile-brief-list">
        {blocked.map((item) => (
          <li>
            <div>
              <h3>{item.nickname}</h3>
              <p class="muted">{formatDateTime(item.blockedAt)} 拉黑</p>
            </div>
            <div class="profile-brief-actions">
              <PostButton action="/account/blocks/remove" csrf={csrf} label="解除" fields={{ userId: item.userId }} confirm={`解除对${item.nickname}的拉黑？你们会重新看到对方的页面，也可以私信。`} />
            </div>
          </li>
        ))}
      </ul>
    )}
  </section>
);
