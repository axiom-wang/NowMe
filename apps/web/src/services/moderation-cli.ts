/**
 * 平台运营命令（contracts 15）：`pnpm --filter @nowme/web moderation <命令>` 的实现（scripts/moderation.ts 只做输入输出）。
 *
 *   list [--status open|dismissed|actioned|all] [--kind page|conversation] [--limit N]
 *   show --id rpt_...                      举报详情：举报人、补充说明、页面快照或私信内容（到举报时为止的最近 50 条）
 *   resolve --id rpt_... --as dismissed|actioned [--note 备注]
 *   hide-page --page pg_... [--note 备注]  页面下墙，这一页的待处理举报记为已处理
 *   suspend --email 邮箱 [--note 备注]      停用账号：会话失效、不能登录、页面下墙
 *   unsuspend --email 邮箱 [--note 备注]
 *
 * 这里能看到举报人与补充说明、私信举报的内容——只有平台运营能用这个命令（直接读写服务器上的数据库）。
 */
import { CHAT_PAGE_SIZE, REPORT_ID_PATTERN } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { type Report, type ReportKind, type ReportStatus } from '../db/moderation.js';
import { normalizeEmail } from './auth.js';
import { platformHidePage, platformResolveReport, REPORT_REASON_LABEL, suspendUser, unsuspendUser } from './moderation.js';

type CliDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;

export class ModerationCliError extends Error {}

export const MODERATION_USAGE =
  '用法：moderation list [--status open|dismissed|actioned|all] [--kind page|conversation] [--limit N] | show --id 举报ID | resolve --id 举报ID --as dismissed|actioned [--note 备注] | hide-page --page 页面ID [--note 备注] | suspend --email 邮箱 [--note 备注] | unsuspend --email 邮箱 [--note 备注]';

const STATUS_LABEL: Record<ReportStatus, string> = { open: '待处理', dismissed: '已忽略', actioned: '已处理' };

function fail(message: string): never {
  throw new ModerationCliError(message);
}

function options(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined) fail(`参数格式不对：${name ?? ''}`);
    result[name.slice(2)] = value;
  }
  return result;
}

function note(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  if (text.length > 500) fail('--note 最多 500 字');
  return text || null;
}

function emailOf(deps: CliDeps, userId: string): string {
  return deps.repos.users.findById(userId)?.email ?? userId;
}

function who(deps: CliDeps, userId: string): string {
  const user = deps.repos.users.findById(userId);
  return user ? `${user.nickname ?? '（未填昵称）'} <${user.email}>` : userId;
}

function reportOf(deps: CliDeps, id: string | undefined): Report {
  const report = id && REPORT_ID_PATTERN.test(id) ? deps.repos.moderation.findReport(id) : null;
  if (!report) fail('没有这条举报');
  return report;
}

function userByEmail(deps: CliDeps, raw: string | undefined) {
  const email = normalizeEmail(raw);
  const user = email ? deps.repos.users.findByEmail(email) : null;
  if (!user) fail('没有这个邮箱的账号');
  return user;
}

function summaryLine(deps: CliDeps, report: Report): string {
  const target = report.targetKind === 'page' ? `页面 ${report.pageId}` : `私信 ${report.conversationId}`;
  return [report.id, STATUS_LABEL[report.status], REPORT_REASON_LABEL[report.reason], target, `被举报：${emailOf(deps, report.reportedUserId)}`, report.updatedAt].join('  ');
}

