/**
 * 删除页面与退出墙的确认页（W16：删除前说明影响范围并确认）与退出后的结果页。
 * 本地的 brief 与画像从不上传，所以删除 / 退出都不影响它们（明确告诉主人）。
 */
import type { FC } from 'hono/jsx';
import type { Wall } from '../db/walls.js';
import type { DeletionImpact } from '../services/page-lifecycle.js';
import { CsrfField, Notice } from './forms.js';

function workspaceHref(wall: Wall): string {
  return `/w/${wall.id}/me`;
}

const Breadcrumb: FC<{ wall: Wall; title: string }> = ({ wall, title }) => (
  <section class="page-intro">
    <nav class="crumbs" aria-label="当前位置">
      <a href="/">首页</a>
      <span aria-hidden="true">/</span>
      <a class="crumbs__wall" href={workspaceHref(wall)} title={wall.name}>{wall.name}</a>
    </nav>
    <h1 class="hero__title">{title}</h1>
  </section>
);

const LocalFilesNote: FC = () => (
  <li>
    你电脑上的 brief.md、长期画像（~/.nowme/profile.md）和 page/ 目录不受影响，它们从没上传到 NOWMe。想清理的话，请在自己电脑上删除。
  </li>
);

export const DeleteConfirmView: FC<{ wall: Wall; csrf: string; impact: DeletionImpact; error?: string | null }> = ({
  wall,
  csrf,
  impact,
  error,
}) => (
  <div class="container container--narrow">
    <Breadcrumb wall={wall} title="删除这一页" />
    <section class="card confirm confirm--danger" aria-labelledby="delete-impact-heading">
      <h2 id="delete-impact-heading">删除后会发生什么</h2>
      <p>删除后不能恢复。确认之前，先看看影响范围：</p>
      <ul class="impact">
        <li>
          {impact.revisionCount > 0
            ? `删除这一页做过的 ${impact.revisionCount} 版${impact.fileRevisionCount > 0 ? `（其中 ${impact.fileRevisionCount} 版有页面、图片、封面和截图文件）` : ''}，以及对应的检查记录；历史里只会留下“已删除”的编号。`
            : '这一页还没有做出过任何一版。'}
        </li>
        <li>
          {impact.publishedRevisionNumber !== null
            ? `墙上正在展示的第 ${impact.publishedRevisionNumber} 版立即撤下，墙上的小卡片、话题和联系方式一并清除。`
            : '页面现在不在墙上；以前发布时留下的小卡片和联系方式也会一并清除。'}
        </li>
        {impact.publicLinkOn ? <li>关闭公开链接，旧链接立即失效。</li> : null}
        {impact.agentConnected ? <li>断开你电脑上的 AI 助手：给它的授权和还没用的那段话立即失效。</li> : null}
        {impact.contactSaved ? <li>清除你保存的联系方式。</li> : null}
      </ul>
      <h3 class="impact__keep-title">不受影响</h3>
      <ul class="impact impact--keep">
        <li>你仍是「{wall.name}」的成员，可以继续逛这面墙，也可以重新开始做一页。</li>
        <LocalFilesNote />
      </ul>
      {error ? <Notice tone="error" id="delete-error">{error}</Notice> : null}
      <form method="post" action={`${workspaceHref(wall)}/delete`} class="confirm__form">
        <CsrfField token={csrf} />
        <label class="check check--strong">
          <input type="checkbox" name="confirm" value="1" required aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'delete-error' : undefined} />
          <span>我明白删除后无法恢复</span>
        </label>
        <div class="actions">
          <button type="submit" class="btn btn--danger-solid">
            删除这一页
          </button>
          <a class="btn btn--ghost" href={workspaceHref(wall)}>
            取消
          </a>
        </div>
      </form>
    </section>
  </div>
);

export interface LeaveImpact {
  isOrganizer: boolean;
  published: boolean;
  publicLinkOn: boolean;
  agentConnected: boolean;
}

export const LeaveConfirmView: FC<{ wall: Wall; csrf: string; impact: LeaveImpact; error?: string | null }> = ({
  wall,
  csrf,
  impact,
  error,
}) => (
  <div class="container container--narrow">
    <Breadcrumb wall={wall} title={`退出「${wall.name}」`} />
    {impact.isOrganizer ? (
      <section class="card confirm">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>你是这面墙的组织者，不能退出。</p>
        <p class="muted">如果活动已经结束，可以在组织者后台关闭这面墙：关闭后，墙对所有人不可见，所有页面一并下墙。</p>
        <div class="actions">
          <a class="btn btn--primary" href={`/w/${wall.id}/admin`}>
            去组织者后台
          </a>
          <a class="btn btn--ghost" href={workspaceHref(wall)}>
            回到我的页面
          </a>
        </div>
      </section>
    ) : (
      <section class="card confirm confirm--danger" aria-labelledby="leave-impact-heading">
        <h2 id="leave-impact-heading">退出后会发生什么</h2>
        <ul class="impact">
          <li>你将看不到这面墙和墙上的成员页面。</li>
          {impact.published ? <li>你的页面立即从墙上撤下。</li> : null}
          {impact.publicLinkOn ? <li>公开链接关闭，旧链接立即失效。</li> : null}
          {impact.agentConnected ? <li>断开你电脑上的 AI 助手：给它的授权立即失效。</li> : null}
        </ul>
        <h3 class="impact__keep-title">不受影响</h3>
        <ul class="impact impact--keep">
          <li>
            你做好的页面会保留：以后用邀请链接重新加入就能找回，但需要重新确认发布。想彻底删掉内容，请先
            <a href={`${workspaceHref(wall)}/delete`}>删除这一页</a>再退出。
          </li>
          <LocalFilesNote />
        </ul>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form method="post" action={`/w/${wall.id}/leave`} class="confirm__form">
          <CsrfField token={csrf} />
          <div class="actions">
            <button type="submit" class="btn btn--danger-solid">
              确认退出
            </button>
            <a class="btn btn--ghost" href={workspaceHref(wall)}>
              取消
            </a>
          </div>
        </form>
      </section>
    )}
  </div>
);

export const LeftView: FC<{ wallName: string; withdrew: boolean }> = ({ wallName, withdrew }) => (
  <div class="container container--narrow">
  <section class="card status-card">
    <p class="status-card__mark" aria-hidden="true">
      ↗
    </p>
    <h1 class="hero__title">已退出「{wallName}」</h1>
    <p>
      {withdrew ? '你的页面已经从墙上撤下，' : ''}你电脑上 AI 助手的授权也已断开。以后拿到邀请链接还能重新加入，之前做好的页面还在，重新确认后就能再发布。
    </p>
    <p>
      <a class="btn btn--primary" href="/">
        回到首页
      </a>
    </p>
  </section>
  </div>
);
