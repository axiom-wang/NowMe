/**
 * 生成进度的实时推送（contracts 18）：连接数限制与“主人还在不在看”。
 *
 * - 每个进度连接（SSE）先 `open()` 占一个名额：每个用户同时最多 `perUser` 个、全站最多 `total` 个；超出时路由返回 429，
 *   前端退回到轮询。连接结束时 `release()`。
 * - 轮询（`/status`）与 SSE 连接都记一次“在看”（`touch`）；`present(jobId)`：这个任务现在有进度连接，
 *   或最近 `presenceMs` 内有人看过。完成通知（services/job-notify.ts）据此判断要不要发邮件。
 * - 只在本进程内计数（多个主站实例时各算各的，见 contracts 18.4）。只记任务 ID 与时间，不记任何内容。
 */
import { JOB_STAGES, type JobEvent, type JobStage } from '../db/job-queue.js';

export interface ProgressSettings {
  /** SSE 连接里查一次新进度的间隔。 */
  pollMs: number;
  /** 心跳（SSE 注释行）的间隔：防止代理因为长时间没有数据断开连接。 */
  heartbeatMs: number;
  /** 一个 SSE 连接最长保持多久；到时服务端关闭，浏览器会自动重连（带 Last-Event-ID 续传）。 */
  maxStreamMs: number;
  /** 每个用户同时最多几个 SSE 连接。 */
  perUser: number;
  /** 全站同时最多几个 SSE 连接。 */
  total: number;
  /** 最近这么久内有过进度连接或轮询，就算主人还在看（不发完成邮件）。 */
  presenceMs: number;
  /** 前端轮询（不支持 SSE 或连不上时）的建议间隔。 */
  fallbackPollMs: number;
}

export const DEFAULT_PROGRESS_SETTINGS: ProgressSettings = {
  pollMs: 1000,
  heartbeatMs: 15_000,
  maxStreamMs: 5 * 60_000,
  perUser: 3,
  total: 200,
  presenceMs: 45_000,
  fallbackPollMs: 3000,
};

export interface ProgressSlot {
  release(): void;
}

export interface ProgressHub {
  readonly settings: ProgressSettings;
  /** 占一个 SSE 名额；超出每用户或全站上限时返回 null。 */
  open(userId: string, jobId: string): ProgressSlot | null;
  /** 记一次“在看”（轮询、SSE 每次推送）。 */
  touch(jobId: string): void;
  /** 这个任务现在有进度连接，或最近 `presenceMs` 内有人看过。 */
  present(jobId: string): boolean;
  /** 当前的 SSE 连接数（测试与诊断）。 */
  connections(): number;
}

export function createProgressHub(now: () => Date, overrides: Partial<ProgressSettings> = {}): ProgressHub {
  const settings: ProgressSettings = { ...DEFAULT_PROGRESS_SETTINGS, ...overrides };
  const perUser = new Map<string, number>();
  const active = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  let total = 0;

  const touch = (jobId: string) => {
    const at = now().getTime();
    lastSeen.set(jobId, at);
    // 顺手清掉早就过期的记录，Map 不会无限增长
    if (lastSeen.size > 1000) {
      for (const [id, seen] of lastSeen) if (at - seen > settings.presenceMs && !active.has(id)) lastSeen.delete(id);
    }
  };

  return {
    settings,
    open(userId, jobId) {
      const mine = perUser.get(userId) ?? 0;
      if (mine >= settings.perUser || total >= settings.total) return null;
      perUser.set(userId, mine + 1);
      active.set(jobId, (active.get(jobId) ?? 0) + 1);
      total += 1;
      touch(jobId);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          total -= 1;
          const left = (perUser.get(userId) ?? 1) - 1;
          if (left > 0) perUser.set(userId, left);
          else perUser.delete(userId);
          const watching = (active.get(jobId) ?? 1) - 1;
          if (watching > 0) active.set(jobId, watching);
          else active.delete(jobId);
          touch(jobId);
        },
      };
    },
    touch,
    present(jobId) {
      if ((active.get(jobId) ?? 0) > 0) return true;
      const seen = lastSeen.get(jobId);
      return seen !== undefined && now().getTime() - seen <= settings.presenceMs;
    },
    connections: () => total,
  };
}

// ---------------------------------------------------------------------------
// 给界面用的阶段
// ---------------------------------------------------------------------------

/** 进度条上的几步（重新排队算“排队中”，三种结束状态都落在“完成”这一格）。 */
export const PROGRESS_STEPS = ['queued', 'reading', 'designing', 'generating', 'validating', 'rendering', 'succeeded'] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export const PROGRESS_STEP_LABELS: Record<ProgressStep, string> = {
  queued: '排队中',
  reading: '整理资料',
  designing: '设计',
  generating: '生成中',
  validating: '检查',
  rendering: '截图',
  succeeded: '完成',
};

/** 推给前端的一条进度（只有阶段名与数字，没有任何内容）。 */
export interface ProgressView {
  seq: number;
  stage: JobStage;
  /** 进度条上落在哪一步。 */
  step: ProgressStep;
  /** 给人看的一句话，例如“生成中（第 3 轮）”。 */
  label: string;
  turn: number | null;
  maxTurns: number | null;
}

export function progressStep(stage: JobStage): ProgressStep {
  if (stage === 'retrying') return 'queued';
  if (stage === 'needs_input' || stage === 'failed') return 'succeeded';
  return stage;
}

export function progressLabel(stage: JobStage, turn: number | null): string {
  switch (stage) {
    case 'queued':
    case 'retrying':
      return '排队中，马上轮到你';
    case 'reading':
      return '正在整理你的资料';
    case 'designing':
      return turn ? `正在设计页面（第 ${turn} 轮）` : '正在设计页面';
    case 'generating':
      return turn ? `正在生成页面（第 ${turn} 轮）` : '正在生成页面';
    case 'validating':
      return '正在检查页面有没有问题';
    case 'rendering':
      return '正在给页面截图、看效果';
    case 'succeeded':
      return '做好了';
    case 'needs_input':
      return '需要你补充一句';
    case 'failed':
      return '这次没有做成';
  }
}

export function progressView(event: Pick<JobEvent, 'seq' | 'stage' | 'props'> | null): ProgressView {
  const stage: JobStage = event?.stage && (JOB_STAGES as readonly string[]).includes(event.stage) ? event.stage : 'queued';
  const turn = event?.props.turn ?? null;
  return {
    seq: event?.seq ?? 0,
    stage,
    step: progressStep(stage),
    label: progressLabel(stage, turn),
    turn,
    maxTurns: event?.props.maxTurns ?? null,
  };
}
