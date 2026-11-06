/**
 * 引用分类（contracts 1.1）：页面只能引用 `assets/<file>`、Kit（`/_nowme/kit/v1/` 根路径）、
 * `data:image/*`、页内锚点 `#...`、运行时生成的 `blob:`。
 *
 * 用 WHATWG URL 解析（与浏览器一致）：去掉首尾空白与控制字符、删掉 Tab/换行、`\` 视为 `/`、
 * 解析 `.` / `..` / `%2e%2e`，因此 `./assets/x.png` 与 `assets/x.png` 等价，
 * `assets/../x.png`、`/\evil.com`、`//evil` 都能被正确识别。
 */
import { KIT_BASE_PATH } from '@nowme/contracts';

export type RefKind =
  /** 空值：浏览器不会请求。 */
  | 'empty'
  /** `#...` 页内锚点。 */
  | 'fragment'
  /** `assets/` 下的文件（`assetPath` 为解码后的 page/ 内路径）。 */
  | 'asset'
  /** Kit 文件（`kitPath` 为根路径）。 */
  | 'kit'
  | 'data-image'
  /** 字体 data URI（报 FONT_FACE_FORBIDDEN）。 */
  | 'data-font'
  /** 其他 data URI（text/html 等）。 */
  | 'data-other'
  | 'blob'
  /** 带协议或协议相对的地址（http:、https:、//、ws:、file:、javascript: 等）。 */
  | 'external'
  /** 相对路径但不在 assets/ 下，或不是 Kit 的根路径。 */
  | 'outside';

export interface RefInfo {
  kind: RefKind;
  /** 清理后的地址（展示用）。 */
  value: string;
  assetPath?: string;
  kitPath?: string;
  /** 小写协议名（不含冒号），`external` 时给出；协议相对地址为 `//`。 */
  scheme?: string;
  mime?: string;
}

/** 假想的页面地址：`<pages>/v/<ticket>/index.html`。只用于解析相对路径。 */
const PAGE_HOST = 'page.nowme.invalid';
const PAGE_DIR = '/v/ticket/';
const PAGE_BASE = `http://${PAGE_HOST}${PAGE_DIR}index.html`;

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** WHATWG URL：去掉首尾 C0 控制字符与空格；删除所有 Tab 与换行。 */
const LEADING_TRAILING = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;
const TAB_NEWLINE = /[\t\n\r]/g;
/** Kit 路径只允许普通字符（不允许 % 编码，避免托管端二次解码造成路径穿越）。 */
const KIT_PATH_CHARS = /^[A-Za-z0-9._~\-/]+$/;

const FONT_MIME = /^(?:font\/|application\/(?:x-)?font|application\/vnd\.ms-fontobject|application\/x-woff)/;

/**
 * 脚本拼出的 HTML 里，无法静态确定的部分用这个私用区字符占位（见 js.ts 的 staticHtml）。
 * 含占位符的地址只按其静态前缀判断。
 */
export const DYNAMIC_PLACEHOLDER = '\uE000';
/** 占位符在事件属性代码里替换成的标识符（让拼出的代码仍能解析）。 */
export const DYNAMIC_IDENTIFIER = '__nmDynamic__';

/**
 * 含占位符的地址：取静态前缀分类。前缀为空或只是相对路径片段时返回 null（无法判断，不报）；
 * 前缀已带协议或 `//` 主机时按外部地址处理。
 */
export function classifyDynamicRef(raw: string): RefInfo | null {
  const prefix = cleanUrl(raw.split(DYNAMIC_PLACEHOLDER)[0] ?? '');
  if (prefix === '') return null;
  if (/^[\\/]{2}/.test(prefix)) return { kind: 'external', value: `${prefix}…`, scheme: '//' };
  const info = classifyRef(prefix);
  if (info.kind === 'external' || info.kind === 'data-other' || info.kind === 'data-font' || info.kind === 'fragment') {
    return { ...info, value: `${prefix}…` };
  }
  return null;
}

export function cleanUrl(raw: string): string {
  return raw.replace(LEADING_TRAILING, '').replace(TAB_NEWLINE, '');
}

export function classifyRef(raw: string): RefInfo {
  const value = cleanUrl(raw);
  if (value === '') return { kind: 'empty', value };
  if (value.startsWith('#')) return { kind: 'fragment', value };

  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === 'data') {
      const mime = dataUrlMime(value);
      if (mime.startsWith('image/')) return { kind: 'data-image', value, mime };
      if (FONT_MIME.test(mime)) return { kind: 'data-font', value, mime };
      return { kind: 'data-other', value, mime };
    }
    if (scheme === 'blob') return { kind: 'blob', value };
    return { kind: 'external', value, scheme };
  }

  let url: URL;
  try {
    url = new URL(value, PAGE_BASE);
  } catch {
    return { kind: 'outside', value };
  }
  if (url.host !== PAGE_HOST) return { kind: 'external', value, scheme: '//' };

  const path = url.pathname;
  if (path.startsWith(`${PAGE_DIR}assets/`)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path.slice(PAGE_DIR.length));
    } catch {
      return { kind: 'outside', value };
    }
    return { kind: 'asset', value, assetPath: decoded };
  }
  if (path.startsWith(KIT_BASE_PATH) && path.length > KIT_BASE_PATH.length && KIT_PATH_CHARS.test(path)) {
    // 只接受根路径写法（`/_nowme/kit/v1/...`），不接受相对路径碰巧解析到 Kit
    if (value.startsWith('/') && !value.startsWith('//')) return { kind: 'kit', value, kitPath: path };
  }
  return { kind: 'outside', value };
}

/** data URI 的 MIME（小写，不含参数）；缺省为 text/plain。 */
function dataUrlMime(value: string): string {
  const body = value.slice(value.indexOf(':') + 1);
  const comma = body.indexOf(',');
  const header = comma >= 0 ? body.slice(0, comma) : body;
  const mime = (header.split(';')[0] ?? '').trim().toLowerCase();
  return mime === '' ? 'text/plain' : mime;
}

/**
 * 解析 `srcset` / `imagesrcset`（HTML 标准 “parse a srcset attribute” 的 URL 部分）：
 * 候选之间用逗号分隔，URL 是一段非空白字符（data URI 里的逗号属于 URL），其后是描述符。
 */
export function parseSrcset(value: string): string[] {
  const urls: string[] = [];
  const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && (isSpace(value[i]) || value[i] === ',')) i += 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(value[i])) i += 1;
    let url = value.slice(start, i);
    let descriptorsFollow = true;
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      descriptorsFollow = false;
    }
    if (url !== '') urls.push(url);
    if (descriptorsFollow) {
      // 跳过描述符直到不在括号内的逗号
      let depth = 0;
      while (i < n) {
        const ch = value[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
          i += 1;
          break;
        }
        i += 1;
      }
    }
  }
  return urls;
}

/** 外链地址（`data-nm-href`、`nowme.openLink`）是否为 https:。 */
export function isHttpsUrl(raw: string): boolean {
  const value = cleanUrl(raw);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}