function show(deps: CliDeps, report: Report): string[] {
  const wall = deps.repos.walls.findById(report.wallId);
  const lines = [
    `举报 ${report.id}（${STATUS_LABEL[report.status]}${report.resolvedBy ? `，由${report.resolvedBy === 'organizer' ? '组织者' : '平台'}处理于 ${report.resolvedAt}` : ''}）`,
    `墙：${wall?.name ?? '?'}（${report.wallId}）`,
    `原因：${REPORT_REASON_LABEL[report.reason]}`,
    `补充说明：${report.note ?? '（没有）'}`,
    `举报人：${who(deps, report.reporterId)}`,
    `被举报：${who(deps, report.reportedUserId)}${deps.repos.moderation.isSuspended(report.reportedUserId) ? '（已停用）' : ''}`,
    `举报时间：${report.createdAt}，最近更新：${report.updatedAt}`,
    `同一对象的举报共 ${deps.repos.moderation.countForTarget(report)} 条`,
  ];
  if (report.targetKind === 'page' && report.pageId) {
    const active = deps.repos.publications.findActiveForPage(report.pageId);
    lines.push(`页面：${report.pageId}（${active ? (active.id === report.publicationId ? '举报的这一版仍在墙上' : '已换成新的发布') : '现在不在墙上'}）`);
    const publication = report.publicationId ? deps.db.prepare('SELECT card_json, revision_id FROM publications WHERE id = ?').get(report.publicationId) as { card_json: string; revision_id: string } | undefined : undefined;
    if (publication) {
      lines.push(`被举报时的缩略卡：${publication.card_json}`);
      const text = deps.repos.revisions.findById(publication.revision_id)?.renderedText ?? '';
      lines.push(`页面文字（前 2000 字）：${text.slice(0, 2000) || '（没有）'}`);
    }
  }
  if (report.targetKind === 'conversation' && report.conversationId) {
    const until = (report.lastSequence ?? 0) + 1;
    const history = deps.repos.chat.history(report.conversationId, { before: until });
    lines.push(`私信（到举报时为止的最近 ${CHAT_PAGE_SIZE} 条）：`);
    for (const message of history.messages) lines.push(`  [${message.createdAt}] ${message.senderName}（${emailOf(deps, message.senderId)}）：${message.text}`);
    if (history.messages.length === 0) lines.push('  （没有消息）');
  }
  return lines;
}

/** 执行一条命令，返回要输出的行。参数错误、对象不存在时抛 `ModerationCliError`。 */
export function runModerationCommand(deps: CliDeps, argv: readonly string[]): string[] {
  const [command, ...rest] = argv;
  const args = options(rest);
  switch (command) {
    case 'list': {
      const status = args.status ?? 'open';
      if (!['open', 'dismissed', 'actioned', 'all'].includes(status)) fail('--status 只能是 open、dismissed、actioned 或 all');
      if (args.kind !== undefined && !['page', 'conversation'].includes(args.kind)) fail('--kind 只能是 page 或 conversation');
      const limit = args.limit === undefined ? 100 : /^\d{1,4}$/.test(args.limit) ? Number(args.limit) : fail('--limit 应为整数');
      const reports = deps.repos.moderation.listReports({ status: status === 'all' ? null : (status as ReportStatus), kind: (args.kind as ReportKind | undefined) ?? null, limit });
      return reports.length === 0 ? ['（没有举报）'] : reports.map((report) => summaryLine(deps, report));
    }
    case 'show':
      return show(deps, reportOf(deps, args.id));
    case 'resolve': {
      const report = reportOf(deps, args.id);
      if (args.as !== 'dismissed' && args.as !== 'actioned') fail('--as 只能是 dismissed 或 actioned');
      if (!platformResolveReport(deps, report, args.as, note(args.note))) fail('这条举报已经处理过了');
      return [`已把 ${report.id} 标记为${STATUS_LABEL[args.as]}`];
    }
    case 'hide-page': {
      const result = platformHidePage(deps, args.page ?? '', note(args.note));
      if (!result) fail('没有这个页面');
      return [`${result.ended ? '页面已下墙' : '页面本来就不在墙上'}；结束了 ${result.resolved} 条待处理举报`];
    }
    case 'suspend': {
      const user = userByEmail(deps, args.email);
      const result = suspendUser(deps, user.id, note(args.note));
      return [`${result.already ? '账号之前已停用，已再次清理' : '账号已停用'}：会话全部失效，${result.endedPublications} 个页面下墙`];
    }
    case 'unsuspend': {
      const user = userByEmail(deps, args.email);
      return [unsuspendUser(deps, user.id, note(args.note)) ? '已解除停用（页面不会自动回到墙上）' : '这个账号没有被停用'];
    }
    default:
      fail(MODERATION_USAGE);
  }
}
