/**
 * 组织者后台（W03、S5，`GET /w/:wallId/admin`）：邀请链接与二维码、少量聚合数字、成员列表、移除、关闭墙。
 *
 * 成员列表**只有昵称、加入时间、发布状态**。这个页面不能出现任何版本 ID、草稿、未发布的 card、联系方式、
 * 工作区链接或个人浏览数据（S5，test/security/wall-admin.security.test.ts 守住）。
 */
import type { FC } from 'hono/jsx';
import type { WallCredits } from '../services/billing.js';
import type { AdminMemberRow } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { formatDateTime } from '../format.js';
import { CsrfField, ImagePicker, Notice } from './forms.js';
import { OrganizerReports } from './moderation.js';
import type { OrganizerReport } from '../services/moderation.js';
import { PAGE_STATE_LABEL } from './home.js';
import { initialOf } from './layout.js';
import { defaultWallCover } from './home.js';
import type { PortraitState } from '../services/portrait.js';
import type { WallProgress } from '../services/reminders.js';
import type { CardAnswer, QuestionFormValue, QuestionStats } from '../services/wall-questions.js';
import { AdminQuestions, PortraitPanel, ProgressPanel } from './organizer-tools.js';

export type AdminNotice = 'created' | 'removed' | 'cover-updated' | 'cover-deleted' | 'credits-saved' | 'report-takedown' | 'report-dismissed' | 'questions-saved' | 'portrait-ready';

/** 墙的 AI 额度（contracts 12）：只有聚合数字，没有任何成员的明细。演示模式与平台 AI 未开放时为 null。 */
export interface AdminCredits {
  wall: WallCredits;
  /** 组织者自己的余额。 */
  balance: number;
  prices: { generate: number; edit: number };
  error: 'bad-amount' | 'bad-cap' | 'insufficient' | null;
}

const CREDITS_ERROR_TEXT: Record<NonNullable<AdminCredits['error']>, string> = {
  'bad-amount': '充入的点数要填 0 到 100000 的整数。',
  'bad-cap': '每位成员上限要填 0 到 10000 的整数（0 表示不限）。',
  insufficient: '你的点数不够这次充入。先去“点数”页用兑换码补充。',
};

const NOTICE_TEXT: Record<AdminNotice, string> = {
  'credits-saved': '墙的 AI 额度已更新。',
  created: '墙建好了。把下面的邀请链接或二维码发给圈子里的人，打开、登录就能加入。你自己也在这面墙上，回到墙里点“我的页面”就能开始做。',
  removed: '已移出。TA 的页面已经从墙上撤下，也不能再通过邀请链接加入。',
  'cover-updated': '墙封面已更新，成员会在首页看到新封面。',
  'cover-deleted': '已移除墙封面，恢复默认插画。',
  'report-takedown': '这一页已经从墙上撤下。TA 可以修改后重新发布；之后再有人举报，会重新出现在这里。',
  'report-dismissed': '已忽略这些举报，页面继续留在墙上。',
  'questions-saved': '必答题已保存。还没答的成员下次打开墙时会先被请去回答。',
  'portrait-ready': '群像生成好了，墙上的成员都能看到。可以复制下面的文字发到群里。',
};

export interface AdminModel {
  wall: Wall;
  coverUrl: string | null;
  sceneLabel: string;
  inviteUrl: string;
  /** 二维码 SVG 的 data URI。 */
  inviteQr: string;
  members: AdminMemberRow[];
  counts: { members: number; published: number };
  credits: AdminCredits | null;
  /** 待处理举报（contracts 15、S12）：只有页面、原因与次数。 */
  reports: OrganizerReport[];
  /** 必答题（contracts 19.1）：统计范围是全部有效成员。 */
  questions: { stats: QuestionStats[]; values: QuestionFormValue[]; errors?: Record<number, string> };
  /** 成员关系 ID → 这个人的回答（成员列表里展示）。 */
  memberAnswers: Map<string, CardAnswer[]>;
  /** 完成度与一键提醒（contracts 19.2）。 */
  progress: WallProgress;
  groupReminder: string;
  /** 刚刚一键提醒了几个人（跳转回来时显示）。 */
  reminded: number | null;
  /** 墙的群像（contracts 19.3）。 */
  portrait: { state: PortraitState; shareText: string | null; error: string | null };
}

export interface AdminViewProps {
  model: AdminModel;
  csrf: string;
  notice: AdminNotice | null;
  /** 关闭墙没有勾选确认。 */
  closeError?: boolean;
  coverError?: string;
}

