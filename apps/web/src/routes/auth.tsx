/**
 * 登录与会话（W01、contracts 4.2）。
 *
 * | 路径 | 谁能访问 | 说明 |
 * | --- | --- | --- |
 * | GET /login | 任何人 | 邮箱表单；已登录直接跳到 next |
 * | POST /login | 任何人（来源检查） | 发验证码到 dev outbox，显示输入验证码的表单 |
 * | POST /login/verify | 任何人（来源检查） | 校验验证码 → 新会话 cookie → 跳到 next（首次登录先去 /welcome） |
 * | GET /welcome、POST /welcome | 已登录（POST 需 CSRF） | 首次登录填昵称 |
 * | POST /logout | 已登录（需 CSRF） | 删除会话 |
 * | GET /dev/outbox | 仅非生产环境 | 开发发件箱（代替真实邮件） |
 *
 * `next` 只允许站内相对路径（security/redirect.ts）。
 */
import { DEV_OUTBOX_LIMIT } from '../constants.js';
import type { AppDeps, AppHono } from '../context.js';
import { DEMO_ACCOUNTS, DEMO_WALL_NAME, demoAccountFor } from '../demo-access.js';
import { requireForm, requireOriginForm } from '../security/forms.js';
import { safeNextPath } from '../security/redirect.js';
import { authOf, clearSessionCookie, readSessionToken, setSessionCookie, welcomeRedirectPath } from '../security/session.js';
import {
  createSession,
  destroySession,
  nicknameProblem,
  normalizeEmail,
  requestLoginCode,
  verifyLoginCode,
} from '../services/auth.js';
import { formatDateTime } from '../format.js';
import { LoginView, VerifyView, WelcomeView } from '../views/auth.js';
import { renderPage } from '../views/layout.js';
import { renderNotFound } from '../views/errors.js';

