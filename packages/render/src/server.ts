/**
 * 本地双源预览服务器（contracts 0.1、4.4、5 S1/S2）。
 *
 * - 外壳：`http://localhost:<shellPort>`，展示沙箱 iframe（见 shell.ts），CSP 用 buildWebCsp；
 * - 页面：`http://127.0.0.1:<pagesPort>`，与页面托管同样的路径：
 *   `/v/<ticket>/`（与 `/v/<ticket>/index.html`）、`/v/<ticket>/assets/*`、`/v/<ticket>/_fonts/*`、`/_nowme/kit/v1/*`，其他 404。
 *   页面文档带 `buildPageCsp({ pagesOrigin, ticket, frameAncestors: 外壳源 })`，所有响应带 PAGE_SECURITY_HEADERS，
 *   字体子集带 `Access-Control-Allow-Origin: *`（沙箱文档是不透明源），不设任何 cookie。
 *
 * 两个服务都只监听 127.0.0.1，并校验 Host 头（外壳只认 `localhost:<port>`，页面只认 `127.0.0.1:<port>`），
 * 保证外壳与页面是两个不同的站点。文件只从内存中的 `served/` 映射查找，不读文件系统（Kit 除外），
 * 因此不存在路径穿越。票据只是占位的随机路径段，不做签名校验（本地预览）。
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PAGE_ASSETS_DIR,
  PAGE_FONTS_DIR,
  PAGE_INDEX_FILE,
  PAGE_SECURITY_HEADERS,
  PAGE_VIEW_PATH_PREFIX,
  buildPageCsp,
  buildWebCsp,
  isSafeRelativePath,
} from '@nowme/contracts';
import { kitFileFromUrl, kitStaticContentType, readKitStaticFile } from '@nowme/kit';
import { SHELL_ASSET_PREFIX, SHELL_CSS, SHELL_JS, shellHtml, shellIndexHtml } from './shell.js';

/** 外壳主机名与页面主机名（contracts 0.1：两个不同的站点）。 */
export const PREVIEW_SHELL_HOST = 'localhost';
export const PREVIEW_PAGES_HOST = '127.0.0.1';
const LISTEN_ADDRESS = '127.0.0.1';

const TICKET_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  woff2: 'font/woff2',
};

