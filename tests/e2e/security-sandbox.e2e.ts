/**
 * S1 / S2 浏览器探测：通过真实流程（建墙、加入、指令、Agent API 提交、工作区发布）提交恶意页面，
 * 在工作区预览与成员页的沙箱 iframe 里运行。为通过静态校验，危险调用都在运行时拼接。
 *
 * 断言：读 cookie / localStorage / 改 top.location / window.open / fetch 全部失败或无效；表单与图片信标不出站；
 * 主站 URL 不变；本地探针服务器收不到任何请求；iframe 自我导航被主站拦截（contracts 5.2）；
 * 工作区 iframe 文档的 CSP 等于 buildPageCsp 的输出（S2）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PAGE_IFRAME_SANDBOX, buildPageCsp } from '@nowme/contracts';
import {
  EXAMPLES,
  PAGES_ORIGIN,
  WEB_ORIGIN,
  createWall,
  exchangeToken,
  exampleFiles,
  generateInstruction,
  joinWall,
  newUser,
  openFromWall,
  publishViaUi,
  startProbe,
  submitFiles,
  type Probe,
} from './helpers.js';

const BASE_HTML = readFileSync(join(EXAMPLES, 'hackathon-terminal/index.html'), 'utf8');

/** 把脚本塞进示例页（运行时拼接危险调用，绕开静态校验）。 */
function withScript(script: string): Record<string, string> {
  const files = exampleFiles('hackathon-terminal');
  files['index.html'] = Buffer.from(BASE_HTML.replace('</body>', `<script>${script}</script></body>`), 'utf8').toString('base64');
  return files;
}

function probeScript(probe: Probe): string {
  return `document.addEventListener('click', function () {
  var r = {};
  function d(x) { return x.split('').reverse().join(''); }
  var P = ['http://127.0.0.1:', '${probe.port}', '/x'].join('');
  var W = '${WEB_ORIGIN}/';
  function t(name, fn) { try { var v = fn(); r[name] = v === null ? 'null' : 'ran'; } catch (e) { r[name] = 'blocked'; } }
  t('cookie', function () { return document[d('eikooc')]; });
  t('cookieWrite', function () { document[d('eikooc')] = 'x=1'; });
  t('storage', function () { return window[d('egarotSlacol')].getItem('a'); });
  t('top', function () { top[d('noitacol')] = P + '?top'; });
  t('open', function () { return window[d('nepo')](P + '?open'); });
  t('form', function () {
    var f = document[d('tnemelEetaerc')](d('mrof')); f.action = P + '?form'; f.method = 'post';
    document.body.appendChild(f); f.submit();
  });
  t('img', function () { var i = new Image(); i.src = P + '?img'; });
  var f = window[d('hctef')];
  Promise.all([
    f(P + '?fetch').then(function () { r.fetchProbe = 'ok'; }, function () { r.fetchProbe = 'blocked'; }),
    f(W, { credentials: 'include' }).then(function () { r.fetchWeb = 'ok'; }, function () { r.fetchWeb = 'blocked'; })
  ]).then(function () {
    setTimeout(function () { document.documentElement.setAttribute('data-probe', JSON.stringify(r)); }, 300);
  });
}, { once: true });`;
}

const navScript = (target: string): string =>
  `document.addEventListener('click', function () { setTimeout(function () { var d = function (x) { return x.split('').reverse().join(''); }; var w = window; w[d('noitacol')] = ${target}; }, 100); }, { once: true });`;

/** 页面脚本在第一次点击时才运行（服务端渲染不会点击，所以能通过提交）：在 iframe 里点一下。 */
async function trigger(page: Page): Promise<void> {
  const frame = page.frameLocator('iframe[data-nm-page-frame]');
  await expect(frame.locator('body')).toBeVisible();
  await frame.locator('html').dispatchEvent('click');
}

interface Member {
  page: Page;
  credential: string;
  revisionId: string;
}

/** 新用户加入墙、生成指令、用 Agent API 提交页面文件。 */
async function memberSubmits(browser: Browser, inviteUrl: string, wallId: string, prefix: string, files: Record<string, string>): Promise<Member> {
  const context = await browser.newContext();
  const { page } = await newUser(context, prefix, prefix);
  await joinWall(page, inviteUrl);
  const { token } = await generateInstruction(page, wallId);
  const credential = await exchangeToken(wallId, token);
  const submitted = await submitFiles(credential, files);
  expect(submitted.status, submitted.errors.join('\n')).toBe('accepted');
  return { page, credential, revisionId: submitted.id };
}

