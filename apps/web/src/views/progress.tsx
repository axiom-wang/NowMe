/**
 * 生成 / 修改的实时进度（contracts 18.2）。服务端先按最近一条进度事件渲染一次；`static/progress.js`
 * 用 SSE（`…/jobs/:jobId/progress`）实时更新，不支持或断线时改为轮询 `…/jobs/:jobId/status`；完成后自动跳到预览。
 * 不用 meta refresh 整页刷新。没有脚本时，“刷新看看”链接也能看到最新状态。
 */
import type { FC } from 'hono/jsx';
import type { JobKind } from '../db/hosted.js';
import { PROGRESS_STEP_LABELS, PROGRESS_STEPS, type ProgressView } from '../services/progress.js';

export function jobPath(wallId: string, jobId: string): string {
  return `/w/${wallId}/me/jobs/${jobId}`;
}

function turnText(view: ProgressView): string {
  return view.step === 'generating' && view.turn ? `第 ${view.turn} 轮` : '';
}

export const JobProgress: FC<{ wallId: string; jobId: string; kind: JobKind; view: ProgressView; pollMs: number; emailOn: boolean; heading?: boolean }> = ({
  wallId,
  jobId,
  kind,
  view,
  pollMs,
  emailOn,
  heading = false,
}) => {
  const current = PROGRESS_STEPS.indexOf(view.step);
  const path = jobPath(wallId, jobId);
  return (
    <div class="job-progress" data-job-progress data-stream={`${path}/progress`} data-status={`${path}/status`} data-poll-ms={String(pollMs)}>
      {heading ? <h2 class="job-progress__title">{kind === 'generate' ? '正在做你的页面' : '正在按你说的修改'}</h2> : null}
      <p class="job-progress__label" data-progress-label role="status" aria-live="polite">
        {view.label}
      </p>
      <ol class="job-progress__steps" aria-label="进度">
        {PROGRESS_STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li class={`job-progress__step job-progress__step--${state}`} data-step={step} aria-current={state === 'current' ? 'step' : undefined}>
              <span class="job-progress__dot" aria-hidden="true"></span>
              <span class="job-progress__name">
                {PROGRESS_STEP_LABELS[step]}
                {step === 'generating' ? (
                  <small class="job-progress__turn" data-progress-turn>
                    {turnText(view)}
                  </small>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p class="muted job-progress__hint">
        一般要几分钟。{emailOn ? '可以先去逛逛墙，做好后会发邮件告诉你。' : '可以先去逛逛墙，回来就能看到结果。'}
        <a href={path} data-progress-refresh>
          刷新看看
        </a>
      </p>
    </div>
  );
};