export function registerAuthRoutes(app: AppHono, deps: AppDeps): void {
  const { config } = deps;
  const originForm = requireOriginForm(deps);
  const devOutbox = !config.isProduction && !deps.demo;
  const demoAccounts = deps.demo ? DEMO_ACCOUNTS : undefined;

  app.get('/login', (c) => {
    const next = safeNextPath(c.req.query('next'), config.webOrigin);
    const auth = c.get('auth');
    if (auth && !deps.demo) return c.redirect(auth.user.nickname ? next : welcomeRedirectPath(next, config.webOrigin), 303);
    return renderPage(c, { title: '登录', bodyClass: deps.demo && auth ? 'page--switch' : undefined, body: <LoginView next={next} demoAccounts={demoAccounts} /> });
  });

  if (deps.demo) {
    app.post('/login/demo', originForm, (c) => {
      const form = c.get('form');
      const account = DEMO_ACCOUNTS.find((entry) => entry.identity === form.identity);
      const user = account ? deps.repos.users.findByEmail(account.email) : null;
      const organizer = deps.repos.users.findByEmail(DEMO_ACCOUNTS[1].email);
      const wall = organizer ? deps.repos.walls.findOpenByOrganizerAndName(organizer.id, DEMO_WALL_NAME) : null;
      if (!account || !user || !wall || Object.keys(form).some((key) => key !== 'identity')) {
        return renderPage(c, { title: '体验登录', bodyClass: c.get('auth') ? 'page--switch' : undefined, status: 400, body: <LoginView next="/" demoAccounts={demoAccounts} error="体验登录失败，请重新选择身份；若演示墙不可用，请联系维护者。" /> });
      }
      destroySession(deps, readSessionToken(c));
      setSessionCookie(c, config, createSession(deps, user.id));
      return c.redirect('/', 303);
    });
  }

  app.post('/login', originForm, (c) => {
    const form = c.get('form');
    const next = safeNextPath(form.next, config.webOrigin);
    const email = normalizeEmail(form.email);
    if (deps.demo && (!email || !demoAccountFor(email))) return renderNotFound(c);
    if (!email) {
      return renderPage(c, {
        title: '登录',
        status: 400,
        body: <LoginView next={next} email={form.email} demoAccounts={demoAccounts} error="邮箱格式不对，请检查后再试。" />,
      });
    }
    const result = requestLoginCode(deps, email);
    if (!result.ok) {
      return renderPage(c, {
        title: '输入验证码',
        status: 429,
        body: (
          <VerifyView
            email={email}
            next={next}
            devOutbox={devOutbox}
            error="验证码发送得太频繁了：同一个邮箱 10 分钟内最多发 5 次。请用最近收到的验证码，或稍后再试。"
          />
        ),
      });
    }
    return renderPage(c, { title: '输入验证码', body: <VerifyView email={email} next={next} devOutbox={devOutbox} /> });
  });

  app.post('/login/verify', originForm, (c) => {
    const form = c.get('form');
    const next = safeNextPath(form.next, config.webOrigin);
    const email = normalizeEmail(form.email);
    if (deps.demo && (!email || !demoAccountFor(email))) return renderNotFound(c);
    if (!email) return c.redirect('/login', 303);
    const result = verifyLoginCode(deps, email, form.code);
    if (!result.ok) {
      const error =
        result.reason === 'mismatch'
          ? `验证码不对，还可以再试 ${result.remaining} 次。`
          : result.reason === 'locked'
            ? '验证码错误次数太多，已经失效。请重新获取一个验证码。'
            : '验证码已过期或已失效，请重新获取。';
      return renderPage(c, {
        title: '输入验证码',
        status: 400,
        body: <VerifyView email={email} next={next} devOutbox={devOutbox} error={error} expired={result.reason !== 'mismatch'} />,
      });
    }
    // 登录总是换一个新会话（防会话固定）
    destroySession(deps, readSessionToken(c));
    const session = createSession(deps, result.user.id);
    setSessionCookie(c, config, session);
    return c.redirect(deps.demo ? '/' : result.user.nickname ? next : welcomeRedirectPath(next, config.webOrigin), 303);
  });

  app.get('/welcome', (c) => {
    const auth = c.get('auth');
    const next = safeNextPath(c.req.query('next'), config.webOrigin);
    if (!auth) return c.redirect(`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, 303);
    if (auth.user.nickname) return c.redirect(next, 303);
    return renderPage(c, { title: '欢迎', body: <WelcomeView next={next} csrf={auth.session.csrfToken} /> });
  });

  app.post('/welcome', requireForm(deps, { allowMissingNickname: true }), (c) => {
    const auth = authOf(c);
    const form = c.get('form');
    const next = safeNextPath(form.next, config.webOrigin);
    const nickname = (form.nickname ?? '').trim();
    const problem = nicknameProblem(nickname);
    if (problem) {
      return renderPage(c, {
        title: '欢迎',
        status: 400,
        body: <WelcomeView next={next} csrf={auth.session.csrfToken} nickname={form.nickname} error={problem} />,
      });
    }
    deps.repos.users.setNickname(auth.user.id, nickname);
    return c.redirect(next, 303);
  });

  app.post('/logout', requireForm(deps, { allowMissingNickname: true }), (c) => {
    destroySession(deps, readSessionToken(c));
    clearSessionCookie(c, config);
    return c.redirect('/login', 303);
  });

  if (devOutbox) {
    app.get('/dev/outbox', (c) => {
      const messages = deps.outbox.list(DEV_OUTBOX_LIMIT);
      return renderPage(c, {
        title: '开发发件箱',
        body: (
          <section class="card container container--narrow">
            <p class="eyebrow">仅本地开发</p>
            <h1>开发发件箱</h1>
            <p class="muted">本地开发不发真实邮件：验证码写在这里（以及 .data/outbox.log 和主站控制台）。生产环境没有这个页面。</p>
            {messages.length === 0 ? (
              <p>还没有邮件。</p>
            ) : (
              <ul class="outbox">
                {messages.map((message) => (
                  <li class="outbox__item">
                    <div class="outbox__meta">
                      <strong>{message.to}</strong>
                      <span class="muted">{message.at ? formatDateTime(message.at) : ''}</span>
                    </div>
                    <div class="outbox__subject">{message.subject}</div>
                    <div class="outbox__body">{message.body}</div>
                  </li>
                ))}
              </ul>
            )}
            <p>
              <a href="/login">去登录</a>
            </p>
          </section>
        ),
      });
    });
  }
}
