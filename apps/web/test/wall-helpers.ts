/**
 * 墙相关测试（T3.1）的种子工具：直接写入 accepted 版本与发布，不经过提交管线与发布流程（T3.2）。
 *
 * - `seedRevision`：插入一个 accepted 版本（revision 的原始 card），可选写入 `cover.png`；
 * - `seedPublication`：插入一条活跃发布（主人确认后的 card 与发布时的联系方式快照）；
 * - `publishedMember`：新用户加入墙、提交并发布，一步到位。
 *
 * 发布快照的格式与 services/wall-view.ts 的解析约定一致：card 同 card.json 字段；contact 为 null（不公开）或
 * `{ channel, value }`。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateId, type Card, type ValidationReport } from '@nowme/contracts';
import type { Page } from '../src/db/pages.js';
import type { Wall } from '../src/db/walls.js';
import { revisionDir } from '../src/services/revision-storage.js';
import { createUser, seedMember, TINY_PNG, type TestWeb } from './helpers.js';
import type { MemberPage } from '../src/services/walls.js';

export const OK_REPORT: ValidationReport = {
  ok: true,
  errors: [],
  warnings: [],
  stats: {
    indexHtmlBytes: 100,
    assetBytes: 0,
    assetCount: 0,
    blocks: ['hero', 'about', 'contact'],
    fontsUsed: [],
    cjkFontCount: 0,
    scriptOnlyChars: '',
    ignoredFiles: [],
  },
  validatorVersion: 'test',
};

export function makeCard(name: string, overrides: Partial<Card> = {}): Card {
  return {
    schemaVersion: 1,
    displayName: name,
    tagline: `${name}的一行介绍`,
    hooks: [
      { id: 'can-help', kind: 'can-help', text: `${name}能帮你做前端`, opener: `你好${name}，我看到你能帮忙做前端，想聊聊！` },
      { id: 'looking-for', kind: 'looking-for', text: `${name}在找设计队友`, opener: `嗨${name}，我是做设计的～` },
    ],
    ...overrides,
  };
}

/** 插入一个 accepted 版本，返回版本 ID。`cover: true` 时写入 revisions/<id>/cover.png。 */
export function seedRevision(t: TestWeb, page: Page, card: Card, options: { cover?: boolean } = {}): string {
  const id = generateId('rev');
  t.repos.revisions.insert({
    id,
    pageId: page.id,
    source: 'local-agent',
    credentialId: null,
    status: 'accepted',
    report: OK_REPORT,
    cardJson: JSON.stringify(card),
    manifestJson: JSON.stringify({ schemaVersion: 1, sceneType: 'hackathon', kitVersion: '1', motionLevel: 'calm', fonts: [], extraChars: '' }),
    renderedText: `${card.displayName} 渲染后的文字`,
    renderJson: '{}',
    createdAt: t.clock.now().toISOString(),
  });
  if (options.cover !== false) {
    const dir = revisionDir(t.dataDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cover.png'), TINY_PNG);
  }
  return id;
}

export interface SeedPublicationOptions {
  /** 主人确认后的 card（默认与版本相同）。 */
  card: Card;
  /** 发布时公开的联系方式；null 表示不公开。 */
  contact?: { channel: string; value: string } | null;
}

/** 插入一条活跃发布（先结束这一页旧的活跃发布：superseded），返回 publication ID。 */
export function seedPublication(t: TestWeb, page: Page, revisionId: string, options: SeedPublicationOptions): string {
  const id = generateId('pbl');
  const nowIso = t.clock.now().toISOString();
  t.db
    .prepare("UPDATE publications SET ended_at = ?, end_reason = 'superseded' WHERE page_id = ? AND ended_at IS NULL")
    .run(nowIso, page.id);
  t.db
    .prepare('INSERT INTO publications (id, page_id, revision_id, card_json, contact_json, published_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, page.id, revisionId, JSON.stringify(options.card), options.contact ? JSON.stringify(options.contact) : null, nowIso);
  return id;
}

/** 撤下（模拟 T3.2）：活跃发布以 withdrawn 结束。 */
export function withdraw(t: TestWeb, page: Page): void {
  t.db
    .prepare("UPDATE publications SET ended_at = ?, end_reason = 'withdrawn' WHERE page_id = ? AND ended_at IS NULL")
    .run(t.clock.now().toISOString(), page.id);
}

export interface PublishedMember extends MemberPage {
  userId: string;
  revisionId: string;
  publicationId: string;
  /** 墙上应该显示的（主人确认后的）card。 */
  card: Card;
}

/**
 * 已有用户（或新建用户）加入墙并发布。版本里的原始 card 与发布的 card 故意不同（tagline 带“原始”字样），
 * 用来断言墙上用的是确认后的 card。
 */
export function publishedMember(
  t: TestWeb,
  wall: Wall,
  options: { userId?: string; email?: string; name: string; contact?: { channel: string; value: string } | null; cover?: boolean; card?: Card },
): PublishedMember {
  const userId = options.userId ?? createUser(t, options.email ?? `${generateId('usr').slice(4, 14)}@example.com`, options.name);
  const member = seedMember(t, wall, userId);
  return publishPage(t, member, options.name, { contact: options.contact, cover: options.cover, userId, card: options.card });
}

/** 给已有成员的页面提交并发布一个版本。 */
export function publishPage(
  t: TestWeb,
  member: MemberPage,
  name: string,
  options: { contact?: { channel: string; value: string } | null; cover?: boolean; userId?: string; card?: Card } = {},
): PublishedMember {
  const card = options.card ?? makeCard(name);
  const revisionId = seedRevision(t, member.page, { ...card, tagline: `原始介绍：${name}未确认的草稿` }, { cover: options.cover });
  const publicationId = seedPublication(t, member.page, revisionId, { card, contact: options.contact ?? null });
  return { ...member, userId: options.userId ?? member.membership.userId, revisionId, publicationId, card };
}
