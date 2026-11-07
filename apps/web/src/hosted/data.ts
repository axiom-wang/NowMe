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

/** 删除页面时：brief、素材、任务内容（修改要求、结果说明）一并清除；任务行保留。 */
export async function eraseHostedPageData(deps: DataDeps, pageId: string): Promise<void> {
  transaction(deps.db, () => {
    deps.repos.briefAssets.deleteForPage(pageId);
    deps.repos.briefs.deleteForPage(pageId);
    deps.repos.jobs.eraseContentForPage(pageId);
  });
  await removeHostedPageFiles(deps.config.dataDir, pageId);
}

/** 删除画像：`entryId` 删一条，`null` 全部删除。返回删除条数。 */
export function deleteOwnProfile(deps: DataDeps, userId: string, entryId: string | null): number {
  const count = entryId ? deps.repos.profileEntries.deleteForUser(userId, entryId) : deps.repos.profileEntries.deleteAllForUser(userId);
  if (count > 0) deps.repos.events.record({ type: 'profile_delete', wallId: null, pageId: null, actorId: userId, props: { count }, createdAt: deps.now().toISOString() });
  return count;
}
