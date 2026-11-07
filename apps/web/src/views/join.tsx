/**
 * 加入墙（W04，`GET /join/:inviteCode`）：墙名、简介、加入按钮；退出过的人重新加入时说明页面不会自动回到墙上；
 * 被移除的人看到友好提示（不能再通过邀请加入）。
 */
import type { FC } from 'hono/jsx';
import type { Wall } from '../db/walls.js';
import { CsrfField } from './forms.js';
import { OrganizerNote } from './wall.js';

export interface JoinViewProps {
  wall: Wall;
  sceneLabel: string;
  csrf: string;
  /** 之前退出过这面墙。 */
  rejoin: boolean;
}

export const JoinView: FC<JoinViewProps> = ({ wall, sceneLabel, csrf, rejoin }) => (
  <div class="container container--narrow">
    <section class={`card join scene--${wall.sceneType}`}>
      <div class="join__band" aria-hidden="true"></div>
      <p class="eyebrow join__eyebrow">你收到了一面墙的邀请</p>
      <h1 class="hero__title join__title">{wall.name}</h1>
      <p>
        <span class="chip">{sceneLabel}</span>
      </p>
      {wall.description ? <p class="join__desc">{wall.description}</p> : null}
      {wall.organizerNote ? <OrganizerNote text={wall.organizerNote} /> : null}
      {rejoin ? (
        <p class="notice notice--warning">你之前退出过这面墙。重新加入后，你原来的页面不会自动回到墙上，需要时在创作工作区重新发布。</p>
      ) : (
        <p class="muted">加入后就能浏览墙上已发布的成员，不需要先做好自己的页面。</p>
      )}
      <form method="post" action={`/join/${wall.inviteCode}`} class="stack">
        <CsrfField token={csrf} />
        <button type="submit" class="btn btn--primary btn--block btn--lg">
          {rejoin ? '重新加入这面墙' : '加入这面墙'}
        </button>
      </form>
    </section>
  </div>
);

export const RemovedFromWallView: FC<{ wall: Wall }> = ({ wall }) => (
  <div class="container container--narrow">
    <section class="card status-card">
      <p class="status-card__mark" aria-hidden="true">
        ✕
      </p>
      <h1 class="display">暂时不能加入</h1>
      <p>你已被组织者移出「{wall.name}」，不能再通过邀请链接加入。如果是误操作，请直接联系组织者。</p>
      <p>
        <a class="btn btn--primary" href="/">
          回到“我的”
        </a>
      </p>
    </section>
  </div>
);
