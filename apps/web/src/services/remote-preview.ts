/**
 * 服务端远程预览（contracts 4.1 `POST /api/agent/previews`）：给随 Skill 包分发的轻量 CLI 用。
 * 真实用户的机器上没有 Playwright 和浏览器，`nowme preview` 把页面文件发到这里，由主站用与提交相同的
 * 沙箱渲染管线（`buildRevision({ mode: 'preview' })`）截图并返回。
 *
 * - 只认页面凭证；文件过滤与提交相同（白名单外的丢弃，并在报告里加 IGNORED_FILE 警告）；
 * - **什么都不存**：不建版本、不写文件；只记一条 `remote_preview` 事件用于限流（不含内容）；
 * - 每页每 24 小时最多 REMOTE_PREVIEWS_PER_PAGE_PER_DAY 次；
 * - 串行渲染（自己的队列与渲染器，第一次预览时才启动浏览器），不会挤占提交的队列。
 */
import {
  REMOTE_PREVIEWS_PER_PAGE_PER_DAY,
  type KitFont,
  type PageFiles,
  type RemotePreviewResponse,
  type ValidationReport,
} from '@nowme/contracts';
import { buildRevision, createRenderer, type Renderer } from '@nowme/render';
import { REVISION_RATE_WINDOW_HOURS } from '../constants.js';
import type { AgentAuth } from '../context.js';
import type { Repos } from '../db/index.js';
import { revalidateAgentAuth } from './agent.js';
import { createSerialQueue } from './queue.js';
import { prepareUploadedFiles, withIgnoredFiles } from './submissions.js';

/** 一次渲染的结果（图片是 PNG 字节）。 */
export interface RemoteRenderResult {
  report: ValidationReport;
  rendered: boolean;
  cover: Uint8Array | null;
  full: Uint8Array | null;
  reducedMotion: Uint8Array | null;
  blocks: { id: string; top: number; height: number; png: Uint8Array }[];
}

/** 渲染器（测试可以注入假的）。 */
export interface RemoteRenderer {
  render(files: PageFiles, kitFonts: KitFont[]): Promise<RemoteRenderResult>;
  close(): Promise<void>;
}

/** 返回的分块截图上限（与托管路线给模型的数量同一量级，避免响应过大）。 */
export const REMOTE_PREVIEW_MAX_BLOCKS = 12;

/** 真实渲染器：与 `nowme preview` 相同的双源沙箱渲染；封面总是用截图重新生成。 */
export function createRealRemoteRenderer(): RemoteRenderer {
  let renderer: Promise<Renderer> | null = null;
  const getRenderer = (): Promise<Renderer> => {
    if (!renderer) {
      renderer = createRenderer().catch((error: unknown) => {
        renderer = null;
        throw error;
      });
    }
    return renderer;
  };
  return {
    async render(files, kitFonts) {
      const result = await buildRevision({
        files,
        kitFonts,
        mode: 'preview',
        renderer: await getRenderer(),
        forceCover: true,
        // 服务端的字体源文件缺失是配置问题，与提交一致：直接报错，不悄悄回退
        missingFontSource: 'error',
      });
      return {
        report: result.report,
        rendered: result.rendered,
        cover: result.cover,
        full: result.fullScreenshot,
        reducedMotion: result.reducedMotionScreenshot,
        blocks: result.blockScreenshots.map((block) => ({ id: block.id, top: block.top, height: block.height, png: block.png })),
      };
    },
    async close() {
      const pending = renderer;
      renderer = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
  };
}

export type RemotePreviewOutcome =
  | { kind: 'rendered'; response: RemotePreviewResponse }
  | { kind: 'rate_limited' }
  | { kind: 'credential_invalid' };

export interface RemotePreviewService {
  /** `files`：已通过 revisionsRequestSchema 校验的 `{ 路径: base64 }`。 */
  preview(agent: AgentAuth, files: Readonly<Record<string, string>>): Promise<RemotePreviewOutcome>;
  close(): Promise<void>;
}

export interface RemotePreviewServiceOptions {
  repos: Repos;
  now: () => Date;
  kitFonts: KitFont[];
  renderer: RemoteRenderer;
}

const toBase64 = (bytes: Uint8Array | null): string | null => (bytes ? Buffer.from(bytes).toString('base64') : null);

export function createRemotePreviewService(options: RemotePreviewServiceOptions): RemotePreviewService {
  const { repos, now, kitFonts, renderer } = options;
  const queue = createSerialQueue();

  const overLimit = (pageId: string): boolean => {
    const since = new Date(now().getTime() - REVISION_RATE_WINDOW_HOURS * 3600 * 1000).toISOString();
    return repos.events.countForPageSince(pageId, 'remote_preview', since) >= REMOTE_PREVIEWS_PER_PAGE_PER_DAY;
  };

  return {
    async preview(agent, input) {
      if (overLimit(agent.page.id)) return { kind: 'rate_limited' };
      const prepared = prepareUploadedFiles(input);
      return queue.run(async (): Promise<RemotePreviewOutcome> => {
        // 排队期间凭证可能已被断开，或者额度已被用完
        const auth = revalidateAgentAuth(repos, agent.credential.id);
        if (!auth) return { kind: 'credential_invalid' };
        if (overLimit(auth.page.id)) return { kind: 'rate_limited' };
        const nowIso = now().toISOString();
        // 先记事件再渲染：渲染失败也计入额度（防止反复触发昂贵的失败渲染）
        repos.events.record({
          type: 'remote_preview',
          wallId: auth.wall.id,
          pageId: auth.page.id,
          actorId: auth.page.ownerId,
          props: { files: prepared.files.size, ignored: prepared.ignored.length },
          createdAt: nowIso,
        });
        repos.credentials.touch(auth.credential.id, nowIso);
        const result = await renderer.render(prepared.files, kitFonts);
        return {
          kind: 'rendered',
          response: {
            report: withIgnoredFiles(result.report, prepared.ignored),
            rendered: result.rendered,
            cover: toBase64(result.cover),
            full: toBase64(result.full),
            reducedMotion: toBase64(result.reducedMotion),
            blocks: result.blocks.slice(0, REMOTE_PREVIEW_MAX_BLOCKS).map((block) => ({
              id: block.id,
              top: block.top,
              height: block.height,
              png: Buffer.from(block.png).toString('base64'),
            })),
          },
        };
      });
    },
    async close() {
      await queue.idle();
      await renderer.close();
    },
  };
}
