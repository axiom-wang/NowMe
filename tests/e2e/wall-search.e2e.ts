/**
 * 墙上的搜索（static/wall.js）：在浏览器里按名字、介绍、接话点筛选已加载的卡片。
 * 用主站的真实脚本与样式跑在一段与墙页面相同结构的文档上（主站 CSP 下加载），不需要先造出一面有很多人的墙。
 */
import { expect, test } from '@playwright/test';

const CARDS = [
  { name: '林舟', search: '林舟 全栈偏后端 找一位会做视觉和交互的设计 我能帮你把接口和数据库搭起来' },
  { name: '苏晴', search: '苏晴 产品 + 交互设计 找一位后端 懂 ai 的开发' },
  { name: '阿岚', search: '阿岚 只淘有前主人痕迹的二手黑胶 推荐你听大贯妙子' },
  { name: '栗子', search: '栗子 凌晨四点去菜市场 用胶片拍摊主的手' },
];

const WALL_HTML = `<section class="wall-board" data-wall-board>
  <div class="section-head wall-board__head"><div class="wall-board__heading"><h2 class="section-title">墙上的人</h2><span class="wall-board__population"><span class="section-head__count" data-wall-count>4</span><span class="section-head__note" data-wall-count-note>位已上墙</span></span><div class="wall-board__tools"><a class="wall-board__assist-link" href="#intros">AI 帮我找人</a><a class="wall-board__assist-link" href="#ask">问问这面墙</a></div></div><div class="wall-board__meta" data-wall-summary><span>共 10 位成员</span><span>每次进来顺序都不一样</span></div>
    <label class="wall-search"><input type="search" data-wall-search /></label></div>
  <button type="button" aria-pressed="false" data-filter="0:0">设计</button>
  <button type="button" hidden data-filter-clear>清除筛选</button>
  <ul class="wall-grid">
    <li class="wall-ghost"><a class="wall-ghost__link" href="#">这里留给你</a></li>
    ${CARDS.map((card, index) => `<li class="wall-card" data-wall-card data-search="${card.search}" data-answers="${index < 2 ? '0:0' : ''}"><a class="wall-card__link" href="#">${card.name}</a></li>`).join('')}
  </ul>
  <p class="wall-board__none" hidden data-wall-none>墙上没有找到相关的人。</p>
</section>`;

test('墙上搜索：多个词都命中才显示，数量与空结果提示同步，清空后恢复', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  await page.goto('/login');
  await page.evaluate((html) => {
    document.querySelector('main')!.innerHTML = html;
  }, WALL_HTML);
  await page.addStyleTag({ url: '/static/wall.css' });
  await page.addScriptTag({ url: '/static/wall.js' });

  const visible = () => page.locator('[data-wall-card]:visible').allTextContents();
  const input = page.locator('[data-wall-search]');
  const count = page.locator('[data-wall-count]');
  const countNote = page.locator('[data-wall-count-note]');
  for (const width of [320, 390, 450, 640, 768, 1000, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const numberBox = (await count.boundingBox())!;
    const unitBox = (await countNote.boundingBox())!;
    expect(Math.abs(numberBox.y + numberBox.height / 2 - unitBox.y - unitBox.height / 2), `${width}px 数量与单位同行`).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 无溢出`).toBe(true);
  }
  expect(await visible()).toEqual(['林舟', '苏晴', '阿岚', '栗子']);

  await input.fill('后端');
  expect(await visible()).toEqual(['林舟', '苏晴']);
  await expect(count).toHaveText('2');
  await expect(countNote).toHaveText('位符合条件');
  await expect(page.locator('[data-wall-summary]')).toBeHidden();
  await expect(page.locator('.wall-ghost')).toBeHidden();
  await expect(page.locator('[data-wall-none]')).toBeHidden();

  // 大小写不敏感；多个词取交集
  await input.fill('后端  AI');
  expect(await visible()).toEqual(['苏晴']);

  await input.fill('不存在的话题');
  expect(await visible()).toEqual([]);
  await expect(count).toHaveText('0');
  await expect(countNote).toHaveText('位符合条件');
  await expect(page.locator('[data-wall-summary]')).toBeHidden();
  await expect(page.locator('[data-wall-none]')).toBeVisible();

  await input.fill('');
  expect(await visible()).toEqual(['林舟', '苏晴', '阿岚', '栗子']);
  await expect(count).toHaveText('4');
  await expect(countNote).toHaveText('位已上墙');
  await expect(page.locator('[data-wall-summary]')).toBeVisible();
  await expect(page.locator('.wall-ghost')).toBeVisible();
  await expect(page.locator('[data-wall-none]')).toBeHidden();

  await page.getByRole('button', { name: '设计', exact: true }).click();
  expect(await visible()).toEqual(['林舟', '苏晴']);
  await expect(count).toHaveText('2');
  await expect(countNote).toHaveText('位符合条件');
  await expect(page.locator('[data-wall-summary]')).toBeHidden();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(count).toHaveText('4');
  await expect(countNote).toHaveText('位已上墙');
  await expect(page.locator('[data-wall-summary]')).toBeVisible();
  expect(violations).toEqual([]);
});
