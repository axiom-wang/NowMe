import { expect, test, type Page } from '@playwright/test';
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
        if (width >= 760) expect(messageWidthWithBadge).toBeGreaterThan(messages!.width);
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
      // 宽屏：左栏会话列表 + 右侧聊天窗口占位（微信电脑端布局）；窄屏只显示列表
      const sidebarBox = await b.page.locator('.messages-sidebar').boundingBox();
      if (width >= 760) {
        const mainBox = await b.page.locator('.messages-main').boundingBox();
        expect(mainBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width - 1);
        await expect(b.page.locator('.messages-placeholder')).toBeVisible();
      } else {
        await expect(b.page.locator('.messages-main')).toBeHidden();
      }
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
    for (const width of [320, 375, 768, 1440]) {
      await b.page.setViewportSize({ width, height: 800 });
      const heading = b.page.locator('.conversation-heading');
      const back = heading.locator('a[href="/messages"]');
      await expect(back).toHaveText('← 消息列表');
      if (width < 760) await expect(back).toBeVisible();
      await expect(heading.getByRole('link', { name: '回到墙上', exact: true })).toHaveAttribute('href', `/w/${wallId}`);
      expect(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(b.page.getByText('最多 2000 字', { exact: false })).toHaveCount(0);
      await expect(b.page.getByText('开场白已经填好了，改成你自己的话再发送。', { exact: true })).toHaveCount(0);
    }
    await b.page.setViewportSize({ width: 375, height: 667 });
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

test('宽屏双栏：左栏列出私聊与群聊，点开某个聊天后右侧是聊天窗口，左栏高亮当前会话', async ({ browser }) => {
  const aContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const a = await newUser(aContext, 'pane-a', '高远');
    const b = await newUser(bContext, 'pane-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '双栏测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await a.page.getByLabel('消息内容').fill('群里的第一句');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和江予安私聊', exact: true }).click();
    await a.page.getByLabel('消息内容').fill('私聊的第一句');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);

    await b.page.goto('/messages');
    await expect(b.page.locator('.conversation-item')).toHaveCount(2);
    await expect(b.page.locator('.messages-placeholder')).toBeVisible();
    await b.page.locator('.conversation-item[data-kind="direct"] a').click();
    await expect(b.page.locator('.message-text')).toHaveText(['私聊的第一句']);
    // 左栏仍在，两类会话都能看到，当前会话高亮且没有未读角标
    await expect(b.page.locator('.conversation-item')).toHaveCount(2);
    const active = b.page.locator('.conversation-item[data-active="true"]');
    await expect(active).toHaveAttribute('data-kind', 'direct');
    await b.page.bringToFront();
    // 读到最新后，当前会话的未读角标消失；另一个会话的未读如实保留
    await expect(active.locator('.message-badge')).toHaveCount(0, { timeout: 8000 });
    await expect(b.page.locator('.conversation-item[data-kind="group"] .message-badge')).toHaveText('1');
    // 宽屏整页不滚动：聊天窗口在左栏右侧，发送框始终在视口内
    const sidebar = await b.page.locator('.messages-sidebar').boundingBox();
    const chat = await b.page.locator('.conversation-page').boundingBox();
    expect(chat!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width - 1);
    await expect(b.page.getByLabel('消息内容')).toBeInViewport({ ratio: 1 });
    expect(await b.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    // 在左栏切到群聊
    await b.page.locator('.conversation-item[data-kind="group"] a').click();
    await expect(b.page.locator('.message-text')).toHaveText(['群里的第一句']);
    await expect(b.page.locator('.conversation-item[data-active="true"]')).toHaveAttribute('data-kind', 'group');
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

const compose = (page: Page) => page.getByLabel('消息内容');
const sendButton = (page: Page) => page.getByRole('button', { name: '发送', exact: true });

test('矮窗口：展开举报表单或成员列表后，输入框仍固定在窗口内、可以发送', async ({ browser }) => {
  const aContext = await browser.newContext({ viewport: { width: 1280, height: 560 } });
  const bContext = await browser.newContext({ viewport: { width: 1280, height: 560 } });
  try {
    const a = await newUser(aContext, 'short-a', '高远');
    const b = await newUser(bContext, 'short-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '矮窗口测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和江予安私聊', exact: true }).click();
    await compose(a.page).fill('先打个招呼');
    await sendButton(a.page).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);

    await b.page.goto(a.page.url());
    await b.page.locator('.safety--chat summary').click();
    // 举报表单展开：聊天记录仍有保底高度，输入框与发送按钮都在窗口内
    expect(await b.page.locator('.chat-history').evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(150);
    await expect(compose(b.page)).toBeInViewport({ ratio: 1 });
    await expect(sendButton(b.page)).toBeInViewport({ ratio: 1 });
    await compose(b.page).fill('举报栏打开时也能回复');
    await sendButton(b.page).click();
    await expect(b.page.locator('.message-text').last()).toHaveText('举报栏打开时也能回复');

    await b.page.goto(`/messages/wall/${wallId}`);
    await b.page.locator('.chat-members summary').click();
    expect(await b.page.locator('.chat-history').evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(150);
    await expect(sendButton(b.page)).toBeInViewport({ ratio: 1 });
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('窄一点的宽屏：长墙名只在眉题里省略，不压住“回到墙上”，昵称与时间不重叠', async ({ browser }) => {
  const aContext = await browser.newContext({ viewport: { width: 760, height: 800 } });
  const bContext = await browser.newContext({ viewport: { width: 760, height: 800 } });
  try {
    const a = await newUser(aContext, 'wide-a', '高远');
    const b = await newUser(bContext, 'wide-b', '一个非常非常非常长的昵称用来测试');
    const { wallId, inviteUrl } = await createWall(a.page, '山野轻徒步 · 一起去透气 · 这是一个很长很长的墙名用来测试截断');
    await joinWall(b.page, inviteUrl);
    await b.page.goto(`/messages/wall/${wallId}`);
    await b.page.locator('.chat-members summary').click();
    await b.page.getByRole('button', { name: '和高远私聊', exact: true }).click();
    await compose(b.page).fill('你好');
    await sendButton(b.page).click();
    await expect(b.page.locator('.message-text')).toHaveCount(1);

    await a.page.goto('/messages');
    const direct = a.page.locator('.conversation-item[data-kind="direct"]');
    await expect(direct).toHaveCount(1);
    const name = await direct.locator('strong').boundingBox();
    const time = await direct.locator('.conversation-time').boundingBox();
    expect(name!.x + name!.width).toBeLessThanOrEqual(time!.x);
    await direct.locator('a').click();
    const eyebrow = await a.page.locator('.conversation-heading .eyebrow').boundingBox();
    const wallLink = await a.page.locator('.conversation-heading__nav a:visible').boundingBox();
    expect(eyebrow!.x + eyebrow!.width).toBeLessThanOrEqual(wallLink!.x);
    expect(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('切换会话：筛选保持、草稿不丢、Enter 发送 / Shift+Enter 换行，后退不会逐个退回看过的聊天', async ({ browser }) => {
  const aContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const a = await newUser(aContext, 'switch-a', '高远');
    const b = await newUser(bContext, 'switch-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '切换测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await compose(a.page).fill('群里一句');
    await sendButton(a.page).click();
    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和江予安私聊', exact: true }).click();
    await compose(a.page).fill('私聊一句');
    await sendButton(a.page).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);

    // 筛选条在脚本运行前就占好位置（不再从 hidden 弹出）；“全部”筛选下点进私聊
    await b.page.goto('/messages#group');
    await expect(b.page.getByRole('button', { name: '墙内群聊', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(b.page.locator('.conversation-item:visible')).toHaveCount(1);
    await b.page.locator('.conversation-item:visible a').click();
    await expect(b.page).toHaveURL(/\/messages\/cnv_[^#]+#group$/);
    await expect(b.page.getByRole('button', { name: '墙内群聊', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(b.page.locator('.conversation-item[data-active="true"]')).toHaveAttribute('data-kind', 'group');
    // 当前会话在任何筛选下都可见
    await b.page.getByRole('button', { name: '未读消息' }).click();
    await expect(b.page.locator('.conversation-item[data-active="true"]')).toBeVisible();
    await b.page.getByRole('button', { name: '最近的聊天', exact: true }).click();

    // 草稿：切到私聊再切回群聊，还在；发送成功后清掉
    await compose(b.page).fill('写了一半');
    await b.page.locator('.conversation-item[data-kind="direct"] a').click();
    await expect(b.page.locator('.message-text')).toHaveText(['私聊一句']);
    await expect(compose(b.page)).toHaveValue('');
    await b.page.locator('.conversation-item[data-kind="group"] a').click();
    await expect(compose(b.page)).toHaveValue('写了一半');
    // 宽屏切换聊天用“替换”历史：后退直接回到 /messages，而不是上一个聊天
    await b.page.goBack();
    await expect(b.page).toHaveURL(/\/messages(#.*)?$/);

    await b.page.goto(`/messages/wall/${wallId}`);
    await compose(b.page).fill('第一行');
    await compose(b.page).press('Shift+Enter');
    await compose(b.page).pressSequentially('第二行');
    await expect(compose(b.page)).toHaveValue('第一行\n第二行');
    await compose(b.page).press('Enter');
    await expect(b.page.locator('.message-text').last()).toHaveText('第一行 第二行'.replace(' ', '\n'));
    await expect(compose(b.page)).toHaveValue('');
    await b.page.reload();
    await expect(compose(b.page)).toHaveValue('');
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('未读：读到最新后左栏与顶栏同时清零；页面没有焦点时角标不会被藏掉', async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const a = await newUser(aContext, 'unread-a', '高远');
    const b = await newUser(bContext, 'unread-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '未读测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await compose(a.page).fill('第一条');
    await sendButton(a.page).click();
    await compose(a.page).fill('第二条');
    await sendButton(a.page).click();
    await expect(a.page.locator('.message-text')).toHaveCount(2);

    // 页面没有焦点：不会标记已读，左栏角标必须如实保留
    await b.page.addInitScript(() => { Document.prototype.hasFocus = () => false; });
    await b.page.goto(a.page.url());
    await expect(b.page.locator('.conversation-item[data-active="true"] .message-badge')).toHaveText('2');
    await expect(b.page.locator('[data-message-unread]')).toHaveText('2', { timeout: 8000 });

    // 有焦点：读到最新后左栏、顶栏一起清零
    const focused = await bContext.newPage();
    await focused.goto(a.page.url());
    await focused.bringToFront();
    await expect(focused.locator('.conversation-item[data-active="true"] .message-badge')).toHaveCount(0, { timeout: 8000 });
    await expect(focused.locator('[data-message-unread]')).toBeHidden({ timeout: 8000 });
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('没有任何聊天时右侧提示与左栏一致；左栏滚动位置不会从别处误恢复', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const { page } = await newUser(context, 'empty-pane', '空空');
    await page.goto('/messages');
    await expect(page.locator('.messages-placeholder')).toContainText('加入一面墙之后');
    await expect(page.locator('.messages-placeholder')).not.toContainText('选择左侧的聊天');
    await page.evaluate(() => sessionStorage.setItem('nowme:inbox-scroll', JSON.stringify({ top: 500, at: Date.now() - 60_000 })));
    await page.goto('/messages');
    expect(await page.locator('.inbox').evaluate((el) => el.scrollTop)).toBe(0);
    expect(await page.evaluate(() => sessionStorage.getItem('nowme:inbox-scroll'))).toBeNull();
  } finally { await context.close(); }
});

test('聊天打不开（404）只停聊天窗口，左栏仍继续更新', async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const a = await newUser(aContext, 'err-a', '高远');
    const b = await newUser(bContext, 'err-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '出错测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和江予安私聊', exact: true }).click();
    await compose(a.page).fill('私聊');
    await sendButton(a.page).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);
    const directUrl = a.page.url();

    await b.page.route(/\/messages\/cnv_[^/]+\/items/, (route) => route.fulfill({ status: 404, json: { error: '这段对话打不开了。' } }));
    await b.page.goto(`/messages/wall/${wallId}`);
    await expect(b.page.locator('[data-chat-status]')).toContainText('打不开', { timeout: 8000 });
    // 左栏继续轮询：另一个会话来了新消息，预览会更新
    await a.page.goto(directUrl);
    await compose(a.page).fill('左栏还活着');
    await sendButton(a.page).click();
    await expect(b.page.locator('.conversation-item[data-kind="direct"] .conversation-preview')).toHaveText('左栏还活着', { timeout: 8000 });
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('时间按浏览器所在时区显示', async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ timezoneId: 'America/Los_Angeles', viewport: { width: 1280, height: 800 } });
  try {
    const a = await newUser(aContext, 'tz-a', '高远');
    const b = await newUser(bContext, 'tz-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '时区测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await compose(a.page).fill('看看几点');
    await sendButton(a.page).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);
    await b.page.goto(`/messages/wall/${wallId}`);
    const iso = (await b.page.locator('.conversation-time').getAttribute('datetime'))!;
    const expected = new Date(iso).toLocaleTimeString('zh-CN', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
    await expect(b.page.locator('.conversation-time')).toHaveText(expected);
    await expect(b.page.locator('.message-meta time').first()).toContainText(expected);
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});

test('会话超过一页：当前会话在左栏里高亮，“更早的会话”原地加载，轮询不把已展开的缩回', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const { page } = await newUser(context, 'many', '多多');
    const walls: string[] = [];
    for (let i = 0; i < 53; i++) walls.push((await createWall(page, `多墙${i}`)).wallId);
    // 没有消息的群按会话 ID 倒序排：ID 最小的排在最后，一定在第一页（50 个）之外
    const oldest = [...walls].sort((x, y) => x.slice(4).localeCompare(y.slice(4)))[0]!;
    await page.goto(`/messages/wall/${oldest}`);
    await expect(page.locator('.conversation-item')).toHaveCount(53);
    await expect(page.locator('.conversation-item[data-active="true"]')).toHaveCount(1);
    await expect(page.locator('.conversation-item[data-active="true"]')).toBeInViewport();
    // 回到最新一页：只有 50 个，点“更早的会话”原地追加，地址不变
    await page.goto('/messages');
    await expect(page.locator('.conversation-item')).toHaveCount(50);
    const url = page.url();
    await page.locator('[data-conversation-next]').click();
    await expect(page.locator('.conversation-item')).toHaveCount(53);
    expect(page.url()).toBe(url);
    await expect(page.locator('[data-conversation-next]')).toBeHidden();
    await page.waitForTimeout(6000);
    await expect(page.locator('.conversation-item')).toHaveCount(53);
  } finally { await context.close(); }
});

test('滚动能从聊天记录传给外层：矮窗口 / 手机展开举报表单后，在聊天区也能滑动页面', async ({ browser }) => {
  const aContext = await browser.newContext();
  const bContext = await browser.newContext({ viewport: { width: 1280, height: 560 } });
  try {
    const a = await newUser(aContext, 'scroll-a', '高远');
    const b = await newUser(bContext, 'scroll-b', '江予安');
    const { wallId, inviteUrl } = await createWall(a.page, '滚动测试墙');
    await joinWall(b.page, inviteUrl);
    await a.page.goto(`/messages/wall/${wallId}`);
    await a.page.locator('.chat-members summary').click();
    await a.page.getByRole('button', { name: '和江予安私聊', exact: true }).click();
    await compose(a.page).fill('私聊一句');
    await sendButton(a.page).click();
    await expect(a.page.locator('.message-text')).toHaveCount(1);
    const direct = a.page.url();
    const wheelOver = async (page: Page, selector: string, dy: number) => {
      const box = (await page.locator(selector).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40));
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(250);
    };

    // 宽屏矮窗口：聊天记录本身没有可滚内容时，滚轮停在记录上要能滚动聊天窗口
    await b.page.goto(direct);
    await b.page.locator('.safety--chat summary').click();
    const panel = b.page.locator('.conversation-panel');
    expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await wheelOver(b.page, '.chat-history', 300);
    expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // 手机：展开举报表单后整页变长，手指停在聊天区（再次滑动时）也要能滑动整页
    await b.page.setViewportSize({ width: 375, height: 667 });
    await b.page.goto(direct);
    await b.page.locator('.safety--chat summary').click();
    expect(await b.page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
    for (let i = 0; i < 3; i++) await wheelOver(b.page, '.chat-history', 400);
    expect(await b.page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  } finally { await Promise.all([aContext.close(), bContext.close()]); }
});
