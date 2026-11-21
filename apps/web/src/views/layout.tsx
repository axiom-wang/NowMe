/**
 * 页面布局。hono/jsx 不会自动输出 `<!doctype html>`，这里手动写。
 * 主站 CSP 不允许内联脚本与内联样式：样式和脚本都是 `/static/` 下的外部文件，元素上不要写 `style=` 或 `on*=`。
 *
 * - `page-frame.js` 放在 `<head>` 里同步加载：它要在 iframe 第一次 `load` 之前注册监听（contracts 5.2）。
 * - `app.js` defer：复制按钮（`data-copy`）、危险操作确认（`form[data-confirm]`）、弹出菜单（`details[data-dismissable]`：Esc / 点外面 / 焦点移走即关闭）。
 * - 样式按页加载：每页都有 `app.css`（设计令牌、字体、顶栏 / 页脚、按钮 / 表单 / 卡片 / 便签 / 标签 / 提示 / 步骤 / 空状态 / 弹层），
 *   再加这一页所属的功能包（见 `STYLE_BUNDLES` 与 `styleBundlesFor()`：按路径归类，路由不用逐个声明）。
 * - 所有静态资源都用 `assetUrl()` 生成带内容哈希的 URL（routes/static.ts：带哈希的响应可以长期缓存）。
 *   字体是 `static/` 下提交进仓库的 WOFF2 子集（`pnpm --filter @nowme/web fonts:build` 生成）。
 */
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { AppEnv, SessionAuth } from '../context.js';
import { assetUrl } from '../routes/static.js';
import { CsrfField } from './forms.js';
import { HomeIcon } from './home-icons.js';

/** 功能样式包 → 文件。基础样式 `app.css` 每页都有，不在这里。 */
export const STYLE_BUNDLES = {
  landing: 'landing.css', // 未登录首页
  auth: 'auth.css', // 登录、验证码、昵称、协议确认、加入
  home: 'home.css', // 登录后的“我的”
  wall: 'wall.css', // 墙、成员页、和 TA 聊什么、举报 / 拉黑
  admin: 'admin.css', // 组织者后台、建墙、墙额度
  tools: 'tools.css', // 组织者工具：必答题、筛选、回答标签、群像、完成度（墙与后台共用）
  workspace: 'workspace.css', // 我的页面、采访、生成进度、发布、版本、公开链接
  messages: 'messages.css', // 消息
  account: 'account.css', // 我的资料、AI 设置、点数、注销与导出
} as const;
export type StyleBundle = keyof typeof STYLE_BUNDLES;

