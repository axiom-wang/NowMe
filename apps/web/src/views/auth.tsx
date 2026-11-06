/** 登录、验证码、首次登录填昵称（W01）。登录前没有会话，这几个表单只做来源检查。 */
import type { FC } from 'hono/jsx';
import { LOGIN_CODE_DIGITS, LOGIN_CODE_TTL_SECONDS } from '@nowme/contracts';
import { EMAIL_MAX_LENGTH, NICKNAME_LIMITS } from '../constants.js';
import { CsrfField, Notice } from './forms.js';

export const LoginView: FC<{ next: string; email?: string; error?: string }> = ({ next, email, error }) => (
  <section class="card card--narrow">
    <h1>登录 NOWMe</h1>
    <p class="muted">用邮箱登录，我们会发一个 {LOGIN_CODE_DIGITS} 位验证码给你。第一次登录会自动创建账号。</p>
    {error ? <Notice tone="error">{error}</Notice> : null}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value={next} />
      <label class="field">
        <span class="field__label">邮箱</span>
        <input
          type="email"
          name="email"
          value={email ?? ''}
          required
          autocomplete="email"
          maxlength={EMAIL_MAX_LENGTH}
          placeholder="you@example.com"
        />
      </label>
      <button type="submit" class="btn btn--primary btn--block">
        发送验证码
      </button>
    </form>
  </section>
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
  <section class="card card--narrow">
    <h1>输入验证码</h1>
    <p class="muted">
      验证码已发送到 <strong>{email}</strong>，{LOGIN_CODE_TTL_SECONDS / 60} 分钟内有效。
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
    <form method="post" action="/login" class="stack stack--tight">
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="next" value={next} />
      <button type="submit" class={expired ? 'btn btn--primary btn--block' : 'link-button'}>
        重新发送验证码
      </button>
    </form>
    <p class="muted">
      <a href={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`}>换一个邮箱</a>
    </p>
  </section>
);

export const WelcomeView: FC<{ next: string; csrf: string; nickname?: string; error?: string }> = ({ next, csrf, nickname, error }) => (
  <section class="card card--narrow">
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
      <button type="submit" class="btn btn--primary btn--block">
        开始
      </button>
    </form>
  </section>
);
