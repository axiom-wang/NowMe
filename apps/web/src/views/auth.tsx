/** 登录、验证码、首次登录填昵称（W01）。登录前没有会话，这几个表单只做来源检查。 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { CONSENT_FIELD_NAME, LEGAL_VERSION, LOGIN_CODE_DIGITS, LOGIN_CODE_TTL_SECONDS, MIN_USER_AGE } from '@nowme/contracts';
import { EMAIL_MAX_LENGTH, NICKNAME_LIMITS } from '../constants.js';
import { CsrfField, Notice } from './forms.js';
import { DEMO_ACCOUNTS } from '../demo-access.js';

/** 登录前后几步共用的外壳：左边是品牌介绍（桌面端），右边是表单卡片。 */
const AuthShell: FC<PropsWithChildren<{ step: string }>> = ({ step, children }) => (
  <div class="auth">
    <aside class="auth__hero">
      <p class="eyebrow eyebrow--on-dark">NOWMe · 社区墙</p>
      <p class="auth__slogan display">
        刚进新圈子？
        <br />
        做一页<mark>有个性</mark>的自己，
        <br />
        挂上大家的墙。
      </p>
      <p class="auth__lead">和 AI 聊几句，它帮你做好一页；你确认之后，才会挂上墙。</p>
      <ul class="auth__stickers" aria-hidden="true">
        <li class="sticker sticker--lime">找一位会做视觉的队友</li>
        <li class="sticker sticker--paper">周末一起逛二手唱片店</li>
        <li class="sticker sticker--orange">想聊这个 →</li>
      </ul>
    </aside>
    <section class="card auth__card">
      <p class="auth__step">{step}</p>
      {children}
    </section>
  </div>
);

interface LoginProps { next: string; email?: string; error?: string; demoAccounts?: typeof DEMO_ACCOUNTS }

const EmailLogin: FC<Pick<LoginProps, 'next' | 'email' | 'error'>> = ({ next, email, error }) => (
  <>
    <p class="muted">用邮箱登录，我们会发一个 {LOGIN_CODE_DIGITS} 位验证码给你。第一次登录会自动创建账号。</p>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value={next} />
      <label class="field">
        <span class="field__label">邮箱</span>
        <input type="email" name="email" value={email ?? ''} required autocomplete="email" maxlength={EMAIL_MAX_LENGTH} placeholder="you@example.com" />
      </label>
      <button type="submit" class="btn btn--primary btn--block">发送验证码</button>
    </form>
  </>
);

export const DemoLogin: FC = () => (
  <section class="demo-login" aria-label="黑客松体验登录">
    <p class="muted">无需邮箱、验证码或注册。选择身份即可进入；切换身份会替换当前会话。墙上其他人物与示例页为背景内容。</p>
    <div class="stack">
      {DEMO_ACCOUNTS.map((account) => (
        <form method="post" action="/login/demo" class="demo-login__account" data-demo-login="1">
          <input type="hidden" name="identity" value={account.identity} />
          <button type="submit" class="btn btn--primary btn--block">{account.label}</button>
          <p class="muted demo-login__description">{account.description}</p>
          <p role="alert" data-demo-error hidden></p>
        </form>
      ))}
    </div>
  </section>
);

export const LoginView: FC<LoginProps> = ({ next, email, error, demoAccounts }) => (
  <AuthShell step={demoAccounts ? '黑客松 · 评审体验' : '1 / 2 · 邮箱'}>
    <h1>{demoAccounts ? '体验 NOWMe' : '登录 NOWMe'}</h1>
    {demoAccounts ? <>{error ? <Notice tone="error">{error}</Notice> : null}<DemoLogin /></> : <EmailLogin next={next} email={email} error={error} />}
  </AuthShell>
);

export interface VerifyViewProps {
  email: string;
  next: string;
  error?: string;
  /** 验证码已失效（过期、次数用完），需要重新获取。 */
  expired?: boolean;
  /** 非生产环境显示 /dev/outbox 入口。 */
  devOutbox: boolean;
}

