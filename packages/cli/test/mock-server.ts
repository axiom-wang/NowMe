/**
 * 模拟 NOWMe 主站的 Agent API（contracts 4.1）：node:http、随机端口，记录所有请求。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CREDENTIAL = `nmc_${'Zq3'.repeat(14)}`;
export const TOKEN = `nmt_${'k9'.repeat(20)}`;
export const WALL_ID = 'wal_testwall';
export const PAGE_ID = 'pag_testpage';

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

export function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    wall: { id: WALL_ID, name: '周末黑客松', description: '48 小时', sceneType: 'hackathon', organizerNote: '欢迎大家！' },
    page: { id: PAGE_ID, revisionCount: 0, lastSubmittedAt: null, workspaceUrl: 'http://localhost:3000/w/wal_testwall/me' },
    kit: { version: '1', basePath: '/_nowme/kit/v1/', fonts: [] },
    limits: { htmlMaxBytes: 307200, assetMaxBytes: 2097152, assetsTotalMaxBytes: 8388608, assetsMaxCount: 20, maxCjkFonts: 2 },
    ...overrides,
  };
}

export function revision(status: 'accepted' | 'rejected', report: Record<string, unknown> = {}) {
  return {
    id: 'rev_1',
    number: 3,
    status,
    report: {
      ok: status === 'accepted',
      errors: [],
      warnings: [],
      stats: {},
      validatorVersion: '1',
      ...report,
    },
    createdAt: '2026-11-06T00:00:00Z',
    workspaceUrl: 'http://localhost:3000/w/wal_testwall/me',
  };
}

export interface MockHandlers {
  exchange?: (body: any) => { status: number; body: unknown };
  context?: () => { status: number; body: unknown };
  revisions?: (body: any) => { status: number; body: unknown };
  events?: () => { status: number; body: unknown };
}

function error(status: number, code: string, message: string) {
  return { status, body: { error: { code, message } } };
}

export interface MockServer {
  origin: string;
  requests: RecordedRequest[];
  handlers: MockHandlers;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMockServer(handlers: MockHandlers = {}): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const mock: MockServer = { origin: '', requests, handlers, close: async () => undefined };
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? '';
    requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization, body });
    const authorized = req.headers.authorization === `Bearer ${CREDENTIAL}`;
    let out: { status: number; body: unknown };
    const h = mock.handlers;
    if (req.method === 'POST' && path === '/api/agent/exchange') {
      out =
        h.exchange?.(JSON.parse(body)) ??
        (() => {
          const parsed = JSON.parse(body) as { wallId: string; token: string };
          return parsed.token === TOKEN && parsed.wallId === WALL_ID
            ? { status: 200, body: { credential: CREDENTIAL, page: { id: PAGE_ID }, context: makeContext() } }
            : error(401, 'TOKEN_INVALID', 'token 已使用');
        })();
    } else if (req.method === 'GET' && path === '/api/agent/context') {
      out = !authorized ? error(401, 'CREDENTIAL_INVALID', '凭证无效') : (h.context?.() ?? { status: 200, body: makeContext() });
    } else if (req.method === 'POST' && path === '/api/agent/revisions') {
      out = !authorized ? error(401, 'CREDENTIAL_INVALID', '凭证无效') : (h.revisions?.(JSON.parse(body)) ?? { status: 201, body: { revision: revision('accepted') } });
    } else if (req.method === 'POST' && path === '/api/agent/events') {
      out = !authorized ? error(401, 'CREDENTIAL_INVALID', '凭证无效') : (h.events?.() ?? { status: 204, body: null });
    } else {
      out = error(404, 'NOT_FOUND', '没有这个接口');
    }
    res.statusCode = out.status;
    if (out.body === null) res.end();
    else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return mock;
}
