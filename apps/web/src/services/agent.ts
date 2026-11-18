/**
 * Agent API 的领域逻辑（contracts 4.1、6.1、S3、S4）：一次性 token 换取页面凭证、凭证认证、AgentContext。
 *
 * - token 与凭证都只按 SHA-256 哈希查找；明文凭证只出现在 exchange 的这一次响应里。
 * - 凭证只能拉情境、提交版本、上报事件，不能发布（主站表单路由一律不读 Authorization 头）。
 * - 墙已关闭或成员关系不再有效时，凭证一律无效（401 CREDENTIAL_INVALID）。
 */
import {
  AGENT_CONTEXT_LIMITS,
  SKILL_GITHUB_URL,
  generateId,
  generateToken,
  hashToken,
  isTokenFormat,
  KIT_BASE_PATH,
  KIT_VERSION,
  type AgentClient,
  type AgentContext,
} from '@nowme/contracts';
import type { AgentAuth, AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { PageCredential } from '../db/credentials.js';
import type { Repos } from '../db/index.js';
import type { Page } from '../db/pages.js';
import type { Wall } from '../db/walls.js';

/** 页面工作区地址（`/w/<wallId>/me`）。 */
export function workspacePath(wallId: string): string {
  return `/w/${wallId}/me`;
}

export function workspaceUrl(webOrigin: string, wallId: string, revisionId?: string): string {
  const base = `${webOrigin}${workspacePath(wallId)}`;
  return revisionId ? `${base}?rev=${revisionId}` : base;
}

/** 凭证对应的页面、成员关系、墙都仍然有效时返回 AgentAuth。 */
export function resolveAgentAuth(repos: Repos, credential: PageCredential): AgentAuth | null {
  if (credential.revokedAt !== null) return null;
  const page = repos.pages.findById(credential.pageId);
  if (!page) return null;
  const membership = repos.memberships.findById(page.membershipId);
  if (!membership || membership.status !== 'active' || membership.userId !== page.ownerId) return null;
  const wall = repos.walls.findById(page.wallId);
  if (!wall || wall.status !== 'open') return null;
  return { credential, page, wall, membership };
}

/** 从 `Authorization: Bearer nmc_...` 认证。格式不对、不存在、已吊销、墙关闭、成员关系无效都返回 null。 */
export function authenticateCredential(deps: Pick<AppDeps, 'repos'>, authorization: string | undefined): AgentAuth | null {
  const match = /^Bearer +(\S+) *$/i.exec(authorization ?? '');
  const token = match?.[1];
  if (!token || !isTokenFormat(token, 'pageCredential')) return null;
  const credential = deps.repos.credentials.findActiveByHash(hashToken(token));
  return credential ? resolveAgentAuth(deps.repos, credential) : null;
}

/** 按凭证 ID 重新检查（提交处理完成、写库之前再确认一次没有被断开）。 */
export function revalidateAgentAuth(repos: Repos, credentialId: string | null): AgentAuth | null {
  if (!credentialId) return null;
  const credential = repos.credentials.findById(credentialId);
  return credential ? resolveAgentAuth(repos, credential) : null;
}

/** `skillPackage` 可选：托管路线内部调用时不需要 Skill 信息（为 null）。 */
export function buildAgentContext(
  deps: Pick<AppDeps, 'repos' | 'config' | 'kitFonts'> & Partial<Pick<AppDeps, 'skillPackage'>>,
  wall: Wall,
  page: Page,
): AgentContext {
  const stats = deps.repos.revisions.statsForPage(page.id);
  return {
    wall: {
      id: wall.id,
      name: wall.name,
      description: wall.description,
      sceneType: wall.sceneType,
      organizerNote: wall.organizerNote,
    },
    page: {
      id: page.id,
      revisionCount: stats.count,
      lastSubmittedAt: stats.lastCreatedAt,
      workspaceUrl: workspaceUrl(deps.config.webOrigin, wall.id),
    },
    kit: { version: KIT_VERSION, basePath: KIT_BASE_PATH, fonts: deps.kitFonts },
    limits: { ...AGENT_CONTEXT_LIMITS },
    skill: deps.skillPackage ? { version: deps.skillPackage.manifest.version, installUrl: SKILL_GITHUB_URL } : null,
  };
}

export type ExchangeResult =
  | { ok: true; credential: string; auth: AgentAuth }
  | { ok: false; message: string };

/**
 * 一次性 token → 页面凭证（S3）。在一个事务里：校验 token（存在、未用、未过期、属于这面墙的页面、
 * 成员关系与墙仍有效）→ 标记已用 → 吊销该页全部旧凭证 → 签发新凭证。
 * 失败时不改变任何状态（墙不匹配不会消耗 token）。
 */
export function exchangeAgentToken(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now'>,
  input: { wallId: string; token: string; client?: AgentClient },
): ExchangeResult {
  const nowIso = deps.now().toISOString();
  const { repos } = deps;
  return transaction(deps.db, (): ExchangeResult => {
    const record = repos.agentTokens.findByHash(hashToken(input.token));
    if (!record) return { ok: false, message: 'token 无效：请回到工作区重新生成 Agent 指令' };
    if (record.usedAt !== null) return { ok: false, message: 'token 已经用过：每条指令只能换取一次，请回到工作区重新生成' };
    if (record.expiresAt <= nowIso) return { ok: false, message: 'token 已过期：请回到工作区重新生成 Agent 指令' };
    const page = repos.pages.findById(record.pageId);
    if (!page || page.wallId !== input.wallId) {
      return { ok: false, message: 'token 与这面墙不匹配：请检查指令中的墙 ID' };
    }
    const membership = repos.memberships.findById(page.membershipId);
    const wall = repos.walls.findById(page.wallId);
    if (!membership || membership.status !== 'active' || !wall || wall.status !== 'open') {
      return { ok: false, message: 'token 已失效：这面墙已关闭，或你已不是这面墙的成员' };
    }
    if (!repos.agentTokens.markUsed(record.id, nowIso)) {
      return { ok: false, message: 'token 已经用过：每条指令只能换取一次，请回到工作区重新生成' };
    }
    repos.credentials.revokeAllForPage(page.id, nowIso);
    const credential = generateToken('pageCredential');
    const credentialId = generateId('crd');
    repos.credentials.create({
      id: credentialId,
      pageId: page.id,
      credentialHash: hashToken(credential),
      createdAt: nowIso,
      clientCliVersion: input.client?.cliVersion ?? null,
      clientSkillVersion: input.client?.skillVersion ?? null,
    });
    const stored = repos.credentials.findById(credentialId);
    if (!stored) throw new Error('凭证写入失败');
    return { ok: true, credential, auth: { credential: stored, page, wall, membership } };
  });
}

/**
 * 断开本地 Agent：吊销该页全部凭证，并作废尚未使用的一次性 token。返回吊销的凭证个数。
 * T3.x 在退出墙、删除页面、移除成员、关闭墙时也调用它。
 */
export function disconnectAgent(deps: Pick<AppDeps, 'db' | 'repos' | 'now'>, pageId: string): number {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    deps.repos.agentTokens.deleteUnusedForPage(pageId);
    return deps.repos.credentials.revokeAllForPage(pageId, nowIso);
  });
}
