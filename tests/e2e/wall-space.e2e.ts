/**
 * 逛墙空间（static/wall.js）：海报排成一面可以拖动、缩放的墙，点海报在详情面板里展开接话点。
 * 与 wall-search.e2e.ts 一样，用主站的真实脚本与样式跑在一段与墙页面相同结构的文档上（主站 CSP 下加载）。
 */
import { expect, test, type Page } from '@playwright/test';

const PEOPLE = Array.from({ length: 14 }, (_, index) => ({
  id: `pg_${String(index).padStart(2, '0')}`,
  name: `成员${index}`,
  hooks: [`话题${index}-一`, `话题${index}-二`],
}));

function cardHtml(person: (typeof PEOPLE)[number], own: boolean): string {
  const hooks = person.hooks
    .map((text, index) => (own ? `<li><p class="space-detail__hook">${text}</p></li>` : `<li><button type="button" class="space-detail__hook" aria-pressed="false" data-hook-id="hook-${index + 1}">${text}</button></li>`))
    .join('');
  return `<li class="wall-card" data-wall-card data-page-id="${person.id}"${own ? ' data-own="1"' : ''} data-search="${person.name} ${person.hooks.join(' ')}" data-answers="">
    <a class="wall-card__link" href="#/w/wal_test/p/${person.id}">
      <span class="wall-card__poster"><span class="wall-card__print"><span class="wall-card__cover"><span class="wall-card__placeholder" aria-hidden="true">${person.name.slice(0, 1)}</span></span></span></span>
      <span class="wall-card__say"><span class="wall-card__say-label">想聊</span><span class="wall-card__say-text">${person.hooks[0]}</span></span>
      <span class="wall-card__body"><span class="wall-card__name">${person.name}</span></span>
      <span class="wall-card__tag">${person.name}</span>
    </a>
    <template data-card-detail><h2 class="space-detail__name" tabindex="-1">${person.name}</h2><div class="space-detail__talk"><ul class="space-detail__hooks">${hooks}</ul></div></template>
  </li>`;
}

const WALL_HTML = `<div class="container"><section class="wall-board wall-board--people" data-wall-board data-wall-id="wal_test">
  <div class="wall-board__head"><div class="wall-board__heading"><h1 class="wall-board__title">测试墙</h1>
    <p class="wall-board__population"><span class="section-head__count" data-wall-count>${PEOPLE.length}</span><span class="section-head__note" data-wall-count-note>位已上墙</span></p></div>
    <div class="wall-board__tools"><label class="wall-search"><input type="search" data-wall-search /></label>
    <button type="button" class="wall-search-toggle" aria-expanded="false" aria-label="搜索墙上的人" hidden data-space-search-toggle>⌕</button></div></div>
  <div class="wall-space" data-wall-space><div class="wall-space__stage"><div class="wall-space__viewport" data-space-viewport>
    <ul class="wall-grid" data-space-track>${PEOPLE.map((person, index) => cardHtml(person, index === 1)).join('')}</ul>
  </div><span class="wall-space__light" aria-hidden="true" data-space-light></span></div>
  <div class="wall-space__hud" hidden data-space-hud><p class="space-hud__explored">已探索 <strong data-space-explored>0</strong> / <span data-space-total>0</span><span class="space-hud__meter"><span class="space-hud__meter-fill" data-space-meter></span></span></p>
    <div class="space-hud__nav"><button type="button" class="space-hud__button" aria-label="往前看" data-space-step="-1">←</button><span class="space-hud__hint">左右拖动逛墙</span><button type="button" class="space-hud__button" aria-label="往后看" data-space-step="1">→</button></div>
    <p class="space-hud__tip">拖动逛墙 · 双指缩放</p>
    <button type="button" class="space-hud__overview" data-space-overview>回到全墙</button>
    <div class="space-hud__zoom"><button type="button" class="space-hud__button" aria-label="缩小" data-space-zoom="-1">−</button><button type="button" class="space-hud__button" aria-label="放大" data-space-zoom="1">+</button></div></div>
  <aside class="wall-space__panel" aria-label="海报详情" hidden data-space-panel>
    <div class="space-panel__card" hidden data-space-card><span class="space-panel__grip" aria-hidden="true" data-space-grip></span><button type="button" class="space-panel__close" aria-label="收起详情" data-space-close>×</button>
      <div class="space-panel__cover" data-space-cover></div><div class="space-panel__detail" data-space-detail></div>
      <div class="space-panel__actions"><form method="post" class="space-panel__chat" hidden data-space-chat><input type="hidden" name="_csrf" value="t" /><input type="hidden" name="hookId" value="" data-space-hook /><button type="submit" class="btn btn--primary space-panel__chat-button">想聊这个</button></form>
      <a class="space-panel__open" href="#" data-space-open><span data-space-open-label>看看 TA 的页面</span></a></div>
      <p class="space-panel__assist"><span>不知道找谁？</span><a href="#ask">问问这面墙</a></p></div>
  </aside></div>
  <p class="wall-board__none" hidden data-wall-none>没有找到</p>
</section>
<details class="wall-assist__section"><summary>问问这面墙</summary><section id="ask"><h2>问问这面墙</h2><p>问墙</p></section></details>
<dialog class="space-assist" data-space-assist-dialog><button type="button" class="space-assist__close" aria-label="关闭" data-space-assist-close>×</button><div class="space-assist__slot" data-space-assist-slot></div></dialog></div>`;

