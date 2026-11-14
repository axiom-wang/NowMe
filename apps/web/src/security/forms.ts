/**
 * 改变状态的表单请求（contracts 4.2）：必须是 POST，并同时满足
 * 1. `Origin`（没有 Origin 时看 `Referer`）等于 `NOWME_WEB_ORIGIN` → 否则 403；
 * 2. 有效会话（只认 cookie，**忽略 `Authorization` 头**）→ 否则 401；
 * 3. 表单字段 `_csrf` 与会话一致（常量时间比较）→ 否则 403。
 * 授权（是不是页面主人、组织者）由路由自己检查，不通过一律 404。
 *
 * 只接受 `application/x-www-form-urlencoded` 表单；请求体上限见 FORM_BODY_MAX_BYTES（app.tsx）。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { constantTimeEqual, CSRF_FIELD_NAME } from '@nowme/contracts';
import type { AppDeps, AppEnv, FormFields } from '../context.js';
import { renderError } from '../views/errors.js';
import { onboardingStep } from './session.js';

/** `Origin`（或 `Referer` 的源）是否是主站。两者都没有时拒绝。 */
export function originAllowed(c: Context<AppEnv>, webOrigin: string): boolean {
  const origin = c.req.header('origin');
  if (origin !== undefined) return origin === webOrigin;
  const referer = c.req.header('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === webOrigin;
  } catch {
    return false;
  }
}

/** 解析 urlencoded 表单为字符串字段（同名取最后一个；其他 Content-Type 返回空对象）。 */
export async function readForm(c: Context<AppEnv>): Promise<FormFields> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) return {};
  const body = await c.req.parseBody({ all: true });
  const fields: FormFields = {};
  for (const [key, value] of Object.entries(body)) {
    const last = Array.isArray(value) ? value[value.length - 1] : value;
    if (typeof last === 'string') fields[key] = last;
  }
  return fields;
}

/**
 * 解析 multipart 表单（只用于带图片上传的托管采访，contracts 9）：字符串字段同 `readForm`，
 * `fileField` 的文件按顺序读成字节（空文件忽略）。不是 multipart 时返回空。
 */
export async function readMultipartForm(c: Context<AppEnv>, fileField: string): Promise<{ fields: FormFields; files: Uint8Array[] }> {
  const type = c.req.header('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) return { fields: {}, files: [] };
  const body = await c.req.parseBody({ all: true });
  const fields: FormFields = {};
  const files: Uint8Array[] = [];
  for (const [key, value] of Object.entries(body)) {
    const values = Array.isArray(value) ? value : [value];
    if (key === fileField) {
      for (const item of values) {
        if (typeof item === 'string' || item.size === 0) continue;
        files.push(new Uint8Array(await item.arrayBuffer()));
      }
      continue;
    }
    const last = values[values.length - 1];
    if (typeof last === 'string') fields[key] = last;
  }
  return { fields, files };
}

function forbiddenOrigin(c: Context<AppEnv>) {
  return renderError(c, {
    status: 403,
    title: '请求来源不对',
    message: '为了安全，NOWMe 只接受从本站页面提交的操作。请回到页面重新操作。',
  });
}

/** 登录前的表单（`POST /login`、`/login/verify`）：没有会话，只检查来源并解析表单。 */
export function requireOriginForm(deps: Pick<AppDeps, 'config'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!originAllowed(c, deps.config.webOrigin)) return forbiddenOrigin(c);
    c.set('form', await readForm(c));
    return next();
  };
}

export interface RequireFormOptions {
  /** 允许还没填昵称、还没确认协议的用户（`/welcome`、`/consent`、`/logout`）。 */
  allowMissingNickname?: boolean;
  /** 接受 multipart 表单，文件字段名（文件在 `c.var.uploads`）。 */
  multipartFiles?: string;
}

/** 已登录用户的改变状态的表单（见文件头）。通过后字段在 `c.var.form`。 */
export function requireForm(deps: Pick<AppDeps, 'config'>, options: RequireFormOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!originAllowed(c, deps.config.webOrigin)) return forbiddenOrigin(c);
    const auth = c.get('auth');
    if (!auth) {
      return renderError(c, {
        status: 401,
        title: '需要登录',
        message: '还没有登录，或者登录已过期。请重新登录后再操作。',
        loginLink: true,
      });
    }
    let form: FormFields;
    if (options.multipartFiles) {
      const parsed = await readMultipartForm(c, options.multipartFiles);
      form = parsed.fields;
      c.set('uploads', parsed.files);
    } else {
      form = await readForm(c);
    }
    const csrf = form[CSRF_FIELD_NAME];
    if (!csrf || !constantTimeEqual(csrf, auth.session.csrfToken)) {
      return renderError(c, { status: 403, title: '页面已过期', message: '这个页面已经过期了。请刷新页面后再操作一次。' });
    }
    if (!options.allowMissingNickname) {
      const step = onboardingStep(auth, c.get('demo'));
      if (step) return c.redirect(step === 'welcome' ? '/welcome' : '/consent', 303);
    }
    c.set('form', form);
    return next();
  };
}
