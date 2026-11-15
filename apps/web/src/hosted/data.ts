/**
 * 主人对自己托管资料的查看与删除（S7）。不依赖 Claude 客户端：即使托管功能之后被关闭（没有 key），
 * 主人仍然可以在“我的资料”里查看、删除已保存的画像与 brief；删除页面时也一并清除。
 */
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { BriefRecord } from '../db/hosted.js';
import { removeHostedPageFiles } from './assets.js';

type DataDeps = Pick<AppDeps, 'db' | 'repos' | 'config' | 'now'>;

/** 删除一份 brief 及其素材（记录与文件）。 */
export async function eraseBriefRecord(deps: DataDeps, brief: BriefRecord): Promise<void> {
  transaction(deps.db, () => {
    deps.repos.briefAssets.deleteForBrief(brief.id);
    deps.repos.briefs.deleteById(brief.id, brief.ownerId);
    // “和 TA 聊什么”的结果是用这份采访推出来的：采访删除或重做时一并清掉（contracts 11）
    const page = deps.repos.pages.findById(brief.pageId);
    if (page) deps.repos.icebreakers.deleteForViewerWall(brief.ownerId, page.wallId);
    // AI 介绍（contracts 20）同样是从这份采访推出来的
    if (page) deps.repos.intros.deleteForViewerWall(brief.ownerId, page.wallId);
  });
  await removeHostedPageFiles(deps.config.dataDir, brief.pageId);
}

/** 主人删除自己的某一份 brief（不要求仍是这面墙的成员）。别人的 / 不存在 → false。 */
export async function deleteOwnBrief(deps: DataDeps, userId: string, briefId: string): Promise<boolean> {
  const brief = deps.repos.briefs.findById(briefId, userId);
  if (!brief) return false;
  await eraseBriefRecord(deps, brief);
  const page = deps.repos.pages.findById(brief.pageId);
  deps.repos.events.record({ type: 'brief_delete', wallId: page?.wallId ?? null, pageId: brief.pageId, actorId: userId, props: { count: 1 }, createdAt: deps.now().toISOString() });
  return true;
}

/** `eraseHostedPageData` 在数据库里的部分（同步，调用方放在事务里；注销账号时与其他清除放在同一个事务）。 */
export function eraseHostedPageRecords(deps: Pick<AppDeps, 'repos'>, pageId: string): void {
  deps.repos.briefAssets.deleteForPage(pageId);
  deps.repos.briefs.deleteForPage(pageId);
  deps.repos.jobs.eraseContentForPage(pageId);
  // 别人针对这一页得到的破冰建议里引用了页面上的文字：页面删除时一并清掉（contracts 11）
  deps.repos.icebreakers.deleteForPage(pageId);
  // 页面被删除：别人得到的、引用了这一页文字的 AI 介绍，与主人自己在这面墙的 AI 介绍（依据是这一页）都删掉（contracts 20）
  deps.repos.intros.deleteForPage(pageId);
  const page = deps.repos.pages.findById(pageId);
  if (page) deps.repos.intros.deleteForViewerWall(page.ownerId, page.wallId);
}

/** 删除页面时：brief、素材、任务内容（修改要求、结果说明）一并清除；任务行保留。 */
export async function eraseHostedPageData(deps: DataDeps, pageId: string): Promise<void> {
  transaction(deps.db, () => eraseHostedPageRecords(deps, pageId));
  await removeHostedPageFiles(deps.config.dataDir, pageId);
}

/** 删除画像：`entryId` 删一条，`null` 全部删除。返回删除条数。 */
export function deleteOwnProfile(deps: DataDeps, userId: string, entryId: string | null): number {
  const count = entryId ? deps.repos.profileEntries.deleteForUser(userId, entryId) : deps.repos.profileEntries.deleteAllForUser(userId);
  if (count > 0) deps.repos.events.record({ type: 'profile_delete', wallId: null, pageId: null, actorId: userId, props: { count }, createdAt: deps.now().toISOString() });
  return count;
}
