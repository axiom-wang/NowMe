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
    <p class="muted">
      <a href="/">我的</a> / <a href={workspaceHref(wall)}>{wall.name}</a>
    </p>
    <h1>{title}</h1>
  </section>
);

const LocalFilesNote: FC = () => (
  <li>
    你电脑上的 brief.md、长期画像（~/.nowme/profile.md）和 page/ 目录不受影响——它们从未上传到 NOWMe。想清理请在本地自己删除。
  </li>
);

export const DeleteConfirmView: FC<{ wall: Wall; csrf: string; impact: DeletionImpact; error?: string | null }> = ({
  wall,
  csrf,
  impact,
  error,
}) => (
  <>
    <Breadcrumb wall={wall} title="删除这一页" />
    <section class="card confirm" aria-labelledby="delete-impact-heading">
      <h2 id="delete-impact-heading">删除后会发生什么</h2>
      <p>删除后不能恢复。确认之前，先看看影响范围：</p>
      <ul class="impact">
        <li>
          {impact.revisionCount > 0
            ? `删除这一页的 ${impact.revisionCount} 个版本${impact.fileRevisionCount > 0 ? `（其中 ${impact.fileRevisionCount} 个通过校验的版本的页面、图片、封面与截图文件）` : ''}和它们的校验报告；版本列表里只留下“已删除”的编号。`
            : '这一页还没有任何版本。'}
        </li>
        <li>
          {impact.publishedRevisionNumber !== null
            ? `墙上的第 ${impact.publishedRevisionNumber} 版立即撤下，墙上的缩略卡、接话点与联系方式一并清除。`
            : '页面现在不在墙上；以前发布记录里的缩略卡与联系方式也会一并清除。'}
        </li>
        {impact.publicLinkOn ? <li>关闭公开链接，旧链接立即失效。</li> : null}
        {impact.agentConnected ? <li>断开本地 Agent：页面凭证与未使用的指令立即失效。</li> : null}
        {impact.contactSaved ? <li>清除你保存的联系方式。</li> : null}
      </ul>
      <h3>不受影响</h3>
      <ul class="impact impact--keep">
        <li>你仍是「{wall.name}」的成员，可以继续浏览这面墙，也可以重新生成 Agent 指令、从头做一页。</li>
        <LocalFilesNote />
      </ul>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form method="post" action={`${workspaceHref(wall)}/delete`} class="confirm__form">
        <CsrfField token={csrf} />
        <label class="check check--strong">
          <input type="checkbox" name="confirm" value="1" required />
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
  </>
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
  <>
    <Breadcrumb wall={wall} title={`退出「${wall.name}」`} />
    {impact.isOrganizer ? (
      <section class="card confirm">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>你是这面墙的组织者，不能退出。</p>
        <p class="muted">如果活动已经结束，可以在组织者后台关闭这面墙：关闭后墙对所有人不可见，所有页面一并下墙。</p>
        <div class="actions">
          <a class="btn btn--primary" href={`/w/${wall.id}/admin`}>
            去组织者后台
          </a>
          <a class="btn btn--ghost" href={workspaceHref(wall)}>
            回到工作区
          </a>
        </div>
      </section>
    ) : (
      <section class="card confirm" aria-labelledby="leave-impact-heading">
        <h2 id="leave-impact-heading">退出后会发生什么</h2>
        <ul class="impact">
          <li>你将看不到这面墙和墙上的成员页面。</li>
          {impact.published ? <li>你的页面立即从墙上撤下。</li> : null}
          {impact.publicLinkOn ? <li>公开链接关闭，旧链接立即失效。</li> : null}
          {impact.agentConnected ? <li>断开本地 Agent：页面凭证与未使用的指令立即失效。</li> : null}
        </ul>
        <h3>不受影响</h3>
        <ul class="impact impact--keep">
          <li>
            你的版本会保留：以后用邀请链接重新加入可以找回它们，但需要重新确认发布。想彻底删除内容，请先
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
  </>
);

export const LeftView: FC<{ wallName: string; withdrew: boolean }> = ({ wallName, withdrew }) => (
  <section class="card confirm">
    <h1>已退出「{wallName}」</h1>
    <p>
      {withdrew ? '你的页面已从墙上撤下，' : ''}本地 Agent 已断开。以后拿到邀请链接可以重新加入，之前的版本还在，重新确认后就能再发布。
    </p>
    <p>
      <a class="btn btn--primary" href="/">
        回到“我的”
      </a>
    </p>
  </section>
);
