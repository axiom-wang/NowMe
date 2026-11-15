/**
 * 生成 / 修改结束后的提醒邮件（contracts 18.3）。
 *
 * 任务在 worker 里结束（可能是另一个进程，worker 不发邮件）；主站每隔几秒扫一次刚结束、还没判定过的任务：
 * - 主人还在看（进度连接还开着，或最近 `presenceMs` 内看过）→ 不发（`present`）；
 * - 主人关掉了这类邮件 → 不发（`off`）；
 * - 账号已注销 / 停用、页面已不在这面墙、任务是被平台中止的 → 不发（`skipped`）；
 * - 否则发一封“做好了 / 没做成 / 需要你补充一句”+ 链接，**不含页面内容、资料或修改要求**（`sent`，发送失败记 `failed`，不重试）。
 * 每个任务先 `claim` 再判定，最多发一封。只看最近 30 分钟内结束的任务（刚部署时不会给很久以前的任务补发）。
 */
import type { AppDeps } from '../context.js';
import type { FinishedJob } from '../db/notify.js';
import { findOwnPage } from './access.js';
import type { ProgressHub } from './progress.js';

export const NOTIFY_WINDOW_MS = 30 * 60_000;
export const NOTICE_RETENTION_MS = 30 * 24 * 3600_000;
/** 平台中止的任务（停用账号、注销 / 删除页面）：用户自己知道，或者已经收不到了。 */
const SILENT_ERRORS: ReadonlySet<string> = new Set(['SUSPENDED', 'PAGE_GONE']);

type NotifyDeps = Pick<AppDeps, 'repos' | 'now' | 'outbox' | 'config' | 'log'>;

export interface JobNotifier {
  /** 扫一次，返回发出的邮件数。 */
  tick(): Promise<number>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export interface JobNoticeMail {
  subject: string;
  body: string;
}

/** 邮件正文：只有墙名、昵称和链接（不含页面内容）。 */
export function jobNoticeMail(input: { nickname: string | null; wallName: string; job: Pick<FinishedJob, 'kind' | 'status'>; link: string; settingsLink: string }): JobNoticeMail {
  const { job } = input;
  const hello = input.nickname ? `${input.nickname}，你好：` : '你好：';
  const what = job.kind === 'generate' ? '页面' : '页面修改';
  let subject: string;
  let lines: string[];
  if (job.status === 'succeeded') {
    subject = job.kind === 'generate' ? '你的页面做好了，去看看' : '你的页面改好了，去看看';
    lines = [`你在「${input.wallName}」的${what}已经${job.kind === 'generate' ? '做好' : '改好'}了，去看看吧：`, input.link, '', '满意的话，在那里确认发布，墙上的人就能看到你了；不满意可以接着改。'];
  } else if (job.status === 'needs_input') {
    subject = '改页面之前，AI 想先问你一句';
    lines = [`你在「${input.wallName}」提的修改，AI 想先问你一个问题才能接着改：`, input.link];
  } else {
    subject = `这次${what}没有做成`;
    lines = [`你在「${input.wallName}」的${what}这次没有做成。如果用了点数，已经全额退回。可以回去再试一次：`, input.link];
  }
  return {
    subject,
    body: [hello, '', ...lines, '', '——', `你离开页面时 NOWMe 会发这类提醒。不想再收到，可以在“我的资料”里关掉：${input.settingsLink}`].join('\n'),
  };
}

export function createJobNotifier(deps: NotifyDeps, hub: Pick<ProgressHub, 'present'>): JobNotifier {
  const { repos, config } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<number> | null = null;

  async function decide(job: FinishedJob): Promise<boolean> {
    const nowIso = deps.now().toISOString();
    if (hub.present(job.id)) {
      if (repos.notify.claim(job.id, nowIso)) repos.notify.resolve(job.id, 'present');
      return false;
    }
    if (!repos.notify.claim(job.id, nowIso)) return false;
    const user = repos.users.findById(job.ownerId);
    const page = repos.pages.findById(job.pageId);
    const own = page ? findOwnPage(repos, job.ownerId, page.wallId) : null;
    if (!user || user.deletedAt || !own || own.page.id !== job.pageId || (job.errorCode && SILENT_ERRORS.has(job.errorCode))) {
      repos.notify.resolve(job.id, 'skipped');
      return false;
    }
    if (!repos.notify.jobEmailEnabled(user.id)) {
      repos.notify.resolve(job.id, 'off');
      return false;
    }
    const base = `${config.webOrigin}/w/${own.wall.id}/me`;
    const link = job.status === 'succeeded' && job.revisionId ? `${base}?rev=${job.revisionId}#preview-heading` : `${base}/jobs/${job.id}`;
    const mail = jobNoticeMail({ nickname: user.nickname, wallName: own.wall.name, job, link, settingsLink: `${config.webOrigin}/account/data#notifications` });
    try {
      await deps.outbox.send({ at: nowIso, to: user.email, ...mail });
      repos.notify.resolve(job.id, 'sent');
      return true;
    } catch {
      // 发不出去不重试（提醒错过了也不影响结果）；邮件模块自己只记域名与错误类别
      repos.notify.resolve(job.id, 'failed');
      deps.log(`[web] 完成提醒没有发出去（任务 ${job.id}）`);
      return false;
    }
  }

  async function scan(): Promise<number> {
    const at = deps.now().getTime();
    let sent = 0;
    for (const job of repos.notify.listUnnoticed(new Date(at - NOTIFY_WINDOW_MS).toISOString())) {
      if (await decide(job)) sent += 1;
    }
    repos.notify.prune(new Date(at - NOTICE_RETENTION_MS).toISOString());
    return sent;
  }

  const tick = (): Promise<number> => {
    // 上一轮还没结束（邮件慢）时不叠加
    running ??= scan().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    tick,
    start(intervalMs) {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((error: unknown) => deps.log(`[web] 完成提醒扫描失败：${error instanceof Error ? error.message : String(error)}`));
      }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running?.catch(() => 0);
    },
  };
}
