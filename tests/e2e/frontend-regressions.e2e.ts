import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { createWall, latestCode, newUser, uniqueEmail } from './helpers.js';

async function fixture(page: Page, html: string, script?: string) {
  await page.route('**/__frontend_fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('/__frontend_fixture');
  if (script) await loadScript(page, script);
}
const loadScript = (page: Page, name: string) => page.addScriptTag({ path: resolve('apps/web/static', name) });

test('复制连点、失败再成功，都恢复最初按钮文字', async ({ page }) => {
  await fixture(page, '<pre id="copy">要复制的文字</pre><button data-copy="copy">复制指令</button>');
  await page.clock.install();
  await page.evaluate(() => {
    let fail = false;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { if (fail) throw new Error('denied'); } } });
    Object.assign(window, { failCopy: (value: boolean) => { fail = value; } });
  });
  await loadScript(page, 'app.js');
  const button = page.locator('button');
  await button.click(); await expect(button).toHaveText('已复制');
  await button.click(); await page.clock.runFor(1600);
  await expect(button).toHaveText('复制指令');
  await page.evaluate(() => (window as any).failCopy(true));
  await button.click(); await expect(button).toHaveText('请手动复制');
  await page.evaluate(() => (window as any).failCopy(false));
  await button.click(); await expect(button).toHaveText('已复制');
  await page.clock.runFor(1600); await expect(button).toHaveText('复制指令');
});

test('普通页面未读数每 30 秒刷新，401 后停止，隐藏时暂停', async ({ page }) => {
  let calls = 0;
  await page.route('**/messages/unread', route => { calls++; return route.fulfill({ status: calls > 1 ? 401 : 200, json: { unread: 2 } }); });
  await fixture(page, '<span data-message-unread></span>');
  await page.clock.install();
  await loadScript(page, 'messages.js');
  await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(10000); expect(calls).toBe(1);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await page.clock.runFor(30000); expect(calls).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => calls).toBe(2);
  await page.clock.runFor(90000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(calls).toBe(2);
});

for (const status of [401, 404]) test(`进度轮询 ${status} 明确结束并提供可用出口`, async ({ page }) => {
  let calls = 0;
  await page.route('**/job/status', route => { calls++; return route.fulfill({ status, body: '' }); });
  await fixture(page, '<div data-job-progress data-status="/job/status" data-poll-ms="3000"><p data-progress-label>正在做</p><ol><li data-step="generating" class="progress__step--current" aria-current="step"></li></ol><p class="job-progress__hint">等待</p></div>');
  await page.clock.install();
  await page.evaluate(() => { Object.defineProperty(window, 'EventSource', { value: undefined }); });
  await loadScript(page, 'progress.js');
  await expect(page.locator('[data-progress-label]')).toContainText(status === 401 ? '登录已经过期' : '无法访问');
  await expect(page.getByRole('link')).toHaveAttribute('href', status === 401 ? /\/login\?next=/ : '/');
  await expect(page.locator('[aria-current="step"]')).toHaveCount(0);
  await page.clock.runFor(60000); expect(calls).toBe(1);
});

test('进度临时故障仍会重试恢复', async ({ page }) => {
  let calls = 0;
  await page.route('**/job/status', route => { calls++; return route.fulfill(calls === 1 ? { status: 503 } : { json: { label: '恢复生成', step: 'generating', done: false } }); });
  await fixture(page, '<div data-job-progress data-status="/job/status" data-poll-ms="3000"><p data-progress-label></p></div>');
  await page.clock.install();
  await page.evaluate(() => { Object.defineProperty(window, 'EventSource', { value: undefined }); });
  await loadScript(page, 'progress.js');
  await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(7000);
  await expect(page.locator('[data-progress-label]')).toHaveText('恢复生成');
});

