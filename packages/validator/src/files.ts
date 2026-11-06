/**
 * index.html 以外的文件检查：card.json、manifest.json、cover.png、assets/、凭证泄露。
 */
import {
  ASSET_EXTENSIONS,
  ASSET_MAX_BYTES,
  ASSET_NAME_PATTERN,
  ASSETS_MAX_COUNT,
  ASSETS_TOTAL_MAX_BYTES,
  COVER_HEIGHT,
  COVER_MAX_BYTES,
  COVER_WIDTH,
  CREDENTIAL_LIKE_PATTERN,
  PAGE_ASSETS_DIR,
  PAGE_CARD_FILE,
  PAGE_COVER_FILE,
  PAGE_MANIFEST_FILE,
  assetExtensionOf,
  cardSchema,
  checkAssetPath,
  manifestSchema,
  type ValidationIssueCode,
} from '@nowme/contracts';
import { HINTS } from './messages.js';
import type { IssueCollector } from './report.js';
import { LineIndex, clip, decodeLatin1, decodeUtf8Strict } from './text.js';

const KB = 1024;

// ---------------------------------------------------------------------------
// JSON（card.json / manifest.json）
// ---------------------------------------------------------------------------

interface ZodIssueLike {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  keys?: string[];
  values?: unknown[];
  expected?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
}

/** cardSchema / manifestSchema 的结构（避免直接依赖 zod）。 */
interface SafeParser {
  safeParse(value: unknown): { success: boolean; error?: { issues: readonly unknown[] } };
}

const HAS_CJK = /[\u3400-\u9fff]/;
const TYPE_NAMES: Record<string, string> = {
  string: '字符串',
  number: '数字',
  int: '整数',
  boolean: '布尔值',
  array: '数组',
  object: '对象',
};

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

/** zod 的问题描述翻译成中文（schema 里自带中文 message 的直接用）。 */
export function describeZodIssue(issue: ZodIssueLike): string {
  if (HAS_CJK.test(issue.message)) return issue.message;
  switch (issue.code) {
    case 'invalid_type':
      if (/received undefined/.test(issue.message)) return '缺少这个必填字段';
      return `类型不对，应为${TYPE_NAMES[issue.expected ?? ''] ?? issue.expected ?? '其他类型'}`;
    case 'unrecognized_keys':
      return `有不允许的字段：${(issue.keys ?? []).join('、')}`;
    case 'invalid_value':
      return `取值不对，应为 ${(issue.values ?? []).map((value) => JSON.stringify(value)).join(' / ')}`;
    case 'too_small':
      return issue.origin === 'array' ? `至少 ${String(issue.minimum)} 项` : `不能小于 ${String(issue.minimum)}`;
    case 'too_big':
      return issue.origin === 'array' ? `最多 ${String(issue.maximum)} 项` : `不能大于 ${String(issue.maximum)}`;
    case 'invalid_format':
      return '格式不对';
    default:
      return issue.message;
  }
}

/**
 * 解析 JSON 并按 schema 校验。返回解析出的值（不论是否通过 schema），解析失败返回 undefined。
 */
function checkJson(
  file: string,
  bytes: Uint8Array,
  schema: SafeParser,
  code: ValidationIssueCode,
  hint: string,
  issues: IssueCollector,
): { value: unknown; valid: boolean } | undefined {
  const text = decodeUtf8Strict(bytes);
  if (text === null) {
    issues.add(code, file, undefined, `${file} 不是合法的 UTF-8 文本`, hint);
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(message)?.[1];
    const line = position === undefined ? undefined : new LineIndex(text).lineAt(Number(position));
    issues.add(code, file, line, `${file} 不是合法的 JSON：${clip(message, 100)}`, hint);
    return undefined;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of (result.error?.issues ?? []).slice(0, 20) as ZodIssueLike[]) {
      const path = formatPath(issue.path);
      issues.add(code, file, undefined, `${file}${path === '' ? '' : ` 的 ${path}`}：${describeZodIssue(issue)}`, hint);
    }
  }
  return { value, valid: result.success };
}