async function mount(page: Page, violations: string[]): Promise<void> {
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login');
  await page.evaluate((html) => {
    document.querySelector('main')!.innerHTML = html;
  }, WALL_HTML);
  await page.addStyleTag({ url: '/static/wall.css' });
  await page.addScriptTag({ url: '/static/wall.js' });
}

const offsetX = (page: Page) =>
  page.locator('[data-space-track]').evaluate((element) => {
    const match = /translate3d\((-?[\d.]+)px/.exec((element as HTMLElement).style.transform);
    return match ? Number(match[1]) : NaN;
  });

const transformOf = (page: Page) => page.locator('[data-space-track]').evaluate((element) => (element as HTMLElement).style.transform);

test('逛墙空间（桌面）：默认打开，右侧一栏是第一位成员；拖动、按钮、方向键都能移动墙面，拖动不会误点开海报', async ({ page }) => {
  const violations: string[] = [];
  await mount(page, violations);
  const board = page.locator('[data-wall-board]');
  await expect(board).toHaveClass(/is-space/);
  await expect(page.locator('html')).toHaveClass(/nm-wall-space/);
  await expect(page.locator('[data-space-hud]')).toBeVisible();
  await expect(page.locator('.wall-card__say').first()).toBeHidden();
  await expect(page.locator('.wall-card__tag').first()).toBeVisible();
  // 一进来就有人：第一位成员，不算“看过”
  await expect(page.locator('[data-space-card]')).toBeVisible();
  await expect(page.locator('[data-space-detail] .space-detail__name')).toHaveText(PEOPLE[0]!.name);
  await expect(page.locator('.wall-card').first()).toHaveClass(/is-selected/);
  await expect(page.locator('[data-space-explored]')).toHaveText('0');
  await expect(page.locator('[data-space-overview]')).toBeHidden();
  // 页面本身不滚动，只在墙面里拖动
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('hidden');

  const viewport = page.locator('[data-space-viewport]');
  await viewport.scrollIntoViewIfNeeded();
  // 14 张在桌面上一屏放得下：先放大，墙才有地方拖
  const zoomedFrom = await transformOf(page);
  await page.getByRole('button', { name: '放大' }).click();
  await page.getByRole('button', { name: '放大' }).click();
  await expect.poll(() => transformOf(page)).not.toBe(zoomedFrom);
  await page.waitForTimeout(500);
  const start = await offsetX(page);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => offsetX(page)).toBeLessThan(start - 100);
  await expect(page.locator('[data-space-detail] .space-detail__name')).toHaveText(PEOPLE[0]!.name);
  expect(page.url()).not.toContain('#/w/');

  const afterDrag = await offsetX(page);
  await page.getByRole('button', { name: '往前看' }).click();
  await expect.poll(() => offsetX(page)).toBeGreaterThan(afterDrag);

  await viewport.focus();
  const beforeKey = await offsetX(page);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => offsetX(page)).toBeLessThan(beforeKey);
  await expect(viewport).toHaveAttribute('role', 'region');
  expect(violations).toEqual([]);
});