test('发送保持焦点、保留失败草稿，Enter / Ctrl+Enter 发送、Shift+Enter 换行且不误发输入法组合', async ({ page }) => {
  let sends = 0;
  let release: (() => void) | undefined;
  await page.route('**/messages/test/items?*', route => route.fulfill({ json: { messages: [], hasMore: false } }));
  await page.route('**/messages/test/send', async route => {
    sends++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill(sends === 2 ? { status: 500, json: {} } : { json: {} });
  });
  await fixture(page, `<div data-chat="test"><div data-chat-history><ul data-message-list></ul></div><button data-older hidden></button><button data-new-messages hidden></button><p data-chat-empty></p><form data-chat-form><input name="_csrf" value="test"><input name="clientId" value="test-client-id"><textarea name="text" data-max-length="2000"></textarea><button type="submit">发送</button><p data-chat-status></p><a data-chat-login hidden></a><a data-chat-back hidden></a></form></div>`, 'messages.js');
  const input = page.locator('textarea');
  await input.fill('第一条');
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  expect(sends).toBe(0);
  await input.press('Shift+Enter'); await expect(input).toHaveValue('第一条\n');
  expect(sends).toBe(0);
  await input.press('Enter'); // 鼠标键盘设备：Enter 直接发送，Shift + Enter 才换行
  await expect.poll(() => sends).toBe(1);
  await expect(input).toBeFocused(); await expect(input).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送中…' })).toBeDisabled();
  release!();
  await expect(input).toHaveValue(''); await expect(input).toBeFocused();
  await input.fill('失败还在'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => sends).toBe(2); release!();
  await expect(page.getByRole('button', { name: '重试发送' })).toBeEnabled();
  await expect(input).toHaveValue('失败还在'); await expect(input).toBeFocused();
  await input.press('Meta+Enter');
  await expect.poll(() => sends).toBe(3);
  await input.fill('发送期间继续写的下一条');
  release!();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('发送期间继续写的下一条');
  await expect(input).toBeFocused();
});

test('真实采访表单拒绝非图片、错误回显全部选择；群像等待状态阻止重复提交', async ({ context }) => {
  const { page } = await newUser(context, 'form-regression', '测试成员');
  const { wallId } = await createWall(page, '前端回归墙');
  // 拦住原生导航，检查同一个真实表单连续提交时的等待与防重状态。
  await page.evaluate(() => {
    Object.assign(window, { prevented: [] as boolean[] });
    document.addEventListener('submit', event => {
      (window as any).prevented.push(event.defaultPrevented);
      event.preventDefault();
    });
  });
  const portrait = page.locator('#portrait');
  await portrait.getByRole('button', { name: '生成群像', exact: true }).click();
  await expect(portrait).toHaveAttribute('aria-busy', 'true');
  await expect(portrait.locator('[data-busy-status]')).toContainText('AI 正在读');
  await expect(portrait.getByRole('button', { name: '生成群像', exact: true })).toBeDisabled();
  await portrait.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (window as any).prevented)).toEqual([false, true]);
  await page.goto(`/w/${wallId}/me/create`);
  const school = page.locator('[name="q_boundaries_0"]');
  await expect(school).toHaveCount(0); // 展示边界移到确认页，第一屏不再询问
  await expect(page.locator('main')).not.toContainText('默认勾选');
  const photos = page.locator('[name="photos"]');
  await photos.setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.locator('[data-photo-status]')).toContainText('只支持 PNG');
  expect(await photos.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await photos.setInputFiles([]);
  await page.locator('[name="material"]').fill('我的素材'.repeat(100) + '稳赚不赔');
  await page.locator('[name="q_teammate_0"]').check();
  await page.getByText('风格与动效（可以看到草稿后再调）', { exact: true }).click();
  await page.locator('[name="style_hackathon-terminal"]').check();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('[name="material"]')).toHaveValue('我的素材'.repeat(100) + '稳赚不赔');
  await expect(school).toHaveCount(0);
  await expect(page.locator('[name="q_teammate_0"]')).toBeChecked();
  await expect(page.locator('[name="style_hackathon-terminal"]')).toBeChecked();
});

test('AI 配置失败保留非敏感字段，带空格的六位验证码可完整粘贴并登录', async ({ page }) => {
  const email = uniqueEmail('spaced-otp');
  await page.goto('/login'); await page.getByLabel('邮箱').fill(email);
  await page.getByRole('button', { name: '发送验证码' }).click();
  const code = await latestCode(email);
  await page.getByLabel('6 位验证码').fill(code.slice(0, 3) + ' ' + code.slice(3));
  await expect(page.getByLabel('6 位验证码')).toHaveValue(code.slice(0, 3) + ' ' + code.slice(3));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByLabel('昵称').fill('回归成员');
  await page.locator('input[type="checkbox"][required]').check();
  await page.getByRole('button', { name: '进入 NOWMe' }).click();
  await page.goto('/account/ai');
  await page.locator('#interview-provider').selectOption('deepseek');
  await page.locator('#interview-url').fill('http://localhost/v1');
  await page.locator('#interview-model').fill('my-model');
  await page.locator('#interview-key').fill('secret-never-echo');
  await page.getByRole('button', { name: '保存 AI 配置' }).click();
  await expect(page.getByText('没能保存。', { exact: false })).toBeVisible();
  await expect(page.locator('#interview-url')).toHaveValue('http://localhost/v1');
  await expect(page.locator('#interview-model')).toHaveValue('my-model');
  await expect(page.locator('[name="shared"]')).toBeChecked();
  await expect(page.locator('#interview-key')).toHaveValue('');
  expect(await page.content()).not.toContain('secret-never-echo');
});
