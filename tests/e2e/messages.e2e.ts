import { expect, test } from '@playwright/test';
import { createWall, joinWall, newUser } from './helpers.js';

test('群头像与墙封面一致，首屏、轮询、更换和恢复默认均显示正确图片', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const owner = await newUser(ownerContext, 'group-cover-owner', '组织者');
    const member = await newUser(memberContext, 'group-cover-member', '群成员');
    const { inviteUrl } = await createWall(owner.page, '山野轻徒步');
    await joinWall(member.page, inviteUrl);
    await member.page.goto('/messages');
    const avatar = member.page.locator('.conversation-icon--group img');
    await expect(avatar).toHaveAttribute('src', '/static/home-wall-mountain.svg');
    const png = await owner.page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } });
    const settings = owner.page.getByRole('region', { name: '墙封面', exact: true });
    for (const label of ['上传封面图', '更换封面图']) {
      const previous = await avatar.getAttribute('src');
      await owner.page.getByLabel(label, { exact: true }).setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
      await settings.getByRole('button', { name: '保存封面', exact: true }).click();
      const src = await settings.locator('img').getAttribute('src');
      expect(src).not.toBe(previous);
      await expect(avatar).toHaveAttribute('src', src!, { timeout: 8000 });
      await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await member.page.reload();
      await expect(avatar).toHaveAttribute('src', src!);
    }
    await settings.getByRole('button', { name: '移除封面，恢复默认' }).click();
    await expect(avatar).toHaveAttribute('src', '/static/home-wall-mountain.svg', { timeout: 8000 });
  } finally { await Promise.all([ownerContext.close(), memberContext.close()]); }
});

test('顶栏没有未读徽标空位，有新消息时才显示未读数', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  try {
    const { page } = await newUser(context, 'header-layout', '江予安');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    let holdUnread = false;
    let unread = 12;
    let releaseUnread: (() => void) | undefined;
    await page.route('**/messages/unread', async (route) => {
      if (holdUnread) {
        holdUnread = false;
        await new Promise<void>((resolve) => { releaseUnread = resolve; });
      }
      await route.fulfill({ json: { unread } });
    });
    const geometry = () => page.evaluate(() => {
      const selectors = ['.site-header', '.site-header__inner', '.brand', '.site-nav', '.site-nav a', '.account-menu', '.account-menu .avatar'];
      return selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { selector, x, y, width, height, fontSize: getComputedStyle(element).fontSize };
      }));
    });
    const badge = page.locator('[data-message-unread]');
    for (const width of [1440, 1024, 768, 760, 700, 562, 440, 375, 320]) {
      await page.setViewportSize({ width, height: 941 });
      let beforeReference: Awaited<ReturnType<typeof geometry>> | undefined;
      let afterReference: Awaited<ReturnType<typeof geometry>> | undefined;
      for (const path of ['/', '/messages', '/account/data', '/messages']) {
        holdUnread = true;
        releaseUnread = undefined;
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        await expect.poll(() => !!releaseUnread).toBe(true);
        await expect(badge).toHaveCSS('display', 'none');
        const beforeUnread = await geometry();
        const [home, messages, data] = beforeUnread.filter(({ selector }) => selector === '.site-nav a');
        expect(messages!.width).toBeCloseTo(home!.width, 1);
        expect(data!.x - messages!.x - messages!.width).toBeCloseTo(messages!.x - home!.x - home!.width, 1);
        beforeReference ??= beforeUnread;
        expect(beforeUnread, `${width}px ${path} 无徽标时与首页`).toEqual(beforeReference);
        releaseUnread!();
        await expect(badge).toBeVisible();
        await expect(badge).toHaveText('12');
        const afterUnread = await geometry();
        expect(afterUnread.filter(({ selector }) => !selector.startsWith('.site-nav'))).toEqual(beforeUnread.filter(({ selector }) => !selector.startsWith('.site-nav')));
        const messageWidthWithBadge = afterUnread.filter(({ selector }) => selector === '.site-nav a')[1]!.width;
        if (width > 760) expect(messageWidthWithBadge).toBeGreaterThan(messages!.width);
        else expect(messageWidthWithBadge).toBe(messages!.width);
        afterReference ??= afterUnread;
        expect(afterUnread, `${width}px ${path} 有徽标时与首页`).toEqual(afterReference);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      if ([1440, 562, 375].includes(width)) await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
    }
    unread = 0;
    await page.clock.fastForward(31_000);
    await expect(badge).toHaveCSS('display', 'none');
  } finally { await context.close(); }
});

