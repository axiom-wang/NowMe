/**
 * 创作工作区的数据（`GET /w/:wallId/me`，只给页面主人）。
 * T3.2：`publish` 是发布状态（当前发布、缩略卡确认、联系方式、公开链接，见 services/publish.ts）；
 * 删除页面后留下的版本墓碑不能预览、不能发布、不签发票据。
 */
import { SKILL_VERSION } from '@nowme/skill';
import { compareVersions, isVersion, REVISION_ID_PATTERN } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import type { Page } from '../db/pages.js';
import type { RevisionListItem } from '../db/revisions.js';
import type { Wall } from '../db/walls.js';
import type { OwnPage } from './access.js';
import type { AgentInstruction } from './instruction.js';
import { isRevisionDeleted, isRevisionUsable } from './page-lifecycle.js';
import { loadPublishModel, type PublishFormState, type PublishModel } from './publish.js';
import type { IssuedTicket } from './tickets.js';
import { skillCheckExpected, skillCheckPrompt, skillInstallPrompt } from './skill-install.js';
import { skillInstallPageUrl } from './skill-package.js';
import type { HostedOverview, JobStartError } from '../hosted/service.js';
import type { GenerationJob } from '../db/hosted.js';
import { DEFAULT_PROGRESS_SETTINGS, progressView, type ProgressView } from './progress.js';
import { creationRoute, workspaceStage, workspaceSteps, type CreationRoute, type StageInput, type WorkspaceStage, type WorkspaceStep } from './workspace-stage.js';

export interface WorkspaceConnection {
  /** 有有效的页面凭证。 */
  connected: boolean;
  connectedAt: string | null;
  lastUsedAt: string | null;
  /** 有一条尚未使用、未过期的指令。 */
  pendingInstructionExpiresAt: string | null;
  /** 连接时 CLI 自报的 Skill 版本（contracts 4.5）；没连接或没报（源码方式运行）时为 null。 */
  skillVersion: string | null;
  /** 连接时 CLI 自报的 CLI 版本；没连接或旧版 CLI 时为 null。 */
  cliVersion: string | null;
}

/** 工作区「安装 NOWMe Skill」用到的信息（contracts 4.5）。这里没有任何 token。 */
export interface WorkspaceSkill {
  /** 主站当前分发的 Skill 版本；没有 Skill 包时为 null。 */
  latestVersion: string | null;
  installPageUrl: string;
  installPrompt: string;
  checkPrompt: string;
  /** 自检输出里应有的文字（没有 Skill 包时为 null）。 */
  checkExpected: string | null;
  /** 已连接的 Agent 用的 Skill 比主站分发的旧。 */
  outdated: boolean;
}

/** 工作区顶部的提示（只用固定文案，不回显请求参数）。 */
export type WorkspaceNotice =
  | 'disconnected'
  | 'text-edited'
  | 'not-previewable'
  | 'deleted-revision'
  | 'published'
  | 'withdrawn'
  | 'not-published'
  | 'public-link-on'
  | 'public-link-off'
  | 'deleted'
  | 'publish-rejected'
  | 'publish-deleted'
  | 'publish-failed'
  | 'publish-errors';

export interface WorkspaceModel {
  wall: Wall;
  page: Page;
  csrf: string;
  connection: WorkspaceConnection;
  lastSubmittedAt: string | null;
  /** 全部版本，编号倒序（含删除后留下的墓碑，用 `isRevisionDeleted` 区分）。 */
  revisions: RevisionListItem[];
  /** 正在预览的 accepted 且未删除的版本。 */
  selected: RevisionListItem | null;
  /** 预览票据：只为页面主人自己的 accepted 版本签发。 */
  ticket: IssuedTicket | null;
  /** 刚生成的指令（明文只在生成它的这次响应里出现）。 */
  instruction: AgentInstruction | null;
  notice: WorkspaceNotice | null;
  /** 发布状态与选中版本的发布确认（T3.2）。 */
  publish: PublishModel;
  /** 平台托管路线（contracts 9）；功能未开启时为 null，工作区不显示“在这里创作”。 */
  hosted: WorkspaceHosted | null;
  /** Skill 安装说明与版本（T3.6）。 */
  skill: WorkspaceSkill;
  /** 现在该做的那一件事（contracts 18.1）。 */
  stage: WorkspaceStage;
  /** 顶部步骤条（与真实状态一致）。 */
  steps: WorkspaceStep[];
  /** 墙上看到的这一页（已发布时）。 */
  wallPagePath: string | null;
  /** 主人有没有打开“做好了发邮件告诉我”（contracts 18.3）。 */
  notifyEmail: boolean;
  /** 前端轮询进度的间隔（不支持 SSE 或断线时）。 */
  progressPollMs: number;
}

export interface WorkspaceHosted {
  demo?: boolean;
  overview: HostedOverview;
  /** 生成默认用哪种方式（平台 AI / 自己的 Key / 点数不够 / 需要设置）。 */
  route: CreationRoute;
  /** 修改一次默认用哪种方式（价目可能不同）。 */
  editRoute: CreationRoute;
  /** 进行中任务的当前进度（服务端先渲染一次，之后由 progress.js 实时更新）。 */
  progress: ProgressView | null;
  /** 最近一次任务没做成（且现在没有进行中的任务）。 */
  lastFailure: GenerationJob | null;
  /** 选中版本的区块（“修改这一版”的下拉选项）。 */
  editBlocks: string[];
  /** 发起任务失败的原因（`?hosted=<码>`，固定文案）。 */
  error: JobStartError | null;
}

