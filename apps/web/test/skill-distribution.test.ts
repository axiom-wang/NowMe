/**
 * Skill 分发（contracts 4.5）：/skill 安装页、install.md、manifest.json、归档下载；exchange 自报版本。
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateToken, type ExchangeResponse, type SkillPackageManifest } from '@nowme/contracts';
import {
  createTestWeb,
  createUser,
  exchange,
  get,
  issueInstruction,
  postJson,
  seedWall,
  TEST_SKILL_VERSION,
  writeTestSkillPackage,
  type TestWeb,
} from './helpers.js';

let t: TestWeb;
afterEach(async () => {
  await t.close();
});

describe('Skill 分发路由', () => {
  it('GET /skill：公开安装页（不需要登录），给出让 Agent 安装的一句话、重开会话、自检、Unknown command 说明', async () => {
    t = createTestWeb();
    const response = await get(t, '/skill');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('给你的 Agent 装上 NOWMe Skill');
    expect(html).toContain(`请按 https://raw.githubusercontent.com/axiom-wang/nowme-skill/main/install.md 的说明安装 NOWMe Skill（版本 ${TEST_SKILL_VERSION}）`);
    expect(html).toContain('重新打开一个会话');
    expect(html).toContain(`NOWMe Skill ${TEST_SKILL_VERSION}`);
    expect(html).toContain('Unknown command: /nowme-page');
    expect(html).toContain(`https://github.com/axiom-wang/nowme-skill/releases/download/v${TEST_SKILL_VERSION}/nowme-page-${TEST_SKILL_VERSION}.tar.gz`);
    expect(html).toContain('data-copy="nm-skill-install"');
    expect(html).toContain('data-copy="nm-skill-check"');
    // 通用写法：不点名任何 Agent 产品
    expect(html).not.toMatch(/Claude Code|Cursor|Codex|Copilot|\.claude\//);
  });

  it('GET /skill/install.md：text/markdown，地址独立于 NOWME_WEB_ORIGIN，使用 GitHub；含 sha256、目录名、重开会话与自检', async () => {
    t = createTestWeb({ env: { NOWME_WEB_ORIGIN: 'https://nowme.example', NOWME_PAGES_ORIGIN: 'https://pages.nowme-pages.example' } });
    const response = await get(t, '/skill/install.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const doc = await response.text();
    const manifest = (await (await get(t, '/skill/manifest.json')).json()) as SkillPackageManifest;
    expect(doc).toContain(`https://github.com/axiom-wang/nowme-skill/releases/download/v${TEST_SKILL_VERSION}/nowme-page-${TEST_SKILL_VERSION}.tar.gz`);
    expect(doc).toContain(manifest.sha256);
    expect(doc).toContain('`nowme-page/`');
    expect(doc).toContain('不要猜');
    expect(doc).toContain('重开一个会话');
    expect(doc).toContain('scripts/nowme.mjs --version');
    expect(doc).not.toContain('https://nowme.example/skill/');
    expect(doc).not.toMatch(/Claude Code|\.claude\//);
  });

  it('GET /skill/manifest.json：带绝对下载地址；归档的 sha256 与大小一致，长缓存；文件名不对 404', async () => {
    t = createTestWeb();
    const manifest = (await (await get(t, '/skill/manifest.json')).json()) as SkillPackageManifest;
    expect(manifest).toMatchObject({ name: 'nowme-page', version: TEST_SKILL_VERSION, url: `https://github.com/axiom-wang/nowme-skill/releases/download/v${TEST_SKILL_VERSION}/${manifest.file}` });
    const archive = await get(t, `/skill/${manifest.file}`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toBe('application/gzip');
    expect(archive.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(archive.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await archive.arrayBuffer());
    expect(bytes.byteLength).toBe(manifest.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
    for (const path of ['/skill/nowme-page-9.9.9.tar.gz', '/skill/manifest', '/skill/..%2Fpackage.json']) {
      expect((await get(t, path)).status).toBe(404);
    }
  });

  it('配置了市场渠道才显示市场安装命令', async () => {
    t = createTestWeb();
    expect(await (await get(t, '/skill')).text()).not.toContain('从 SkillHub 安装');
    await t.close();
    t = createTestWeb({ env: { NOWME_SKILL_MARKET_LABEL: 'SkillHub', NOWME_SKILL_MARKET_COMMAND: 'npx skills add nowme/nowme-page' } });
    expect(await (await get(t, '/skill')).text()).toContain('从 SkillHub 安装');
    expect(await (await get(t, '/skill/install.md')).text()).toContain('npx skills add nowme/nowme-page');
  });

  it('没有本地 Skill 包：仍提供 GitHub 安装入口；本地 manifest 404', async () => {
    t = createTestWeb({ skillPackageDir: null });
    const html = await (await get(t, '/skill')).text();
    expect(html).toContain('仍可从 GitHub 安装');
    expect(html).toContain('npx skills add axiom-wang/nowme-skill');
    expect(html).toContain('pnpm --filter @nowme/skill pack:skill');
    expect((await get(t, '/skill/manifest.json')).status).toBe(404);
    expect(await (await get(t, '/skill/install.md')).text()).toContain('https://github.com/axiom-wang/nowme-skill');
  });

  it('Skill 包的 sha256 对不上：当作没有 Skill 包', async () => {
    const dir = writeTestSkillPackage('0.2.0');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/nowme-page-0.2.0.tar.gz`, 'tampered');
    t = createTestWeb({ skillPackageDir: dir });
    expect((await get(t, '/skill/manifest.json')).status).toBe(404);
  });
});

describe('exchange 自报版本', () => {
  it('带 client：存进凭证记录；不带也能换取；context.skill 给出最新版本与安装页', async () => {
    t = createTestWeb();
    const { wall, page } = seedWall(t, createUser(t, 'owner@example.com'));
    const instruction = issueInstruction(t, wall, page);
    const response = await postJson(t, '/api/agent/exchange', {
      wallId: wall.id,
      token: instruction.token,
      client: { cliVersion: '0.1.0', skillVersion: '0.0.9' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ExchangeResponse;
    expect(body.context.skill).toEqual({ version: TEST_SKILL_VERSION, installUrl: 'https://github.com/axiom-wang/nowme-skill' });
    expect(t.repos.credentials.findActiveForPage(page.id)).toMatchObject({ clientCliVersion: '0.1.0', clientSkillVersion: '0.0.9' });

    const again = issueInstruction(t, wall, page);
    expect((await exchange(t, wall.id, again.token)).status).toBe(200);
    expect(t.repos.credentials.findActiveForPage(page.id)).toMatchObject({ clientCliVersion: null, clientSkillVersion: null });
  });

  it('client 格式不对：400 BAD_REQUEST，token 没有被使用（之后用正常请求还能换取）', async () => {
    t = createTestWeb();
    const { wall, page } = seedWall(t, createUser(t, 'owner@example.com'));
    const instruction = issueInstruction(t, wall, page);
    const bad = await postJson(t, '/api/agent/exchange', {
      wallId: wall.id,
      token: instruction.token,
      client: { cliVersion: '<script>', skillVersion: null },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string; message: string } }).error.message).toContain('token 没有被使用');
    expect((await exchange(t, wall.id, instruction.token)).status).toBe(200);
  });

  it('token 格式不对时仍是 TOKEN_INVALID（即使同时带了 client）', async () => {
    t = createTestWeb();
    const { wall } = seedWall(t, createUser(t, 'owner@example.com'));
    const response = await postJson(t, '/api/agent/exchange', {
      wallId: wall.id,
      token: generateToken('pageCredential'),
      client: { cliVersion: 'bad', skillVersion: null },
    });
    expect(response.status).toBe(401);
  });
});
