import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTEXT_LIMITS,
  AGENT_EVENT_TYPES,
  API_ERROR_STATUS,
  apiErrorBody,
  ASSET_MAX_BYTES,
  ASSETS_MAX_COUNT,
  ASSETS_TOTAL_MAX_BYTES,
  COVER_HEIGHT,
  COVER_MAX_BYTES,
  COVER_WIDTH,
  DEFAULT_AGENT_TOKEN_TTL_HOURS,
  EVENT_TYPES,
  HTML_MAX_BYTES,
  isApiErrorCode,
  isValidationIssueCode,
  KIT_BASE_PATH,
  KIT_CSS_PATH,
  KIT_JS_PATH,
  MOTION_LEVELS,
  NM_ID_PATTERN,
  RENDER_SLOW_MS,
  RENDER_TIMEOUT_MS,
  RENDER_VIEWPORT,
  REVISION_REQUEST_MAX_BYTES,
  REVISIONS_PER_PAGE_PER_DAY,
  SCENE_TYPES,
  severityOf,
  toStoredAgentEventType,
  VALIDATION_ISSUE_CODE_LIST,
  VALIDATION_ISSUE_CODES,
} from '../src/index.js';

describe('[原型默认] 数值', () => {
  it('页面与资源限制（contracts 1）', () => {
    expect(HTML_MAX_BYTES).toBe(307_200);
    expect(COVER_WIDTH).toBe(750);
    expect(COVER_HEIGHT).toBe(1000);
    expect(COVER_MAX_BYTES).toBe(600 * 1024);
    expect(ASSET_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(ASSETS_TOTAL_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ASSETS_MAX_COUNT).toBe(20);
    expect(AGENT_CONTEXT_LIMITS).toEqual({
      htmlMaxBytes: 307_200,
      assetMaxBytes: 2 * 1024 * 1024,
      assetsTotalMaxBytes: 8 * 1024 * 1024,
      assetsMaxCount: 20,
      maxCjkFonts: 2,
    });
  });

  it('渲染、提交、有效期', () => {
    expect(RENDER_VIEWPORT).toEqual({ width: 375, height: 667 });
    expect(RENDER_SLOW_MS).toBe(3000);
    expect(RENDER_TIMEOUT_MS).toBe(10_000);
    expect(REVISIONS_PER_PAGE_PER_DAY).toBe(50);
    expect(REVISION_REQUEST_MAX_BYTES).toBe(12 * 1024 * 1024);
    expect(DEFAULT_AGENT_TOKEN_TTL_HOURS).toBe(72);
  });

  it('Kit 路径', () => {
    expect(KIT_BASE_PATH).toBe('/_nowme/kit/v1/');
    expect(KIT_CSS_PATH).toBe('/_nowme/kit/v1/nowme.css');
    expect(KIT_JS_PATH).toBe('/_nowme/kit/v1/nowme.js');
  });

  it('枚举', () => {
    expect(SCENE_TYPES).toEqual(['hackathon', 'interest', 'club', 'general']);
    expect(MOTION_LEVELS).toEqual(['calm', 'medium', 'lively']);
    expect(AGENT_EVENT_TYPES).toEqual(['fetch', 'validate', 'preview', 'generate', 'submit']);
    expect(EVENT_TYPES).toHaveLength(16);
    expect(EVENT_TYPES).toContain('want_to_chat');
    for (const type of AGENT_EVENT_TYPES) expect(EVENT_TYPES).toContain(toStoredAgentEventType(type));
    expect(NM_ID_PATTERN.test('hero')).toBe(true);
  });
});

describe('校验错误码（contracts 2.2、2.3）', () => {
  it('全部 41 个码，大写蛇形', () => {
    expect(VALIDATION_ISSUE_CODE_LIST).toHaveLength(41);
    for (const code of VALIDATION_ISSUE_CODE_LIST) expect(code).toMatch(/^[A-Z][A-Z_]+$/);
  });

  it('警告级别的码与 contracts 一致，其余为 error', () => {
    const warnings = VALIDATION_ISSUE_CODE_LIST.filter((code) => severityOf(code) === 'warning').sort();
    expect(warnings).toEqual(
      [
        'HTML_MISSING_LANG',
        'EXTERNAL_URL_IN_SCRIPT',
        'NM_BLOCKS_MISMATCH',
        'FONT_NOT_IN_KIT',
        'EXTRA_CHARS_MISSING',
        'ASSET_UNUSED',
        'IGNORED_FILE',
        'RENDER_CONSOLE_ERROR',
        'RENDER_SLOW',
        'RENDER_BLANK',
      ].sort(),
    );
  });

  it('渲染阶段的码', () => {
    const render = VALIDATION_ISSUE_CODE_LIST.filter((code) => VALIDATION_ISSUE_CODES[code].stage === 'render');
    expect(render).toEqual([
      'RENDER_SCRIPT_ERROR',
      'RENDER_CSP_VIOLATION',
      'RENDER_CONSOLE_ERROR',
      'RENDER_SLOW',
      'RENDER_BLANK',
      'RENDER_FAILED',
    ]);
    expect(isValidationIssueCode('CREDENTIAL_LEAK')).toBe(true);
    expect(isValidationIssueCode('toString')).toBe(false);
  });
});

describe('API 错误码（contracts 4.1）', () => {
  it('错误码与状态码', () => {
    expect(API_ERROR_STATUS).toMatchObject({
      TOKEN_INVALID: 401,
      CREDENTIAL_INVALID: 401,
      RATE_LIMITED: 429,
      VALIDATION_FAILED: 422,
      PAYLOAD_TOO_LARGE: 413,
      BAD_REQUEST: 400,
      NOT_FOUND: 404,
    });
    expect(isApiErrorCode('TOKEN_INVALID')).toBe(true);
    expect(isApiErrorCode('constructor')).toBe(false);
  });

  it('错误体 { error: { code, message } }', () => {
    expect(apiErrorBody('TOKEN_INVALID', 'token 已使用')).toEqual({
      error: { code: 'TOKEN_INVALID', message: 'token 已使用' },
    });
  });
});