function contentTypeOf(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export interface PreviewServerOptions {
  /** 外壳端口；0（默认）为随机空闲端口。`nowme preview --serve` 用 4100。 */
  shellPort?: number;
  /** 页面端口；0（默认）为随机空闲端口。`nowme preview --serve` 用 4101。 */
  pagesPort?: number;
}

export interface PublishOptions {
  /** 占位票据（URL 路径段）；默认随机生成。 */
  ticket?: string;
  /** 外壳标题。 */
  title?: string;
}

export interface PublishedPage {
  ticket: string;
  /** 页面文档地址：`<pagesOrigin>/v/<ticket>/`。 */
  pageUrl: string;
  /** 给主人看的外壳地址：`<shellOrigin>/p/<ticket>`。 */
  shellUrl: string;
  /** 渲染管线用的外壳地址（无边框，iframe 在左上角）：`<shellOrigin>/render/<ticket>`。 */
  renderUrl: string;
}

interface Site {
  files: ReadonlyMap<string, Uint8Array>;
  title?: string;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`端口 ${port} 已被占用：关掉占用它的程序（例如另一个 nowme preview --serve），或用 --port 换一个端口`)
          : error,
      );
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LISTEN_ADDRESS);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** 把请求路径拆成解码后的路径段；含非法转义时返回 null。 */
function pathSegments(req: IncomingMessage): string[] | null {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://placeholder').pathname;
  } catch {
    return null;
  }
  try {
    return pathname.split('/').slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export class PreviewServer {
  readonly shellOrigin: string;
  readonly pagesOrigin: string;
  private readonly sites = new Map<string, Site>();
  private current: string | null = null;

  private constructor(
    private readonly shellServer: Server,
    private readonly pagesServer: Server,
    readonly shellPort: number,
    readonly pagesPort: number,
  ) {
    this.shellOrigin = `http://${PREVIEW_SHELL_HOST}:${shellPort}`;
    this.pagesOrigin = `http://${PREVIEW_PAGES_HOST}:${pagesPort}`;
  }

  /** 启动两个服务。端口被占用时抛出中文错误。 */
  static async start(options: PreviewServerOptions = {}): Promise<PreviewServer> {
    let instance: PreviewServer | null = null;
    const shellServer = createServer((req, res) => instance?.handleShell(req, res));
    const pagesServer = createServer((req, res) => instance?.handlePages(req, res));
    let shellPort: number;
    let pagesPort: number;
    try {
      shellPort = await listen(shellServer, options.shellPort ?? 0);
      pagesPort = await listen(pagesServer, options.pagesPort ?? 0);
    } catch (error) {
      await Promise.all([closeServer(shellServer), closeServer(pagesServer)]);
      throw error;
    }
    instance = new PreviewServer(shellServer, pagesServer, shellPort, pagesPort);
    return instance;
  }

  /** 页面文档的 CSP（与 buildPageCsp 的输出完全一致）。 */
  pageCsp(ticket: string): string {
    return buildPageCsp({ pagesOrigin: this.pagesOrigin, ticket, frameAncestors: this.shellOrigin });
  }

  /** 外壳的 CSP。 */
  shellCsp(): string {
    return buildWebCsp({ pagesOrigin: this.pagesOrigin });
  }

  /** 挂出一份 `served/`（相对路径 → 内容），返回各个地址。最后挂出的页面也是外壳首页 `/` 显示的页面。 */
  publish(files: ReadonlyMap<string, Uint8Array>, options: PublishOptions = {}): PublishedPage {
    const ticket = options.ticket ?? `preview-${randomBytes(12).toString('base64url')}`;
    if (!TICKET_PATTERN.test(ticket)) throw new Error('ticket 只能含字母、数字、下划线与连字符');
    this.sites.set(ticket, { files, title: options.title });
    this.current = ticket;
    return this.urls(ticket);
  }

  /** 撤下一份页面（之后它的地址都返回 404）。 */
  unpublish(ticket: string): void {
    this.sites.delete(ticket);
    if (this.current === ticket) this.current = [...this.sites.keys()].pop() ?? null;
  }

  urls(ticket: string): PublishedPage {
    return {
      ticket,
      pageUrl: `${this.pagesOrigin}${PAGE_VIEW_PATH_PREFIX}${ticket}/`,
      shellUrl: `${this.shellOrigin}/p/${ticket}`,
      renderUrl: `${this.shellOrigin}/render/${ticket}`,
    };
  }

  async close(): Promise<void> {
    this.sites.clear();
    await Promise.all([closeServer(this.shellServer), closeServer(this.pagesServer)]);
  }

  // -------------------------------------------------------------------------

  private send(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: string | Uint8Array,
  ): void {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': String(bytes.byteLength), ...headers });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  private reject(req: IncomingMessage, res: ServerResponse, status: number, base: Record<string, string>): void {
    const messages: Record<number, string> = { 400: '请求不合法', 404: '找不到', 405: '只支持 GET', 421: '主机名不对' };
    this.send(req, res, status, { ...base, 'Content-Type': 'text/plain; charset=utf-8' }, messages[status] ?? '错误');
  }

  private handleShell(req: IncomingMessage, res: ServerResponse): void {
    const base = {
      'Content-Security-Policy': this.shellCsp(),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (req.headers.host !== `${PREVIEW_SHELL_HOST}:${this.shellPort}`) return this.reject(req, res, 421, base);
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.reject(req, res, 405, base);
    const segments = pathSegments(req);
    if (segments === null) return this.reject(req, res, 400, base);
    const path = segments.join('/');
    const html = { ...base, 'Content-Type': 'text/html; charset=utf-8' };
    if (path === '') {
      const site = this.current === null ? undefined : this.sites.get(this.current);
      if (this.current === null || !site) return this.send(req, res, 200, html, shellIndexHtml());
      return this.send(req, res, 200, html, shellHtml({ mode: 'serve', pageUrl: this.urls(this.current).pageUrl, title: site.title }));
    }
    if (path === `${SHELL_ASSET_PREFIX.slice(1)}shell.js`) {
      return this.send(req, res, 200, { ...base, 'Content-Type': 'text/javascript; charset=utf-8' }, SHELL_JS);
    }
    if (path === `${SHELL_ASSET_PREFIX.slice(1)}shell.css`) {
      return this.send(req, res, 200, { ...base, 'Content-Type': 'text/css; charset=utf-8' }, SHELL_CSS);
    }
    const [kind, ticket, ...rest] = segments;
    if ((kind === 'p' || kind === 'render') && ticket !== undefined && rest.length === 0) {
      const site = this.sites.get(ticket);
      if (!site) return this.reject(req, res, 404, base);
      const mode = kind === 'p' ? 'serve' : 'render';
      return this.send(req, res, 200, html, shellHtml({ mode, pageUrl: this.urls(ticket).pageUrl, title: site.title }));
    }
    return this.reject(req, res, 404, base);
  }

  private handlePages(req: IncomingMessage, res: ServerResponse): void {
    const base: Record<string, string> = { ...PAGE_SECURITY_HEADERS };
    if (req.headers.host !== `${PREVIEW_PAGES_HOST}:${this.pagesPort}`) return this.reject(req, res, 421, base);
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.reject(req, res, 405, base);
    const segments = pathSegments(req);
    if (segments === null) return this.reject(req, res, 400, base);

    const kit = kitFileFromUrl(`/${segments.join('/')}`);
    if (kit !== null) {
      return this.send(req, res, 200, { ...base, 'Content-Type': kitStaticContentType(kit) }, readKitStaticFile(kit));
    }

    const [prefix, ticket, ...rest] = segments;
    if (prefix !== PAGE_VIEW_PATH_PREFIX.slice(1, -1) || ticket === undefined || rest.length === 0) return this.reject(req, res, 404, base);
    const site = this.sites.get(ticket);
    if (!site) return this.reject(req, res, 404, base);
    const file = rest.join('/');

    if (file === '' || file === PAGE_INDEX_FILE) {
      const index = site.files.get(PAGE_INDEX_FILE);
      if (!index) return this.reject(req, res, 404, base);
      return this.send(
        req,
        res,
        200,
        { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': this.pageCsp(ticket) },
        index,
      );
    }
    if (!isSafeRelativePath(file)) return this.reject(req, res, 404, base);
    const isAsset = file.startsWith(`${PAGE_ASSETS_DIR}/`);
    const isFont = file.startsWith(`${PAGE_FONTS_DIR}/`) && rest.length === 2;
    const bytes = isAsset || isFont ? site.files.get(file) : undefined;
    if (!bytes) return this.reject(req, res, 404, base);
    const headers: Record<string, string> = { ...base, 'Content-Type': contentTypeOf(file) };
    // 沙箱文档的源是 null：没有 CORS 头时 Chromium 拒绝加载字体（contracts S2）
    if (isFont) headers['Access-Control-Allow-Origin'] = '*';
    return this.send(req, res, 200, headers, bytes);
  }
}

/** 启动预览服务器（`PreviewServer.start` 的简写）。 */
export function startPreviewServer(options: PreviewServerOptions = {}): Promise<PreviewServer> {
  return PreviewServer.start(options);
}
