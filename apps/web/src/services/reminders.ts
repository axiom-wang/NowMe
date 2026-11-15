/**
 * 完成度与一键提醒（contracts 19.2）。
 *
 * - 完成度：有效成员里谁已经发布、谁还没发布、谁还没答完必答题。组织者后台只用昵称展示（与成员列表相同的可见范围）。
 * - 一键提醒：给“从没发布过”或“没答完必答题”的成员发一封固定模板的邮件。组织者不能写正文（不能借此群发任意内容），
 *   看不到任何人的邮箱；不提醒组织者自己、已撤下页面的人（那是本人的选择）、关闭了提醒邮件的人、拉黑了组织者
 *   （或被组织者拉黑）的人、已停用或注销的账号。同一面墙里每人 48 小时内最多一封、总共最多 3 封。
 * - 先在一个事务里记下 `pending` 占住限额，然后在后台逐封投递，改为 `sent` / `failed`；页面不等邮件发完。
 *   不接收提醒与被拉黑的人数合在一起显示为“不接收提醒邮件”，看不出谁拉黑了谁。
 */
import { generateId } from '@nowme/contracts';
import { REMINDER_LIMITS } from '../constants.js';
import type { AppDeps } from '../context.js';
import { transaction } from '../db/index.js';
import type { ReminderReason } from '../db/organizer-tools.js';
import type { PageDisplayState } from '../db/publications.js';
import { wallQueries } from '../db/wall-queries.js';
import type { Wall } from '../db/walls.js';
import { answersForWall } from './wall-questions.js';

type ReminderDeps = Pick<AppDeps, 'db' | 'repos' | 'now' | 'outbox' | 'config' | 'log'>;

export interface ProgressMember {
  userId: string;
  nickname: string;
  role: 'organizer' | 'member';
  state: PageDisplayState;
  /** 没答完的题数（没有题目时为 0）。 */
  missingAnswers: number;
}

export interface WallProgress {
  members: ProgressMember[];
  total: number;
  published: number;
  /** 没有题目时为 null。 */
  answered: number | null;
  questionCount: number;
  /** 还没发布过的人（不含撤下的）。 */
  unpublished: ProgressMember[];
  withdrawn: number;
  /** 没答完必答题的人。 */
  unanswered: ProgressMember[];
  remind: ReminderPlan;
  lastBatch: { at: string; count: number } | null;
}

export interface ReminderTarget {
  userId: string;
  nickname: string;
  reason: ReminderReason;
  missingAnswers: number;
}

export interface ReminderPlan {
  /** 这次会提醒的人。 */
  targets: ReminderTarget[];
  /** 需要提醒、但 48 小时内已经提醒过或已经提醒满 3 次的人数。 */
  limited: number;
  /** 需要提醒、但不接收提醒邮件的人数（含双方之间有拉黑、账号停用的）。 */
  declined: number;
}

function reasonOf(member: ProgressMember): ReminderReason | null {
  const publish = member.state === 'unpublished';
  const answer = member.missingAnswers > 0;
  if (publish && answer) return 'both';
  if (publish) return 'publish';
  if (answer) return 'answer';
  return null;
}

/** 这面墙的完成度与这次一键提醒会提醒谁（组织者后台）。 */
export function loadWallProgress(deps: Pick<AppDeps, 'db' | 'repos' | 'now'>, wall: Wall, organizerId: string): WallProgress {
  const questions = deps.repos.questions.listForWall(wall.id);
  const answers = answersForWall(deps, wall.id, questions);
  const rows = wallQueries(deps.db).listMembersForAdmin(wall.id);
  const members: ProgressMember[] = rows.map((row) => {
    const mine = answers.get(row.userId);
    return {
      userId: row.userId,
      nickname: row.nickname,
      role: row.role,
      state: row.state,
      missingAnswers: questions.filter((question) => !mine?.has(question.id)).length,
    };
  });
  const stats = deps.repos.reminders.statsForWall(wall.id);
  const now = deps.now().getTime();
  const plan: ReminderPlan = { targets: [], limited: 0, declined: 0 };
  for (const member of members) {
    if (member.role === 'organizer' || member.userId === organizerId) continue;
    const reason = reasonOf(member);
    if (!reason) continue;
    const user = deps.repos.users.findById(member.userId);
    if (!user || user.deletedAt || deps.repos.moderation.isSuspended(member.userId) || !deps.repos.reminders.acceptsReminders(member.userId) || deps.repos.moderation.blockedEitherWay(organizerId, member.userId)) {
      plan.declined += 1;
      continue;
    }
    const sent = stats.get(member.userId);
    if (sent && (sent.count >= REMINDER_LIMITS.maxPerMember || now - Date.parse(sent.last) < REMINDER_LIMITS.cooldownMs)) {
      plan.limited += 1;
      continue;
    }
    plan.targets.push({ userId: member.userId, nickname: member.nickname, reason, missingAnswers: member.missingAnswers });
  }
  return {
    members,
    total: members.length,
    published: members.filter((member) => member.state === 'published').length,
    answered: questions.length > 0 ? members.filter((member) => member.missingAnswers === 0).length : null,
    questionCount: questions.length,
    unpublished: members.filter((member) => member.state === 'unpublished'),
    withdrawn: members.filter((member) => member.state === 'withdrawn').length,
    unanswered: questions.length > 0 ? members.filter((member) => member.missingAnswers > 0) : [],
    remind: plan,
    lastBatch: deps.repos.reminders.lastBatch(wall.id),
  };
}

