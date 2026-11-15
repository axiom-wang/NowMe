/**
 * 无障碍（T8.10）的服务端渲染约定：跳到主要内容、landmark、表单控件的 autocomplete 与错误关联、
 * 弹出菜单的脚本约定、页面 iframe 的 title。完整的浏览器检查（对比度、焦点、点击区域、溢出）在 tests/e2e/a11y.e2e.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE_IFRAME_SANDBOX } from '@nowme/contracts';
import { createTestWeb, get, latestCode, login, postForm, seedWall, type TestWeb } from './helpers.js';
import { jsx } from 'hono/jsx';
import { PageFrame } from '../src/views/page-frame.js';

describe('无障碍：服务端渲染约定', () => {
  let t: TestWeb;
  beforeEach(() => {
    t = createTestWeb();
  });
  afterEach(async () => {
    await t.close();
  });

  it('每个页面第一个可聚焦元素是“跳到主要内容”，目标是带 id 的 main；顶栏导航有名称', async () => {
    const me = await login(t, 'a11y@example.com', '无障碍');
    const { wall } = seedWall(t, me.userId, '无障碍墙');
    for (const [path, cookie] of [['/login', undefined], ['/terms', undefined], ['/does-not-exist', undefined], ['/', me.cookie], [`/w/${wall.id}`, me.cookie], ['/account/data', me.cookie]] as const) {
      const html = await (await get(t, path, { cookie })).text();
      const firstLink = /<a [^>]*href="([^"]*)"/.exec(html);
      expect(firstLink?.[0], path).toContain('class="skip-link"');
      expect(firstLink?.[1], path).toBe('#main');
      expect(html, path).toMatch(/<main id="main" class="site-main" tabindex="-1">/);
      expect(html.match(/<h1[\s>]/g)?.length, `${path} 恰好一个 h1`).toBe(1);
    }
    const signedIn = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(signedIn).toContain('<nav class="site-nav" aria-label="主导航">');
  });

  it('登录：邮箱 autocomplete；格式错误时输入框 aria-invalid 并用 aria-describedby 指向错误提示', async () => {
    const page = await (await get(t, '/login')).text();
    expect(page).toMatch(/<input[^>]*type="email"[^>]*autocomplete="email"/);
    expect(page).not.toContain('aria-invalid');
    const bad = await (await postForm(t, '/login', { email: 'nope' })).text();
    expect(bad).toMatch(/<p class="notice notice--error" id="login-error" role="alert">/);
    expect(bad).toMatch(/<input[^>]*type="email"[^>]*aria-invalid="true"[^>]*aria-describedby="login-error"/);
  });

  it('验证码：one-time-code、numeric；输错后关联错误提示', async () => {
    await postForm(t, '/login', { email: 'code@example.com' });
    const verifyPage = await (await postForm(t, '/login', { email: 'code@example.com' })).text();
    expect(verifyPage).toMatch(/<input[^>]*name="code"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"/);
    const wrong = latestCode(t, 'code@example.com') === '000000' ? '111111' : '000000';
    const failed = await (await postForm(t, '/login/verify', { email: 'code@example.com', code: wrong })).text();
    expect(failed).toContain('id="verify-error"');
    expect(failed).toMatch(/<input[^>]*name="code"[^>]*aria-invalid="true"[^>]*aria-describedby="verify-error"/);
  });

  it('欢迎页：昵称 autocomplete；昵称有问题时标出来，勾选框只在没勾选时标记', async () => {
    await postForm(t, '/login', { email: 'welcome@example.com' });
    const verified = await postForm(t, '/login/verify', { email: 'welcome@example.com', code: latestCode(t, 'welcome@example.com') });
    const cookie = verified.headers.getSetCookie()[0]!.split(';')[0]!;
    const page = await (await get(t, '/welcome', { cookie })).text();
    expect(page).toMatch(/<input[^>]*name="nickname"[^>]*autocomplete="nickname"/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
    const noConsent = await (await postForm(t, '/welcome', { _csrf: csrf, nickname: '小明' }, { cookie })).text();
    expect(noConsent).toMatch(/type="checkbox"[^>]*aria-invalid="true"[^>]*aria-describedby="welcome-error"/);
    expect(noConsent).not.toMatch(/name="nickname"[^>]*aria-invalid/);
    expect(noConsent).toContain('在新标签页打开');
  });

  it('弹出菜单（账号菜单）带 data-dismissable，app.js 负责 Esc、点外面与焦点移走时关闭', async () => {
    const me = await login(t, 'menu@example.com', '菜单');
    const html = await (await get(t, '/', { cookie: me.cookie })).text();
    expect(html).toContain('<details class="account-menu" data-dismissable="true">');
    const appJs = await (await get(t, '/static/app.js')).text();
    expect(appJs).toContain("details[data-dismissable]");
    expect(appJs).toContain("event.key !== 'Escape'");
    expect(appJs).toContain("addEventListener('focusin'");
  });

  it('展示用户页面的 iframe 有 title，sandbox 仍然只是 allow-scripts', () => {
    const html = String(jsx(PageFrame, { ticket: { src: 'http://127.0.0.1:4200/v/abc/' } as never, title: '林舟的页面' }));
    expect(html).toMatch(/<iframe[^>]*title="林舟的页面"/);
    expect(html).toContain(`sandbox="${PAGE_IFRAME_SANDBOX}"`);
    expect(PAGE_IFRAME_SANDBOX).toBe('allow-scripts');
  });
});
