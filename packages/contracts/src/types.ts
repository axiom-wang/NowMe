/**
 * 跨模块共享的类型：校验报告（contracts 2.1）、Agent API 响应（4.1）、错误体。
 */
import type { ApiErrorCode, IssueSeverity, ValidationIssueCode } from './codes.js';
import type { KIT_BASE_PATH, KIT_VERSION, SceneType } from './constants.js';
import type { KitFont } from './schemas.js';

// ---------------------------------------------------------------------------
// 校验（contracts 2.1）
// ---------------------------------------------------------------------------

/** key 为 page/ 内的相对路径，用 "/" 分隔。 */
export type PageFiles = Map<string, Uint8Array>;

export interface ValidationIssue {
  /** 见 contracts 2.2 / 2.3，大写蛇形。 */
  code: ValidationIssueCode;
  severity: IssueSeverity;
  /** 例如 "index.html"。 */
  file: string;
  /** 1 起。 */
  line?: number;
  /** 中文：哪里有什么问题。 */
  message: string;
  /** 中文：怎么修（给出修复指引或替代方案）。 */
  hint: string;
}

export interface ValidationStats {
  indexHtmlBytes: number;
  assetBytes: number;
  assetCount: number;
  blocks: string[];
  fontsUsed: string[];
  cjkFontCount: number;
  /** 脚本字符串里出现、静态文本里没有的中文字符。 */
  scriptOnlyChars: string;
  /** 不会上传的文件。 */
  ignoredFiles: string[];
}

export interface ValidationReport {
  /** 没有 error 即为 true。 */
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: ValidationStats;
  validatorVersion: string;
}

export interface ValidateOptions {
  kitFonts?: KitFont[];
}

// ---------------------------------------------------------------------------
// Agent API（contracts 4.1）
// ---------------------------------------------------------------------------

export interface AgentContext {
  wall: { id: string; name: string; description: string; sceneType: SceneType; organizerNote: string | null };
  page: { id: string; revisionCount: number; lastSubmittedAt: string | null; workspaceUrl: string };
  kit: { version: typeof KIT_VERSION; basePath: typeof KIT_BASE_PATH; fonts: KitFont[] };
  limits: {
    htmlMaxBytes: number;
    assetMaxBytes: number;
    assetsTotalMaxBytes: number;
    assetsMaxCount: number;
    maxCjkFonts: number;
  };
  /** 主站当前分发的 Skill 版本与安装页（contracts 4.5）；CLI 发现自己落后时提示更新。没有 Skill 包时为 null。 */
  skill: { version: string; installUrl: string } | null;
}

export type RevisionStatus = 'accepted' | 'rejected';

export interface RevisionSummary {
  id: string;
  number: number;
  status: RevisionStatus;
  report: ValidationReport;
  /** ISO 8601 UTC。 */
  createdAt: string;
  workspaceUrl: string;
}

/** `POST /api/agent/exchange` 200。`credential` 明文只在这次响应中出现。 */
export interface ExchangeResponse {
  credential: string;
  page: { id: string };
  context: AgentContext;
}

/** `GET /api/agent/context` 200。 */
export type ContextResponse = AgentContext;

/** `POST /api/agent/revisions` 201（accepted）或 422（rejected，含报告）。 */
export interface RevisionResponse {
  revision: RevisionSummary;
}

/**
 * `POST /api/agent/previews` 200（contracts 4.1）：服务端用与提交相同的沙箱渲染管线做预览，什么都不存。
 * 静态校验有错误也照样渲染（报告里保留错误），与本地 `nowme preview` 一致。图片都是 PNG 的 base64；没有时为 null。
 */
export interface RemotePreviewResponse {
  report: ValidationReport;
  /** 是否渲染了（缺 index.html 时为 false）。 */
  rendered: boolean;
  /** 750×1000 封面（截图生成）。 */
  cover: string | null;
  /** 整页截图。 */
  full: string | null;
  /** `prefers-reduced-motion: reduce` 时的整页截图。 */
  reducedMotion: string | null;
  /** 按 `data-nm-id` 分块的截图。 */
  blocks: { id: string; top: number; height: number; png: string }[];
}

/** 所有 API 错误的响应体。 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** 中文说明。 */
    message: string;
  };
}
