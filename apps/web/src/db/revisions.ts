/**
 * `revisions` 表（contracts 3、4.1）：number 页内递增（accepted 与 rejected 共用一个序列）。
 * 文件在 `<dataDir>/revisions/<id>/`（见 services/revision-storage.ts）；rejected 只存报告。
 */
import type { RevisionStatus, ValidationReport } from '@nowme/contracts';
import type { Database } from './database.js';

/** 版本来源：本地 Agent 提交 / 平台托管生成（contracts 9）/ 主人直接改文字（contracts 22）。 */
export type RevisionSource = 'local-agent' | 'hosted' | 'owner-edit';

export interface Revision {
  id: string;
  pageId: string;
  number: number;
  source: RevisionSource;
  credentialId: string | null;
  status: RevisionStatus;
  report: ValidationReport;
  /** accepted 时为提交的 card.json（已通过 schema 校验）；rejected 为 null。 */
  cardJson: string | null;
  manifestJson: string | null;
  renderedText: string | null;
  renderJson: string | null;
  createdAt: string;
}

/** 版本列表用的摘要（不含渲染文字等大字段）。 */
export type RevisionListItem = Omit<Revision, 'renderedText' | 'renderJson' | 'manifestJson'>;

interface RevisionRow {
  id: string;
  page_id: string;
  number: number;
  source: RevisionSource;
  credential_id: string | null;
  status: RevisionStatus;
  report_json: string;
  card_json: string | null;
  manifest_json?: string | null;
  rendered_text?: string | null;
  render_json?: string | null;
  created_at: string;
}

function toRevision(row: RevisionRow): Revision {
  return {
    id: row.id,
    pageId: row.page_id,
    number: Number(row.number),
    source: row.source,
    credentialId: row.credential_id,
    status: row.status,
    report: JSON.parse(row.report_json) as ValidationReport,
    cardJson: row.card_json,
    manifestJson: row.manifest_json ?? null,
    renderedText: row.rendered_text ?? null,
    renderJson: row.render_json ?? null,
    createdAt: row.created_at,
  };
}

export interface InsertRevisionInput {
  id: string;
  pageId: string;
  source: RevisionSource;
  credentialId: string | null;
  status: RevisionStatus;
  report: ValidationReport;
  cardJson: string | null;
  manifestJson: string | null;
  renderedText: string | null;
  renderJson: string | null;
  createdAt: string;
}

const LIST_COLUMNS = 'id, page_id, number, source, credential_id, status, report_json, card_json, created_at';

export function createRevisionsRepo(db: Database) {
  const insert = db.prepare(
    `INSERT INTO revisions (id, page_id, number, source, credential_id, status, report_json, card_json, manifest_json, rendered_text, render_json, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM revisions WHERE page_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING number`,
  );
  const byId = db.prepare('SELECT * FROM revisions WHERE id = ?');
  const listForPage = db.prepare(`SELECT ${LIST_COLUMNS} FROM revisions WHERE page_id = ? ORDER BY number DESC`);
  const latestAccepted = db.prepare(
    `SELECT ${LIST_COLUMNS} FROM revisions WHERE page_id = ? AND status = 'accepted' ORDER BY number DESC LIMIT 1`,
  );
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE page_id = ? AND created_at > ?');
  const stats = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM revisions WHERE page_id = ?');

  return {
    /** 插入并分配页内编号，返回编号。 */
    insert(input: InsertRevisionInput): number {
      const row = insert.get(
        input.id,
        input.pageId,
        input.pageId,
        input.source,
        input.credentialId,
        input.status,
        JSON.stringify(input.report),
        input.cardJson,
        input.manifestJson,
        input.renderedText,
        input.renderJson,
        input.createdAt,
      ) as { number: number };
      return Number(row.number);
    },
    findById(id: string): Revision | null {
      const row = byId.get(id) as RevisionRow | undefined;
      return row ? toRevision(row) : null;
    },
    /** 该页全部版本，编号倒序。 */
    listForPage(pageId: string): RevisionListItem[] {
      return (listForPage.all(pageId) as unknown as RevisionRow[]).map(toRevision);
    },
    findLatestAccepted(pageId: string): RevisionListItem | null {
      const row = latestAccepted.get(pageId) as RevisionRow | undefined;
      return row ? toRevision(row) : null;
    },
    /** `since` 之后的提交次数（含 rejected），每日上限用。 */
    countForPageSince(pageId: string, since: string): number {
      return Number((countSince.get(pageId, since) as { n: number }).n);
    },
    /** 版本总数与最近一次提交时间（AgentContext.page）。 */
    statsForPage(pageId: string): { count: number; lastCreatedAt: string | null } {
      const row = stats.get(pageId) as { n: number; last: string | null };
      return { count: Number(row.n), lastCreatedAt: row.last ?? null };
    },
  };
}

export type RevisionsRepo = ReturnType<typeof createRevisionsRepo>;
