/**
 * 全流程：组织者建墙 → 成员 A 用真实 CLI 取情境、提交示例页 → A 在工作区发布确认 → 成员 B 在墙上看到并聊 →
 * 组织者后台只看到发布状态 → A 开公开链接 → A 撤下后卡片消失、公开链接 404。
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { EXAMPLES, PAGES_ORIGIN, WEB_ORIGIN, createWall, generateInstruction, joinWall, newUser, publishViaUi, runCli } from './helpers.js';

test('全流程：建墙、CLI 提交、发布确认、浏览与接话、组织者后台、公开链接、撤下', async ({ browser }) => {
  const work = mkdtempSync(join(tmpdir(), 'nowme-e2e-'));
  const home = join(work, 'home');
  const newTagline = '确认后的介绍：想找一位会做视觉和交互的搭档';
  try {
    // 1. 组织者登录、建墙、拿邀请链接
    const organizerContext = await browser.newContext();
    const organizer = await newUser(organizerContext, 'organizer', '组织者');
    const { wallId, inviteUrl } = await createWall(organizer.page, 'e2e 黑客松');

    // 2. 成员 A 加入，生成指令
    const aContext = await browser.newContext();
    const a = await newUser(aContext, 'member-a', '成员A');
    await joinWall(a.page, inviteUrl);
    const { token } = await generateInstruction(a.page, wallId);

    // 3. 真实 CLI：fetch → 复制示例页 → submit
    const fetched = await runCli(['fetch', wallId, token, '--server', WEB_ORIGIN], { cwd: work, home });
    expect(fetched.code, fetched.stdout + fetched.stderr).toBe(0);
    cpSync(join(EXAMPLES, 'hackathon-terminal'), join(work, 'page'), { recursive: true });
    rmSync(join(work, 'page', 'DESIGN.md'), { force: true });
    const submitted = await runCli(['submit', 'page'], { cwd: work, home });
    expect(submitted.code, submitted.stdout + submitted.stderr).toBe(0);
    expect(submitted.stdout + submitted.stderr).not.toContain('nmc_');

    // 4. A 在工作区看到第 1 版并发布确认（改写介绍、公开联系方式）
    await a.page.goto(`/w/${wallId}/me`);
    await expect(a.page.locator('iframe[data-nm-page-frame]')).toBeVisible();
    await publishViaUi(a.page, wallId, { tagline: newTagline, contactValue: 'linzhou_e2e', contactPublic: true });
    await expect(a.page.getByText('已发布').first()).toBeVisible();

    // 5. 成员 B 加入，在墙上看到 A 的卡片（确认后的介绍）
    const bContext = await browser.newContext();
    const b = await newUser(bContext, 'member-b', '成员B');
    await joinWall(b.page, inviteUrl);
    await b.page.goto(`/w/${wallId}`);
    const card = b.page.locator('.wall-card', { hasText: newTagline });
    await expect(card).toHaveCount(1);
    await expect(b.page.locator('.wall-card')).toHaveCount(1);

    // 6. 打开 A 的页面：沙箱 iframe 里页面在运行
    await card.locator('a.wall-card__link').click();
    const iframe = b.page.locator('iframe[data-nm-page-frame]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(iframe).toHaveAttribute('src', new RegExp(`^${PAGES_ORIGIN}/v/`));
    await expect(b.page.frameLocator('iframe[data-nm-page-frame]').locator('body')).toContainText('林舟');

    // 7. 想聊这个：联系方式与开场白
    await b.page.getByRole('button', { name: '想聊这个' }).first().click();
    await expect(b.page.locator('#nm-chat-contact')).toHaveText('linzhou_e2e');
    await expect(b.page.locator('#nm-chat-opener')).not.toBeEmpty();

    // 8. 组织者后台：A 已发布，看不到私密内容
    await organizer.page.goto(`/w/${wallId}/admin`);
    const row = organizer.page.locator('.member-row', { hasText: '成员A' });
    await expect(row).toContainText('已发布');
    const adminHtml = await organizer.page.content();
    for (const secret of ['linzhou_e2e', newTagline, 'rev_']) expect(adminHtml).not.toContain(secret);

    // 9. A 开公开链接；未登录的上下文能打开页面，但没有联系方式
    await a.page.goto(`/w/${wallId}/me`);
    await a.page.getByRole('button', { name: '开启公开链接' }).click();
    const publicUrl = (await a.page.locator('#nm-public-link').textContent())?.trim() ?? '';
    expect(publicUrl).toContain('/s/');
    const anonymous = await browser.newContext();
    const anonPage = await anonymous.newPage();
    const publicResponse = await anonPage.goto(publicUrl);
    expect(publicResponse?.status()).toBe(200);
    await expect(anonPage.frameLocator('iframe[data-nm-page-frame]').locator('body')).toContainText('林舟');
    await expect(anonPage.locator('body')).not.toContainText('linzhou_e2e');
    await expect(anonPage.getByRole('button', { name: '想聊这个' })).toHaveCount(0);

    // 10. A 撤下：B 的墙上卡片消失，公开链接 404
    a.page.on('dialog', (dialog) => void dialog.accept());
    await a.page.goto(`/w/${wallId}/me`);
    await a.page.getByRole('button', { name: '从墙上撤下' }).click();
    await expect(a.page.getByText('已从墙上撤下').first()).toBeVisible();
    await b.page.goto(`/w/${wallId}`);
    await expect(b.page.locator('.wall-card')).toHaveCount(0);
    const gone = await anonPage.goto(publicUrl);
    expect(gone?.status()).toBe(404);

    await Promise.all([organizerContext, aContext, bContext, anonymous].map((context) => context.close()));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