const SUBJECT: Record<ReminderReason, string> = {
  publish: '还差你的一页',
  answer: '还差你的回答',
  both: '还差你的一页和回答',
};

/** 提醒邮件（固定模板，纯文本；组织者不能改正文）。 */
export function reminderMail(input: { wallName: string; organizerName: string; nickname: string; reason: ReminderReason; missingAnswers: number; wallUrl: string; settingsUrl: string }): { subject: string; body: string } {
  const lines = [`${input.nickname}，你好：`, '', `「${input.wallName}」的组织者${input.organizerName}提醒你：`];
  if (input.reason !== 'answer') lines.push('· 你的页面还没发布。和 AI 聊几句就能做出你的一页，挂到墙上让大家认识你。');
  if (input.reason !== 'publish') lines.push(`· 还有 ${input.missingAnswers} 道必答题没答，点几下就好。`);
  lines.push('', `打开这面墙：${input.wallUrl}`, '', `不想再收到组织者的提醒邮件？登录后在“我的资料”里关闭：${input.settingsUrl}`, '', '—— NOWMe');
  return { subject: `「${input.wallName}」${SUBJECT[input.reason]}`, body: lines.join('\n') };
}

const deliveries = new WeakMap<object, Set<Promise<void>>>();

/** 测试用：等后台的提醒邮件全部投递完。 */
export async function remindersIdle(deps: Pick<AppDeps, 'db'>): Promise<void> {
  const pending = deliveries.get(deps.db);
  while (pending && pending.size > 0) await Promise.allSettled([...pending]);
}

/**
 * 一键提醒：在一个事务里重新计算名单并记下 `pending`（占住限额），然后在后台逐封投递。返回这次提醒的人数。
 * 并发点击两次时，第二次的事务看到第一次的记录，不会重复提醒。
 */
export function remindMembers(deps: ReminderDeps, wall: Wall, organizerId: string): number {
  const nowIso = deps.now().toISOString();
  const claimed = transaction(deps.db, () => {
    const plan = loadWallProgress(deps, wall, organizerId).remind;
    const rows = plan.targets.map((target) => {
      const id = generateId('rmd');
      deps.repos.reminders.insert({ id, wallId: wall.id, organizerId, userId: target.userId, reason: target.reason, createdAt: nowIso });
      return { id, target };
    });
    deps.repos.events.record({ type: 'wall_remind', wallId: wall.id, pageId: null, actorId: organizerId, props: { count: rows.length, limited: plan.limited, declined: plan.declined }, createdAt: nowIso });
    return rows;
  });
  if (claimed.length === 0) return 0;

  const organizerName = deps.repos.users.findById(organizerId)?.nickname ?? '';
  const wallUrl = `${deps.config.webOrigin}/w/${wall.id}`;
  const settingsUrl = `${deps.config.webOrigin}/account/data#notifications`;
  const job = (async () => {
    let failed = 0;
    for (const { id, target } of claimed) {
      const user = deps.repos.users.findById(target.userId);
      if (!user || user.deletedAt) {
        deps.repos.reminders.setStatus(id, 'failed');
        continue;
      }
      const mail = reminderMail({ wallName: wall.name, organizerName, nickname: user.nickname ?? target.nickname, reason: target.reason, missingAnswers: target.missingAnswers, wallUrl, settingsUrl });
      try {
        await deps.outbox.send({ at: deps.now().toISOString(), to: user.email, subject: mail.subject, body: mail.body });
        deps.repos.reminders.setStatus(id, 'sent');
      } catch {
        failed += 1;
        deps.repos.reminders.setStatus(id, 'failed');
      }
    }
    if (failed > 0) deps.log(`[web] 一键提醒：${wall.id} 有 ${failed} 封没有发出去`);
  })();
  let pending = deliveries.get(deps.db);
  if (!pending) deliveries.set(deps.db, (pending = new Set()));
  pending.add(job);
  void job.finally(() => pending.delete(job));
  return claimed.length;
}

/** 发到群里的提醒文案（组织者自己复制；只用昵称）。 */
export function groupReminderText(wall: Wall, progress: WallProgress, wallUrl: string): string {
  const names = (list: ProgressMember[]) => list.map((member) => member.nickname || '成员').join('、');
  const lines = [`【${wall.name}】已经有 ${progress.published} / ${progress.total} 人上墙啦。`];
  const unpublished = progress.unpublished.filter((member) => member.role !== 'organizer');
  if (unpublished.length > 0) lines.push(`还没上墙：${names(unpublished)}`);
  const unanswered = progress.unanswered.filter((member) => member.role !== 'organizer');
  if (unanswered.length > 0) lines.push(`还没答必答题：${names(unanswered)}`);
  lines.push(`打开墙做一页自己：${wallUrl}`);
  return lines.join('\n');
}
