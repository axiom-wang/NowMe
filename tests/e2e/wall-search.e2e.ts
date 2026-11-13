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
  <div class="section-head"><span data-wall-count>4</span>
    <label class="wall-search"><input type="search" data-wall-search /></label></div>
  <ul class="wall-grid">
    <li class="wall-ghost"><a class="wall-ghost__link" href="#">这里留给你</a></li>
    ${CARDS.map((card) => `<li class="wall-card" data-wall-card data-search="${card.search}"><a class="wall-card__link" href="#">${card.name}</a></li>`).join('')}
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
  await page.addScriptTag({ url: '/static/wall.js' });

  const visible = () => page.locator('[data-wall-card]:visible').allTextContents();
  const input = page.locator('[data-wall-search]');
  expect(await visible()).toEqual(['林舟', '苏晴', '阿岚', '栗子']);

  await input.fill('后端');
  expect(await visible()).toEqual(['林舟', '苏晴']);
  await expect(page.locator('[data-wall-count]')).toHaveText('2');
  await expect(page.locator('.wall-ghost')).toBeHidden();
  await expect(page.locator('[data-wall-none]')).toBeHidden();

  // 大小写不敏感；多个词取交集
  await input.fill('后端  AI');
  expect(await visible()).toEqual(['苏晴']);

  await input.fill('不存在的话题');
  expect(await visible()).toEqual([]);
  await expect(page.locator('[data-wall-count]')).toHaveText('0');
  await expect(page.locator('[data-wall-none]')).toBeVisible();

  await input.fill('');
  expect(await visible()).toEqual(['林舟', '苏晴', '阿岚', '栗子']);
  await expect(page.locator('[data-wall-count]')).toHaveText('4');
  await expect(page.locator('.wall-ghost')).toBeVisible();
  await expect(page.locator('[data-wall-none]')).toBeHidden();
  expect(violations).toEqual([]);
});
