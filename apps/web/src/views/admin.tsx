/**
 * 组织者后台（W03、S5，`GET /w/:wallId/admin`）：邀请链接与二维码、少量聚合数字、成员列表、移除、关闭墙。
 *
 * 成员列表**只有昵称、加入时间、发布状态**。这个页面不能出现任何版本 ID、草稿、未发布的 card、联系方式、
 * 工作区链接或个人浏览数据（S5，test/security/wall-admin.security.test.ts 守住）。
 */
import type { FC } from 'hono/jsx';
import type { AdminMemberRow } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { formatDateTime } from '../format.js';
import { CsrfField, Notice } from './forms.js';
import { PAGE_STATE_LABEL } from './home.js';
import { initialOf } from './layout.js';
import { defaultWallCover } from './home.js';

export type AdminNotice = 'created' | 'removed' | 'cover-updated' | 'cover-deleted';

const NOTICE_TEXT: Record<AdminNotice, string> = {
  created: '墙建好了！把下面的邀请链接或二维码发出去，大家打开、登录就能加入。你自己的页面也在这面墙上，回到墙里点“我的页面”就能开始做。',
  removed: '已移出：TA 的页面已立即从墙上消失，本地 Agent 的连接也已断开。TA 不能再通过邀请加入。',
  'cover-updated': '墙封面已更新，成员会在首页看到新封面。',
  'cover-deleted': '已移除墙封面，恢复默认插画。',
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
}

export interface AdminViewProps {
  model: AdminModel;
  csrf: string;
  notice: AdminNotice | null;
  /** 关闭墙没有勾选确认。 */
  closeError?: boolean;
  coverError?: string;
}

const MemberItem: FC<{ member: AdminMemberRow; wallId: string; csrf: string }> = ({ member, wallId, csrf }) => (
  <li class="member-row">
    <span class="avatar" aria-hidden="true">
      {member.avatarUrl ? <img src={member.avatarUrl} alt="" loading="lazy" /> : initialOf(member.nickname)}
    </span>
    <div class="member-row__main">
      <span class="member-row__name">{member.nickname}</span>
      {member.role === 'organizer' ? <span class="badge badge--accent">组织者</span> : null}
      <span class={`badge ${member.state === 'published' ? 'badge--ok' : 'badge--muted'}`}>{PAGE_STATE_LABEL[member.state]}</span>
    </div>
    <div class="member-row__meta muted">{formatDateTime(member.joinedAt)} 加入</div>
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
          <section class="card invite" aria-labelledby="invite-heading">
            <div class="invite__text">
              <h2 id="invite-heading">邀请成员</h2>
              <p class="muted">把链接或二维码发到群公告、报名表或现场物料里。打开并登录就能加入，不需要先做好页面。</p>
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
                <a href={model.inviteQr} download="nowme-invite-qr.svg">
                  下载二维码
                </a>
              </figcaption>
            </figure>
          </section>

          <section class="card" aria-labelledby="members-heading">
            <h2 id="members-heading">成员</h2>
            <p class="muted">这里只显示昵称、加入时间和发布状态。成员的草稿、版本和联系方式只有本人看得到。</p>
            <ul class="member-list">
              {model.members.map((member) => (
                <MemberItem member={member} wallId={wall.id} csrf={csrf} />
              ))}
            </ul>
          </section>
        </div>

        <aside class="admin-layout__side">
          <section class="card wall-cover-settings" aria-labelledby="wall-cover-heading">
            <h2 id="wall-cover-heading">墙封面</h2>
            <p class="muted">给这面墙选一张有个性的封面，它会展示在成员首页的墙卡片上。</p>
            <img class="wall-cover-settings__preview" src={model.coverUrl ?? `/static/home-wall-${defaultWallCover(wall)}.svg`} alt={`「${wall.name}」的${model.coverUrl ? '当前封面' : '默认封面'}`} width="400" height="400" />
            {coverError ? <Notice tone="error">{coverError}</Notice> : null}
            <form method="post" action={`/w/${wall.id}/admin/cover`} enctype="multipart/form-data" class="stack">
              <CsrfField token={csrf} />
              <label for="wall-cover-file">{model.coverUrl ? '更换封面图' : '上传封面图'}</label>
              <input id="wall-cover-file" name="cover" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="wall-cover-help" required />
              <p id="wall-cover-help" class="field-help">JPG、PNG 或 WebP，5 MB 以内。建议使用 1:1 正方形图片，其他比例将居中裁切。</p>
              <button type="submit" class="btn btn--primary">保存封面</button>
            </form>
            {model.coverUrl ? <form method="post" action={`/w/${wall.id}/admin/cover/delete`} class="wall-cover-settings__delete"><CsrfField token={csrf} /><button type="submit" class="btn btn--ghost btn--small">移除封面，恢复默认</button></form> : null}
          </section>
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
              关闭后所有人（包括你）都看不到这面墙，成员的页面全部下墙，大家本地 Agent 的连接全部断开，邀请链接失效。关闭后不能重新打开。
            </p>
            {closeError ? <Notice tone="error">请先勾选确认，再关闭墙。</Notice> : null}
            <form
              method="post"
              action={`/w/${wall.id}/admin/close`}
              class="stack"
              data-confirm={`确定关闭「${wall.name}」吗？关闭后不能重新打开。`}
            >
              <CsrfField token={csrf} />
              <label class="check">
                <input type="checkbox" name="confirm" value="1" required />
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
