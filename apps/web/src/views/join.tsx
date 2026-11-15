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
  <div class="container board join-board">
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
        <p class="notice notice--warning">你之前退出过这面墙。重新加入后，你原来的页面不会自动挂回墙上；想让大家看到，需要你自己重新发布。</p>
      ) : (
        <p class="muted">加入后，花几分钟和 AI 做一页你自己；也可以先逛逛墙上的人，不着急。</p>
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
      <h1 class="display">现在不能加入这面墙</h1>
      <p>组织者把你移出了「{wall.name}」，所以这个邀请链接现在对你不管用。如果觉得是误会，可以直接找组织者说一声。</p>
      <p>
        <a class="btn btn--primary" href="/">
          回到“我的”
        </a>
      </p>
    </section>
  </div>
);
