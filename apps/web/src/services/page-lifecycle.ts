/**
 * 删除页面与退出墙（W16，build-plan 决策记录）。调用方（路由）负责确认请求者是页面主人（`findOwnPage`）。
 *
 * 删除页面（“墓碑”语义）：
 * - 删除 `revisions/<id>/` 全部文件；
 * - 版本行保留（编号继续递增），但清空 `card_json` / `manifest_json` / `rendered_text` / `render_json`，
 *   `report_json` 换成不含任何内容的空报告（`validatorVersion` 为 `DELETED_REVISION_MARKER`）；
 * - 活跃发布以 `deleted` 结束；所有发布记录的 `card_json` / `contact_json` 清空；
 * - 清空公开链接与联系方式；吊销页面凭证与未使用的 token；
 * - 保留成员关系与页面行：之后可以重新生成指令、从头开始。
 *
 * 退出墙：成员关系 `left`、活跃发布以 `withdrawn` 结束、关闭公开链接、吊销凭证与未使用的 token；
 * 版本保留（用邀请重新加入后页面保持未发布，需要重新确认发布）。组织者不能退出（先关闭墙）。
 *
 * 事件（contracts 6 没有“删除页面”类型）：删除时若页面在墙上记 `withdraw`、若公开链接开着记 `public_link_off`，
 * 都带 `pageDeleted: true`；退出记 `leave`。
 */
import type { ValidationReport } from '@nowme/contracts';
import { emptyStats } from '@nowme/validator';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { Revision, RevisionListItem } from '../db/revisions.js';
import type { OwnPage } from './access.js';
import { disconnectAgent } from './agent.js';
import { removeAllRevisionFiles } from './revision-storage.js';
import { eraseHostedPageData } from '../hosted/data.js';
import { cancelActiveJobsForPage } from '../hosted/job-cancel.js';

/** 删除后版本报告的 `validatorVersion`：标记这是墓碑（报告里没有任何内容）。 */
export const DELETED_REVISION_MARKER = 'deleted';

/** 删除后的版本报告：不含问题、统计与文件名。 */
export function deletedRevisionReport(accepted: boolean): ValidationReport {
  return { ok: accepted, errors: [], warnings: [], stats: emptyStats(), validatorVersion: DELETED_REVISION_MARKER };
}

/** 版本是否已随页面删除（墓碑）：不能预览、不能发布、不能签发票据。 */
export function isRevisionDeleted(revision: Pick<Revision | RevisionListItem, 'report'>): boolean {
  return revision.report.validatorVersion === DELETED_REVISION_MARKER;
}

/** 可以预览、发布的版本：通过校验且没有被删除。 */
export function isRevisionUsable(revision: Pick<Revision | RevisionListItem, 'status' | 'report'>): boolean {
  return revision.status === 'accepted' && !isRevisionDeleted(revision);
}

type LifecycleDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'config' | 'log'>;

/** 删除前给主人看的影响范围。 */
export interface DeletionImpact {
  /** 还没删除的版本数（含未通过的）。 */
  revisionCount: number;
  /** 其中有文件的（通过校验的）版本数。 */
  fileRevisionCount: number;
  /** 当前在墙上的版本号。 */
  publishedRevisionNumber: number | null;
  publicLinkOn: boolean;
  /** 有有效的页面凭证或未使用的指令。 */
  agentConnected: boolean;
  contactSaved: boolean;
}

export function deletionImpact(deps: Pick<AppDeps, 'repos' | 'now'>, own: OwnPage): DeletionImpact {
  const { repos } = deps;
  const live = repos.revisions.listForPage(own.page.id).filter((revision) => !isRevisionDeleted(revision));
  const active = repos.publications.findActiveForPage(own.page.id);
  const activeRevision = active ? live.find((revision) => revision.id === active.revisionId) : undefined;
  const pending = repos.agentTokens.findPendingForPage(own.page.id, deps.now().toISOString());
  return {
    revisionCount: live.length,
    fileRevisionCount: live.filter((revision) => revision.status === 'accepted').length,
    publishedRevisionNumber: activeRevision?.number ?? null,
    publicLinkOn: own.page.publicToken !== null,
    agentConnected: repos.credentials.findActiveForPage(own.page.id) !== null || pending !== null,
    contactSaved: own.page.contactChannel !== null || own.page.contactValue !== null,
  };
}

export interface DeletePageResult {
  /** 清空内容的版本数（本次删除前还没删除的）。 */
  revisionCount: number;
  /** 删除了文件目录的版本数。 */
  fileRevisionCount: number;
  withdrew: boolean;
  publicLinkClosed: boolean;
  revokedCredentials: number;
}

