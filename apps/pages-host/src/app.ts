/**
 * 页面托管（contracts 4.4、S2）。独立进程、独立源：只做静态托管 + 票据校验 + 安全响应头，
 * 不读主站 cookie、不连数据库、不设任何 cookie，也不读取请求里的 cookie。
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import {
  ASSET_EXTENSIONS,
  KIT_BASE_PATH,
  PAGE_ASSETS_DIR,
  PAGE_FONTS_DIR,
  PAGE_INDEX_FILE,
  PAGE_SECURITY_HEADERS,
  buildPageCsp,
  dataPaths,
  verifyTicket,
  type NowmeConfig,
} from '@nowme/contracts';
import { isKitStaticFile, kitStaticContentType, readKitStaticFile } from '@nowme/kit';

export type PagesHostConfig = Pick<NowmeConfig, 'pagesOrigin' | 'webOrigin' | 'dataDir'> & {
  ticketSecret: string;
};

export interface PagesHostOptions {
  /** 记录拒绝原因（不含完整票据）。默认 console.warn；测试可传空函数。 */
  log?: (message: string) => void;
  /** 注入当前时间（测试用）。 */
  now?: () => Date;
}

const SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const SERVED_DIR = 'served';
const STRICT_NON_HTML_CSP = "default-src 'none'";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 逐段 lstat（不跟随符号链接），最后用 O_NOFOLLOW 打开。返回 null 表示不可用。 */
async function openRegularFile(root: string, segments: readonly string[]) {
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return null;
    }
    if (info.isSymbolicLink()) return null;
    const last = i === segments.length - 1;
    if (last ? !info.isFile() : !info.isDirectory()) return null;
  }
  try {
    const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size };
  } catch {
    return null;
  }
}

export function createPagesApp(config: PagesHostConfig, options: PagesHostOptions = {}): Hono {
  const log = options.log ?? ((message: string) => console.warn(`[pages-host] ${message}`));
  const now = options.now ?? (() => new Date());
  const paths = dataPaths(config.dataDir);
  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) c.header(name, value);
    c.res.headers.delete('Set-Cookie');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', STRICT_NON_HTML_CSP);
    }
  });

  const notFound = (c: Context) => c.text('Not Found', 404, { 'Cache-Control': 'no-store' });

  async function sendFile(
    c: Context,
    root: string,
    segments: readonly string[],
    headers: Record<string, string>,
  ): Promise<Response> {
    const file = await openRegularFile(root, segments);
    if (!file) return notFound(c);
    const base: Record<string, string> = { ...headers, 'Content-Length': String(file.size) };
    if (c.req.method === 'HEAD') {
      await file.handle.close();
      return new Response(null, { status: 200, headers: base });
    }
    const stream = Readable.toWeb(file.handle.createReadStream()) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers: base });
  }

  app.all('*', async (c) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      return c.text('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
    }

    // 用未解码的原始路径；任何含百分号编码、反斜杠、空字节的段都不匹配白名单。
    const url = new URL(c.req.url);
    const rawPath = url.pathname;
    const parts = rawPath.split('/').slice(1);
    const trailingSlash = parts.length > 1 && parts[parts.length - 1] === '';
    const segments = trailingSlash ? parts.slice(0, -1) : parts;

    // Kit：/_nowme/kit/v1/<file>
    if (rawPath.startsWith(KIT_BASE_PATH)) {
      const name = rawPath.slice(KIT_BASE_PATH.length);
      if (!SEGMENT_PATTERN.test(name) || !isKitStaticFile(name)) return notFound(c);
      const body = readKitStaticFile(name);
      return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': kitStaticContentType(name),
          'Content-Length': String(body.length),
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    if (segments[0] !== 'v' || segments.length < 2) return notFound(c);
    const ticket = segments[1]!;
    const rest = segments.slice(2);
    if (!SEGMENT_PATTERN.test(ticket) || !rest.every((segment) => SEGMENT_PATTERN.test(segment))) {
      return notFound(c);
    }

    const verified = verifyTicket(ticket, config.ticketSecret, now());
    if (!verified.ok) {
      log(`ticket rejected: ${verified.reason}`);
      return notFound(c);
    }
    const revisionRoot = paths.revision(verified.revisionId);
    const noStore = { 'Cache-Control': 'no-store' };

    // /v/<ticket> → /v/<ticket>/（相对路径资源需要结尾斜杠）
    if (rest.length === 0 && !trailingSlash) {
      return c.redirect(`${rawPath}/${url.search}`, 308);
    }

    const isIndex =
      (rest.length === 0 && trailingSlash) || (rest.length === 1 && rest[0] === PAGE_INDEX_FILE && !trailingSlash);
    if (isIndex) {
      const csp = buildPageCsp({
        pagesOrigin: config.pagesOrigin,
        ticket,
        frameAncestors: config.webOrigin,
      });
      const response = await sendFile(c, revisionRoot, [SERVED_DIR, PAGE_INDEX_FILE], {
        ...noStore,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
      });
      if (response.status === 404) log(`revision not found: ${verified.revisionId}`);
      return response;
    }
    if (trailingSlash) return notFound(c);

    const [dir, ...tail] = rest;
    if (dir === PAGE_ASSETS_DIR && tail.length >= 1) {
      const ext = extensionOf(tail[tail.length - 1]!);
      const type = IMAGE_TYPES[ext];
      if (!type || !(ASSET_EXTENSIONS as readonly string[]).includes(ext)) return notFound(c);
      return sendFile(c, revisionRoot, [SERVED_DIR, ...rest], { ...noStore, 'Content-Type': type });
    }
    if (dir === PAGE_FONTS_DIR && tail.length === 1) {
      if (extensionOf(tail[0]!) !== 'woff2') return notFound(c);
      return sendFile(c, revisionRoot, [SERVED_DIR, ...rest], {
        ...noStore,
        'Content-Type': 'font/woff2',
        'Access-Control-Allow-Origin': '*',
      });
    }
    return notFound(c);
  });

  return app;
}

/** 兼容 T0.2 的名字。 */
export const createApp = createPagesApp;