export interface LoadWorkspaceOptions {
  csrf: string;
  /** `?rev=`：要预览的版本。不属于这一页 → 返回 null（路由回 404）。 */
  revisionId?: string | null;
  instruction?: AgentInstruction | null;
  notice?: WorkspaceNotice | null;
  /** 没通过校验的发布确认：回显主人的输入与错误（只对 `revisionId` 对应的版本）。 */
  publishForm?: PublishFormState | null;
  hostedError?: JobStartError | null;
}

export function loadWorkspace(
  deps: Pick<AppDeps, 'repos' | 'tickets' | 'now' | 'config' | 'hosted'> & Partial<Pick<AppDeps, 'skillPackage' | 'demo' | 'progress'>>,
  own: OwnPage,
  options: LoadWorkspaceOptions,
): WorkspaceModel | null {
  const { repos } = deps;
  const { page, wall } = own;
  const revisions = repos.revisions.listForPage(page.id);
  let notice = options.notice ?? null;

  let selected: RevisionListItem | null = null;
  if (options.revisionId) {
    if (!REVISION_ID_PATTERN.test(options.revisionId)) return null;
    const requested = revisions.find((revision) => revision.id === options.revisionId);
    if (!requested) return null;
    if (isRevisionUsable(requested)) selected = requested;
    else notice = notice ?? (isRevisionDeleted(requested) ? 'deleted-revision' : 'not-previewable');
  } else {
    selected = revisions.find(isRevisionUsable) ?? null;
  }

  const credential = repos.credentials.findActiveForPage(page.id);
  const pending = repos.agentTokens.findPendingForPage(page.id, deps.now().toISOString());
  const overview = deps.hosted ? deps.hosted.overview(own, page.ownerId) : null;
  const publish = loadPublishModel(deps, own, revisions, selected, options.publishForm ?? null);
  const stageInput: StageInput = {
    briefStatus: overview?.brief?.record.status ?? null,
    activeJob: Boolean(overview?.activeJob),
    hasLive: revisions.some((revision) => !isRevisionDeleted(revision)),
    hasUsable: revisions.some(isRevisionUsable),
    published: publish.state === 'published',
  };
  const latestJob = overview?.recentJobs[0] ?? null;

  return {
    wall,
    page,
    csrf: options.csrf,
    connection: {
      connected: credential !== null,
      connectedAt: credential?.createdAt ?? null,
      lastUsedAt: credential?.lastUsedAt ?? null,
      pendingInstructionExpiresAt: options.instruction ? null : (pending?.expiresAt ?? null),
      skillVersion: credential?.clientSkillVersion ?? null,
      cliVersion: credential?.clientCliVersion ?? null,
    },
    lastSubmittedAt: revisions[0]?.createdAt ?? null,
    revisions,
    selected,
    // 授权已通过（findOwnPage + 版本属于这一页、accepted 且未删除），才签发票据
    ticket: selected ? deps.tickets.issue(selected.id) : null,
    instruction: options.instruction ?? null,
    notice,
    publish,
    hosted: overview
      ? {
          overview,
          demo: !!deps.demo,
          editBlocks: selected?.report.stats.blocks ?? [],
          error: options.hostedError ?? null,
          route: creationRoute(overview.ai, 'generate'),
          editRoute: creationRoute(overview.ai, 'edit'),
          progress: overview.activeJob ? progressView(repos.jobEvents.latest(overview.activeJob.id)) : null,
          lastFailure: !overview.activeJob && latestJob && latestJob.status === 'failed' ? latestJob : null,
        }
      : null,
    stage: workspaceStage(stageInput),
    steps: workspaceSteps(stageInput, overview !== null),
    wallPagePath: publish.state === 'published' ? `/w/${wall.id}/p/${page.id}` : null,
    notifyEmail: repos.notify.jobEmailEnabled(page.ownerId),
    progressPollMs: deps.progress?.settings.fallbackPollMs ?? DEFAULT_PROGRESS_SETTINGS.fallbackPollMs,
    skill: loadWorkspaceSkill(deps.config.webOrigin, deps.skillPackage?.manifest.version ?? SKILL_VERSION, credential?.clientSkillVersion ?? null),
  };
}

export function loadWorkspaceSkill(webOrigin: string, latestVersion: string | null, connectedSkillVersion: string | null): WorkspaceSkill {
  const outdated =
    latestVersion !== null &&
    connectedSkillVersion !== null &&
    isVersion(latestVersion) &&
    isVersion(connectedSkillVersion) &&
    compareVersions(connectedSkillVersion, latestVersion) < 0;
  return {
    latestVersion,
    installPageUrl: skillInstallPageUrl(webOrigin),
    installPrompt: skillInstallPrompt(webOrigin, latestVersion),
    checkPrompt: skillCheckPrompt(),
    checkExpected: latestVersion ? skillCheckExpected(latestVersion) : null,
    outdated,
  };
}
