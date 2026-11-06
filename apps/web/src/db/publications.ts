/**
 * `publications` 表（contracts 3）：不可变快照；每页至多一个 `ended_at IS NULL`。
 *
 * - 发布（T3.2）：旧的活跃发布以 `superseded` 结束，再插入新的；撤下 `withdrawn`；删除页面 `deleted`。
 *   T3.1 的移除成员（`removed`）、关闭墙（`closed`）同样用 `endActive(pageId, reason, now)`。
 * - `card_json`：主人在发布确认中确认后的缩略卡，结构与 card.json 相同（`cardSchema`）。
 *   **墙上只能显示这里的内容**，不能显示版本里未经确认的 card.json。
 * - `contact_json`：发布时的联系方式快照 `{ "channel": "wechat", "value": "..." }`；主人不公开时为 null。
 * - 删除页面（墓碑语义，build-plan 决策记录）：所有发布记录的 `card_json` 置为 `DELETED_CARD_JSON`（`{"deleted":true}`）、
 *   `contact_json` 置空；这些记录不再算作“发布历史”（展示状态回到 unpublished）。
 */
import { cardSchema, type Card } from '@nowme/contracts';
import type { Database } from './database.js';

export type PublicationEndReason = 'superseded' | 'withdrawn' | 'removed' | 'closed' | 'deleted';

export interface Publication {
  id: string;
  pageId: string;
  revisionId: string;
  cardJson: string;
  contactJson: string | null;
  publishedAt: string;
  endedAt: string | null;
  endReason: PublicationEndReason | null;
}

/** 页面的展示状态（contracts 3：由数据推导）。 */
export type PageDisplayState = 'published' | 'withdrawn' | 'unpublished';

/** 删除页面后发布记录的 `card_json`（`card_json` 列不能为空；不是合法的缩略卡，解析结果为 null）。 */
export const DELETED_CARD_JSON = '{"deleted":true}';

/** 联系方式的渠道（发布确认表单的选项；`contact_json.channel` 与 `pages.contact_channel` 的取值）。 */
export const CONTACT_CHANNELS = ['wechat', 'qq', 'email', 'phone', 'other'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_CHANNEL_LABELS: Readonly<Record<ContactChannel, string>> = {
  wechat: '微信',
  qq: 'QQ',
  email: '邮箱',
  phone: '手机',
  other: '其他',
};

export function isContactChannel(value: unknown): value is ContactChannel {
  return typeof value === 'string' && (CONTACT_CHANNELS as readonly string[]).includes(value);
}

/** `contact_json` 的结构。 */
export interface PublishedContact {
  channel: ContactChannel;
  value: string;
}

/** 解析发布记录的 `card_json`；删除后的墓碑或格式不对时返回 null。 */
export function parsePublishedCard(cardJson: string): Card | null {
  if (cardJson === DELETED_CARD_JSON) return null;
  try {
    const result = cardSchema.safeParse(JSON.parse(cardJson));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** 解析发布记录的 `contact_json`；不公开（null）或格式不对时返回 null。 */
export function parsePublishedContact(contactJson: string | null): PublishedContact | null {
  if (!contactJson) return null;
  try {
    const value = JSON.parse(contactJson) as Partial<PublishedContact> | null;
    if (!value || !isContactChannel(value.channel) || typeof value.value !== 'string' || value.value.length === 0) return null;
    return { channel: value.channel, value: value.value };
  } catch {
    return null;
  }
}

interface PublicationRow {
  id: string;
  page_id: string;
  revision_id: string;
  card_json: string;
  contact_json: string | null;
  published_at: string;
  ended_at: string | null;
  end_reason: PublicationEndReason | null;
}

function toPublication(row: PublicationRow | undefined): Publication | null {
  if (!row) return null;
  return {
    id: row.id,
    pageId: row.page_id,
    revisionId: row.revision_id,
    cardJson: row.card_json,
    contactJson: row.contact_json,
    publishedAt: row.published_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

export interface CreatePublicationInput {
  id: string;
  pageId: string;
  revisionId: string;
  cardJson: string;
  contactJson: string | null;
  publishedAt: string;
}

export function createPublicationsRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO publications (id, page_id, revision_id, card_json, contact_json, published_at, ended_at, end_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  const byId = db.prepare('SELECT * FROM publications WHERE id = ?');
  const active = db.prepare('SELECT * FROM publications WHERE page_id = ? AND ended_at IS NULL');
  const endActive = db.prepare(
    'UPDATE publications SET ended_at = ?, end_reason = ? WHERE page_id = ? AND ended_at IS NULL RETURNING *',
  );
  const history = db.prepare('SELECT 1 AS x FROM publications WHERE page_id = ? AND card_json <> ? LIMIT 1');
  const latestEnded = db.prepare(
    `SELECT * FROM publications WHERE page_id = ? AND ended_at IS NOT NULL AND card_json <> ?
      ORDER BY ended_at DESC, rowid DESC LIMIT 1`,
  );
  const latestForRevision = db.prepare(
    `SELECT * FROM publications WHERE revision_id = ? AND card_json <> ?
      ORDER BY published_at DESC, rowid DESC LIMIT 1`,
  );
  const eraseForPage = db.prepare('UPDATE publications SET card_json = ?, contact_json = NULL WHERE page_id = ?');

  return {
    create(input: CreatePublicationInput): Publication {
      insert.run(input.id, input.pageId, input.revisionId, input.cardJson, input.contactJson, input.publishedAt);
      return { ...input, endedAt: null, endReason: null };
    },
    findById(id: string): Publication | null {
      return toPublication(byId.get(id) as PublicationRow | undefined);
    },
    findActiveForPage(pageId: string): Publication | null {
      return toPublication(active.get(pageId) as PublicationRow | undefined);
    },
    /** 结束该页的活跃发布，返回被结束的那条（没有活跃发布时返回 null）。 */
    endActive(pageId: string, reason: PublicationEndReason, now: string): Publication | null {
      return toPublication(endActive.get(now, reason, pageId) as PublicationRow | undefined);
    },
    /** 最近一次结束的发布（不含删除后的墓碑），用于显示“何时撤下”。 */
    findLatestEndedForPage(pageId: string): Publication | null {
      return toPublication(latestEnded.get(pageId, DELETED_CARD_JSON) as PublicationRow | undefined);
    },
    /** 某个版本最近一次发布（不含墓碑）：恢复旧版本时预填主人上次确认的缩略卡。 */
    findLatestForRevision(revisionId: string): Publication | null {
      return toPublication(latestForRevision.get(revisionId, DELETED_CARD_JSON) as PublicationRow | undefined);
    },
    /** 删除页面：清空该页所有发布记录的缩略卡与联系方式（记录本身保留为墓碑）。返回清空的条数。 */
    eraseContentForPage(pageId: string): number {
      return Number(eraseForPage.run(DELETED_CARD_JSON, pageId).changes);
    },
    /** 有活跃发布 → published；有发布历史（不含删除后的墓碑）但当前无 → withdrawn；否则 unpublished。 */
    displayState(pageId: string): PageDisplayState {
      if (active.get(pageId)) return 'published';
      return history.get(pageId, DELETED_CARD_JSON) ? 'withdrawn' : 'unpublished';
    },
  };
}

export type PublicationsRepo = ReturnType<typeof createPublicationsRepo>;
