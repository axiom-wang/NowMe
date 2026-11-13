/**
 * Agent API（contracts 4.1）：CLI 使用的 JSON 接口。认证只用 `Authorization: Bearer nmc_...`（页面凭证），
 * 不读会话 cookie；错误体统一 `{ error: { code, message } }`（中文说明）。
 *
 * | 方法与路径 | 认证 | 成功 |
 * | --- | --- | --- |
 * | POST /api/agent/exchange | 无（一次性 token） | 200 { credential, page: { id }, context } |
 * | GET /api/agent/context | 凭证 | 200 AgentContext |
 * | POST /api/agent/revisions | 凭证 | 201 { revision }；校验不通过 422 { revision } |
 * | POST /api/agent/events | 凭证 | 204 |
 * | POST /api/agent/previews | 凭证 | 200 RemotePreviewResponse（服务端渲染预览，什么都不存） |
 */
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  AGENT_JSON_REQUEST_MAX_BYTES,
  apiErrorBody,
  apiErrorStatus,
  eventsRequestSchema,
  exchangeRequestSchema,
  REVISION_REQUEST_MAX_BYTES,
  REMOTE_PREVIEWS_PER_PAGE_PER_DAY,
  REVISIONS_PER_PAGE_PER_DAY,
  revisionsRequestSchema,
  toStoredAgentEventType,
  type ApiErrorCode,
  type ExchangeResponse,
  type RemotePreviewResponse,
  type RevisionResponse,
} from '@nowme/contracts';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { RATE_RULES } from '../constants.js';
import { clientAddress } from '../security/client.js';
import { authenticateCredential, buildAgentContext, exchangeAgentToken } from '../services/agent.js';

export const AGENT_API_PREFIX = '/api/agent';

export function apiError(c: Context<AppEnv>, code: ApiErrorCode, message: string, headers?: Record<string, string>): Response {
  return c.json(apiErrorBody(code, message), apiErrorStatus(code), headers);
}

const CREDENTIAL_INVALID_MESSAGE =
  '页面凭证无效或已失效：可能已在工作区断开本地 Agent、重新生成过指令，或者墙已关闭、你已不是成员。请在工作区重新生成指令后运行 nowme fetch。';

/** 页面凭证认证。通过后在 `c.var.agent`。 */
export function requireCredential(deps: Pick<AppDeps, 'repos'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const agent = authenticateCredential(deps, c.req.header('authorization'));
    if (!agent) return apiError(c, 'CREDENTIAL_INVALID', CREDENTIAL_INVALID_MESSAGE, { 'WWW-Authenticate': 'Bearer' });
    c.set('agent', agent);
    return next();
  };
}