test('消息页：筛选与轮询保持同步，发起聊天入口和窄屏布局可用', async ({ browser }, testInfo) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  try {
    const a = await newUser(aContext, 'inbox-a', '高远');
    const b = await newUser(bContext, 'inbox-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '山野轻徒步 · 一起去透气');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    const groupPath = new URL(a.page.url()).pathname;
    await a.page.getByLabel('消息内容').fill('周六去山里走走？');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(a.page.locator('.message-text')).toHaveText(['周六去山里走走？']);
    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和江予安私聊', exact: true }).click();
    const directPath = new URL(a.page.url()).pathname;
    await a.page.getByLabel('消息内容').fill('对了，你周六下午方便吗？我们也可以先在群里约时间。');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);

    await b.page.goto('/messages');
    await expect(b.page.locator('.site-nav [aria-current="page"]')).toHaveText(/消息/);
    await expect(b.page.locator('[data-inbox-unread]')).toHaveText('2');
    await expect(b.page.locator('.conversation-time')).toHaveCount(2);
    await expect(b.page.locator('.conversation-time').first()).toHaveText(/^\d{2}:\d{2}$/);
    await b.page.getByRole('button', { name: '墙内群聊', exact: true }).click();
    await expect(b.page.locator('.conversation-item:visible')).toHaveCount(1);
    await expect(b.page.locator('.conversation-item:visible')).toHaveAttribute('data-kind', 'group');
    // 轮询重建列表后仍使用当前筛选。
    await a.page.getByLabel('消息内容').fill('我也可以周日。');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(b.page.locator('[data-inbox-unread]')).toHaveText('3', { timeout: 8000 });
    await expect(b.page.locator('.conversation-item:visible')).toHaveCount(1);
    await b.page.getByRole('button', { name: '未读消息' }).click();
    await expect(b.page.locator('.conversation-item:visible')).toHaveCount(2);
    await b.page.reload();
    await expect(b.page.getByRole('button', { name: '未读消息' })).toHaveAttribute('aria-pressed', 'true');
    // 阅读后返回，筛选应显示准确的空状态。
    for (const path of [directPath, groupPath]) {
      await b.page.goto(path);
      await b.page.bringToFront();
      await expect.poll(async () => (await (await b.page.request.get('/messages/unread')).json()).unread).toBe(path === directPath ? 1 : 0);
    }
    await b.page.goto('/messages#unread');
    await expect(b.page.getByText('消息都看过了')).toBeVisible();
    await b.page.getByRole('button', { name: '最近的聊天', exact: true }).click();
    await expect(b.page.locator('.conversation-item:visible')).toHaveCount(2);

    await b.page.getByText('发起聊天', { exact: true }).click();
    await expect(b.page.locator('.start-chat__menu')).toBeVisible();
    await b.page.locator('.start-chat summary').press('Escape');
    await expect(b.page.locator('.start-chat__menu')).toBeHidden();
    for (const width of [1440, 562, 375]) {
      await b.page.setViewportSize({ width, height: 941 });
      expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const inboxBox = await b.page.locator('.inbox').boundingBox();
      const wallsBox = await b.page.locator('.inbox-walls').boundingBox();
      if (width >= 540) expect(wallsBox!.x).toBeGreaterThan(inboxBox!.x + inboxBox!.width);
      else expect(wallsBox!.y).toBeGreaterThan(inboxBox!.y);
      await b.page.screenshot({ path: testInfo.outputPath(`inbox-${width}.png`), fullPage: true });
    }
    await b.page.getByText('发起聊天', { exact: true }).click();
    await b.page.locator('.start-chat__menu a').click();
    await expect(b.page).toHaveURL(new RegExp(groupPath + '$'));
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('群聊与私聊：多人收发、未读、断网重试去重、历史、手机布局与权限撤销', async ({ browser }, testInfo) => {
  const ownerContext = await browser.newContext();
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
  try {
    const owner = await newUser(ownerContext, 'chat-owner', '聊天组织者');
    const a = await newUser(aContext, 'chat-a', '聊天甲');
    const b = await newUser(bContext, 'chat-b', '聊天乙');
    const { wallId, inviteUrl } = await createWall(owner.page, '一起聊的墙');
    await joinWall(a.page, inviteUrl);
    await joinWall(b.page, inviteUrl);
    // 加入后先进入引导；回到墙再进群聊
    await a.page.goto(`/w/${wallId}`);
    await b.page.goto(`/w/${wallId}`);
    await a.page.getByRole('link', { name: '全员群聊', exact: true }).click();
    await b.page.getByRole('link', { name: '全员群聊', exact: true }).click();
    await expect(b.page.locator('.conversation-heading .eyebrow')).toHaveText('全员群聊');
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('一起聊的墙');
    await expect(b.page.getByLabel('消息内容')).toBeInViewport({ ratio: 1 });
    await expect(b.page.getByRole('button', { name: '发送', exact: true })).toBeInViewport({ ratio: 1 });
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
    await expect(b.page.getByLabel('消息内容')).toBeInViewport({ ratio: 1 });
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
    await expect(b.page.locator('[data-chat-status]')).toContainText('打不开', { timeout: 8000 });
    await expect(b.page.locator('.message')).toHaveCount(0);
    await expect(b.page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect((await b.page.request.get(groupPath + '/items')).status()).toBe(404);
  } finally {
    await Promise.all([ownerContext.close(), aContext.close(), bContext.close()]);
  }
});

test('历史消息分页与阅读位置：收到新消息不打断阅读，隐藏页面恢复后补齐', async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ viewport: { width: 320, height: 667 } });
  try {
    const a = await newUser(aContext, 'history-a', '历史甲');
    const b = await newUser(bContext, 'history-b', '历史乙');
    const { wallId, inviteUrl } = await createWall(a.page, '历史分页的墙');
    await joinWall(b.page, inviteUrl);
    await b.page.goto(`/w/${wallId}`);
    await b.page.getByRole('link', { name: '全员群聊', exact: true }).click();
    const path = new URL(b.page.url()).pathname;
    await a.page.goto(path);
    // 使用真实登录 cookie 与 CSRF，通过同源请求批量填充历史。
    // 每人每分钟最多发 40 条（contracts 10.3），65 条由两个人交替各发一段。
    const fill = (start: number, end: number) => async (args: { url: string; start: number; end: number }) => {
      const csrf = (document.querySelector('[data-chat-form] input[name="_csrf"]') as HTMLInputElement).value;
      for (let i = args.start; i < args.end; i++) {
        const response = await fetch(args.url + '/send', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrf, clientId: crypto.randomUUID(), text: '历史消息' + i }) });
        if (!response.ok) throw new Error('填充历史失败');
      }
    };
    await a.page.evaluate(fill(0, 33), { url: path, start: 0, end: 33 });
    await b.page.evaluate(fill(33, 65), { url: path, start: 33, end: 65 });
    await b.page.reload();
    await expect(b.page.locator('.message')).toHaveCount(50);
    await expect(b.page.getByLabel('消息内容')).toBeInViewport({ ratio: 1 });
    expect(await b.page.evaluate(() => document.documentElement.scrollHeight)).toBe(667);
    const shortHistory = (await b.page.locator('[data-chat-history]').boundingBox())!.height;
    await b.page.setViewportSize({ width: 320, height: 812 });
    expect((await b.page.locator('[data-chat-history]').boundingBox())!.height - shortHistory).toBeCloseTo(145);
    await b.page.setViewportSize({ width: 320, height: 667 });
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
