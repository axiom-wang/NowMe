/**
 * `page/` 目录的路径白名单（contracts 1、1.4、4.1）。
 *
 * 只有白名单内的路径会被提交；服务端只接受白名单路径，忽略其他路径。
 * 白名单是结构性的：顶层四个文件 + `assets/` 下的任何路径。`assets/` 下的文件名、
 * 扩展名、目录层数是否合规由校验器报 ASSET_NAME_INVALID / ASSET_TYPE_FORBIDDEN（error），
 * 而不是当作“忽略的文件”。
 */
import {
  ASSET_EXTENSIONS,
  ASSET_MAX_SUBDIR_DEPTH,
  ASSET_NAME_PATTERN,
  type AssetExtension,
} from './constants.js';

export const PAGE_INDEX_FILE = 'index.html';
export const PAGE_CARD_FILE = 'card.json';
export const PAGE_MANIFEST_FILE = 'manifest.json';
export const PAGE_COVER_FILE = 'cover.png';
export const PAGE_ASSETS_DIR = 'assets';

/** 必需文件（缺失报 MISSING_FILE）。 */
export const PAGE_REQUIRED_FILES = [PAGE_INDEX_FILE, PAGE_CARD_FILE, PAGE_MANIFEST_FILE] as const;
/** 可提交的顶层文件。 */
export const PAGE_TOP_LEVEL_FILES = [...PAGE_REQUIRED_FILES, PAGE_COVER_FILE] as const;

const TOP_LEVEL_SET: ReadonlySet<string> = new Set(PAGE_TOP_LEVEL_FILES);
const ASSET_EXTENSION_SET: ReadonlySet<string> = new Set(ASSET_EXTENSIONS);

/**
 * 是否是规范的 `page/` 内相对路径：用 `/` 分隔，不以 `/` 开头或结尾，
 * 没有空段、`.`、`..`，不含反斜杠、控制字符、冒号。
 * 校验器、CLI、服务端都应先用它过滤，防止路径穿越。
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  // 控制字符、反斜杠、冒号（Windows 盘符 / NTFS 流）一律拒绝
  if (/[\u0000-\u001f\u007f\\:]/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** 路径是否在提交白名单内（顶层四个文件或 `assets/` 下的任意规范路径）。 */
export function isPageUploadPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  if (TOP_LEVEL_SET.has(path)) return true;
  return path.startsWith(`${PAGE_ASSETS_DIR}/`);
}

export type AssetPathProblem = 'not-asset' | 'unsafe' | 'too-deep' | 'name-invalid' | 'type-forbidden';

/**
 * 检查 `assets/` 下的路径：最多一层子目录，每一段匹配 ASSET_NAME_PATTERN，扩展名在允许列表中。
 * 返回 null 表示合规。
 */
export function checkAssetPath(path: string): AssetPathProblem | null {
  if (!isSafeRelativePath(path)) return 'unsafe';
  const segments = path.split('/');
  if (segments[0] !== PAGE_ASSETS_DIR || segments.length < 2) return 'not-asset';
  const rest = segments.slice(1);
  if (rest.length > ASSET_MAX_SUBDIR_DEPTH + 1) return 'too-deep';
  if (!rest.every((segment) => ASSET_NAME_PATTERN.test(segment))) return 'name-invalid';
  if (assetExtensionOf(path) === null) return 'type-forbidden';
  return null;
}

/** 取允许的资源扩展名（区分大小写，资源文件名本身只允许小写）；不允许时返回 null。 */
export function assetExtensionOf(path: string): AssetExtension | null {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1) : '';
  return ASSET_EXTENSION_SET.has(extension) ? (extension as AssetExtension) : null;
}
