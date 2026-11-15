/**
 * 登录与会话（W01、contracts 4.2）。
 *
 * | 路径 | 谁能访问 | 说明 |
 * | --- | --- | --- |
 * | GET /login | 任何人 | 邮箱表单；已登录直接跳到 next |
 * | POST /login | 任何人（来源检查） | 把验证码交给发件箱（本地文件或 SMTP），显示输入验证码的表单；发不出去 → 503 并说明 |
 * | POST /login/verify | 任何人（来源检查） | 校验验证码 → 新会话 cookie → 跳到 next（首次登录先去 /welcome） |
 * | GET /welcome、POST /welcome | 已登录（POST 需 CSRF） | 首次登录填昵称，并勾选“已年满 18 岁，同意用户协议和隐私政策”（contracts 16.3） |
 * | GET /consent、POST /consent | 已登录（POST 需 CSRF） | 协议升版本后，老用户重新确认（不影响 /api/） |
 * | POST /logout | 已登录（需 CSRF） | 删除会话 |
 * | GET /dev/outbox | 仅非生产环境 | 开发发件箱（代替真实邮件） |
 *
 * `next` 只允许站内相对路径（security/redirect.ts）。
 */
import { CONSENT_FIELD_NAME, LEGAL_VERSION } from '@nowme/contracts';
import { DEV_OUTBOX_LIMIT, RATE_RULES } from '../constants.js';
import type { AppDeps, AppHono } from '../context.js';
import { DEMO_ACCOUNTS, DEMO_WALL_NAME, demoAccountFor } from '../demo-access.js';
import { clientAddress } from '../security/client.js';
import { requireForm, requireOriginForm } from '../security/forms.js';
import { safeNextPath } from '../security/redirect.js';
import { afterLoginPath, authOf, clearSessionCookie, hasCurrentConsent, readSessionToken, setSessionCookie } from '../security/session.js';
import {
  createSession,
  destroySession,
  nicknameProblem,
  normalizeEmail,
  requestLoginCode,
  verifyLoginCode,
} from '../services/auth.js';
import { formatDateTime } from '../format.js';
import { CONSENT_REQUIRED_TEXT, ConsentView, LoginView, VerifyView, WelcomeView } from '../views/auth.js';
import { renderPage } from '../views/layout.js';
import { renderNotFound } from '../views/errors.js';

/** 限流提示里的“大约几分钟”：向上取整，至少 1 分钟。 */
function waitMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