export const VerifyView: FC<VerifyViewProps> = ({ email, next, error, expired, devOutbox }) => (
  <AuthShell step="2 / 2 · 验证码">
    <h1>输入验证码</h1>
    <p class="muted">
      验证码已发送到 <strong>{email}</strong>，{LOGIN_CODE_TTL_SECONDS / 60} 分钟内有效。没收到的话，看看垃圾邮件箱。
    </p>
    {devOutbox ? (
      <Notice tone="info">
        本地开发不会发真实邮件：到 <a href="/dev/outbox">开发发件箱</a> 查看验证码。
      </Notice>
    ) : null}
    {error ? <Notice tone="error">{error}</Notice> : null}
    {expired ? null : (
      <form method="post" action="/login/verify" class="stack">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={next} />
        <label class="field">
          <span class="field__label">{LOGIN_CODE_DIGITS} 位验证码</span>
          <input
            type="text"
            name="code"
            required
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern={`\\d{${LOGIN_CODE_DIGITS}}`}
            maxlength={LOGIN_CODE_DIGITS}
            class="input--code"
          />
        </label>
        <button type="submit" class="btn btn--primary btn--block">
          登录
        </button>
      </form>
    )}
    <form method="post" action="/login" class="stack stack--tight auth__resend">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" class={expired ? 'btn btn--primary btn--block' : 'link-button'}>
        重新发送验证码
      </button>
    </form>
    <p class="auth__alt">
      <a href={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`}>换一个邮箱</a>
    </p>
  </AuthShell>
);

export const CONSENT_REQUIRED_TEXT = `请先勾选“我已年满 ${MIN_USER_AGE} 岁，并同意《用户协议》和《隐私政策》”，才能继续。`;

/** 年龄与协议勾选框（欢迎页与重新确认页共用）：必选，条款在新标签页打开。 */
const ConsentCheck: FC<{ checked?: boolean }> = ({ checked }) => (
  <label class="check check--strong">
    <input type="checkbox" name={CONSENT_FIELD_NAME} value="1" required checked={checked} />
    <span>
      我已年满 {MIN_USER_AGE} 岁，并同意
      <a href="/terms" target="_blank" rel="noopener">《用户协议》</a>
      和
      <a href="/privacy" target="_blank" rel="noopener">《隐私政策》</a>
    </span>
  </label>
);

export const WelcomeView: FC<{ next: string; csrf: string; nickname?: string; agreed?: boolean; error?: string }> = ({ next, csrf, nickname, agreed, error }) => (
  <AuthShell step="最后一步 · 昵称">
    <h1>欢迎来到 NOWMe</h1>
    <p class="muted">先起一个昵称。组织者和墙上的其他成员会看到它。</p>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <form method="post" action="/welcome" class="stack">
      <CsrfField token={csrf} />
      <input type="hidden" name="next" value={next} />
      <label class="field">
        <span class="field__label">昵称</span>
        <input type="text" name="nickname" value={nickname ?? ''} required maxlength={NICKNAME_LIMITS.max * 2} autocomplete="nickname" />
      </label>
      <ConsentCheck checked={agreed} />
      <button type="submit" class="btn btn--primary btn--block">
        进入 NOWMe
      </button>
    </form>
  </AuthShell>
);

/** 协议升版本后，老用户下次登录看到的确认页（contracts 16.3）。 */
export const ConsentView: FC<{ next: string; csrf: string; previousVersion: string | null; error?: string }> = ({ next, csrf, previousVersion, error }) => (
  <AuthShell step="需要你确认一下">
    <h1>我们更新了协议</h1>
    <p class="muted">
      {previousVersion ? `《用户协议》和《隐私政策》更新到了 ${LEGAL_VERSION} 版。` : `使用 NOWMe 前，需要你确认《用户协议》和《隐私政策》（${LEGAL_VERSION} 版）。`}
      确认之后就能继续使用，你的页面和资料不受影响。
    </p>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <form method="post" action="/consent" class="stack">
      <CsrfField token={csrf} />
      <input type="hidden" name="next" value={next} />
      <ConsentCheck />
      <button type="submit" class="btn btn--primary btn--block">
        确认并继续
      </button>
    </form>
    <form method="post" action="/logout" class="stack stack--tight auth__resend">
      <CsrfField token={csrf} />
      <button type="submit" class="link-button">
        不同意，退出登录
      </button>
    </form>
  </AuthShell>
);
