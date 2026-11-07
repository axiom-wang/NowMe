/**
 * `preview_page` 工具的真实实现：`buildRevision({ mode: 'preview' })`（与 `nowme preview` 相同的双源沙箱渲染），
 * 返回报告与给模型自查的截图（封面、减少动效整页、各区块）。渲染器懒启动，任务之间复用。
 */
import { buildRevision, createRenderer, type Renderer } from '@nowme/render';
import type { PagePreviewer } from './tools.js';

/** 整页截图太长时不给模型（区块截图已经覆盖）。 */
const MAX_FULL_SCREENSHOT_BYTES = 3 * 1024 * 1024;

export function createRenderPreviewer(): PagePreviewer {
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
    async preview(files, kitFonts) {
      const result = await buildRevision({ files, kitFonts, mode: 'preview', renderer: await getRenderer(), forceCover: true });
      const images: { label: string; png: Uint8Array }[] = [];
      if (result.cover) images.push({ label: '封面（首屏 375×500）', png: result.cover });
      for (const block of result.blockScreenshots.slice(0, 6)) images.push({ label: `区块 ${block.id}`, png: block.png });
      if (result.reducedMotionScreenshot && result.reducedMotionScreenshot.byteLength <= MAX_FULL_SCREENSHOT_BYTES) {
        images.push({ label: '减少动态效果时的整页', png: result.reducedMotionScreenshot });
      }
      return { report: result.report, images };
    },
    async close() {
      const pending = renderer;
      renderer = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
  };
}
