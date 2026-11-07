/** 登录、验证码、首次登录填昵称（W01）。登录前没有会话，这几个表单只做来源检查。 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { LOGIN_CODE_DIGITS, LOGIN_CODE_TTL_SECONDS } from '@nowme/contracts';
import { EMAIL_MAX_LENGTH, NICKNAME_LIMITS } from '../constants.js';
import { CsrfField, Notice } from './forms.js';

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
      <p class="auth__lead">和你自己的 AI Agent 聊几句，它帮你做好一页；你确认之后，才会出现在墙上。</p>
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

export const LoginView: FC<{ next: string; email?: string; error?: string }> = ({ next, email, error }) => (
  <AuthShell step="1 / 2 · 邮箱">
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

export const WelcomeView: FC<{ next: string; csrf: string; nickname?: string; error?: string }> = ({ next, csrf, nickname, error }) => (
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
      <button type="submit" class="btn btn--primary btn--block">
        开始
      </button>
    </form>
  </AuthShell>
);