test('逛墙空间（桌面）：点海报换人，展开接话点，“想聊这个”提交到该成员的 chat 路由；Esc 把焦点还给海报', async ({ page }) => {
  const violations: string[] = [];
  await mount(page, violations);
  const person = PEOPLE[2]!;
  const link = page.locator('.wall-card__link').nth(2);
  await link.click();
  expect(page.url()).not.toContain('#/w/');
  await expect(page.locator('[data-space-card]')).toBeVisible();
  await expect(page.locator('.wall-card').nth(2)).toHaveClass(/is-selected/);
  await expect(page.locator('.wall-card').first()).not.toHaveClass(/is-selected/);
  await expect(page.locator('[data-space-detail] .space-detail__name')).toHaveText(person.name);
  await expect(page.locator('[data-space-detail] .space-detail__name')).toBeFocused();
  await expect(page.locator('[data-space-cover] .wall-card__cover')).toHaveCount(1);

  const chat = page.locator('[data-space-chat]');
  await expect(chat).toBeVisible();
  await expect(chat).toHaveAttribute('action', `#/w/wal_test/p/${person.id}/chat`);
  await expect(page.locator('[data-space-hook]')).toHaveValue('hook-1');
  await page.getByRole('button', { name: person.hooks[1]! }).click();
  await expect(page.locator('[data-space-hook]')).toHaveValue('hook-2');
  await expect(page.getByRole('button', { name: person.hooks[1]! })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-space-open]')).toHaveAttribute('href', `#/w/wal_test/p/${person.id}`);
  await expect(page.locator('[data-space-explored]')).toHaveText('1');
  expect(await page.evaluate(() => localStorage.getItem('nowme:wall-explored:wal_test'))).toBe(JSON.stringify([person.id]));

  // 桌面上详情一直开着：Esc 只把焦点还给海报
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-space-card]')).toBeVisible();
  await expect(link).toBeFocused();

  // 自己的海报：没有“想聊这个”，入口写“看看我的页面”
  await page.locator('.wall-card__link').nth(1).click();
  await expect(chat).toBeHidden();
  await expect(page.locator('[data-space-open]')).toHaveText('看看我的页面');

  // 页面底部不再出现“问问这面墙”；从详情里打开，显示在对话框里，关掉后地址栏不留 #ask
  await expect(page.locator('details.wall-assist__section')).toBeHidden();
  await page.getByRole('link', { name: '问问这面墙' }).click();
  const dialog = page.getByRole('dialog', { name: '问问这面墙' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#ask')).toBeVisible();
  expect(page.url()).toMatch(/#ask$/);
  await page.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/#ask/);
  expect(violations).toEqual([]);
});

test('逛墙空间（桌面）：搜索后墙面按结果重新排布；选中的人被筛掉时换成第一位符合的人', async ({ page }) => {
  const violations: string[] = [];
  await mount(page, violations);
  await expect(page.locator('[data-space-detail] .space-detail__name')).toHaveText(PEOPLE[0]!.name);
  await page.getByRole('button', { name: '搜索墙上的人' }).click();
  await page.locator('[data-wall-search]').fill('成员1');
  await expect(page.locator('[data-wall-card]:visible')).toHaveCount(5); // 成员1、成员10–13
  await expect(page.locator('[data-space-detail] .space-detail__name')).toHaveText(PEOPLE[1]!.name);
  await expect(page.locator('[data-space-track]')).toHaveAttribute('style', /translate3d/);
  await page.locator('[data-wall-search]').fill('');
  await expect(page.locator('[data-wall-card]:visible')).toHaveCount(PEOPLE.length);
  expect(violations).toEqual([]);
});

test('逛墙空间（手机）：一屏约两列，拖动横竖都能逛；点海报镜头靠近并升起资料卡，收起后镜头回到原处；回到全墙', async ({ page }) => {
  const violations: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, violations);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.locator('[data-space-panel]');
  await expect(panel).not.toHaveClass(/is-open/);
  await expect(page.locator('[data-space-card]')).toBeHidden();
  await expect(page.locator('[data-space-overview]')).toBeVisible();
  await expect(page.getByRole('button', { name: '往前看' })).toBeHidden();

  // 一张海报大约占屏宽的四成
  const poster = (await page.locator('.wall-card').first().boundingBox())!;
  expect(poster.width).toBeGreaterThan(390 * 0.3);
  expect(poster.width).toBeLessThan(390 * 0.55);

  const viewport = page.locator('[data-space-viewport]');
  const before = await transformOf(page);
  await page.locator('.wall-card__link').nth(4).click();
  await expect(panel).toHaveClass(/is-open/);
  await expect(page.locator('[data-space-detail] .space-detail__name')).toHaveText(PEOPLE[4]!.name);
  await expect(page.locator('[data-space-cover] .wall-card__cover')).toHaveCount(0);
  await expect(page.locator('[data-space-chat]')).toBeVisible();
  await expect.poll(() => transformOf(page)).not.toBe(before);

  await page.getByRole('button', { name: '收起详情' }).click();
  await expect(panel).not.toHaveClass(/is-open/);
  await expect.poll(() => transformOf(page)).toBe(before);
  await expect(page.locator('.wall-card__link').nth(4)).toBeFocused();

  // 拖动：横竖都能逛，不会误点开海报
  const box = (await viewport.boundingBox())!;
  const start = await transformOf(page);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => transformOf(page)).not.toBe(start);
  await expect(panel).not.toHaveClass(/is-open/);

  // Esc 也能收起
  await page.getByRole('button', { name: '回到全墙' }).click();
  await page.locator('.wall-card__link').nth(5).click();
  await expect(panel).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveClass(/is-open/);

  // 回到全墙：整面墙都放进视野
  await page.getByRole('button', { name: '回到全墙' }).click();
  const stage = (await viewport.boundingBox())!;
  await expect
    .poll(async () => {
      const last = (await page.locator('.wall-card').last().boundingBox())!;
      return last.x + last.width <= stage.x + stage.width + 1 && last.x >= stage.x - 1;
    })
    .toBe(true);
  expect(page.url()).not.toContain('#/w/');
  expect(violations).toEqual([]);
});
