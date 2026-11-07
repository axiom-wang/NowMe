/** 服务端远程预览（contracts 4.1 `POST /api/agent/previews`）：给随 Skill 包分发的轻量 CLI 用。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemotePreviewResponse } from '@nowme/contracts';
import {
  brokenFiles,
  connectAgent,
  createStaticRemoteRenderer,
  createTestWeb,
  createUser,
  exampleFiles,
  postJson,
  seedWall,
  TINY_PNG,
  type StaticRemoteRenderer,
  type TestWeb,
} from './helpers.js';
import type { Wall } from '../src/db/walls.js';
import type { Page } from '../src/db/pages.js';

describe('远程预览', () => {
  let t: TestWeb;
  let renderer: StaticRemoteRenderer;
  let wall: Wall;
  let page: Page;
  let credential: string;

  beforeEach(async () => {
    renderer = createStaticRemoteRenderer();
    t = createTestWeb({ remoteRenderer: renderer });
    ({ wall, page } = seedWall(t, createUser(t, 'owner@example.com')));
    credential = await connectAgent(t, wall, page);
  });
  afterEach(async () => {
    await t.close();
  });

  it('通过校验的页面：200，返回报告与 base64 截图（封面、整页、减少动效、分块）', async () => {
    const response = await postJson(t, '/api/agent/previews', { files: exampleFiles() }, credential);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RemotePreviewResponse;
    expect(body.report.ok).toBe(true);
    expect(body.rendered).toBe(true);
    const tiny = Buffer.from(TINY_PNG).toString('base64');
    expect(body.cover).toBe(tiny);
    expect(body.full).toBe(tiny);
    expect(body.reducedMotion).toBe(tiny);
    expect(body.blocks).toEqual([{ id: 'hero', top: 0, height: 100, png: tiny }]);
    expect(renderer.calls).toBe(1);
  });

  it('没通过校验的页面也照样返回（报告里保留错误），状态仍是 200', async () => {
    const response = await postJson(t, '/api/agent/previews', { files: brokenFiles() }, credential);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RemotePreviewResponse;
    expect(body.report.ok).toBe(false);
    expect(body.report.errors.length).toBeGreaterThan(0);
  });

  it('白名单外的文件不进入渲染，并在报告里加 IGNORED_FILE 警告', async () => {
    const files = { ...exampleFiles(), 'brief.md': Buffer.from('私密 brief').toString('base64') };
    const seen: string[][] = [];
    const original = renderer.render.bind(renderer);
    renderer.render = async (pageFiles, kitFonts) => {
      seen.push([...pageFiles.keys()]);
      return original(pageFiles, kitFonts);
    };
    const body = (await (await postJson(t, '/api/agent/previews', { files }, credential)).json()) as RemotePreviewResponse;
    expect(seen[0]).not.toContain('brief.md');
    expect(body.report.warnings.some((issue) => issue.code === 'IGNORED_FILE' && issue.file === 'brief.md')).toBe(true);
  });

  it('请求格式不对：400 BAD_REQUEST，不渲染', async () => {
    const response = await postJson(t, '/api/agent/previews', { files: { 'index.html': 'not base64!' } }, credential);
    expect(response.status).toBe(400);
    expect(renderer.calls).toBe(0);
  });
});