export function checkCard(bytes: Uint8Array, issues: IssueCollector): void {
  checkJson(PAGE_CARD_FILE, bytes, cardSchema, 'CARD_INVALID', HINTS.card, issues);
}

/** 宽松读取的 manifest（schema 不通过时也尽量取出 fonts / extraChars / blocks 做后续检查）。 */
export interface ManifestInfo {
  fonts: { id: string; weights: number[] }[];
  extraChars: string;
  blocks: string[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readManifestInfo(value: unknown): ManifestInfo | null {
  if (!isRecord(value)) return null;
  const fonts: ManifestInfo['fonts'] = [];
  if (Array.isArray(value.fonts)) {
    for (const font of value.fonts) {
      if (!isRecord(font) || typeof font.id !== 'string') continue;
      const weights = Array.isArray(font.weights) ? font.weights.filter((weight): weight is number => typeof weight === 'number') : [];
      fonts.push({ id: font.id, weights });
    }
  }
  const extraChars = typeof value.extraChars === 'string' ? value.extraChars : '';
  const blocks = Array.isArray(value.blocks) ? value.blocks.filter((block): block is string => typeof block === 'string') : null;
  return { fonts, extraChars, blocks };
}

export function checkManifest(bytes: Uint8Array, issues: IssueCollector): ManifestInfo | null {
  const parsed = checkJson(PAGE_MANIFEST_FILE, bytes, manifestSchema, 'MANIFEST_INVALID', HINTS.manifest, issues);
  return parsed === undefined ? null : readManifestInfo(parsed.value);
}

/** 不报问题，只读出 manifest（computeExtraChars 用）。 */
export function peekManifest(bytes: Uint8Array | undefined): ManifestInfo | null {
  if (!bytes) return null;
  const text = decodeUtf8Strict(bytes);
  if (text === null) return null;
  try {
    return readManifestInfo(JSON.parse(text));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

const ascii = (text: string) => Array.from(text, (ch) => ch.charCodeAt(0));

/** 按魔数判断真实图片格式。 */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  return null;
}

const FORMAT_OF_EXTENSION: Record<(typeof ASSET_EXTENSIONS)[number], ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
};

function readUint32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

export function checkCover(bytes: Uint8Array, issues: IssueCollector): void {
  const file = PAGE_COVER_FILE;
  if (bytes.byteLength > COVER_MAX_BYTES) {
    issues.add('COVER_INVALID', file, undefined, `cover.png 有 ${Math.ceil(bytes.byteLength / KB)} KB，超过上限 ${COVER_MAX_BYTES / KB} KB`, HINTS.cover);
  }
  if (sniffImage(bytes) !== 'png' || bytes.byteLength < 24 || !startsWith(bytes, ascii('IHDR'), 12)) {
    issues.add('COVER_INVALID', file, undefined, 'cover.png 不是有效的 PNG 文件', HINTS.cover);
    return;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width !== COVER_WIDTH || height !== COVER_HEIGHT) {
    issues.add('COVER_INVALID', file, undefined, `cover.png 尺寸是 ${width}×${height}，应为 ${COVER_WIDTH}×${COVER_HEIGHT}`, HINTS.cover);
  }
}

export interface AssetSummary {
  /** assets/ 下所有（会上传的）文件。 */
  paths: string[];
  bytes: number;
  /** 没有其他问题的文件（用于 ASSET_UNUSED）。 */
  clean: Set<string>;
}

export function checkAssets(files: ReadonlyMap<string, Uint8Array>, uploadPaths: readonly string[], issues: IssueCollector): AssetSummary {
  const paths = uploadPaths.filter((path) => path.startsWith(`${PAGE_ASSETS_DIR}/`));
  let total = 0;
  const clean = new Set<string>();
  for (const path of paths) {
    const bytes = files.get(path) as Uint8Array;
    total += bytes.byteLength;
    let ok = true;
    const problem = checkAssetPath(path);
    const segments = path.split('/').slice(1);
    if (problem === 'too-deep') {
      ok = false;
      issues.add('ASSET_NAME_INVALID', path, undefined, `${path} 的目录层数太多：assets/ 下最多一层子目录`, HINTS.assetName);
    }
    if (!segments.every((segment) => ASSET_NAME_PATTERN.test(segment))) {
      ok = false;
      issues.add('ASSET_NAME_INVALID', path, undefined, `${path} 的文件名或目录名不合规`, HINTS.assetName);
    }
    const extension = assetExtensionOf(path.toLowerCase());
    if (extension === null) {
      ok = false;
      const name = segments[segments.length - 1] ?? path;
      const dot = name.lastIndexOf('.');
      const shown = dot > 0 ? name.slice(dot + 1) : '（无扩展名）';
      issues.add('ASSET_TYPE_FORBIDDEN', path, undefined, `${path} 的类型 ${clip(shown, 20)} 不允许放进 assets/`, HINTS.assetType);
    } else {
      const actual = sniffImage(bytes);
      if (actual !== FORMAT_OF_EXTENSION[extension]) {
        ok = false;
        issues.add(
          'ASSET_TYPE_FORBIDDEN',
          path,
          undefined,
          actual === null
            ? `${path} 的内容不是图片（扩展名是 .${extension}，但文件内容不是 ${extension.toUpperCase()}）`
            : `${path} 的扩展名是 .${extension}，实际内容是 ${actual.toUpperCase()}`,
          HINTS.assetType,
        );
      }
    }
    if (bytes.byteLength > ASSET_MAX_BYTES) {
      ok = false;
      issues.add('ASSET_TOO_LARGE', path, undefined, `${path} 有 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，超过单个上限 ${ASSET_MAX_BYTES / 1024 / 1024} MB`, HINTS.assetSize);
    }
    if (ok) clean.add(path);
  }
  if (paths.length > ASSETS_MAX_COUNT) {
    issues.add('ASSETS_TOO_MANY', `${PAGE_ASSETS_DIR}/`, undefined, `assets/ 有 ${paths.length} 个文件，超过上限 ${ASSETS_MAX_COUNT} 个`, HINTS.assetCount);
  }
  if (total > ASSETS_TOTAL_MAX_BYTES) {
    issues.add('ASSET_TOO_LARGE', `${PAGE_ASSETS_DIR}/`, undefined, `assets/ 合计 ${(total / 1024 / 1024).toFixed(1)} MB，超过上限 ${ASSETS_TOTAL_MAX_BYTES / 1024 / 1024} MB`, HINTS.assetSize);
  }
  return { paths, bytes: total, clean };
}

// ---------------------------------------------------------------------------
// 凭证泄露（S4）
// ---------------------------------------------------------------------------

/** 名为 credentials（或 credentials.xxx）的文件。 */
export function isCredentialsFileName(path: string): boolean {
  const base = (path.slice(path.lastIndexOf('/') + 1) || path).toLowerCase();
  return base === 'credentials' || /^credentials\.[a-z0-9]+$/.test(base);
}

const MAX_LEAKS_PER_FILE = 3;

/** 扫描任意文件（二进制按单字节解码）中形如 nmc_ / nmt_ 的凭证。不在报告里输出凭证全文。 */
export function scanCredentials(path: string, bytes: Uint8Array, issues: IssueCollector): void {
  const text = decodeLatin1(bytes);
  if (!text.includes('nmc_') && !text.includes('nmt_')) return;
  const pattern = new RegExp(CREDENTIAL_LIKE_PATTERN.source, 'g');
  const isTextFile = !path.startsWith(`${PAGE_ASSETS_DIR}/`) && path !== PAGE_COVER_FILE;
  let lines: LineIndex | null = null;
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    count += 1;
    if (count > MAX_LEAKS_PER_FILE) break;
    let line: number | undefined;
    if (isTextFile) {
      lines ??= new LineIndex(text);
      line = lines.lineAt(match.index ?? 0);
    }
    const masked = `${match[0].slice(0, 8)}…`;
    issues.add(
      'CREDENTIAL_LEAK',
      path,
      line,
      `${path} 中出现了疑似页面凭证或一次性 token（${masked}）`,
      HINTS.credentialLeak,
      `${match.index ?? 0}`,
    );
  }
}
