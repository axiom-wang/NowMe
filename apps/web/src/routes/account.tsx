/**
 * 注销账号与导出数据（contracts 14、S11）。全部只作用于当前会话的用户；POST 需要会话 + CSRF + Origin，
 * 忽略 `Authorization` 头（页面凭证在这里无效）。演示模式没有这些路由（演示账号是大家共用的）。
 *
 * | 路径 | 作用 |
 * | --- | --- |
 * | GET /account/export | 下载 zip（按用户限流 `RATE_RULES.accountExport`） |
 * | GET /account/delete | 说明后果；还是开放墙的组织者时只提示先关闭墙 |
 * | POST /account/delete/code | 向账号邮箱发注销确认码，显示输入框 |
 * | POST /account/delete | `code` + `confirm=1`：校验并注销，清除 cookie，显示结果页 |
 */
import type { Context } from 'hono';
import { RATE_RULES } from '../constants.js';
import type { AppDeps, AppEnv, AppHono } from '../context.js';
import { requireForm } from '../security/forms.js';
import { authOf, clearSessionCookie, requireUser } from '../security/session.js';
import { deleteAccount, requestDeletionCode, wallsBlockingDeletion } from '../services/account-deletion.js';
import { buildAccountExport } from '../services/account-export.js';
import { AccountDeletedView, AccountDeleteView, type AccountDeleteViewProps } from '../views/account.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';

const BLOCKED_ERROR = '你还是一些墙的组织者。先把这些墙关闭，才能注销账号。';

export function registerAccountRoutes(app: AppHono, deps: AppDeps): void {
  if (deps.demo) return;
  const user = requireUser(deps);
  const form = requireForm(deps);

  const render = (c: Context<AppEnv>, props: Omit<AccountDeleteViewProps, 'csrf' | 'email' | 'blocking'>, status: 200 | 400 | 409 | 429 | 503 = 200) => {
    const auth = authOf(c);
    return renderPage(c, {
      title: '注销账号',
      status,
      body: <AccountDeleteView csrf={auth.session.csrfToken} email={auth.user.email} blocking={wallsBlockingDeletion(deps, auth.user.id)} {...props} />,
    });
  };

  app.get('/account/export', user, async (c) => {
    const auth = authOf(c);
    const limit = deps.rateLimiter.hit('account-export', auth.user.id, RATE_RULES.accountExport);
    if (!limit.ok) {
      c.header('Retry-After', String(limit.retryAfterSeconds));
      return renderPage(c, {
        title: '导出我的数据',
        status: 429,
        body: (
          <section class="card container container--narrow">
            <h1>导出得有点频繁</h1>
            <p>
              一小时内最多导出 {RATE_RULES.accountExport.max} 次，这一小时的次数用完了。大约 {Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} 分钟后可以再导出。
            </p>
            <p>
              <a href="/account/data">回到我的资料</a>
            </p>
          </section>
        ),
      });
    }
    const exported = await buildAccountExport(deps, auth.user.id);
    if (!exported) return renderNotFound(c);
    return c.body(new Uint8Array(exported.zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${exported.fileName}"`,
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/account/delete', user, (c) => render(c, { stage: 'intro' }));

  app.post('/account/delete/code', form, async (c) => {
    const result = await requestDeletionCode(deps, authOf(c).user.id);
    if (result.ok) return render(c, { stage: 'code', notice: '确认码已经发到你的邮箱，10 分钟内有效。' });
    switch (result.reason) {
      case 'organizer':
        return render(c, { stage: 'intro', error: BLOCKED_ERROR }, 409);
      case 'rate_limited':
        return render(c, { stage: 'code', error: '确认码发得有点多：同一个邮箱 10 分钟内最多发 5 次（登录验证码也算在内）。先用最近收到的那个，或者过几分钟再来。' }, 429);
      case 'send_failed':
        return render(c, { stage: 'intro', error: '确认码邮件暂时发不出去。过几分钟再试一次。' }, 503);
      case 'gone':
        return renderNotFound(c);
    }
  });

  app.post('/account/delete', form, async (c) => {
    const auth = authOf(c);
    const fields = c.get('form');
    if (fields.confirm !== '1') return render(c, { stage: 'code', error: '请先勾选“我明白注销后所有内容都会删除，不能恢复”。' }, 400);
    const result = await deleteAccount(deps, auth.user.id, fields.code);
    if (!result.ok) {
      switch (result.reason) {
        case 'organizer':
          return render(c, { stage: 'intro', error: BLOCKED_ERROR }, 409);
        case 'mismatch':
          return render(c, { stage: 'code', error: `确认码不对，还可以再试 ${result.remaining} 次。` }, 400);
        case 'locked':
          return render(c, { stage: 'intro', error: '确认码错得太多次，已经失效了。重新发一个吧。' }, 400);
        case 'no_code':
          return render(c, { stage: 'intro', error: '确认码已经过期或失效了。重新发一个吧。' }, 400);
        case 'gone':
          return renderNotFound(c);
      }
    }
    clearSessionCookie(c, deps.config);
    c.set('auth', null);
    return renderPage(c, { title: '账号已注销', body: <AccountDeletedView /> });
  });
}
