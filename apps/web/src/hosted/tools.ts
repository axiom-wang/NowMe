/**
 * 托管生成的工具（hosted-route 3.2，S8）。每个任务一个 `GenerationWorkspace`，绑定到它自己的临时目录。
 *
 * 能力边界：
 * - `read_skill_file`：只读 `skill/` 下 reference/、templates/、scenes/、examples/ 里的 .md / .json / .html 文本；
 *   规范化后必须仍在这些目录内，拒绝 `..`、绝对路径、符号链接（realpath 校验）。
 * - `read_page_file` / `list_page_files`：只看临时 `page/`。
 * - `write_page_file`：只能写 index.html、card.json、manifest.json（文本，≤ 300 KB）。
 * - `validate_page` / `preview_page`：校验与预览渲染，结果只是数据。
 * - `finish`：结束循环。
 * 没有执行命令、联网、读环境变量、读数据库的工具。
 */
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  HTML_MAX_BYTES,
  PAGE_CARD_FILE,
  PAGE_INDEX_FILE,
  PAGE_MANIFEST_FILE,
  type KitFont,
  type PageFiles,
  type ValidationReport,
} from '@nowme/contracts';
import { SKILL_DIR } from '@nowme/skill';
import { computeExtraChars, isSystemFile, validatePage } from '@nowme/validator';
import type { ImageBlock, TextBlock, ToolDefinition } from './claude.js';

export const WRITABLE_PAGE_FILES: ReadonlySet<string> = new Set([PAGE_INDEX_FILE, PAGE_CARD_FILE, PAGE_MANIFEST_FILE]);
const SKILL_READ_DIRS = ['reference', 'templates', 'scenes', 'examples'];
const SKILL_READ_EXTENSIONS = new Set(['.md', '.json', '.html']);
const SKILL_READ_MAX_BYTES = 200 * 1024;

/** 预览渲染（真实实现用 `buildRevision({ mode: 'preview' })`）。 */
export interface PagePreviewer {
  preview(files: PageFiles, kitFonts: KitFont[]): Promise<PreviewOutcome>;
  close(): Promise<void>;
}

export interface PreviewOutcome {
  report: ValidationReport;
  images: { label: string; png: Uint8Array }[];
}

export class ToolError extends Error {
  override name = 'ToolError';
}

export const GENERATION_TOOLS: ToolDefinition[] = [
  {
    name: 'read_skill_file',
    description: '读取 Skill 目录里的参考文件（reference/、templates/、scenes/、examples/ 下的 .md / .json / .html），例如 examples/club-newbie-sticker/index.html。',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_page_files',
    description: '列出 page/ 目录中的文件（相对路径与字节数）。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_page_file',
    description: '读取 page/ 中的文本文件（index.html、card.json、manifest.json）。',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_page_file',
    description: '写入（覆盖）page/ 中的 index.html、card.json 或 manifest.json。content 是完整的文件内容。',
    input_schema: { type: 'object', properties: { path: { type: 'string', enum: [...WRITABLE_PAGE_FILES] }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'validate_page',
    description: '对 page/ 运行 NOWMe 静态校验（等同 nowme validate，会自动补全 manifest.extraChars），返回报告。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_page',
    description: '在与平台相同的沙箱里渲染 page/（等同 nowme preview），返回渲染问题、封面与区块截图。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'finish',
    description: '结束本次任务。outcome 为 "done"（页面已完成，交给平台重新校验）或 "clarify"（只用于修改任务：作用范围不清，message 写给主人的问题）。',
    input_schema: {
      type: 'object',
      properties: { outcome: { type: 'string', enum: ['done', 'clarify'] }, message: { type: 'string' } },
      required: ['outcome', 'message'],
    },
    cache_control: { type: 'ephemeral' },
  },
];

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function asString(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) throw new ToolError('参数应为对象');
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new ToolError(`缺少字符串参数 ${key}`);
  return value;
}

/** Skill 文件路径检查（导出给测试）。返回绝对路径。 */
export async function resolveSkillPath(path: string, skillDir: string = SKILL_DIR): Promise<string> {
  if (path.length === 0 || path.length > 200 || isAbsolute(path) || path.includes('\0') || path.includes('\\')) {
    throw new ToolError('路径不允许');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '' || segment.startsWith('.'))) {
    throw new ToolError('路径不允许');
  }
  if (!SKILL_READ_DIRS.includes(segments[0] ?? '') || segments.length < 2) throw new ToolError(`只能读取 ${SKILL_READ_DIRS.join('/、')}/ 下的文件`);
  if (!SKILL_READ_EXTENSIONS.has(extname(path).toLowerCase())) throw new ToolError('只能读取 .md、.json、.html 文件');
  const root = await realpath(resolve(skillDir));
  const target = resolve(root, ...segments);
  if (!inside(root, target)) throw new ToolError('路径不允许');
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new ToolError('文件不存在');
  }
  if (!inside(root, real) || real !== target) throw new ToolError('路径不允许');
  const info = await lstat(real);
  if (!info.isFile()) throw new ToolError('不是文件');
  if (info.size > SKILL_READ_MAX_BYTES) throw new ToolError('文件太大');
  return real;
}

function checkPagePath(path: string): string {
  if (path.length === 0 || path.length > 120 || isAbsolute(path) || path.includes('\0') || path.includes('\\')) throw new ToolError('路径不允许');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) throw new ToolError('路径不允许');
  return segments.join('/');
}

export interface FinishSignal {
  outcome: 'done' | 'clarify';
  message: string;
}