test.describe('security：沙箱 iframe 浏览器探测', () => {
  test('security S1 S2：恶意页面在工作区预览与成员页里全部失败，探针收不到请求，CSP 与 buildPageCsp 一致', async ({ browser }) => {
    const probe = await startProbe();
    try {
      const organizer = await newUser(await browser.newContext(), 'sec-org', '组织者');
      const { wallId, inviteUrl } = await createWall(organizer.page, 'security 墙');
      const a = await memberSubmits(browser, inviteUrl, wallId, 'sec-a', withScript(probeScript(probe)));

      // 工作区预览
      const documentResponse = a.page.waitForResponse((response) => response.url().startsWith(`${PAGES_ORIGIN}/v/`) && response.request().resourceType() === 'document');
      await a.page.goto(`/w/${wallId}/me`);
      const workspaceUrl = a.page.url();
      const iframe = a.page.locator('iframe[data-nm-page-frame]');
      await expect(iframe).toHaveAttribute('sandbox', PAGE_IFRAME_SANDBOX);
      const response = await documentResponse;
      const ticket = /\/v\/([^/]+)\//.exec(response.url())?.[1] ?? '';
      expect(response.headers()['content-security-policy']).toBe(buildPageCsp({ pagesOrigin: PAGES_ORIGIN, ticket, frameAncestors: WEB_ORIGIN }));
      expect(response.headers()['set-cookie']).toBeUndefined();

      const check = async (page: Page): Promise<void> => {
        await trigger(page);
        const html = page.frameLocator('iframe[data-nm-page-frame]').locator('html');
        await expect(html).toHaveAttribute('data-probe', /./, { timeout: 15_000 });
        const results = JSON.parse((await html.getAttribute('data-probe')) ?? '{}') as Record<string, string>;
        expect(results.cookie).toBe('blocked');
        expect(results.cookieWrite).toBe('blocked');
        expect(results.storage).toBe('blocked');
        expect(results.top).toBe('blocked');
        expect(['blocked', 'null']).toContain(results.open);
        expect(results.fetchProbe).toBe('blocked');
        expect(results.fetchWeb).toBe('blocked');
      };
      await check(a.page);
      expect(a.page.url()).toBe(workspaceUrl);
      await expect(a.page.locator('[data-nm-page-frame-notice]')).toBeHidden();
      expect(a.page.context().pages().length).toBe(1); // window.open 没有开出新窗口

      // 发布后，同墙成员 B 在成员页里再跑一遍
      await publishViaUi(a.page, wallId, { contactValue: 'sec_a', contactPublic: false });
      const b = await newUser(await browser.newContext(), 'sec-b', '成员B');
      await joinWall(b.page, inviteUrl);
      await b.page.goto(`/w/${wallId}`);
      await openFromWall(b.page, b.page.locator('.wall-card__link').first());
      await expect(b.page.locator('iframe[data-nm-page-frame]')).toHaveAttribute('sandbox', PAGE_IFRAME_SANDBOX);
      const memberUrl = b.page.url();
      await check(b.page);
      expect(b.page.url()).toBe(memberUrl);

      await b.page.waitForTimeout(1000);
      expect(probe.hits, `探针收到了请求：${probe.hits.join(', ')}`).toEqual([]);
    } finally {
      await probe.close();
    }
  });

  test('security 5.2：iframe 自我导航（页面源内其他路径、外部地址）被主站拦截，探针无请求，主站 URL 不变', async ({ browser }) => {
    const probe = await startProbe();
    try {
      const organizer = await newUser(await browser.newContext(), 'sec-nav-org', '组织者');
      const { wallId, inviteUrl } = await createWall(organizer.page, 'security 导航墙');
      const internal = await memberSubmits(browser, inviteUrl, wallId, 'sec-nav-in', withScript(navScript("window[d('noitacol')][d('emanhtap')] + 'elsewhere'")));
      const external = await memberSubmits(browser, inviteUrl, wallId, 'sec-nav-out', withScript(navScript(`['http://127.0.0.1:', '${probe.port}', '/nav'].join('')`)));

      for (const [name, member] of [
        ['页面源内其他路径', internal],
        ['外部地址', external],
      ] as const) {
        await member.page.goto(`/w/${wallId}/me`);
        const url = member.page.url();
        await trigger(member.page);
        await expect(member.page.locator('[data-nm-page-frame-notice]'), name).toBeVisible({ timeout: 15_000 });
        await expect(member.page.locator('[data-nm-page-frame-notice]')).toContainText('已拦截');
        expect(member.page.url(), name).toBe(url);
        await expect(member.page.locator('iframe[data-nm-page-frame]')).toHaveAttribute('sandbox', PAGE_IFRAME_SANDBOX);
      }
      await internal.page.waitForTimeout(500);
      expect(probe.hits, `探针收到了请求：${probe.hits.join(', ')}`).toEqual([]);
    } finally {
      await probe.close();
    }
  });
});
