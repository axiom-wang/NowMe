/**
 * docs/contracts.md 中的常量。
 *
 * 标 [原型默认] 的是需求文档里 [待定] 项的临时取值，集中放在这里便于以后调整；
 * 标 [T0.2 暂定] 的是 contracts 没有给出、脚手架阶段补充的取值（需总规划师确认）。
 */

const KB = 1024;
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// 源与端口（contracts 0.1）[原型默认]
// ---------------------------------------------------------------------------

/** 主站默认源（`NOWME_WEB_ORIGIN`）。 */
export const DEFAULT_WEB_ORIGIN = 'http://localhost:3000';
/** 页面托管默认源（`NOWME_PAGES_ORIGIN`）。与主站故意使用不同站点（localhost / 127.0.0.1）。 */
export const DEFAULT_PAGES_ORIGIN = 'http://127.0.0.1:4000';
export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_PAGES_PORT = 4000;
/** `nowme preview` 的预览外壳源与页面源（`nowme preview --port` 可调）。 */
export const DEFAULT_PREVIEW_SHELL_ORIGIN = 'http://localhost:4100';
export const DEFAULT_PREVIEW_PAGES_ORIGIN = 'http://127.0.0.1:4101';
export const DEFAULT_PREVIEW_SHELL_PORT = 4100;
export const DEFAULT_PREVIEW_PAGES_PORT = 4101;

/** 本地数据目录默认值（相对仓库根）。contracts 0：`db.sqlite`、`revisions/<id>/`、`outbox.log`、`secret`。 */
export const DEFAULT_DATA_DIR_NAME = '.data';
export const DATA_DB_FILE = 'db.sqlite';
export const DATA_REVISIONS_DIR = 'revisions';
export const DATA_OUTBOX_FILE = 'outbox.log';
export const DATA_SECRET_FILE = 'secret';
/**
 * CLI 本地目录（contracts 1.5）：`NOWME_HOME`，默认 `~/.nowme`。
 * `credentials`：页面凭证（JSON，按 pageId 索引），目录 0700、文件 0600；`profile.md`：长期画像，永不上传。
 */
export const DEFAULT_NOWME_HOME_DIR_NAME = '.nowme';
export const NOWME_HOME_CREDENTIALS_FILE = 'credentials';
export const NOWME_HOME_PROFILE_FILE = 'profile.md';
export const NOWME_HOME_DIR_MODE = 0o700;
export const NOWME_CREDENTIALS_FILE_MODE = 0o600;
/** 本地工作目录中的文件（contracts 1.5）。`nowme.json` 只含 `{ server, wallId, pageId }`，不含密钥。 */
export const WORKDIR_LINK_FILE = 'nowme.json';
export const WORKDIR_CONTEXT_FILE = 'context.json';
export const WORKDIR_BRIEF_FILE = 'brief.md';
export const WORKDIR_PAGE_DIR = 'page';

// ---------------------------------------------------------------------------
// Kit 与沙箱（contracts 1.1、5）
// ---------------------------------------------------------------------------

export const KIT_VERSION = '1';
export const KIT_BASE_PATH = '/_nowme/kit/v1/';
/** CSP 中 Kit 的源表达式路径（S2 写的是 `<pages>/_nowme/kit/`，覆盖所有 Kit 版本）。 */
export const KIT_CSP_PATH = '/_nowme/kit/';
export const KIT_CSS_PATH = `${KIT_BASE_PATH}nowme.css`;
export const KIT_JS_PATH = `${KIT_BASE_PATH}nowme.js`;
/** 展示用户页面的 iframe 只允许这一个沙箱标记（S1）。 */
export const PAGE_IFRAME_SANDBOX = 'allow-scripts';
/** 页面托管上版本页面的路径前缀：`/v/<ticket>/`。 */
export const PAGE_VIEW_PATH_PREFIX = '/v/';
/** 版本目录内字体子集的路径段：`/v/<ticket>/_fonts/`。 */
export const PAGE_FONTS_DIR = '_fonts';
/** `nowme.openLink` 的 postMessage 类型（contracts 5.1）。 */
export const OPEN_LINK_MESSAGE_TYPE = 'nowme:open-link';

// ---------------------------------------------------------------------------
// 页面输出契约的限制（contracts 1）
// ---------------------------------------------------------------------------

export const PAGE_SCHEMA_VERSION = 1;
/** `index.html` 体积上限：300 KB = 307 200 字节（含内联 base64，不含 assets/ 与字体）。 */
export const HTML_MAX_BYTES = 300 * KB;
/** `data-nm-id` 至少 3 个。 */
export const NM_ID_MIN_COUNT = 3;
/** `data-nm-id` / hook id / 各种短标识的格式。 */
export const NM_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** 移动端基准宽度。 */
export const MOBILE_BASE_WIDTH = 375;