export function registerAuthRoutes(app: AppHono, deps: AppDeps): void {
  const { config } = deps;
  const originForm = requireOriginForm(deps);
  // 只有本地发件箱（文件 / 内存）才有 /dev/outbox；真实投递时验证码只在用户的邮箱里
  const devOutbox = !config.isProduction && !deps.demo && deps.outbox.inspectable;
  const demoAccounts = deps.demo ? DEMO_ACCOUNTS : undefined;

  app.get('/login', (c) => {
    const next = safeNextPath(c.req.query('next'), config.webOrigin);
    const auth = c.get('auth');
    if (auth && !deps.demo) return c.redirect(afterLoginPath(auth, false, next, config.webOrigin), 303);
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

  app.post('/login', originForm, async (c) => {
    const form = c.get('form');
    const next = safeNextPath(form.next, config.webOrigin);
    const email = normalizeEmail(form.email);
    if (deps.demo && (!email || !demoAccountFor(email))) return renderNotFound(c);
    if (!email) {
      return renderPage(c, {
        title: '登录',
        status: 400,
        body: <LoginView next={next} email={form.email} demoAccounts={demoAccounts} error="这个邮箱格式不对，检查一下有没有写错。" />,
      });
    }
    // 按来源地址：挡住换着邮箱批量让平台发信（按邮箱的限流在 requestLoginCode 里）
    const fromAddress = deps.rateLimiter.hit('login-request', clientAddress(c, config.trustProxyHops), RATE_RULES.loginRequest);
    if (!fromAddress.ok) {
      c.header('Retry-After', String(fromAddress.retryAfterSeconds));
      return renderPage(c, { title: '登录', status: 429, body: <LoginView next={next} email={email} demoAccounts={demoAccounts} error={`这个网络发验证码发得太频繁了，大约 ${waitMinutes(fromAddress.retryAfterSeconds)} 分钟后再试。`} /> });
    }
    const result = await requestLoginCode(deps, email);
    if (!result.ok && result.reason === 'send_failed') {
      return renderPage(c, {
        title: '登录',
        status: 503,
        body: <LoginView next={next} email={email} demoAccounts={demoAccounts} error="验证码邮件暂时发不出去。过几分钟再试一次；一直不行的话，换个邮箱试试。" />,
      });
    }
    if (!result.ok) {
      return renderPage(c, {
        title: '输入验证码',
        status: 429,
        body: (
          <VerifyView
            email={email}
            next={next}
            devOutbox={devOutbox}
            error="这个邮箱发得有点多了（10 分钟内最多 5 次）。先用最近收到的那个验证码，或者过几分钟再试。"
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
    const fromAddress = deps.rateLimiter.hit('login-verify', clientAddress(c, config.trustProxyHops), RATE_RULES.loginVerify);
    if (!fromAddress.ok) {
      c.header('Retry-After', String(fromAddress.retryAfterSeconds));
      return renderPage(c, { title: '输入验证码', status: 429, body: <VerifyView email={email} next={next} devOutbox={devOutbox} error={`这个网络试得太频繁了，大约 ${waitMinutes(fromAddress.retryAfterSeconds)} 分钟后再试。`} /> });
    }
    const result = verifyLoginCode(deps, email, form.code);
    if (!result.ok) {
      const error =
        result.reason === 'mismatch'
          ? `验证码不对，还可以再试 ${result.remaining} 次。`
          : result.reason === 'locked'
            ? '验证码错得太多次，已经失效了。重新获取一个吧。'
            : result.reason === 'suspended'
              ? '这个账号已被停用，暂时不能登录。'
              : '验证码已经过期或失效了，重新获取一个吧。';
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
    return c.redirect(deps.demo ? '/' : afterLoginPath(result, false, next, config.webOrigin), 303);
  });

  app.get('/welcome', (c) => {
    const auth = c.get('auth');
    const next = safeNextPath(c.req.query('next'), config.webOrigin);
    if (!auth) return c.redirect(`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, 303);
    if (auth.user.nickname) return c.redirect(afterLoginPath(auth, !!deps.demo, next, config.webOrigin), 303);
    return renderPage(c, { title: '欢迎', body: <WelcomeView next={next} csrf={auth.session.csrfToken} /> });
  });

  app.post('/welcome', requireForm(deps, { allowMissingNickname: true }), async (c) => {
    const auth = authOf(c);
    const form = c.get('form');
    const next = safeNextPath(form.next, config.webOrigin);
    const nickname = (form.nickname ?? '').trim();
    const fail = (error: string, status: 400 | 422 = 400) =>
      renderPage(c, {
        title: '欢迎',
        status,
        body: <WelcomeView next={next} csrf={auth.session.csrfToken} nickname={form.nickname} agreed={form[CONSENT_FIELD_NAME] === '1'} error={error} />,
      });
    const problem = nicknameProblem(nickname);
    if (problem) return fail(problem);
    if (form[CONSENT_FIELD_NAME] !== '1') return fail(CONSENT_REQUIRED_TEXT);
    const verdict = await deps.contentSafety.checkText('nickname', nickname);
    if (!verdict.ok) return fail(verdict.message, 422);
    deps.repos.users.setNickname(auth.user.id, nickname);
    deps.repos.users.recordConsent(auth.user.id, LEGAL_VERSION, deps.now().toISOString());
    return c.redirect(next, 303);
  });

  // 协议升版本后的重新确认（老用户）：不影响 /api/（Agent API 不加载会话）
  app.get('/consent', (c) => {
    const auth = c.get('auth');
    const next = safeNextPath(c.req.query('next'), config.webOrigin);
    if (!auth) return c.redirect(`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, 303);
    if (!auth.user.nickname || deps.demo || hasCurrentConsent(auth.user)) return c.redirect(afterLoginPath(auth, !!deps.demo, next, config.webOrigin), 303);
    return renderPage(c, { title: '请先确认协议', body: <ConsentView next={next} csrf={auth.session.csrfToken} previousVersion={auth.user.termsVersion ?? null} /> });
  });

  app.post('/consent', requireForm(deps, { allowMissingNickname: true }), (c) => {
    const auth = authOf(c);
    const form = c.get('form');
    const next = safeNextPath(form.next, config.webOrigin);
    if (!auth.user.nickname) return c.redirect('/welcome', 303);
    if (form[CONSENT_FIELD_NAME] !== '1') {
      return renderPage(c, {
        title: '请先确认协议',
        status: 400,
        body: <ConsentView next={next} csrf={auth.session.csrfToken} previousVersion={auth.user.termsVersion ?? null} error={CONSENT_REQUIRED_TEXT} />,
      });
    }
    deps.repos.users.recordConsent(auth.user.id, LEGAL_VERSION, deps.now().toISOString());
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
