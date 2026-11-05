/**
 * 错误码。校验错误码见 contracts 2.2（静态校验）与 2.3（渲染检查）；API 错误码见 contracts 4.1。
 */

export type IssueSeverity = 'error' | 'warning';
/** `static`：packages/validator 的静态校验；`render`：packages/render 的渲染检查。 */
export type IssueStage = 'static' | 'render';

export interface IssueCodeInfo {
  readonly severity: IssueSeverity;
  readonly stage: IssueStage;
}

const error = { severity: 'error', stage: 'static' } as const;
const warning = { severity: 'warning', stage: 'static' } as const;
const renderError = { severity: 'error', stage: 'render' } as const;
const renderWarning = { severity: 'warning', stage: 'render' } as const;

/** 全部校验错误码及其级别。键的顺序与 contracts 表格一致。 */
export const VALIDATION_ISSUE_CODES = {
  // 2.2 静态校验
  MISSING_FILE: error,
  HTML_TOO_LARGE: error,
  HTML_MISSING_VIEWPORT: error,
  HTML_MISSING_CHARSET: error,
  HTML_MISSING_DOCTYPE: error,
  HTML_MISSING_LANG: warning,
  EXTERNAL_RESOURCE: error,
  FORBIDDEN_LINK_HREF: error,
  INSECURE_OPEN_LINK: error,
  EXTERNAL_URL_IN_SCRIPT: warning,
  FORBIDDEN_ELEMENT: error,
  FORBIDDEN_API: error,
  JS_SYNTAX_ERROR: error,
  NM_ID_TOO_FEW: error,
  NM_ID_INVALID: error,
  NM_ID_DUPLICATE: error,
  NM_BLOCKS_MISMATCH: warning,
  MOTION_WITHOUT_REDUCED: error,
  FONT_FACE_FORBIDDEN: error,
  FONT_UNDECLARED: error,
  FONT_NOT_IN_KIT: warning,
  FONT_TOO_MANY_CJK: error,
  FONT_UNKNOWN: error,
  EXTRA_CHARS_MISSING: warning,
  CARD_INVALID: error,
  MANIFEST_INVALID: error,
  COVER_INVALID: error,
  ASSET_TYPE_FORBIDDEN: error,
  ASSET_TOO_LARGE: error,
  ASSETS_TOO_MANY: error,
  ASSET_NAME_INVALID: error,
  ASSET_MISSING: error,
  ASSET_UNUSED: warning,
  CREDENTIAL_LEAK: error,
  IGNORED_FILE: warning,
  // 2.3 渲染检查
  RENDER_SCRIPT_ERROR: renderError,
  RENDER_CSP_VIOLATION: renderError,
  RENDER_CONSOLE_ERROR: renderWarning,
  RENDER_SLOW: renderWarning,
  RENDER_BLANK: renderWarning,
  RENDER_FAILED: renderError,
} as const satisfies Record<string, IssueCodeInfo>;

export type ValidationIssueCode = keyof typeof VALIDATION_ISSUE_CODES;

export const VALIDATION_ISSUE_CODE_LIST = Object.keys(VALIDATION_ISSUE_CODES) as ValidationIssueCode[];

export function isValidationIssueCode(value: string): value is ValidationIssueCode {
  return Object.hasOwn(VALIDATION_ISSUE_CODES, value);
}

export function severityOf(code: ValidationIssueCode): IssueSeverity {
  return VALIDATION_ISSUE_CODES[code].severity;
}

/** API 错误码 → HTTP 状态码。错误体统一为 `{ error: { code, message } }`。 */
export const API_ERROR_STATUS = {
  /** exchange：token 不存在、已用、过期、墙不匹配一律同一码。 */
  TOKEN_INVALID: 401,
  /** 凭证无效、已吊销，或墙已关闭 / 成员关系不再有效。 */
  CREDENTIAL_INVALID: 401,
  /** 每页每日提交次数超限。 */
  RATE_LIMITED: 429,
  /** 校验不通过（revisions 的 422 响应体是 `{ revision }`，此码供其他需要错误体的场景使用）。 */
  VALIDATION_FAILED: 422,
  PAYLOAD_TOO_LARGE: 413,
  /** 请求体不是合法 JSON 或不符合 schema。 */
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  /** [T0.2 暂定] 未预期的服务器错误。 */
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export const API_ERROR_CODE_LIST = Object.keys(API_ERROR_STATUS) as ApiErrorCode[];

export function isApiErrorCode(value: string): value is ApiErrorCode {
  return Object.hasOwn(API_ERROR_STATUS, value);
}
