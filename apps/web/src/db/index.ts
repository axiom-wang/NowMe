/**
 * 数据层入口：`openDatabase()` 打开并迁移，`createRepos(db)` 得到按表拆分的仓储。
 *
 * 仓储归属（M3 按文件分工）：
 * - users / login-codes / sessions / agent-tokens / credentials / revisions：T2.1（M3 一般只读）
 * - walls / memberships / events：T3.1 补充（关闭墙、邀请码、退出 / 移除、统计）
 * - pages / publications：T3.2 补充（联系方式、公开链接、发布 / 撤下 / 删除）
 */
import type { Database } from './database.js';
import { createAgentTokensRepo } from './agent-tokens.js';
import { createCredentialsRepo } from './credentials.js';
import { createEventsRepo } from './events.js';
import { createBriefAssetsRepo, createBriefsRepo, createGenerationJobsRepo, createProfileEntriesRepo } from './hosted.js';
import { createLoginCodesRepo } from './login-codes.js';
import { createMembershipsRepo } from './memberships.js';
import { createPagesRepo } from './pages.js';
import { createPublicationsRepo } from './publications.js';
import { createRevisionsRepo } from './revisions.js';
import { createSessionsRepo } from './sessions.js';
import { createUsersRepo } from './users.js';
import { createWallsRepo } from './walls.js';
import { createChatRepo } from './chat.js';
import { createCreditsRepo } from './credits.js';
import { createIcebreakersRepo } from './icebreakers.js';

export { migrate, openDatabase, transaction, MIGRATIONS_DIR, type Database } from './database.js';

export function createRepos(db: Database) {
  return {
    chat: createChatRepo(db),
    users: createUsersRepo(db),
    loginCodes: createLoginCodesRepo(db),
    sessions: createSessionsRepo(db),
    walls: createWallsRepo(db),
    memberships: createMembershipsRepo(db),
    pages: createPagesRepo(db),
    agentTokens: createAgentTokensRepo(db),
    credentials: createCredentialsRepo(db),
    revisions: createRevisionsRepo(db),
    publications: createPublicationsRepo(db),
    events: createEventsRepo(db),
    profileEntries: createProfileEntriesRepo(db),
    briefs: createBriefsRepo(db),
    briefAssets: createBriefAssetsRepo(db),
    jobs: createGenerationJobsRepo(db),
    icebreakers: createIcebreakersRepo(db),
    credits: createCreditsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;
