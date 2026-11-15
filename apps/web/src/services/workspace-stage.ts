/**
 * 创作工作区“现在该做哪一件事”（contracts 18.1）：按真实状态判定阶段、步骤条与默认的创作方式。纯函数，便于测试。
 *
 * 阶段（只突出一件事）：
 * - `start`      还没开始：开始采访
 * - `interview`  采访中（填了素材、还有追问）：继续采访
 * - `review`     AI 整理好了资料，等主人确认：确认资料
 * - `ready`      资料已确认，还没有做好的页面：生成页面
 * - `generating` 有排队中 / 进行中的生成或修改：看进度
 * - `preview`    有做好的页面、还没发布：看预览、修改或发布
 * - `published`  墙上有这一页：看墙上效果、修改、公开链接、撤下
 *
 * 默认创作方式（不让新人选路线）：
 * - `own`      主人自己配置了模型 Key（自己选的，继续用）；
 * - `platform` 平台 AI 可用且这次的点数够（个人余额或墙的额度）：默认用它；
 * - `credits`  平台 AI 可用但点数不够：说明怎么补（兑换 / 请组织者充墙额度），其他方式展开；
 * - `setup`    平台 AI 没开放、自己也没配置：引导填自己的 Key 或用自己电脑上的 AI 助手。
 */
import type { BriefStatus, JobKind } from '../db/hosted.js';
import { affordable, type AiStatus } from './billing.js';

export type WorkspaceStage = 'start' | 'interview' | 'review' | 'ready' | 'generating' | 'preview' | 'published';
export type CreationRoute = 'own' | 'platform' | 'credits' | 'setup';

export interface StageInput {
  /** 这一页的采访状态；没有采访过为 null。 */
  briefStatus: BriefStatus | null;
  /** 有排队中 / 进行中的生成或修改。 */
  activeJob: boolean;
  /** 有没删除的版本（含没做成的）。 */
  hasLive: boolean;
  /** 有做好的（通过检查、没删除）版本。 */
  hasUsable: boolean;
  /** 墙上现在有这一页。 */
  published: boolean;
}

export function workspaceStage(input: StageInput): WorkspaceStage {
  if (input.activeJob) return 'generating';
  if (input.published) return 'published';
  if (input.hasUsable) return 'preview';
  switch (input.briefStatus) {
    case 'confirmed':
      return 'ready';
    case 'review':
      return 'review';
    case 'collecting':
    case 'followups':
      return 'interview';
    default:
      return 'start';
  }
}

export type StepState = 'done' | 'current' | 'todo';
export interface WorkspaceStep {
  label: string;
  state: StepState;
}

/**
 * 步骤条：采访 → 确认资料 → 生成页面 → 发布到墙上（网页内创作）。每一步“完成”都对应真实数据：
 * 采访完成 = 资料已整理出来（待确认 / 已确认）；确认资料 = 已确认；生成页面 = 有做好的版本；发布 = 墙上有这一页。
 * 已经有版本（例如用自己电脑上的 AI 助手做的）时，前两步视为完成。
 */
export function workspaceSteps(input: StageInput, hosted: boolean): WorkspaceStep[] {
  const done = hosted
    ? [
        input.hasLive || input.briefStatus === 'review' || input.briefStatus === 'confirmed',
        input.hasLive || input.briefStatus === 'confirmed',
        input.hasUsable,
        input.published,
      ]
    : [input.hasLive, input.hasUsable, input.published];
  const labels = hosted ? ['采访', '确认资料', '生成页面', '发布到墙上'] : ['交给 AI 助手', '做好一版页面', '发布到墙上'];
  const current = done.indexOf(false);
  return labels.map((label, index) => ({ label, state: done[index] ? 'done' : index === current ? 'current' : 'todo' }));
}

/** 这次（生成或修改）默认用哪种方式。 */
export function creationRoute(ai: AiStatus, kind: JobKind = 'generate'): CreationRoute {
  if (ai.mode === 'own') return 'own';
  if (ai.mode === 'none') return 'setup';
  return affordable(ai, kind) ? 'platform' : 'credits';
}

/** 平台 AI 这次要多少点、现在能用多少点（给“点数不够”的说明用）。 */
export function creditGap(ai: AiStatus, kind: JobKind = 'generate'): { price: number; available: number } {
  const price = kind === 'generate' ? ai.prices.generate : ai.prices.edit;
  return { price, available: Math.max(ai.balance, ai.wallAllowance) };
}