const MemberItem: FC<{ member: AdminMemberRow; wallId: string; csrf: string; answers: CardAnswer[] }> = ({ member, wallId, csrf, answers }) => (
  <li class="member-row">
    <span class="avatar" aria-hidden="true">
      {member.avatarUrl ? <img src={member.avatarUrl} alt="" loading="lazy" /> : initialOf(member.nickname)}
    </span>
    <div class="member-row__main">
      <span class="member-row__name">{member.nickname}</span>
      {member.role === 'organizer' ? <span class="badge badge--accent">组织者</span> : null}
      <span class={`badge ${member.state === 'published' ? 'badge--ok' : 'badge--muted'}`}>{PAGE_STATE_LABEL[member.state]}</span>
    </div>
    <div class="member-row__meta muted">
      {formatDateTime(member.joinedAt)} 加入
      {answers.length > 0 ? (
        <span class="member-row__answers">
          {answers.map((answer) => (
            <span class="answer-tag" title={answer.prompt}>
              {answer.choices.map((choice) => choice.label).join('、')}
            </span>
          ))}
        </span>
      ) : null}
    </div>
    {member.role === 'member' ? (
      <form
        method="post"
        action={`/w/${wallId}/admin/remove`}
        class="member-row__action"
        data-confirm={`确定把「${member.nickname}」移出这面墙吗？TA 的页面会立即下墙，并且不能再通过邀请加入。`}
      >
        <CsrfField token={csrf} />
        <input type="hidden" name="membershipId" value={member.membershipId} />
        <button type="submit" class="btn btn--danger btn--small">
          移出
        </button>
      </form>
    ) : null}
  </li>
);

