/**
 * 创作工作区的数据（`GET /w/:wallId/me`，只给页面主人）。
 * T3.2：`publish` 是发布状态（当前发布、缩略卡确认、联系方式、公开链接，见 services/publish.ts）；
 * 删除页面后留下的版本墓碑不能预览、不能发布、不签发票据。
 */
import { REVISION_ID_PATTERN } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import type { Page } from '../db/pages.js';
import type { RevisionListItem } from '../db/revisions.js';
import type { Wall } from '../db/walls.js';
import type { OwnPage } from './access.js';
import type { AgentInstruction } from './instruction.js';
import { isRevisionDeleted, isRevisionUsable } from './page-lifecycle.js';
import { loadPublishModel, type PublishFormState, type PublishModel } from './publish.js';
import type { IssuedTicket } from './tickets.js';

export interface WorkspaceConnection {
  /** 有有效的页面凭证。 */
  connected: boolean;
  connectedAt: string | null;
  lastUsedAt: string | null;
  /** 有一条尚未使用、未过期的指令。 */
  pendingInstructionExpiresAt: string | null;
}

/** 工作区顶部的提示（只用固定文案，不回显请求参数）。 */
export type WorkspaceNotice =
  | 'disconnected'
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
}

export interface LoadWorkspaceOptions {
  csrf: string;
  /** `?rev=`：要预览的版本。不属于这一页 → 返回 null（路由回 404）。 */
  revisionId?: string | null;
  instruction?: AgentInstruction | null;
  notice?: WorkspaceNotice | null;
  /** 没通过校验的发布确认：回显主人的输入与错误（只对 `revisionId` 对应的版本）。 */
  publishForm?: PublishFormState | null;
}

export function loadWorkspace(
  deps: Pick<AppDeps, 'repos' | 'tickets' | 'now' | 'config'>,
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

  return {
    wall,
    page,
    csrf: options.csrf,
    connection: {
      connected: credential !== null,
      connectedAt: credential?.createdAt ?? null,
      lastUsedAt: credential?.lastUsedAt ?? null,
      pendingInstructionExpiresAt: options.instruction ? null : (pending?.expiresAt ?? null),
    },
    lastSubmittedAt: revisions[0]?.createdAt ?? null,
    revisions,
    selected,
    // 授权已通过（findOwnPage + 版本属于这一页、accepted 且未删除），才签发票据
    ticket: selected ? deps.tickets.issue(selected.id) : null,
    instruction: options.instruction ?? null,
    notice,
    publish: loadPublishModel(deps, own, revisions, selected, options.publishForm ?? null),
  };
}
