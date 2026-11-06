/**
 * 提交处理器：页面文件（已过滤为白名单路径）→ 校验报告 + `served/` + 封面 + 整页截图 + 渲染后文字。
 *
 * 默认实现走真实渲染管线：`buildRevision({ mode: 'submit' })`（重新运行全部静态校验，不信任客户端结果；
 * 渲染检查；字体子集化），共享一个 `createRenderer()` 实例（第一次提交时才启动浏览器）。
 * 串行由 SubmissionService 的队列保证。测试可以注入假的处理器。
 */
import type { KitFont, PageFiles, ValidationReport } from '@nowme/contracts';
import { buildRevision, createRenderer, type Renderer, type RendererOptions } from '@nowme/render';

export interface ProcessInput {
  files: PageFiles;
  kitFonts: KitFont[];
}

export interface ProcessedSubmission {
  /** 最终报告（静态 + 渲染）；`ok` 决定 accepted / rejected。 */
  report: ValidationReport;
  /** `served/` 布局：`index.html`（已注入 @font-face）、`assets/...`、`_fonts/...`。rejected 时可以为空。 */
  served: Map<string, Uint8Array>;
  cover: Uint8Array | null;
  fullScreenshot: Uint8Array | null;
  renderedText: string;
  /** 存进 `revisions.render_json` 的渲染摘要（指标、字体子集、openLink 地址）；没渲染时为 null。 */
  render: Record<string, unknown> | null;
}

export interface SubmissionProcessor {
  process(input: ProcessInput): Promise<ProcessedSubmission>;
  close(): Promise<void>;
}

export interface RenderProcessorOptions {
  /** Kit 字体源文件目录（默认 `packages/kit/fonts/`）。 */
  fontSource?: string;
  rendererOptions?: RendererOptions;
}

export function createRenderProcessor(options: RenderProcessorOptions = {}): SubmissionProcessor {
  let renderer: Promise<Renderer> | null = null;
  const getRenderer = (): Promise<Renderer> => {
    if (!renderer) {
      renderer = createRenderer(options.rendererOptions).catch((error: unknown) => {
        renderer = null;
        throw error;
      });
    }
    return renderer;
  };

  return {
    async process({ files, kitFonts }) {
      const result = await buildRevision({
        files,
        kitFonts,
        mode: 'submit',
        renderer: await getRenderer(),
        fontSource: options.fontSource,
      });
      return {
        report: result.report,
        served: result.rendered ? result.served : new Map(),
        cover: result.cover,
        fullScreenshot: result.fullScreenshot,
        renderedText: result.renderedText,
        render: result.rendered
          ? {
              coverGenerated: result.coverGenerated,
              fonts: result.fonts,
              openLinks: result.openLinks,
              metrics: result.metrics,
            }
          : null,
      };
    },
    async close() {
      const pending = renderer;
      renderer = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
  };
}