/** 按路径（与 bodyClass）判断这一页需要的功能包。 */
export function styleBundlesFor(path: string, bodyClass?: string): StyleBundle[] {
  if (bodyClass === 'page--landing') return ['landing'];
  if (bodyClass === 'page--home') return ['home'];
  if (/^\/(login|welcome|consent|logout)(\/|$)/.test(path) || path === '/dev/outbox') return ['auth'];
  if (/^\/join\//.test(path)) return ['auth'];
  if (/^\/walls(\/new)?$/.test(path) || /^\/w\/[^/]+\/(admin|questions)(\/|$)/.test(path)) return ['admin', 'tools'];
  if (/^\/w\/[^/]+\/(me|leave)(\/|$)/.test(path) || /^\/s\//.test(path)) return ['workspace'];
  if (/^\/w\//.test(path)) return ['wall', 'tools'];
  if (/^\/messages(\/|$)/.test(path)) return ['messages'];
  if (/^\/account\//.test(path)) return ['account'];
  return [];
}

/** 这一页链接的样式表（按顺序）。 */
export function stylesheetsFor(path: string, bodyClass?: string, styles?: StyleBundle[]): string[] {
  return ['app.css', ...(styles ?? styleBundlesFor(path, bodyClass)).map((bundle) => STYLE_BUNDLES[bundle])];
}

export interface LayoutProps {
  title: string;
  origin?: string;
  auth: SessionAuth | null;
  demo?: boolean;
  /** 顶栏 Demo 入口（`NOWME_DEMO_URL`）；null 或演示模式不显示。 */
  demoUrl?: string | null;
  /** 页面主体的额外 class（例如 `page--narrow`）。 */
  bodyClass?: string;
  /** 页面上有生成进度（加载 `progress.js`：SSE 实时进度，退回轮询；contracts 18，不用 meta refresh）。 */
  progress?: boolean;
  /** 请求路径：决定加载哪些样式包、访客顶栏是否显示“登录”。 */
  path?: string;
  /** 指定样式包（不按路径判断）。错误页用 `[]`：404 在任何路径下都必须逐字节相同（contracts S6）。 */
  styles?: StyleBundle[];
}

/** 名字的第一个字（头像占位）。 */
export function initialOf(name: string): string {
  return [...name.trim()][0] ?? '·';
}

/** 字标：NOW + 贴纸样式的 Me。 */
export const Brand: FC = () => (
  <a class="brand" href="/" aria-label="NOWMe">
    <span class="brand__now" aria-hidden="true">
      NOW
    </span>
    <span class="brand__me" aria-hidden="true">
      Me
    </span>
  </a>
);

const Footer: FC = () => (
  <footer class="site-footer">
    <p>
      <span class="site-footer__brand">NOWMe</span> 和 AI 一起，做一页有个性的自己，挂在圈子共同的墙上。
    </p>
    <p class="site-footer__legal">
      <a href="/terms">用户协议</a>
      <span aria-hidden="true"> · </span>
      <a href="/privacy">隐私政策</a>
    </p>
  </footer>
);

const ThemePicker: FC<{ menu?: boolean }> = ({ menu = false }) => (
  <label class="theme-picker">
    <span class={menu ? undefined : 'visually-hidden'}>外观</span>
    <select aria-label="外观" data-theme-picker>
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  </label>
);

/** 主站共用顶栏；访客显示品牌与“登录”，登录后显示导航与账号菜单。 */
export const SiteHeader: FC<{ auth: SessionAuth | null; demo?: boolean; demoUrl?: string | null; active?: 'home' | 'messages' | 'data'; path?: string }> = ({ auth, demo, demoUrl, active, path }) => {
  const demoHref = demoUrl && !demo ? demoUrl : null;
  const showLogin = !auth && !(path ?? '').startsWith('/login');
  return (
  <header class="site-header">
    <div class="site-header__inner">
      <Brand />
      {!auth?.user.nickname ? <ThemePicker /> : null}
      {auth?.user.nickname ? <>
        <nav class="site-nav" aria-label="主导航">
          <a class={`site-nav__link${active === 'home' ? ' is-active' : ''}`} href="/" aria-current={active === 'home' ? 'page' : undefined}>我的</a>
          <a class={`site-nav__link${active === 'messages' ? ' is-active' : ''}`} href="/messages" aria-current={active === 'messages' ? 'page' : undefined}><span>消息</span><span class="message-badge" data-message-unread hidden aria-label="未读消息"></span></a>
          <a class={`site-nav__link${active === 'data' ? ' is-active' : ''}`} href="/account/data" aria-current={active === 'data' ? 'page' : undefined}>我的资料</a>
          {demoHref ? <a class="site-nav__link site-nav__demo" href={demoHref} rel="noopener">Demo</a> : null}
        </nav>
        <details class="account-menu" data-dismissable>
          <summary class="user-chip" aria-label={`账号菜单：${auth.user.nickname}`}><span class="avatar avatar--sm" aria-hidden="true">{auth.user.avatarVersion ? <img src={`/account/avatar?v=${auth.user.avatarVersion}`} alt="" /> : initialOf(auth.user.nickname ?? '')}</span><span class="user-chip__name">{auth.user.nickname}</span><HomeIcon name="chevron" /></summary>
          <div class="popover account-menu__panel">
            <ThemePicker menu />
            {demoHref ? <a class="account-menu__demo" href={demoHref} rel="noopener">Demo</a> : null}
            {!demo ? <a href="/account/credits">点数</a> : null}
            {!demo ? <a href="/account/ai">AI 设置</a> : null}
            {demo ? <a href="/login">切换身份</a> : null}
            <form method="post" action="/logout"><CsrfField token={auth.session.csrfToken} /><button type="submit">退出登录</button></form>
          </div>
        </details>
      </> : demoHref || showLogin ? (
        <div class="site-header__actions">
          {demoHref ? <a class="btn btn--ghost btn--small site-header__demo" href={demoHref} rel="noopener">Demo</a> : null}
          {showLogin ? <a class="btn btn--primary btn--small site-header__login" href="/login">{demo ? '体验' : '登录'}</a> : null}
        </div>
      ) : null}
    </div>
  </header>
  );
};

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, auth, bodyClass, progress, demo, demoUrl, path, styles, origin, children }) => {
  const signedIn = !!auth?.user.nickname;
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content={bodyClass === 'page--conversation' ? 'width=device-width, initial-scale=1, interactive-widget=resizes-content' : 'width=device-width, initial-scale=1'} />
          <meta name="referrer" content="same-origin" />
          <meta name="theme-color" content="#f3f0e8" media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content="#171612" media="(prefers-color-scheme: dark)" />
          <meta name="description" content="和 AI 一起，做一页有个性的自己，认识圈子里的人。" />
          <meta property="og:title" content="NOWMe · 在圈子里，遇见有意思的人" />
          <meta property="og:description" content="和 AI 一起，做一页有个性的自己，挂在圈子共同的墙上。" />
          <meta property="og:type" content="website" />
          <meta property="og:image" content={origin ? new URL(assetUrl('share-card.png'), origin).href : assetUrl('share-card.png')} />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <link rel="icon" type="image/svg+xml" href={assetUrl('favicon.svg')} />
          <title>{title === 'NOWMe' ? title : `${title} · NOWMe`}</title>
          <script src={assetUrl('theme.js')}></script>
          {stylesheetsFor(path ?? '', bodyClass, styles).map((name) => (
            <link rel="stylesheet" href={assetUrl(name)} />
          ))}
          <script src={assetUrl('page-frame.js')}></script>
          <script src={assetUrl('app.js')} defer></script>
          {signedIn ? <script src={assetUrl('messages.js')} defer></script> : null}
          {bodyClass === 'page--create' ? <script src={assetUrl('hosted.js')} defer></script> : null}
          {progress ? <script src={assetUrl('progress.js')} defer></script> : null}
          {bodyClass === 'page--wall' ? <script src={assetUrl('wall.js')} defer></script> : null}
        </head>
        <body class={bodyClass ? `site ${bodyClass}` : 'site'}>
          <a class="skip-link" href="#main">跳到主要内容</a>
          <SiteHeader auth={auth} demo={demo} demoUrl={demoUrl} path={path} active={bodyClass === 'page--data' ? 'data' : bodyClass === 'page--messages' || bodyClass === 'page--conversation' ? 'messages' : bodyClass === 'page--home' ? 'home' : undefined} />
          <main id="main" class="site-main" tabindex={-1}>{children}</main>
          {bodyClass === 'page--landing' ? <Footer /> : null}
        </body>
      </html>
    </>
  );
};

/** 用布局渲染一个页面（读取当前会话以显示账号栏）。 */
export function renderPage(
  c: Context<AppEnv>,
  options: { title: string; body: Child; status?: number; bodyClass?: string; progress?: boolean; styles?: StyleBundle[] },
): Response | Promise<Response> {
  const auth = c.get('auth') ?? null;
  return c.html(
    <Layout title={options.title} origin={new URL(c.req.url).origin} auth={auth} demo={c.get('demo')} demoUrl={c.get('demoUrl')} bodyClass={options.bodyClass} progress={options.progress} path={c.req.path} styles={options.styles}>
      {options.body}
    </Layout>,
    (options.status ?? 200) as 200,
  );
}