/** card.json 字段长度（按 Unicode 码点计数）。 */
export const CARD_LIMITS = {
  displayName: { min: 1, max: 24 },
  tagline: { min: 1, max: 40 },
  hooks: { min: 2, max: 3 },
  hookText: { min: 2, max: 32 },
  hookOpener: { min: 1, max: 80 },
} as const;

/** 中文字体每个字重计 1 款，合计 ≤ 2。 */
export const MAX_CJK_FONTS = 2;

/** cover.png [原型默认]：750×1000（375×500 CSS 像素、DPR 2），≤ 600 KB。 */
export const COVER_WIDTH = 750;
export const COVER_HEIGHT = 1000;
export const COVER_CSS_WIDTH = 375;
export const COVER_CSS_HEIGHT = 500;
export const COVER_DEVICE_SCALE_FACTOR = 2;
export const COVER_MAX_BYTES = 600 * KB;

/** assets/ [原型默认]。 */
export const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
export type AssetExtension = (typeof ASSET_EXTENSIONS)[number];
/** assets/ 下文件名（以及子目录名）的格式。 */
export const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** assets/ 下最多一层子目录。 */
export const ASSET_MAX_SUBDIR_DEPTH = 1;
export const ASSET_MAX_BYTES = 2 * MB;
export const ASSETS_TOTAL_MAX_BYTES = 8 * MB;
export const ASSETS_MAX_COUNT = 20;

// ---------------------------------------------------------------------------
// 渲染（contracts 2.3）[原型默认]
// ---------------------------------------------------------------------------

export const RENDER_VIEWPORT = { width: 375, height: 667 } as const;
/** `load` 超过该时长报 RENDER_SLOW（警告）。 */
export const RENDER_SLOW_MS = 3000;
/** 渲染超时，超过报 RENDER_FAILED。 */
export const RENDER_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// 认证、令牌与有效期（contracts 3、4）
// ---------------------------------------------------------------------------

/** 一次性 token 有效期 [原型默认] 72 小时，`NOWME_AGENT_TOKEN_TTL_HOURS` 可调。 */
export const DEFAULT_AGENT_TOKEN_TTL_HOURS = 72;
/** 页面票据有效期 [原型默认] 30 分钟。 */
export const TICKET_TTL_SECONDS = 30 * 60;
/** 登录验证码：6 位数字，10 分钟，最多 5 次尝试。 */
export const LOGIN_CODE_DIGITS = 6;
export const LOGIN_CODE_TTL_SECONDS = 10 * 60;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** 会话 30 天。 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_COOKIE_NAME = 'nowme_session';
export const CSRF_FIELD_NAME = '_csrf';

/** 每页每日提交上限 [原型默认] 50 次，超出 429 RATE_LIMITED。 */
export const REVISIONS_PER_PAGE_PER_DAY = 50;
/** `POST /api/agent/revisions` 请求体上限 12 MB。 */
export const REVISION_REQUEST_MAX_BYTES = 12 * MB;
/** [T0.2 暂定] Agent API 其他 JSON 请求体上限。 */
export const AGENT_JSON_REQUEST_MAX_BYTES = 64 * KB;

// ---------------------------------------------------------------------------
// 场景、动效、事件（contracts 1.3、6、7）
// ---------------------------------------------------------------------------

export const SCENE_TYPES = ['hackathon', 'interest', 'club', 'general'] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

export const MOTION_LEVELS = ['calm', 'medium', 'lively'] as const;
export type MotionLevel = (typeof MOTION_LEVELS)[number];

/** CLI 通过 `POST /api/agent/events` 上报的 `type`。 */
export const AGENT_EVENT_TYPES = ['fetch', 'validate', 'preview', 'generate', 'submit'] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** 数据库 `events.type` 中 CLI 来源的事件（`agent_` + AgentEventType）。 */
export const STORED_AGENT_EVENT_TYPES = [
  'agent_fetch',
  'agent_validate',
  'agent_preview',
  'agent_generate',
  'agent_submit',
] as const satisfies readonly `agent_${AgentEventType}`[];

/** 主站事件。 */
export const WEB_EVENT_TYPES = [
  'wall_view',
  'page_open',
  'want_to_chat',
  'publish',
  'withdraw',
  'public_link_on',
  'public_link_off',
  'join',
  'leave',
  'member_removed',
  'wall_closed',
] as const;

export const EVENT_TYPES = [...STORED_AGENT_EVENT_TYPES, ...WEB_EVENT_TYPES] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** CLI 上报的事件类型 → 数据库中的事件类型。 */
export function toStoredAgentEventType(type: AgentEventType): `agent_${AgentEventType}` {
  return `agent_${type}`;
}

/** [T0.2 暂定] 事件 `props` 的键数量上限与键名格式（只允许数字与布尔值）。 */
export const EVENT_PROPS_MAX_KEYS = 16;
export const EVENT_PROP_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
