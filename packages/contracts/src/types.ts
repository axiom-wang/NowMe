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

/** 所有 API 错误的响应体。 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** 中文说明。 */
    message: string;
  };
}