function sizeLabel(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes >= mb ? `${Math.round(bytes / mb)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function limit(maxSize: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      apiError(
        c as Context<AppEnv>,
        'PAYLOAD_TOO_LARGE',
        `请求体太大：上限 ${sizeLabel(maxSize)}。图片请压缩后放进 assets/（单个 ≤ 2 MB，合计 ≤ 8 MB）`,
      ),
  });
}

const INVALID_JSON = Symbol('invalid-json');

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return INVALID_JSON;
  }
}

function firstIssue(error: { issues: { message: string; path: PropertyKey[] }[] }): string {
  const issue = error.issues[0];
  if (!issue) return '请求不符合格式';
  const path = issue.path.map(String).join('.');
  return path ? `${path}：${issue.message}` : issue.message;
}

export function registerAgentApiRoutes(app: AppHono, deps: AppDeps): void {
  const credential = requireCredential(deps);
  const jsonLimit = limit(AGENT_JSON_REQUEST_MAX_BYTES);
  const revisionLimit = limit(REVISION_REQUEST_MAX_BYTES);

  app.post(`${AGENT_API_PREFIX}/exchange`, jsonLimit, async (c) => {
    // 没有凭证的入口：按来源地址限流，挡住批量试 token（contracts 10.3）
    const fromAddress = deps.rateLimiter.hit('agent-exchange', clientAddress(c, deps.config.trustProxyHops), RATE_RULES.agentExchange);
    if (!fromAddress.ok) {
      c.header('Retry-After', String(fromAddress.retryAfterSeconds));
      return apiError(c, 'RATE_LIMITED', '这个网络换取凭证太频繁了，请过几分钟再试');
    }
    const body = await readJson(c);
    if (body === INVALID_JSON) return apiError(c, 'BAD_REQUEST', '请求体不是合法的 JSON');
    const parsed = exchangeRequestSchema.safeParse(body);
    if (!parsed.success) {
      // 只有 client（CLI 自报的版本）不对时返回 BAD_REQUEST；此时 token 没有被使用，换一个正常的 CLI 还能用
      if (parsed.error.issues.every((issue) => issue.path[0] === 'client')) {
        return apiError(c, 'BAD_REQUEST', `CLI 版本信息格式不对：${firstIssue(parsed.error)}（token 没有被使用）`);
      }
      // token 或墙 ID 格式不对也返回 TOKEN_INVALID（与不存在、已用、过期一致，contracts 4.1）
      return apiError(c, 'TOKEN_INVALID', 'token 或墙 ID 格式不对：请复制工作区里的完整指令');
    }
    const result = exchangeAgentToken(deps, parsed.data);
    if (!result.ok) return apiError(c, 'TOKEN_INVALID', result.message);
    const response: ExchangeResponse = {
      credential: result.credential,
      page: { id: result.auth.page.id },
      context: buildAgentContext(deps, result.auth.wall, result.auth.page),
    };
    return c.json(response, 200);
  });

  app.get(`${AGENT_API_PREFIX}/context`, credential, (c) => {
    const agent = c.get('agent');
    deps.repos.credentials.touch(agent.credential.id, deps.now().toISOString());
    return c.json(buildAgentContext(deps, agent.wall, agent.page), 200);
  });

  app.post(`${AGENT_API_PREFIX}/events`, credential, jsonLimit, async (c) => {
    const agent = c.get('agent');
    const body = await readJson(c);
    if (body === INVALID_JSON) return apiError(c, 'BAD_REQUEST', '请求体不是合法的 JSON');
    const parsed = eventsRequestSchema.safeParse(body);
    if (!parsed.success) return apiError(c, 'BAD_REQUEST', `事件格式不对：${firstIssue(parsed.error)}（props 只接受数字和布尔值）`);
    const nowIso = deps.now().toISOString();
    deps.repos.events.record({
      type: toStoredAgentEventType(parsed.data.type),
      wallId: agent.wall.id,
      pageId: agent.page.id,
      actorId: agent.page.ownerId,
      props: parsed.data.props,
      createdAt: nowIso,
    });
    deps.repos.credentials.touch(agent.credential.id, nowIso);
    return c.body(null, 204);
  });

  app.post(`${AGENT_API_PREFIX}/revisions`, credential, revisionLimit, async (c) => {
    const agent = c.get('agent');
    const body = await readJson(c);
    if (body === INVALID_JSON) return apiError(c, 'BAD_REQUEST', '请求体不是合法的 JSON');
    const parsed = revisionsRequestSchema.safeParse(body);
    if (!parsed.success) return apiError(c, 'BAD_REQUEST', `提交格式不对：${firstIssue(parsed.error)}`);
    const outcome = await deps.submissions.submit(agent, parsed.data.files);
    if (outcome.kind === 'rate_limited') {
      return apiError(c, 'RATE_LIMITED', `提交太频繁：每页每 24 小时最多提交 ${REVISIONS_PER_PAGE_PER_DAY} 次，请稍后再试`);
    }
    if (outcome.kind === 'credential_invalid') {
      return apiError(c, 'CREDENTIAL_INVALID', CREDENTIAL_INVALID_MESSAGE, { 'WWW-Authenticate': 'Bearer' });
    }
    const response: RevisionResponse = { revision: outcome.summary };
    return c.json(response, outcome.summary.status === 'accepted' ? 201 : 422);
  });

  app.post(`${AGENT_API_PREFIX}/previews`, credential, revisionLimit, async (c) => {
    const agent = c.get('agent');
    const body = await readJson(c);
    if (body === INVALID_JSON) return apiError(c, 'BAD_REQUEST', '请求体不是合法的 JSON');
    const parsed = revisionsRequestSchema.safeParse(body);
    if (!parsed.success) return apiError(c, 'BAD_REQUEST', `预览请求格式不对：${firstIssue(parsed.error)}`);
    const outcome = await deps.remotePreview.preview(agent, parsed.data.files);
    if (outcome.kind === 'rate_limited') {
      return apiError(c, 'RATE_LIMITED', `预览太频繁：每页每 24 小时最多预览 ${REMOTE_PREVIEWS_PER_PAGE_PER_DAY} 次，请稍后再试`);
    }
    if (outcome.kind === 'credential_invalid') {
      return apiError(c, 'CREDENTIAL_INVALID', CREDENTIAL_INVALID_MESSAGE, { 'WWW-Authenticate': 'Bearer' });
    }
    const response: RemotePreviewResponse = outcome.response;
    return c.json(response, 200);
  });
}