/** 删除页面在数据库里的部分（同步，调用方放在事务里）：返回需要删除文件的版本 ID 与结果。 */
export function erasePageRecords(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now'>,
  own: OwnPage,
  actorId: string,
): { fileIds: string[]; result: DeletePageResult } {
  const { repos, db } = deps;
  const nowIso = deps.now().toISOString();
  const pageId = own.page.id;
  const accepted = JSON.stringify(deletedRevisionReport(true));
  const rejected = JSON.stringify(deletedRevisionReport(false));
  const eraseRevisions = db.prepare(
    `UPDATE revisions
        SET report_json = CASE status WHEN 'accepted' THEN ? ELSE ? END,
            card_json = NULL, manifest_json = NULL, rendered_text = NULL, render_json = NULL
      WHERE page_id = ?`,
  );
  // 全部版本（含之前已删除的：它们的目录早已不存在，rm 会跳过）
  const all = repos.revisions.listForPage(pageId);
  const live = all.filter((revision) => !isRevisionDeleted(revision));
  const page = repos.pages.findById(pageId);
  const ended = repos.publications.endActive(pageId, 'deleted', nowIso);
  repos.publications.eraseContentForPage(pageId);
  eraseRevisions.run(accepted, rejected, pageId);
  const publicLinkClosed = page?.publicToken != null;
  repos.pages.clearContactAndPublicLink(pageId, nowIso);
  const revokedCredentials = disconnectAgent(deps, pageId);
  // 进行中的网页内生成 / 修改：立即中止并退点，worker 不再发出后续模型请求（contracts 13.4）
  cancelActiveJobsForPage(deps, pageId);
  if (ended) {
    repos.events.record({ type: 'withdraw', wallId: own.wall.id, pageId, actorId, props: { pageDeleted: true }, createdAt: nowIso });
  }
  if (publicLinkClosed) {
    repos.events.record({ type: 'public_link_off', wallId: own.wall.id, pageId, actorId, props: { pageDeleted: true }, createdAt: nowIso });
  }
  return {
    fileIds: all.filter((revision) => revision.status === 'accepted').map((revision) => revision.id),
    result: {
      revisionCount: live.length,
      fileRevisionCount: live.filter((revision) => revision.status === 'accepted').length,
      withdrew: ended !== null,
      publicLinkClosed,
      revokedCredentials,
    },
  };
}

/** 删除页面（见文件头）。先在一个事务里改数据库，再删文件；文件删除失败只记日志。 */
export async function deletePage(deps: LifecycleDeps, own: OwnPage, actorId: string): Promise<DeletePageResult> {
  const pageId = own.page.id;
  const outcome = transaction(deps.db, () => erasePageRecords(deps, own, actorId));
  // 托管资料（brief、素材、任务内容）一并清除（S7）；不依赖托管功能是否开启
  await eraseHostedPageData(deps, pageId);
  const failed = await removeAllRevisionFiles(deps.config.dataDir, outcome.fileIds);
  if (failed.length > 0) deps.log(`[web] 删除页面 ${pageId}：${failed.length} 个版本目录没能删除（${failed.join('、')}），请手动清理`);
  return outcome.result;
}

export type LeaveWallResult = { ok: true; withdrew: boolean; publicLinkClosed: boolean } | { ok: false; reason: 'organizer' };

/** 退出墙（见文件头）。组织者不能退出。 */
export function leaveWall(deps: LifecycleDeps, own: OwnPage, actorId: string): LeaveWallResult {
  if (own.membership.role === 'organizer') return { ok: false, reason: 'organizer' };
  const { repos, db } = deps;
  const nowIso = deps.now().toISOString();
  const markLeft = db.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE id = ? AND status = 'active'");
  return transaction(db, (): LeaveWallResult => {
    markLeft.run(nowIso, own.membership.id);
    const ended = repos.publications.endActive(own.page.id, 'withdrawn', nowIso);
    const page = repos.pages.findById(own.page.id);
    const publicLinkClosed = page?.publicToken != null;
    if (publicLinkClosed) repos.pages.setPublicToken(own.page.id, null, nowIso);
    disconnectAgent(deps, own.page.id);
    cancelActiveJobsForPage(deps, own.page.id);
    repos.icebreakers.deleteForViewerWall(own.membership.userId, own.wall.id);
    repos.events.record({
      type: 'leave',
      wallId: own.wall.id,
      pageId: own.page.id,
      actorId,
      props: { withdrew: ended !== null, publicLinkClosed },
      createdAt: nowIso,
    });
    return { ok: true, withdrew: ended !== null, publicLinkClosed };
  });
}
