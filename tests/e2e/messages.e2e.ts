import { expect, test } from '@playwright/test';
import { createWall, joinWall, newUser } from './helpers.js';

test('群聊与私聊：多人收发、未读、断网重试去重、历史、手机布局与权限撤销', async ({ browser }, testInfo) => {
  const ownerContext = await browser.newContext();
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  try {
    const owner = await newUser(ownerContext, 'chat-owner', '聊天组织者');
    const a = await newUser(aContext, 'chat-a', '聊天甲');
    const b = await newUser(bContext, 'chat-b', '聊天乙');
    const { wallId, inviteUrl } = await createWall(owner.page, '一起聊的墙');
    await joinWall(a.page, inviteUrl);
    await joinWall(b.page, inviteUrl);
    await a.page.getByRole('link', { name: '全员群聊', exact: true }).click();
    await b.page.getByRole('link', { name: '全员群聊', exact: true }).click();
    const groupPath = new URL(a.page.url()).pathname;
    expect(new URL(b.page.url()).pathname).toBe(groupPath);
    await a.page.getByLabel('消息内容').fill('甲在全员群打招呼');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(b.page.locator('.message-text')).toContainText(['甲在全员群打招呼'], { timeout: 8000 });
    await b.page.getByLabel('消息内容').fill('乙收到群消息了');
    await b.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(a.page.locator('.message-text')).toContainText(['甲在全员群打招呼', '乙收到群消息了'], { timeout: 8000 });
    await owner.page.goto(groupPath);
    await expect(owner.page.locator('.message')).toHaveCount(2);

    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和聊天乙私聊', exact: true }).click();
    const directPath = new URL(a.page.url()).pathname;
    let dropResponse = true;
    await a.page.route('**/messages/*/send', async (route) => {
      if (dropResponse) {
        dropResponse = false;
        await route.fetch(); // 已入库，但模拟响应丢失；客户端必须使用同一消息标识重试。
        await route.abort();
      } else await route.continue();
    });
    await a.page.getByLabel('消息内容').fill('只给乙的私聊消息');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(a.page.getByRole('button', { name: '重试发送' })).toBeVisible();
    await expect(a.page.getByLabel('消息内容')).toHaveValue('只给乙的私聊消息');
    await a.page.getByRole('button', { name: '重试发送' }).click();
    await expect(a.page.getByLabel('消息内容')).toHaveValue('');
    await expect(a.page.locator('.message-text', { hasText: '只给乙的私聊消息' })).toHaveCount(1);
    await b.page.goto('/messages');
    const privateItem = b.page.locator('.conversation-item', { hasText: '聊天甲' });
    await expect(privateItem.locator('.message-badge')).toHaveText('1');
    await privateItem.getByRole('link').click();
    await b.page.bringToFront();
    await expect(b.page.locator('.message-text')).toHaveText(['只给乙的私聊消息']);
    await expect.poll(async () => {
      const data = await (await b.page.request.get('/messages/list')).json();
      return data.conversations.find((c: { id: string }) => directPath.endsWith(c.id)).unread;
    }).toBe(0);
    await b.page.getByLabel('消息内容').fill('乙的私聊回复');
    await b.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(a.page.locator('.message-text')).toHaveText(['只给乙的私聊消息', '乙的私聊回复'], { timeout: 8000 });
    await a.page.reload();
    await expect(a.page.locator('.message')).toHaveCount(2);
    expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(b.page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    await b.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => b.page.evaluate(() => window.scrollY)).toBe(0);
    await expect(b.page.locator('.conversation-heading h1')).toBeInViewport();
    await expect(b.page.getByRole('link', { name: '← 消息列表' })).toBeInViewport();
    await b.page.screenshot({ path: testInfo.outputPath('chat-mobile.png'), fullPage: true });

    // 组织者不能通过猜测会话路径读取甲乙私聊。
    expect((await owner.page.request.get(directPath)).status()).toBe(404);
    await owner.page.goto(`/w/${wallId}/admin`);
    const row = owner.page.locator('.member-row', { hasText: '聊天乙' });
    owner.page.on('dialog', (dialog) => void dialog.accept());
    await row.getByRole('button', { name: '移出', exact: true }).click();
    await expect(b.page.locator('[data-chat-status]')).toContainText('失去', { timeout: 8000 });
    await expect(b.page.locator('.message')).toHaveCount(0);
    await expect(b.page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect((await b.page.request.get(groupPath + '/items')).status()).toBe(404);
  } finally {
    await Promise.all([ownerContext.close(), aContext.close(), bContext.close()]);
  }
});

test('历史消息分页与阅读位置：收到新消息不打断阅读，隐藏页面恢复后补齐', async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  try {
    const a = await newUser(aContext, 'history-a', '历史甲');
    const b = await newUser(bContext, 'history-b', '历史乙');
    const { inviteUrl } = await createWall(a.page, '历史分页的墙');
    await joinWall(b.page, inviteUrl);
    await b.page.getByRole('link', { name: '全员群聊', exact: true }).click();
    const path = new URL(b.page.url()).pathname;
    await a.page.goto(path);
    // 使用真实登录 cookie 与 CSRF，通过同源请求批量填充历史。
    await a.page.evaluate(async (url) => {
      const csrf = (document.querySelector('[data-chat-form] input[name="_csrf"]') as HTMLInputElement).value;
      for (let i = 0; i < 65; i++) {
        const response = await fetch(url + '/send', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrf, clientId: crypto.randomUUID(), text: '历史消息' + i }) });
        if (!response.ok) throw new Error('填充历史失败');
      }
    }, path);
    await b.page.reload();
    await expect(b.page.locator('.message')).toHaveCount(50);
    await b.page.locator('[data-chat-history]').evaluate((el) => { el.scrollTop = 0; });
    await b.page.getByRole('button', { name: '加载更早消息' }).click();
    await expect(b.page.locator('.message')).toHaveCount(65);
    await b.page.locator('[data-chat-history]').evaluate((el) => { el.scrollTop = 0; });
    const before = await b.page.locator('[data-chat-history]').evaluate((el) => el.scrollTop);
    await a.page.getByLabel('消息内容').fill('正在阅读时的新消息');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(b.page.getByRole('button', { name: '有新消息，点击查看 ↓' })).toBeVisible({ timeout: 8000 });
    expect(await b.page.locator('[data-chat-history]').evaluate((el) => el.scrollTop)).toBe(before);
    await b.page.getByRole('button', { name: '有新消息，点击查看 ↓' }).click();
    await expect(b.page.locator('.message-text').last()).toBeInViewport();
    // visibilitychange 使用浏览器实际页面的 document.hidden 门闩，验证暂停与恢复。
    await b.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await a.page.getByLabel('消息内容').fill('恢复后补齐的消息');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await b.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(b.page.locator('.message-text').last()).toHaveText('恢复后补齐的消息', { timeout: 8000 });
    await expect(b.page.locator('.message')).toHaveCount(67);
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});
