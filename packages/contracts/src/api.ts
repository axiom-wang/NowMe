/**
 * Agent API 的小工具（contracts 4.1）。
 */
import { API_ERROR_STATUS, type ApiErrorCode } from './codes.js';
import {
  ASSET_MAX_BYTES,
  ASSETS_MAX_COUNT,
  ASSETS_TOTAL_MAX_BYTES,
  HTML_MAX_BYTES,
  MAX_CJK_FONTS,
} from './constants.js';
import type { AgentContext, ApiErrorBody } from './types.js';

/** AgentContext.limits 的取值。 */
export const AGENT_CONTEXT_LIMITS: AgentContext['limits'] = Object.freeze({
  htmlMaxBytes: HTML_MAX_BYTES,
  assetMaxBytes: ASSET_MAX_BYTES,
  assetsTotalMaxBytes: ASSETS_TOTAL_MAX_BYTES,
  assetsMaxCount: ASSETS_MAX_COUNT,
  maxCjkFonts: MAX_CJK_FONTS,
});

export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function apiErrorStatus(code: ApiErrorCode): (typeof API_ERROR_STATUS)[ApiErrorCode] {
  return API_ERROR_STATUS[code];
}