export interface ToolCallResult {
  content: string | (TextBlock | ImageBlock)[];
  isError: boolean;
  finish?: FinishSignal;
}

export class GenerationWorkspace {
  /** 临时目录下的 page/。 */
  readonly pageDir: string;
  validateCount = 0;
  previewCount = 0;

  constructor(
    readonly rootDir: string,
    private readonly kitFonts: KitFont[],
    private readonly previewer: PagePreviewer,
    private readonly skillDir: string = SKILL_DIR,
  ) {
    this.pageDir = join(rootDir, 'page');
  }

  /** 读出 page/ 全部文件（跳过系统文件与符号链接）。 */
  async readFiles(): Promise<PageFiles> {
    const files: PageFiles = new Map();
    const root = await realpath(this.pageDir);
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = relative(root, full).split(sep).join('/');
        if (isSystemFile(rel)) continue;
        files.set(rel, new Uint8Array(await readFile(full)));
      }
    };
    await walk(root);
    return files;
  }

  async call(name: string, input: unknown): Promise<ToolCallResult> {
    try {
      switch (name) {
        case 'read_skill_file': {
          const file = await resolveSkillPath(asString(input, 'path'), this.skillDir);
          return { content: await readFile(file, 'utf8'), isError: false };
        }
        case 'list_page_files': {
          const files = await this.readFiles();
          const lines = [...files].map(([path, bytes]) => `${path}\t${bytes.byteLength} 字节`).sort();
          return { content: lines.length > 0 ? lines.join('\n') : '（page/ 目前是空的）', isError: false };
        }
        case 'read_page_file': {
          const path = checkPagePath(asString(input, 'path'));
          if (!WRITABLE_PAGE_FILES.has(path)) throw new ToolError('只能读取 index.html、card.json、manifest.json');
          const files = await this.readFiles();
          const bytes = files.get(path);
          if (!bytes) throw new ToolError('文件不存在');
          return { content: Buffer.from(bytes).toString('utf8'), isError: false };
        }
        case 'write_page_file': {
          const path = checkPagePath(asString(input, 'path'));
          if (!WRITABLE_PAGE_FILES.has(path)) throw new ToolError('只能写 index.html、card.json、manifest.json（图片只来自主人上传，封面由平台生成）');
          const content = asString(input, 'content');
          if (Buffer.byteLength(content, 'utf8') > HTML_MAX_BYTES) throw new ToolError('内容超过 300 KB');
          const target = join(this.pageDir, path);
          // 目标若是符号链接（不应出现），拒绝写入
          try {
            if ((await lstat(target)).isSymbolicLink()) throw new ToolError('路径不允许');
          } catch (error) {
            if (error instanceof ToolError) throw error;
          }
          await writeFile(target, content, 'utf8');
          return { content: `已写入 ${path}（${Buffer.byteLength(content, 'utf8')} 字节）`, isError: false };
        }
        case 'validate_page': {
          this.validateCount += 1;
          await this.fixExtraChars();
          const report = validatePage(await this.readFiles(), { kitFonts: this.kitFonts });
          return { content: JSON.stringify(summarizeReport(report)), isError: false };
        }
        case 'preview_page': {
          this.previewCount += 1;
          await this.fixExtraChars();
          const outcome = await this.previewer.preview(await this.readFiles(), this.kitFonts);
          const blocks: (TextBlock | ImageBlock)[] = [{ type: 'text', text: JSON.stringify(summarizeReport(outcome.report)) }];
          for (const image of outcome.images.slice(0, 8)) {
            blocks.push({ type: 'text', text: `截图：${image.label}` });
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(image.png).toString('base64') } });
          }
          return { content: blocks, isError: false };
        }
        case 'finish': {
          const outcome = asString(input, 'outcome');
          if (outcome !== 'done' && outcome !== 'clarify') throw new ToolError('outcome 只能是 done 或 clarify');
          const message = Array.from(asString(input, 'message').trim()).slice(0, 300).join('');
          return { content: '好的', isError: false, finish: { outcome, message } };
        }
        default:
          throw new ToolError(`没有这个工具：${name}`);
      }
    } catch (error) {
      if (error instanceof ToolError) return { content: error.message, isError: true };
      return { content: '工具执行失败', isError: true };
    }
  }

  /** 同 `nowme validate`：自动补全 manifest.extraChars（manifest 不合法时不动）。 */
  private async fixExtraChars(): Promise<void> {
    const files = await this.readFiles();
    const bytes = files.get(PAGE_MANIFEST_FILE);
    if (!bytes) return;
    let manifest: unknown;
    try {
      manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      return;
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return;
    const record = manifest as Record<string, unknown>;
    if (typeof record.extraChars !== 'string') return;
    const after = computeExtraChars(files);
    if (after === record.extraChars) return;
    await writeFile(join(this.pageDir, PAGE_MANIFEST_FILE), `${JSON.stringify({ ...record, extraChars: after }, null, 2)}\n`, 'utf8');
  }
}

/** 给模型看的报告摘要（不含统计里的大字段）。 */
export function summarizeReport(report: ValidationReport): Record<string, unknown> {
  const issue = (item: ValidationReport['errors'][number]) => ({
    code: item.code,
    file: item.file,
    ...(item.line ? { line: item.line } : {}),
    message: item.message,
    hint: item.hint,
  });
  return {
    ok: report.ok,
    errors: report.errors.slice(0, 30).map(issue),
    warnings: report.warnings.slice(0, 30).map(issue),
    blocks: report.stats.blocks,
    indexHtmlBytes: report.stats.indexHtmlBytes,
  };
}
