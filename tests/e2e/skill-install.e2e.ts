/**
 * 真实用户安装 NOWMe Skill（T3.6，contracts 4.5）：手里没有 NOWMe 仓库，只有主站。
 *
 * 1. 工作区里看到「安装 NOWMe Skill」，里面是主站的真实地址，没有 token；
 * 2. 按 install.md：下载 manifest 与 Skill 包，核对 sha256，用系统 tar 解压；
 * 3. 用 Skill 包里自带的单文件 CLI（不是仓库里的源码 CLI）：--version → fetch → validate → preview（服务端渲染）→ submit；
 * 4. 工作区显示新版本，连接状态里有 Skill 版本。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { EXAMPLES, WEB_ORIGIN, createWall, generateInstruction, joinWall, newUser, type CliResult } from './helpers.js';

function run(file: string, args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CliResult> {
  return new Promise((resolveRun) => {
    execFile(file, args, { cwd: options.cwd, env: { PATH: process.env.PATH ?? '', ...options.env }, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolveRun({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

test('真实用户：按工作区说明安装 Skill，用 Skill 自带的命令行走完 fetch → validate → 服务端预览 → submit', async ({ browser }) => {
  const root = mkdtempSync(join(tmpdir(), 'nowme-e2e-skill-'));
  const home = join(root, 'home');
  const skillsDir = join(root, 'agent-skills');
  const work = join(root, 'work');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  try {
    // 1. 组织者建墙，成员加入并生成指令；安装说明里是真实地址、没有 token
    const organizerContext = await browser.newContext();
    const organizer = await newUser(organizerContext, 'skill-organizer', '组织者');
    const { wallId, inviteUrl } = await createWall(organizer.page, 'Skill 安装 e2e');
    const memberContext = await browser.newContext();
    const member = await newUser(memberContext, 'skill-member', '新成员');
    await joinWall(member.page, inviteUrl);

    await member.page.goto(`/w/${wallId}/me`);
    const guide = member.page.locator('#skill-install');
    await expect(guide).toHaveAttribute('open', '');
    await expect(member.page.locator('#nm-skill-install')).toContainText(`${WEB_ORIGIN}/skill/install.md`);
    await expect(guide).toContainText('Unknown command: /nowme-page');
    const { token } = await generateInstruction(member.page, wallId);
    expect(await member.page.locator('#skill-install').innerHTML()).not.toContain(token);

    // 2. 按 install.md 下载并核对 Skill 包
    const doc = await (await fetch(`${WEB_ORIGIN}/skill/install.md`)).text();
    const manifest = (await (await fetch(`${WEB_ORIGIN}/skill/manifest.json`)).json()) as { url: string; sha256: string; file: string; version: string };
    expect(doc).toContain(manifest.url);
    const archive = Buffer.from(await (await fetch(manifest.url)).arrayBuffer());
    expect(createHash('sha256').update(archive).digest('hex')).toBe(manifest.sha256);
    writeFileSync(join(root, manifest.file), archive);
    const untar = await run('tar', ['-xzf', join(root, manifest.file), '-C', skillsDir], { cwd: root });
    expect(untar.code, untar.stderr).toBe(0);
    const skillDir = join(skillsDir, 'nowme-page');
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(readdirSync(skillDir).sort()).toEqual(['SKILL.md', 'examples', 'reference', 'scenes', 'scripts', 'templates']);

    // 3. 自检
    const cli = join(skillDir, 'scripts', 'nowme.mjs');
    const nowme = (args: string[]) => run(process.execPath, [cli, ...args], { cwd: work, env: { NOWME_HOME: home } });
    const version = await nowme(['--version']);
    expect(version.stdout.trim()).toBe(`nowme 0.1.0 · NOWMe Skill ${manifest.version}`);

    // 4. 用 Skill 自带的命令行走完流程
    const fetched = await nowme(['fetch', wallId, token, '--server', WEB_ORIGIN]);
    expect(fetched.code, fetched.stdout + fetched.stderr).toBe(0);
    cpSync(join(EXAMPLES, 'hackathon-terminal'), join(work, 'page'), { recursive: true });
    rmSync(join(work, 'page', 'DESIGN.md'), { force: true });
    rmSync(join(work, 'page', 'cover.png'), { force: true });

    const validated = await nowme(['validate', 'page']);
    expect(validated.code, validated.stdout + validated.stderr).toBe(0);

    const previewed = await nowme(['preview', 'page']);
    expect(previewed.code, previewed.stdout + previewed.stderr).toBe(0);
    expect(previewed.stdout).toContain('服务端渲染');
    expect(existsSync(join(work, '.nowme-preview', 'full.png'))).toBe(true);
    expect(existsSync(join(work, 'page', 'cover.png'))).toBe(true);

    const submitted = await nowme(['submit', 'page']);
    expect(submitted.code, submitted.stdout + submitted.stderr).toBe(0);
    const output = [fetched, validated, previewed, submitted].map((r) => r.stdout + r.stderr).join('\n');
    expect(output).not.toMatch(/nmc_[A-Za-z0-9_-]{16,}/);

    // 5. 工作区：只有提交的那一个版本（预览没有生成版本），显示 Skill 版本
    await member.page.goto(`/w/${wallId}/me`);
    await expect(member.page.locator('.revision')).toHaveCount(1);
    await expect(member.page.locator('iframe[data-nm-page-frame]')).toBeVisible();
    await expect(member.page.locator('.ws-agent')).toContainText('Skill 版本');
    await expect(member.page.locator('.ws-agent')).toContainText(manifest.version);
    await expect(member.page.locator('#skill-install')).not.toHaveAttribute('open', '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