export const AdminView: FC<AdminViewProps> = ({ model, csrf, notice, closeError, coverError }) => {
  const { wall } = model;
  return (
    <div class="container container--wide">
      <nav class="back-link" aria-label="返回">
        <a href={`/w/${wall.id}`}>
          <span aria-hidden="true">←</span> 回到墙
        </a>
      </nav>
      <section class={`hero admin-hero scene--${wall.sceneType}`}>
        <div>
          <p class="eyebrow admin-eyebrow">组织者后台</p>
          <h1 class="hero__title">{wall.name}</h1>
          <p>
            <span class="chip">{model.sceneLabel}</span>
          </p>
        </div>
      </section>
      {notice ? <Notice tone="success">{NOTICE_TEXT[notice]}</Notice> : null}

      <div class="admin-layout">
        <div class="admin-layout__main">
          <section class="card card--pinned invite" aria-labelledby="invite-heading">
            <div class="invite__text">
              <h2 id="invite-heading">邀请成员</h2>
              <p class="muted">把链接或二维码发到群公告、报名表或现场物料里。打开、登录就能加入，不用先做好页面。</p>
              <div class="invite__link">
                <code class="invite__url" id="nm-invite-link">
                  {model.inviteUrl}
                </code>
                <button type="button" class="btn btn--primary" data-copy="nm-invite-link">
                  复制邀请链接
                </button>
              </div>
            </div>
            <figure class="invite__qr">
              <img src={model.inviteQr} alt={`「${wall.name}」的邀请二维码`} width="200" height="200" />
              <figcaption>
                <a class="link-block" href={model.inviteQr} download="nowme-invite-qr.svg">
                  下载二维码
                </a>
              </figcaption>
            </figure>
          </section>

          <ProgressPanel wall={wall} progress={model.progress} groupText={model.groupReminder} csrf={csrf} remindedCount={model.reminded} />

          <OrganizerReports wallId={wall.id} csrf={csrf} reports={model.reports} />

          <AdminQuestions wall={wall} stats={model.questions.stats} total={model.progress.total} values={model.questions.values} errors={model.questions.errors} csrf={csrf} />

          <PortraitPanel wall={wall} state={model.portrait.state} shareText={model.portrait.shareText} organizer={true} csrf={csrf} error={model.portrait.error} />

          <section class="card" aria-labelledby="members-heading">
            <h2 id="members-heading">成员</h2>
            <p class="muted">这里只显示昵称、加入时间、有没有发布页面和必答题的回答。成员的草稿、做好的页面和联系方式，只有他们自己看得到。</p>
            {model.members.every((member) => member.role === 'organizer') ? (
              <p class="muted">现在只有你一个人。把上面的邀请链接发出去，有人加入后会出现在这里。</p>
            ) : null}
            <ul class="member-list">
              {model.members.map((member) => (
                <MemberItem member={member} wallId={wall.id} csrf={csrf} answers={model.memberAnswers.get(member.membershipId) ?? []} />
              ))}
            </ul>
          </section>
        </div>

        <aside class="admin-layout__side">
          <section class="card wall-cover-settings" aria-labelledby="wall-cover-heading">
            <h2 id="wall-cover-heading">墙封面</h2>
            <p class="muted">给这面墙选一张有个性的封面，成员在首页的墙卡片上会看到它。</p>
            <img class="wall-cover-settings__preview" src={model.coverUrl ?? `/static/home-wall-${defaultWallCover(wall)}.svg`} alt={`「${wall.name}」的${model.coverUrl ? '当前封面' : '默认封面'}`} width="400" height="400" />
            {coverError ? <Notice tone="error" id="wall-cover-error">{coverError}</Notice> : null}
            <form method="post" action={`/w/${wall.id}/admin/cover`} enctype="multipart/form-data" class="stack">
              <CsrfField token={csrf} />
              <ImagePicker id="wall-cover-file" name="cover" label={model.coverUrl ? '更换封面图' : '上传封面图'} describedBy={coverError ? 'wall-cover-error wall-cover-help' : 'wall-cover-help'} invalid={!!coverError} required />
              <p id="wall-cover-help" class="field-help">JPG、PNG 或 WebP，5 MB 以内。建议使用 1:1 正方形图片，其他比例将居中裁切。</p>
              <button type="submit" class="btn btn--primary">保存封面</button>
            </form>
            {model.coverUrl ? <form method="post" action={`/w/${wall.id}/admin/cover/delete`} class="wall-cover-settings__delete"><CsrfField token={csrf} /><button type="submit" class="btn btn--ghost btn--small">移除封面，恢复默认</button></form> : null}
          </section>
          {model.credits ? (
            <section class="card wall-credits" id="credits" aria-labelledby="credits-heading">
              <h2 id="credits-heading">给成员的 AI 额度</h2>
              <p class="muted">
                成员用 NOWMe 的 AI 做页面要点数（生成一版 {model.credits.prices.generate} 点，修改一次 {model.credits.prices.edit} 点）。你可以为整面墙充一笔额度：成员做页面时先用墙的，用完才用自己的。
              </p>
              <dl class="stat-tiles">
                <div class="stat-tile stat-tile--accent">
                  <dt>墙的额度</dt>
                  <dd>{model.credits.wall.balance}</dd>
                </div>
                <div class="stat-tile">
                  <dt>已用掉</dt>
                  <dd>{model.credits.wall.spent}</dd>
                </div>
              </dl>
              {model.credits.error ? <Notice tone="error" id="wall-credits-error">{CREDITS_ERROR_TEXT[model.credits.error]}</Notice> : null}
              <form method="post" action={`/w/${wall.id}/admin/credits`} class="stack">
                <CsrfField token={csrf} />
                <label class="field" for="wall-credits-amount">
                  从我的点数里充入（我有 {model.credits.balance} 点）
                  <input id="wall-credits-amount" type="number" name="credits" min="0" max="100000" step="1" inputmode="numeric" placeholder="0" aria-invalid={model.credits.error === 'bad-amount' || model.credits.error === 'insufficient' ? 'true' : undefined} aria-describedby={model.credits.error === 'bad-amount' || model.credits.error === 'insufficient' ? 'wall-credits-error' : undefined} />
                </label>
                <label class="field" for="wall-credits-cap">
                  每位成员最多用多少点
                  <input id="wall-credits-cap" type="number" name="memberCap" min="0" max="10000" step="1" inputmode="numeric" value={String(model.credits.wall.memberCap)} aria-invalid={model.credits.error === 'bad-cap' ? 'true' : undefined} aria-describedby={model.credits.error === 'bad-cap' ? 'wall-credits-error wall-credits-cap-help' : 'wall-credits-cap-help'} />
                </label>
                <p id="wall-credits-cap-help" class="field-help">
                  0 表示不限。比如填 {model.credits.prices.generate + 2 * model.credits.prices.edit}，够每人生成一版、再改两次。
                </p>
                <button type="submit" class="btn btn--primary">
                  保存
                </button>
              </form>
              <p class="muted">
                这里只显示总数，看不到每位成员用了多少。关闭这面墙时，没用完的额度会退回你的点数。 <a href="/account/credits">我的点数</a>
              </p>
            </section>
          ) : null}
          <section class="card overview" aria-labelledby="overview-heading">
            <h2 id="overview-heading">概况</h2>
            <dl class="stat-tiles">
              <div class="stat-tile">
                <dt>成员</dt>
                <dd>{model.counts.members}</dd>
              </div>
              <div class="stat-tile stat-tile--accent">
                <dt>已发布</dt>
                <dd>{model.counts.published}</dd>
              </div>
            </dl>
          </section>

          <section class="card danger-zone" aria-labelledby="close-heading">
            <h2 id="close-heading">关闭这面墙</h2>
            <p>
              关闭后，所有人（包括你）都看不到这面墙，所有页面下墙，邀请链接失效，而且没法重新打开。
            </p>
            {closeError ? <Notice tone="error" id="close-error">请先勾选确认，再关闭墙。</Notice> : null}
            <form
              method="post"
              action={`/w/${wall.id}/admin/close`}
              class="stack"
              data-confirm={`确定关闭「${wall.name}」吗？关闭后不能重新打开。`}
            >
              <CsrfField token={csrf} />
              <label class="check">
                <input type="checkbox" name="confirm" value="1" required aria-invalid={closeError ? 'true' : undefined} aria-describedby={closeError ? 'close-error' : undefined} />
                <span>我确认关闭这面墙</span>
              </label>
              <div>
                <button type="submit" class="btn btn--danger">
                  关闭墙
                </button>
              </div>
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
};
