/**
 * 内容安全策略与安全响应头（contracts 5）。
 *
 * - buildPageCsp：页面托管返回用户页面文档时的 CSP（S2）。渲染管线、`nowme preview` 必须用同一个函数。
 * - PAGE_SECURITY_HEADERS：页面托管所有响应都带的安全头（S2）。
 * - buildWebCsp：主站自身的 CSP（第 5 节末尾）。
 */
import { KIT_CSP_PATH, PAGE_FONTS_DIR, PAGE_VIEW_PATH_PREFIX } from './constants.js';

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;

/**
 * 把输入规范化为 `scheme://host[:port]`。只接受 http/https，不允许路径、查询、片段、用户信息。
 * 用于构造 CSP 源表达式，防止注入 `;`、空格、`*` 等。
 */
export function normalizeOrigin(value: string, label = 'origin'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 不是合法的 URL：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} 只能是 http(s) 源：${value}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${label} 只能是源（scheme://host[:port]），不能带路径、查询或用户信息：${value}`);
  }
  // WHATWG URL 允许主机名里出现 `*`、`'` 等字符；CSP 源表达式里它们有特殊含义，必须拒绝。
  if (!HOSTNAME_PATTERN.test(url.hostname)) {
    throw new Error(`${label} 的主机名只能含字母、数字、点、连字符（或 IPv6 字面量）：${value}`);
  }
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  if (trimmed !== url.origin) {
    // 例如大写主机名、默认端口、IDN：要求调用方直接给规范形式，避免同一个源出现两种写法。
    throw new Error(`${label} 不是规范形式，应为 ${url.origin}：${value}`);
  }
  return url.origin;
}

/** 票据（或预览时的占位路径段）只能由 URL 安全字符组成，且不是 `.` / `..`。 */
const PATH_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,256}$/;

export interface PageCspInput {
  /** 页面托管源，例如 `http://127.0.0.1:4000`（预览时为预览页面源）。 */
  pagesOrigin: string;
  /** 当前文档路径 `/v/<ticket>/` 中的票据。 */
  ticket: string;
  /** 允许嵌入页面的源：主站源；预览时为预览外壳源。可以给多个。 */
  frameAncestors: string | readonly string[];
}

/** CSP 指令（有序）。键是指令名，值是源列表。 */
export type CspDirectives = ReadonlyArray<readonly [name: string, values: readonly string[]]>;

export function serializeCsp(directives: CspDirectives): string {
  return directives.map(([name, values]) => [name, ...values].join(' ')).join('; ');
}

/** S2 的页面 CSP 指令（结构化形式，便于测试与渲染管线复用）。 */
export function pageCspDirectives({ pagesOrigin, ticket, frameAncestors }: PageCspInput): CspDirectives {
  const pages = normalizeOrigin(pagesOrigin, 'pagesOrigin');
  if (!PATH_SEGMENT_PATTERN.test(ticket)) {
    throw new Error('ticket 含有不允许的字符');
  }
  const ancestors = (typeof frameAncestors === 'string' ? [frameAncestors] : [...frameAncestors]).map((origin) =>
    normalizeOrigin(origin, 'frameAncestors'),
  );
  if (ancestors.length === 0) {
    throw new Error('frameAncestors 不能为空');
  }

  const kit = `${pages}${KIT_CSP_PATH}`;
  const assets = `${pages}${PAGE_VIEW_PATH_PREFIX}${ticket}/assets/`;
  const fonts = `${pages}${PAGE_VIEW_PATH_PREFIX}${ticket}/${PAGE_FONTS_DIR}/`;
  const images = [assets, kit, 'data:', 'blob:'];

  return [
    ['default-src', ["'none'"]],
    ['script-src', ["'unsafe-inline'", kit]],
    ['style-src', ["'unsafe-inline'", kit]],
    ['img-src', images],
    ['media-src', images],
    ['font-src', [fonts]],
    ['connect-src', ["'none'"]],
    ['form-action', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ancestors],
    ['sandbox', ['allow-scripts']],
  ];
}

/** 页面文档的 `Content-Security-Policy` 头的值（S2）。 */
export function buildPageCsp(input: PageCspInput): string {
  return serializeCsp(pageCspDirectives(input));
}

/**
 * 关闭的浏览器能力。只列 Chromium 能识别的特性名：未知特性名会在控制台产生
 * “Error with Permissions-Policy header: Unrecognized feature” 警告（packages/render 的测试会检查）。
 * 已确认 Chromium 145 不识别 ambient-light-sensor、web-share，因此不列。
 */
export const PERMISSIONS_POLICY_DISABLED_FEATURES = [
  'accelerometer',
  'autoplay',
  'bluetooth',
  'camera',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'hid',
  'identity-credentials-get',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'otp-credentials',
  'payment',
  'picture-in-picture',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'window-management',
  'xr-spatial-tracking',
] as const;

export const PERMISSIONS_POLICY = PERMISSIONS_POLICY_DISABLED_FEATURES.map((feature) => `${feature}=()`).join(', ');

/**
 * 页面托管所有响应都带的安全头（S2）。页面文档另加 `Content-Security-Policy: buildPageCsp(...)`。
 * 页面托管不设置任何 cookie。
 */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': PERMISSIONS_POLICY,
});

export interface WebCspInput {
  /** 页面托管源（预览外壳用预览页面源）。 */
  pagesOrigin: string;
}

/**
 * 主站 CSP 指令（contracts 第 5 节末尾）。主站不用内联脚本和内联样式：脚本与样式都是同源的外部文件，
 * 图片只允许同源与 data:，表单只能提交回主站，只能嵌入页面托管源的 iframe。
 */
export function webCspDirectives({ pagesOrigin }: WebCspInput): CspDirectives {
  const pages = normalizeOrigin(pagesOrigin, 'pagesOrigin');
  return [
    ['default-src', ["'self'"]],
    ['frame-src', [pages]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['img-src', ["'self'", 'data:']],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ];
}

/** 主站（以及 `nowme preview` 外壳）的 `Content-Security-Policy` 头的值。 */
export function buildWebCsp(input: WebCspInput): string {
  return serializeCsp(webCspDirectives(input));
}

/** 解析 CSP 头为 `指令名 → 源列表`（测试与诊断用；重复指令只取第一个，与浏览器一致）。 */
export function parseCsp(header: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...values] = tokens;
    if (!name) continue;
    const key = name.toLowerCase();
    if (!result.has(key)) result.set(key, values);
  }
  return result;
}
