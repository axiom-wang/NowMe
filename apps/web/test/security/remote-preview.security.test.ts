/**
 * 远程预览的安全要求（contracts 4.1、S4）：
 * - 只认有效的页面凭证（缺失、错误、已断开 → 401），不读会话 cookie；
 * - 什么都不存：调用前后版本、发布、页面、凭证表与 revisions/ 目录都不变（只多一条不含内容的 remote_preview 事件）；
 * - 按页限流；
 * - 凭证仍然不能发布（远程预览不是发布的旁路）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_PREVIEWS_PER_PAGE_PER_DAY, dataPaths } from '@nowme/contracts';
import { disconnectAgent } from '../../src/services/agent.js';
import {
  connectAgent,
  createStaticRemoteRenderer,
  createTestWeb,
  dumpDb,
  exampleFiles,
  HOUR,
  login,
  postJson,
  seedWall,
  type StaticRemoteRenderer,
  type TestSession,
  type TestWeb,
} from '../helpers.js';
import type { Wall } from '../../src/db/walls.js';
import type { Page } from '../../src/db/pages.js';

describe('远程预览：认证、不落盘、限流', () => {
  let t: TestWeb;
  let renderer: StaticRemoteRenderer;
  let owner: TestSession;
  let wall: Wall;
  let page: Page;
  let credential: string;

  beforeEach(async () => {
    renderer = createStaticRemoteRenderer();
    t = createTestWeb({ remoteRenderer: renderer });
    owner = await login(t, 'owner@example.com', '林舟');
    ({ wall, page } = seedWall(t, owner.userId));
    credential = await connectAgent(t, wall, page);
  });
  afterEach(async () => {
    await t.close();
  });

  const preview = (cred?: string, init: { cookie?: string } = {}) =>
    init.cookie
      ? t.request('/api/agent/previews', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: init.cookie },
          body: JSON.stringify({ files: exampleFiles() }),
        })
      : postJson(t, '/api/agent/previews', { files: exampleFiles() }, cred);

  it('没有凭证、凭证错误、只有会话 cookie：401 CREDENTIAL_INVALID，不渲染', async () => {
    for (const response of [await preview(), await preview(`nmc_${'a'.repeat(43)}`), await preview(undefined, { cookie: owner.cookie })]) {
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('CREDENTIAL_INVALID');
    }
    expect(renderer.calls).toBe(0);
  });

  it('主人断开本地 Agent 后：401，不渲染', async () => {
    disconnectAgent(t.web.deps, page.id);
    expect((await preview(credential)).status).toBe(401);
    expect(renderer.calls).toBe(0);
  });

  it('什么都不存：版本、发布、页面、凭证（除最近使用时间）与 revisions/ 目录都不变，只多一条不含内容的事件', async () => {
    const before = dumpDb(t.db);
    const response = await preview(credential);
    expect(response.status).toBe(200);
    const after = dumpDb(t.db);
    for (const table of Object.keys(before)) {
      if (table === 'events' || table === 'page_credentials') continue;
      expect(after[table], table).toEqual(before[table]);
    }
    expect(t.repos.revisions.listForPage(page.id)).toEqual([]);
    const revisionsDir = dataPaths(t.dataDir).revisions;
    expect(existsSync(revisionsDir) ? readdirSync(revisionsDir) : []).toEqual([]);
    const events = (after.events as { type: string; props_json: string }[]).filter((event) => event.type === 'remote_preview');
    expect(events).toHaveLength(1);
    // 事件只含数字
    expect(Object.values(JSON.parse(events[0]?.props_json ?? '{}') as Record<string, unknown>).every((v) => typeof v === 'number')).toBe(true);
    const credentialRow = t.repos.credentials.findActiveForPage(page.id);
    expect(credentialRow?.revokedAt).toBeNull();
  });

  it(`每页每 24 小时最多 ${REMOTE_PREVIEWS_PER_PAGE_PER_DAY} 次，超出 429；过了窗口恢复`, async () => {
    const nowIso = t.clock.now().toISOString();
    for (let i = 0; i < REMOTE_PREVIEWS_PER_PAGE_PER_DAY; i += 1) {
      t.repos.events.record({ type: 'remote_preview', wallId: wall.id, pageId: page.id, actorId: owner.userId, props: {}, createdAt: nowIso });
    }
    const limited = await preview(credential);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(renderer.calls).toBe(0);
    t.clock.advance(24 * HOUR + 1000);
    expect((await preview(credential)).status).toBe(200);
  });

  it('远程预览之后，凭证依然不能发布（发布表单忽略 Authorization 头，墙上没有页面）', async () => {
    await preview(credential);
    const response = await t.request(`/w/${wall.id}/me/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/x-www-form-urlencoded', origin: t.config.webOrigin },
      body: new URLSearchParams({ revisionId: 'rev_x', confirm: '1' }).toString(),
    });
    expect([302, 303, 401, 403, 404]).toContain(response.status);
    expect(t.repos.revisions.listForPage(page.id)).toEqual([]);
  });
});
