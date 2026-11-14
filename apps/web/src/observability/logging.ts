/**
 * 结构化日志与请求 ID（contracts 17）。
 *
 * - `createLogger()` 返回与现有注入点 `log(message: string)` 签名兼容的函数：生产环境输出 JSON 行
 *   （time、level、service、msg、reqId），开发环境保持原样的人类可读文本。已有的 log 调用点不用改。
 * - 请求 ID 放在 AsyncLocalStorage 里，同一个请求内的 log 调用自动带上 reqId。
 * - JSON 日志里的邮箱地址与一次性 token 会被打码（开发环境的可读文本保持原样，方便看发件箱），访问日志不含查询串、cookie 与表单内容。
 * - pages-host 有一份结构相同的实现（它不依赖 apps/web）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  /** 兼容现有 `log(message)` 注入点：按文字内容推断级别。 */
  (message: string): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  service: string;
  /** 输出 JSON 行（生产环境）。 */
  json: boolean;
  now?: () => Date;
  /** 测试注入；默认 info 写 stdout、warn / error 写 stderr。 */
  write?: (level: LogLevel, line: string) => void;
}

const requestStore = new AsyncLocalStorage<{ reqId: string }>();

export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.reqId;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const TOKEN_PATTERN = /\b(nmt|nmc|nms)_[A-Za-z0-9_-]{8,}/g;

/** 打码日志文字里的邮箱与一次性 token / 凭证。 */
export function redactText(text: string): string {
  return text.replace(EMAIL_PATTERN, '***@$1').replace(TOKEN_PATTERN, '$1_***');
}

/** 按现有日志文字的措辞推断级别（现有调用点都是单个字符串）。 */
export function inferLevel(message: string): LogLevel {
  if (/未处理的错误|失败|出错|异常|崩溃/.test(message)) return 'error';
  if (/提醒|不可用|警告|上限|拒绝|忽略|rejected|not found/.test(message)) return 'warn';
  return 'info';
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((level: LogLevel, line: string) => {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    });
  function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!options.json) {
      write(level, message);
      return;
    }
    const msg = redactText(message);
    const reqId = currentRequestId();
    // 固定字段放最后，业务字段不能覆盖 time / level / msg
    write(level, JSON.stringify({ ...fields, time: now().toISOString(), level, service: options.service, msg, ...(reqId ? { reqId } : {}) }));
  }
  const logger = ((message: string) => emit(inferLevel(message), message)) as Logger;
  for (const level of ['debug', 'info', 'warn', 'error'] as const) logger[level] = (message, fields) => emit(level, message, fields);
  return logger;
}

/** 注入点可能是普通的 `(message) => void`（测试）：包成 Logger，文字原样交给它。 */
export function asLogger(log: ((message: string) => void) | Logger): Logger {
  if (typeof (log as Logger).info === 'function') return log as Logger;
  return createLogger({ service: 'web', json: false, write: (_level, line) => log(line) });
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** 生成请求 ID；上游传来的 ID 只在 `trustUpstream` 为真且格式合法时沿用。 */
export function resolveRequestId(upstream: string | undefined, trustUpstream: boolean): string {
  if (trustUpstream && upstream !== undefined && REQUEST_ID_PATTERN.test(upstream)) return upstream;
  return randomUUID();
}

/** 命中的最具体路由模板（跳过 `*` 中间件）；没有命中时只保留前两段路径，避免把路径里的标识写进日志。 */
export function routeLabel(c: Context): string {
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i--) {
    const path = routes[i]!.path;
    if (path !== '*' && path !== '/*') return path;
  }
  const segments = c.req.path.split('/').filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.slice(0, 2).join('/')}${segments.length > 2 ? '/…' : ''}`;
}

export interface RequestLoggingOptions {
  logger: Logger;
  /** 声明了 `NOWME_TRUST_PROXY` 才接受上游的 X-Request-Id。 */
  trustUpstreamRequestId: boolean;
  /** 是否写访问日志（生产环境开启；请求 ID 与响应头始终有）。 */
  accessLog: boolean;
  now?: () => number;
}

/** 请求 ID 中间件 + 访问日志：方法、路由模板、状态码、耗时。不记录查询串、cookie、表单内容。 */
export function requestLogging(options: RequestLoggingOptions): MiddlewareHandler {
  const clock = options.now ?? (() => performance.now());
  return async (c, next) => {
    const reqId = resolveRequestId(c.req.header('x-request-id'), options.trustUpstreamRequestId);
    c.header('X-Request-Id', reqId);
    const started = clock();
    await requestStore.run({ reqId }, async () => {
      try {
        await next();
      } finally {
        if (options.accessLog) {
          const status = c.res.status;
          const ms = Math.round(clock() - started);
          const route = routeLabel(c);
          options.logger[status >= 500 ? 'error' : 'info'](`${c.req.method} ${route} ${status} ${ms}ms`, { method: c.req.method, route, status, ms });
        }
      }
    });
  };
}
