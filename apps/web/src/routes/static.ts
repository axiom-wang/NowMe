/**
 * 主站静态文件（`apps/web/static/` → `/static/<文件名>`）：样式与脚本都是外部文件（主站 CSP 不允许内联）。
 * 只提供该目录第一层、文件名合规、扩展名已知的普通文件。
 *
 * 资源指纹：页面里用 `assetUrl('app.css')` 生成 `/static/app.<内容哈希>.css`。
 * - 带哈希且与当前内容一致：`Cache-Control: public, max-age=31536000, immutable`（内容变了 URL 就变）。
 * - 不带哈希（CSS 里的相对引用之外的老链接、用户内容里的默认封面）或哈希已过期（发版瞬间的旧 HTML）：
 *   返回当前内容，`Cache-Control: no-cache`，不会把新内容缓存在旧 URL 下。
 * - CSS 里的 `url('font-display.woff2')` 等相对引用在输出时改写成带哈希的文件名，CSS 的哈希按改写后的内容计算，
 *   所以字体或图片变了，引用它的样式表 URL 也会变。
 * 每次使用都比对文件的修改时间（开发时改了 CSS 刷新即可看到，不用重启）。
 */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_PATH_PREFIX } from '../constants.js';
import type { AppHono } from '../context.js';

/** 本文件位于 `src/routes/` 或 `dist/routes/`，向上两级即包根。 */
export const STATIC_DIR = fileURLToPath(new URL('../../static/', import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

/** 合规的文件名：`<名字>.<扩展名>`，名字只含小写字母、数字、连字符。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.(css|js|svg|png|ico|woff2)$/;
/** 请求路径里的文件名：可以在扩展名前带 10 位十六进制内容哈希。 */
const REQUEST_PATTERN = /^([a-z0-9][a-z0-9-]{0,63})(?:\.([0-9a-f]{10}))?\.(css|js|svg|png|ico|woff2)$/;
/** CSS 里引用同目录文件的 `url(...)`。 */
const CSS_URL_PATTERN = /url\(\s*(['"]?)([a-z0-9][a-z0-9-]{0,63}\.(?:woff2|svg|png|ico))\1\s*\)/g;

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE = 'no-cache';

interface Asset {
  body: Uint8Array;
  hash: string;
  contentType: string;
  /** 文件本身的修改时间与大小。 */
  ownStamp: string;
  /** 样式表引用的同目录文件（它们变了，样式表的输出也要变）。 */
  refs: readonly string[];
  /** ownStamp 加上引用文件的修改时间（变了就重新生成）。 */
  stamp: string;
}

function hashOf(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 10);
}

function stampOf(dir: string, name: string): string | null {
  try {
    const info = statSync(join(dir, name));
    return info.isFile() ? `${info.mtimeMs}:${info.size}` : null;
  } catch {
    return null;
  }
}

export interface StaticAssets {
  /** 读取当前内容（不存在或不合规时返回 null）。 */
  load(name: string): Asset | null;
  /** 带内容哈希的 URL；文件不存在时退回不带哈希的 URL。 */
  url(name: string): string;
}

export function createStaticAssets(dir: string = STATIC_DIR): StaticAssets {
  const cache = new Map<string, Asset>();

  function load(name: string): Asset | null {
    const match = NAME_PATTERN.exec(name);
    if (!match) return null;
    const ext = match[1]!;
    const ownStamp = stampOf(dir, name);
    if (!ownStamp) {
      cache.delete(name);
      return null;
    }
    const cached = cache.get(name);
    if (cached && cached.ownStamp === ownStamp && cached.stamp === stampWithRefs(ownStamp, cached.refs)) return cached;
    let raw: Buffer;
    try {
      raw = readFileSync(join(dir, name));
    } catch {
      return null;
    }
    let body: Uint8Array = new Uint8Array(raw);
    let refs: string[] = [];
    if (ext === 'css') {
      // 样式表只引用字体与图片（CSS_URL_PATTERN 不匹配 .css），不会递归
      refs = [...raw.toString('utf8').matchAll(CSS_URL_PATTERN)].map((m) => m[2]!);
      const text = raw.toString('utf8').replace(CSS_URL_PATTERN, (all, quote: string, ref: string) => {
        const target = load(ref);
        if (!target) return all;
        const [base, extension] = splitName(ref);
        return `url(${quote}${base}.${target.hash}.${extension}${quote})`;
      });
      body = new TextEncoder().encode(text);
    }
    const asset: Asset = { body, hash: hashOf(body), contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream', ownStamp, refs, stamp: stampWithRefs(ownStamp, refs) };
    cache.set(name, asset);
    return asset;
  }

  function stampWithRefs(ownStamp: string, refs: readonly string[]): string {
    return [ownStamp, ...refs.map((ref) => `${ref}=${stampOf(dir, ref) ?? '-'}`)].join('|');
  }

  return {
    load: (name) => load(name),
    url(name) {
      const asset = load(name);
      if (!asset) return `${STATIC_PATH_PREFIX}${name}`;
      const [base, extension] = splitName(name);
      return `${STATIC_PATH_PREFIX}${base}.${asset.hash}.${extension}`;
    },
  };
}

function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return [name.slice(0, dot), name.slice(dot + 1)];
}

/** 进程内共用的一份（布局与静态路由都用它）。 */
export const staticAssets = createStaticAssets();

/** 页面里引用静态文件：`/static/<名字>.<哈希>.<扩展名>`。 */
export function assetUrl(name: string): string {
  return staticAssets.url(name);
}

export function registerStaticRoutes(app: AppHono, assets: StaticAssets = staticAssets): void {
  app.get(`${STATIC_PATH_PREFIX}:name`, (c) => {
    const match = REQUEST_PATTERN.exec(c.req.param('name'));
    if (!match) return c.notFound();
    const [, base, requestedHash, ext] = match;
    const asset = assets.load(`${base}.${ext}`);
    if (!asset) return c.notFound();
    return c.body(asset.body as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': asset.contentType,
      'Cache-Control': requestedHash && requestedHash === asset.hash ? IMMUTABLE_CACHE : REVALIDATE_CACHE,
    });
  });
}
