import { transaction } from '../db/index.js';
import { saveAccountProfile } from '../services/account-profile.js';
/**
 * 平台托管路线的路由（contracts 9 / hosted-route 5）。全部是会话 + CSRF + Origin 的表单路由，忽略 `Authorization` 头；
 * 只有页面主人可访问（`findOwnPage`，否则 404）；网页创作始终可见，未配置自己的 API 时引导到账号设置。
 *
 * “我的资料”（`/account/data`、`/account/profile/delete`、`/account/briefs/delete`）不依赖托管功能是否开启：
 * 主人随时可以查看、删除自己已保存的画像与 brief（S7）。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PROFILE_ENRICHMENT_QUESTIONS, generateId, profileEntryInputSchema, BRIEF_MATERIAL_MAX_CHARS, BRIEF_ASSET_ID_PATTERN, BRIEF_ID_PATTERN, GENERATION_JOB_ID_PATTERN, NM_ID_PATTERN, PROFILE_ENTRY_ID_PATTERN } from '@nowme/contracts';
import { EXAMPLES_DIR, listExampleDirs, loadExamplesIndex } from '@nowme/skill';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDeps, AppEnv, AppHono, FormFields } from '../context.js';
import { choiceLabel, clip, isMotionLevel, type FollowupAnswer, type InterviewAnswers } from '../hosted/brief.js';
import { deleteOwnBrief, deleteOwnProfile } from '../hosted/data.js';
import type { ConfirmEdits, HostedService, StepResult } from '../hosted/service.js';
import { requireForm } from '../security/forms.js';
import { authOf, onboardingStep, requireUser } from '../security/session.js';
import type { GenerationJob } from '../db/hosted.js';
import type { JobEvent } from '../db/job-queue.js';
import { progressView } from '../services/progress.js';
import { questionsGate } from './organizer-tools.js';
import { findOwnPage, type OwnPage } from '../services/access.js';
import { renderError, renderNotFound } from '../views/errors.js';
import { demoModelError } from '../demo-access.js';
import { BriefPageView, CreateView, EditForm, JOB_START_ERROR_TEXT, JobView, MyDataView, STEP_ERROR_TEXT, type JobCharge } from '../views/hosted.js';
import { Notice } from '../views/forms.js';
import { renderPage } from '../views/layout.js';

const STEP_ERRORS = new Set(Object.keys(STEP_ERROR_TEXT));

const isRunning = (job: GenerationJob): boolean => job.status === 'queued' || job.status === 'running';

/** 进度的 JSON（轮询与 SSE 的 `done` 共用）：阶段名、数字、是否结束、做好后去哪（站内相对路径）。不含任何内容。 */
export function statusPayload(own: OwnPage, job: GenerationJob, latest: JobEvent | null) {
  const done = !isRunning(job);
  // 结束与否以任务行为准（结束事件可能晚一点才写进 job_events）
  const final = !done ? null : job.status === 'succeeded' ? 'succeeded' : job.status === 'needs_input' ? 'needs_input' : 'failed';
  const view = progressView(final ? { seq: latest?.seq ?? 0, stage: final, props: {} } : latest);
  return {
    ...view,
    done,
    status: job.status,
    next: job.status === 'succeeded' && job.revisionId ? `/w/${own.wall.id}/me?rev=${job.revisionId}#preview-heading` : null,
  };
}
const JOB_ERRORS = new Set(Object.keys(JOB_START_ERROR_TEXT));
const MAX_STYLES = 2;

function text(fields: FormFields, name: string, max: number): string {
  return clip(fields[name] ?? '', max);
}

/** 第 1、2 步的表单 → InterviewAnswers（只认场景指南里的题目与选项，其他字段忽略）。 */
export function readInterviewAnswers(fields: FormFields, hosted: HostedService, own: OwnPage): InterviewAnswers {
  const scene = hosted.scene(own);
  const choices: InterviewAnswers['choices'] = {};
  const known = hosted.known(own, own.page.ownerId);
  for (const question of scene.choiceQuestions) {
    const selected: string[] = [];
    if (question.multi) {
      question.options.forEach((option, index) => {
        if (fields[`q_${question.id}_${index}`] === '1') selected.push(choiceLabel(option));
      });
    } else {
      const index = Number(fields[`q_${question.id}`]);
      const option = Number.isInteger(index) ? question.options[index] : undefined;
      if (option && (question.required || option !== '跳过')) selected.push(option);
    }
    const written = text(fields, `q_${question.id}_text`, 200);
    choices[question.id] = fields[`reuse_${question.id}`] === '1' && known.choices[question.id]
      ? known.choices[question.id]! : { selected, text: written };
  }
  const knownStyles = new Set(listExampleDirs());
  const styles = Object.keys(fields)
    .filter((key) => key.startsWith('style_') && fields[key] === '1')
    .map((key) => key.slice('style_'.length))
    .filter((dir) => knownStyles.has(dir))
    .slice(0, MAX_STYLES);
  const motion = fields.motion && isMotionLevel(fields.motion) ? fields.motion : 'medium';
  const quick: Record<string, string> = {};
  for (const q of scene.quickQuestions) {
    const raw = fields[`quick_${q.id}`];
    const value = raw !== undefined ? q.options[Number(raw)] : undefined;
    if (value) quick[q.id] = value;
  }
  const starters = Object.fromEntries(scene.sentenceStarters.map((_, i) => [String(i), text(fields, `starter_${i}`, 200)]));
  const wallTopics = known.topics.filter((_, i) => fields[`topic_${i}`] === '1');
  return { material: text(fields, 'material', BRIEF_MATERIAL_MAX_CHARS), choices, styles, motion, intent: text(fields, 'intent', 200), quick, starters, wallTopics };
}

function readFollowupAnswers(fields: FormFields, questions: { id: string; options: string[] }[]): Record<string, FollowupAnswer> {
  const answers: Record<string, FollowupAnswer> = {};
  for (const question of questions) {
    const raw = fields[`f_${question.id}`];
    const index = Number(raw);
    const selected = raw !== 'skip' && Number.isInteger(index) ? (question.options[index] ?? null) : null;
    const written = text(fields, `f_${question.id}_text`, 200);
    answers[question.id] = { selected, text: written, skipped: selected === null && written.length === 0 };
  }
  return answers;
}

function readConfirmEdits(fields: FormFields, counts: { aiView: number; hooks: number; profile: number }, current?: import('../hosted/brief.js').StructuredBrief): ConfirmEdits {
  return {
    aiView: Array.from({ length: counts.aiView }, (_, index) => ({ text: clip(fields[`ai_${index}`] ?? current?.aiView[index] ?? '', 120), drop: fields[`ai_${index}_drop`] === '1' })),
    hooks: Array.from({ length: counts.hooks }, (_, index) => ({
      text: clip(fields[`hook_${index}_text`] ?? current?.hooks[index]?.text ?? '', 32),
      opener: clip(fields[`hook_${index}_opener`] ?? current?.hooks[index]?.opener ?? '', 80),
      drop: fields[`hook_${index}_drop`] === '1',
    })),
    keepProfile: Array.from({ length: counts.profile }, (_, index) => index).filter((index) => fields[`profile_${index}`] === '1'),
  };
}

export function registerHostedRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);
  const uploadForm = requireForm(deps, { multipartFiles: 'photos' });

  /** 托管功能开启且当前用户是这面墙的页面主人。 */
  const ownOf = (c: Context<AppEnv>): { own: OwnPage; hosted: HostedService } | null => {
    if (!deps.hosted) return null;
    const own = findOwnPage(deps.repos, authOf(c).user.id, c.req.param('wallId') ?? '');
    return own ? { own, hosted: deps.hosted } : null;
  };

  /** 隐私说明里“发给哪家模型服务”：自己配置的服务，或平台 AI 用的服务。 */
  const providersFor = (userId: string): string => {
    if (deps.config.hosted.fake) return '测试用的假模型';
    const labels = deps.userModels.ready(userId)
      ? (['interview', 'generate'] as const).map((role) => deps.userModels.summary(userId, role)?.endpoint.label)
      : deps.platformModel.available && deps.config.billing.platform
        ? [deps.config.billing.platform.interview.label, deps.config.billing.platform.generate.label]
        : [];
    return labels.filter((value, i, all) => value && all.indexOf(value) === i).join('、') || '你配置的服务';
  };

  /** 任务的点数情况（只读流水；页面主人才能走到这里）。 */
  const jobCharge = (jobId: string): JobCharge | null => {
    const charge = deps.repos.credits.findJobEntry('job', jobId);
    if (!charge) return null;
    return { credits: -charge.delta, payer: charge.account.kind, refunded: deps.repos.credits.findJobEntry('job_refund', jobId) !== null };
  };

  const renderCreate = (c: Context<AppEnv>, own: OwnPage, hosted: HostedService, error: string | null, status = 200, welcome = false, submittedAnswers?: InterviewAnswers) => {
    const auth = authOf(c);
    return renderPage(c, {
      title: `做一页你自己 · ${own.wall.name}`,
      bodyClass: 'page--create',
      status,
      body: (
        <CreateView
          model={{
            wall: own.wall,
            csrf: auth.session.csrfToken,
            scene: hosted.scene(own),
            examples: loadExamplesIndex().examples,
            demo: !!deps.demo,
            providers: providersFor(auth.user.id),
            overview: hosted.overview(own, auth.user.id),
            error,
            welcome,
            submittedAnswers,
            known: hosted.known(own, auth.user.id),
          }}
        />
      ),
    });
  };

  const afterStep = (c: Context<AppEnv>, own: OwnPage, hosted: HostedService, result: StepResult, answers?: InterviewAnswers) => {
    if (result.ok) return c.redirect(`/w/${own.wall.id}/me/create#create-step`, 303);
    return renderCreate(c, own, hosted, (deps.demo ? demoModelError(result.error) : null) ?? STEP_ERROR_TEXT[result.error], result.error === 'rate-limited' ? 429 : 422, false, answers);
  };

  app.get('/w/:wallId/me/create', user, (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    // 必答题没答完时先去回答（contracts 19.1）；邀请加入后的引导也先经过这里，答完回到引导
    const gate = questionsGate(c, deps, found.own);
    if (gate) return gate;
    const error = c.req.query('error');
    const message = error && deps.demo && demoModelError(error) ? demoModelError(error) : error && JOB_ERRORS.has(error) ? JOB_START_ERROR_TEXT[error as keyof typeof JOB_START_ERROR_TEXT] : error && STEP_ERRORS.has(error) ? STEP_ERROR_TEXT[error as keyof typeof STEP_ERROR_TEXT] : null;
    return renderCreate(c, found.own, found.hosted, message, 200, c.req.query('welcome') === '1');
  });

  app.post('/w/:wallId/me/create/start', uploadForm, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const answers = readInterviewAnswers(c.get('form'), found.hosted, found.own);
    // 内容安全（contracts 16.1）：在交给模型之前检查
    const verdict = await deps.contentSafety.checkTexts('interview', [answers.material, ...Object.values(answers.choices).map((choice) => choice.text), answers.intent ?? '', ...Object.values(answers.starters ?? {})]);
    if (!verdict.ok) return renderCreate(c, found.own, found.hosted, verdict.message, 422, false, answers);
    const result = await found.hosted.startInterview(found.own, authOf(c).user.id, answers, c.get('uploads') ?? []);
    return afterStep(c, found.own, found.hosted, result, answers);
  });

  app.post('/w/:wallId/me/create/followups', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const userId = authOf(c).user.id;
    const questions = found.hosted.loadBrief(found.own, userId)?.followups?.questions ?? [];
    const answers = readFollowupAnswers(c.get('form'), questions);
    const verdict = await deps.contentSafety.checkTexts('interview', Object.values(answers).map((answer) => answer.text));
    if (!verdict.ok) return renderCreate(c, found.own, found.hosted, verdict.message, 422);
    const result = await found.hosted.answerFollowups(found.own, userId, answers);
    return afterStep(c, found.own, found.hosted, result);
  });

  app.post('/w/:wallId/me/create/revise', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const note = text(c.get('form'), 'note', 300);
    const verdict = await deps.contentSafety.checkText('interview', note);
    if (!verdict.ok) return renderCreate(c, found.own, found.hosted, verdict.message, 422);
    const result = await found.hosted.revise(found.own, authOf(c).user.id, note);
    return afterStep(c, found.own, found.hosted, result);
  });

  app.post('/w/:wallId/me/create/confirm', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const userId = authOf(c).user.id;
    const brief = found.hosted.loadBrief(found.own, userId)?.brief;
    const edits = readConfirmEdits(c.get('form'), {
      aiView: brief?.aiView.length ?? 0,
      hooks: brief?.hooks.length ?? 0,
      profile: brief?.profileSuggestions.length ?? 0,
    }, brief ?? undefined);
    const fields = c.get('form');
    if (brief && fields.displayName !== undefined) {
      edits.displayName = text(fields, 'displayName', 24);
      if (!edits.displayName) return renderCreate(c, found.own, found.hosted, '请填写页面上的显示名。', 422);
      edits.boundaries = {
        name: `昵称“${edits.displayName}”`, school: fields.showSchool === '1' ? '显示' : '不显示',
        gradeMajor: fields.showGradeMajor === '1' ? '显示' : '不显示', photo: fields.showPhoto === '1' ? '可以' : '不可以',
        hidden: text(fields, 'hidden', 300).split('；').filter(Boolean), rejected: brief.boundaries.rejected,
      };
    }
    const followupAnswers = readFollowupAnswers(fields, found.hosted.loadBrief(found.own, userId)?.followups?.questions ?? []);
    const verdict = await deps.contentSafety.checkTexts('interview', [...Object.values(followupAnswers).map((a) => a.text), edits.displayName ?? '', ...(edits.boundaries?.hidden ?? []), ...edits.aiView.map((item) => item.text), ...edits.hooks.flatMap((hook) => [hook.text, hook.opener])]);
    if (!verdict.ok) return renderCreate(c, found.own, found.hosted, verdict.message, 422);
    if (Object.values(followupAnswers).some((a) => !a.skipped) || found.hosted.loadBrief(found.own, userId)?.followups?.pending) {
      return afterStep(c, found.own, found.hosted, await found.hosted.answerFollowups(found.own, userId, followupAnswers, edits));
    }
    if (fields.reviewAction === 'compose') return afterStep(c, found.own, found.hosted, { ok: true });
    return afterStep(c, found.own, found.hosted, found.hosted.confirm(found.own, userId, edits));
  });

  app.post('/w/:wallId/me/create/restart', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    await found.hosted.restart(found.own, authOf(c).user.id);
    return c.redirect(`/w/${found.own.wall.id}/me/create#create-step`, 303);
  });

  app.get('/w/:wallId/me/create/assets/:assetId', user, async (c) => {
    const found = ownOf(c);
    const assetId = c.req.param('assetId');
    if (!found || !BRIEF_ASSET_ID_PATTERN.test(assetId)) return renderNotFound(c);
    const file = await found.hosted.readAssetFile(authOf(c).user.id, assetId, found.own.page.id);
    if (!file) return renderNotFound(c);
    return c.body(Buffer.from(file.bytes), 200, {
      'Content-Type': file.asset.mime,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // ---------------------------------------------------------------------------
  // 生成与修改
  // ---------------------------------------------------------------------------

  app.post('/w/:wallId/me/generate', form, (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const result = found.hosted.startJob(found.own, authOf(c).user.id, { kind: 'generate' });
    if (!result.ok) return c.redirect(`/w/${found.own.wall.id}/me/create?error=${result.error}`, 303);
    return c.redirect(`/w/${found.own.wall.id}/me/jobs/${result.job.id}`, 303);
  });

  app.post('/w/:wallId/me/edit', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const fields = c.get('form');
    if (['更大胆', '换配色', '更安静', '首屏换一个细节'].includes(fields.shortcut ?? '')) fields.request = [fields.request?.trim(), fields.shortcut].filter(Boolean).join('；');
    const block = fields.block && NM_ID_PATTERN.test(fields.block) ? fields.block : null;
    const renderEditError = (message: string) => {
      const revision = deps.repos.revisions.findById(fields.revisionId ?? '');
      const blocks = revision?.pageId === found.own.page.id ? revision.report.stats.blocks : [];
      return renderPage(c, { title: '修改还没开始', status: 422, body: <div class="container container--form stack" id="hosted">
        <h1>修改还没开始</h1>
        <Notice tone="error">{message}</Notice>
        <EditForm wallId={found.own.wall.id} csrf={authOf(c).session.csrfToken} revisionId={fields.revisionId ?? ''} blocks={blocks} request={fields.request ?? ''} targetBlock={block ?? ''} rememberFacts={fields.rememberFacts === '1'} />
        <p><a href="/account/credits">补充点数</a> · <a href="/account/ai">AI 设置</a></p>
        <a href={`/w/${found.own.wall.id}/me`}>回到工作区</a>
      </div> });
    };
    const verdict = await deps.contentSafety.checkText('edit', fields.request);
    if (!verdict.ok) return renderEditError(verdict.message);
    const result = found.hosted.startJob(found.own, authOf(c).user.id, {
      kind: 'edit',
      baseRevisionId: fields.revisionId ?? null,
      targetBlock: block,
      request: fields.request ?? '',
      rememberFacts: fields.rememberFacts === '1',
    });
    if (!result.ok) return renderEditError((deps.demo ? demoModelError(result.error) : null) ?? JOB_START_ERROR_TEXT[result.error]);
    return c.redirect(`/w/${found.own.wall.id}/me/jobs/${result.job.id}`, 303);
  });

  app.post('/w/:wallId/me/enrich', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const publication = deps.repos.publications.findActiveForPage(found.own.page.id);
    if (!publication) return renderNotFound(c);
    const fields = c.get('form');
    const questionIndex = Number(fields.questionIndex ?? '0');
    const question = Number.isInteger(questionIndex) ? PROFILE_ENRICHMENT_QUESTIONS[questionIndex] : undefined;
    if (!question) return renderNotFound(c);
    const answer = text(fields, 'answer', 200);
    const statement = question.statement + answer;
    if (!answer) return c.redirect(`/w/${found.own.wall.id}/me`, 303);
    const verdict = await deps.contentSafety.checkText('interview', answer);
    if (!verdict.ok) return renderError(c, { status: 400, title: '补充还没有保存', message: verdict.message });
    const revision = deps.repos.revisions.findById(publication.revisionId);
    if (!revision) return renderNotFound(c);
    return renderPage(c, { title: '把这条加进页面？', body: <div class="container container--form stack">
      <h1>把这条加进页面？</h1><p>{statement}</p><p class="muted">会先做一个新版本给你预览，现有页面由你确认后才更新。</p>
      <EditForm wallId={found.own.wall.id} csrf={authOf(c).session.csrfToken} revisionId={revision.id} blocks={revision.report.stats.blocks} request={`补充：${statement}`} />
      <a href={`/w/${found.own.wall.id}/me`}>这次先不加</a>
    </div> });
  });

  /** 任务主人才能看到的任务（不是主人、页面不在、格式不对 → null，路由一律 404）。 */
  const ownJobOf = (c: Context<AppEnv>): { own: OwnPage; hosted: HostedService; job: GenerationJob } | null => {
    const found = ownOf(c);
    const jobId = c.req.param('jobId') ?? '';
    if (!found || !GENERATION_JOB_ID_PATTERN.test(jobId)) return null;
    const job = found.hosted.findJob(found.own, authOf(c).user.id, jobId);
    return job ? { ...found, job } : null;
  };

  app.get('/w/:wallId/me/jobs/:jobId', user, (c) => {
    const found = ownJobOf(c);
    if (!found) return renderNotFound(c);
    const { job } = found;
    const auth = authOf(c);
    const revision = job.revisionId ? deps.repos.revisions.findById(job.revisionId) : null;
    const base = job.baseRevisionId ? deps.repos.revisions.findById(job.baseRevisionId) : null;
    const running = isRunning(job);
    if (running) deps.progress.touch(job.id);
    return renderPage(c, {
      title: `${job.kind === 'generate' ? '生成页面' : '修改页面'} · ${found.own.wall.name}`,
      progress: running,
      body: (
        <JobView
          demo={!!deps.demo}
          wall={found.own.wall}
          job={job}
          charge={jobCharge(job.id)}
          platform={!deps.userModels.ready(auth.user.id) && deps.platformModel.available}
          revisionNumber={revision?.pageId === found.own.page.id ? revision.number : null}
          csrf={auth.session.csrfToken}
          blocks={base?.pageId === found.own.page.id ? base.report.stats.blocks : []}
          progress={running ? progressView(deps.repos.jobEvents.latest(job.id)) : null}
          pollMs={deps.progress.settings.fallbackPollMs}
          emailOn={deps.repos.notify.jobEmailEnabled(auth.user.id)}
        />
      ),
    });
  });

  // 实时进度（contracts 18.2）：只对任务主人开放，其他人（含未登录）一律 404；只推阶段名与数字。
  const progressOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.get('auth');
    if (!auth || onboardingStep(auth, c.get('demo'))) return renderNotFound(c);
    return next();
  };

  /** 轮询用：当前阶段与是否结束（`progress.js` 在不支持 SSE 或断线时使用）。 */
  app.get('/w/:wallId/me/jobs/:jobId/status', progressOwner, (c) => {
    const found = ownJobOf(c);
    if (!found) return renderNotFound(c);
    deps.progress.touch(found.job.id);
    return c.json(statusPayload(found.own, found.job, deps.repos.jobEvents.latest(found.job.id)));
  });

  app.get('/w/:wallId/me/jobs/:jobId/progress', progressOwner, (c) => {
    const found = ownJobOf(c);
    if (!found) return renderNotFound(c);
    const userId = authOf(c).user.id;
    const { wall } = found.own;
    const jobId = found.job.id;
    const slot = deps.progress.open(userId, jobId);
    // 连接太多：前端收到非 200 会改为轮询
    if (!slot) return c.json({ error: 'too-many-connections' }, 429);
    const settings = deps.progress.settings;
    const lastId = Number(c.req.header('Last-Event-ID') ?? '0');
    let seq = Number.isInteger(lastId) && lastId > 0 ? lastId : 0;
    return streamSSE(c, async (stream) => {
      const started = Date.now();
      let beat = started;
      try {
        await stream.writeSSE({ event: 'ready', data: '{}', retry: settings.fallbackPollMs });
        while (!stream.aborted) {
          // 每一轮都重新确认：仍是这面墙的有效成员、任务仍属于他（被移除、删除页面后立即停止推送）
          const own = findOwnPage(deps.repos, userId, wall.id);
          const job = own ? deps.repos.jobs.findForOwner(jobId, own.page.id, userId) : null;
          if (!own || !job) {
            await stream.writeSSE({ event: 'gone', data: '{}' });
            break;
          }
          for (const event of deps.repos.jobEvents.listAfter(jobId, seq, 100)) {
            seq = event.seq;
            await stream.writeSSE({ event: 'stage', id: String(event.seq), data: JSON.stringify(progressView(event)) });
          }
          deps.progress.touch(jobId);
          if (!isRunning(job)) {
            await stream.writeSSE({ event: 'done', data: JSON.stringify(statusPayload(own, job, deps.repos.jobEvents.latest(jobId))) });
            break;
          }
          // 到时关闭：浏览器会带 Last-Event-ID 自动重连，从断开处续传
          if (Date.now() - started >= settings.maxStreamMs) break;
          if (Date.now() - beat >= settings.heartbeatMs) {
            await stream.write(': keep-alive\n\n');
            beat = Date.now();
          }
          await stream.sleep(settings.pollMs);
        }
      } finally {
        slot.release();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // brief
  // ---------------------------------------------------------------------------

  app.get('/w/:wallId/me/brief', user, (c) => {
    // 查看 brief 不要求托管功能开启（主人的资料随时能看）
    const auth = authOf(c);
    const own = findOwnPage(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!own) return renderNotFound(c);
    const brief = deps.repos.briefs.findForPage(own.page.id, auth.user.id);
    if (!brief?.briefMd) return renderNotFound(c);
    return renderPage(c, {
      title: `这一页的资料 · ${own.wall.name}`,
      body: <BriefPageView wall={own.wall} csrf={auth.session.csrfToken} briefMd={brief.briefMd} briefId={brief.id} />,
    });
  });

  app.post('/w/:wallId/me/brief/delete', form, async (c) => {
    const auth = authOf(c);
    const own = findOwnPage(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!own) return renderNotFound(c);
    const brief = deps.repos.briefs.findForPage(own.page.id, auth.user.id);
    if (!brief) return renderNotFound(c);
    await deleteOwnBrief(deps, auth.user.id, brief.id);
    return c.redirect('/account/data?notice=brief-deleted', 303);
  });

  // ---------------------------------------------------------------------------
  // 我的资料（S7）
  // ---------------------------------------------------------------------------

  const DATA_NOTICES: Record<string, string> = {
    'brief-deleted': '资料已删除：采访内容和上传的图片都已清除。',
    'notify-saved': '提醒邮件的设置已保存。',
    'profile-deleted': '已删除。',
    'profile-saved': '个人资料已保存。',
    unblocked: '已解除拉黑。',
    'reminders-on': '已开启：会收到组织者的提醒邮件。',
    'reminders-off': '已关闭：不会再收到组织者的提醒邮件。',
  };

  app.get('/account/data', user, (c) => {
    const auth = authOf(c);
    const notice = c.req.query('notice');
    return renderPage(c, {
      title: '我的资料',
      bodyClass: 'page--data',
      body: (
        <MyDataView
          accountLinks={!deps.demo}
          nickname={auth.user.nickname ?? '我'}
          avatarVersion={auth.user.avatarVersion}
          csrf={auth.session.csrfToken}
          profile={deps.repos.profileEntries.listForUser(auth.user.id)}
          briefs={deps.repos.briefs.listForOwner(auth.user.id)} blocked={deps.repos.moderation.listBlockedBy(auth.user.id)} remindersOn={deps.repos.reminders.acceptsReminders(auth.user.id)}
          notifyEmail={deps.repos.notify.jobEmailEnabled(auth.user.id)}
          notice={notice ? (DATA_NOTICES[notice] ?? null) : null}
        />
      ),
    });
  });

  app.get('/account/avatar', user, (c) => {
    const bytes = deps.repos.users.avatarForUser(authOf(c).user.id);
    if (!bytes) return renderNotFound(c);
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' });
  });

  app.post('/account/profile', requireForm(deps, { multipartFiles: 'avatar' }), async (c) => {
    const auth = authOf(c);
    const fields = c.get('form');
    const nickname = (fields.nickname ?? '').trim();
    const verdict = await deps.contentSafety.checkText('nickname', nickname);
    const error = verdict.ok ? await saveAccountProfile(deps.repos.users, auth.user.id, nickname, c.get('uploads'), fields.removeAvatar === '1') : verdict.message;
    if (error) return renderPage(c, {
      title: '我的资料', bodyClass: 'page--data', status: 400,
      body: <MyDataView accountLinks={!deps.demo} nickname={auth.user.nickname ?? '我'} avatarVersion={auth.user.avatarVersion} nicknameDraft={nickname} error={error} csrf={auth.session.csrfToken} profile={deps.repos.profileEntries.listForUser(auth.user.id)} briefs={deps.repos.briefs.listForOwner(auth.user.id)} blocked={deps.repos.moderation.listBlockedBy(auth.user.id)} remindersOn={deps.repos.reminders.acceptsReminders(auth.user.id)} notifyEmail={deps.repos.notify.jobEmailEnabled(auth.user.id)} notice={null} />,
    });
    return c.redirect('/account/data?notice=profile-saved', 303);
  });

  app.post('/account/profile/entry', form, async (c) => {
    const auth = authOf(c);
    const fields = c.get('form');
    const entries = deps.repos.profileEntries.listForUser(auth.user.id);
    const entry = fields.entryId ? entries.find((e) => e.id === fields.entryId) : null;
    const merge = fields.mergeId ? entries.find((e) => e.id === fields.mergeId) : null;
    if ((fields.entryId && !entry) || (fields.mergeId && (!entry || !merge || entry.id === merge.id))) return renderNotFound(c);
    const input = profileEntryInputSchema.safeParse(fields);
    if (!input.success) return renderError(c, { status: 400, title: '画像没有保存', message: input.error.issues[0]?.message ?? '请检查填写的内容' });
    if (input.data.scope.startsWith('wall:') && input.data.scope !== entry?.scope && !findOwnPage(deps.repos, auth.user.id, input.data.scope.slice(5))) return renderNotFound(c);
    const verdict = await deps.contentSafety.checkText('interview', input.data.text);
    if (!verdict.ok) return renderError(c, { status: 400, title: '画像没有保存', message: verdict.message });
    const now = deps.now().toISOString();
    const saved = transaction(deps.db, () => {
      const current = deps.repos.profileEntries.listForUser(auth.user.id);
      if ((entry && !current.some((e) => e.id === entry.id)) || (merge && !current.some((e) => e.id === merge.id))) return false;
      if (entry) deps.repos.profileEntries.updateForUser(auth.user.id, entry.id, input.data.text, input.data.category, input.data.scope, now);
      else deps.repos.profileEntries.insert({ id: generateId('pfe'), userId: auth.user.id, ...input.data, source: 'owner-file', confirmation: 'owner-stated', createdAt: now, updatedAt: now });
      if (merge) deps.repos.profileEntries.deleteForUser(auth.user.id, merge.id);
      return true;
    });
    if (!saved) return renderNotFound(c);
    return c.redirect('/account/data?notice=profile-saved', 303);
  });

  app.post('/account/profile/delete', form, (c) => {
    const auth = authOf(c);
    const fields = c.get('form');
    if (fields.all === '1') {
      deleteOwnProfile(deps, auth.user.id, null);
    } else {
      if (!fields.entryId || !PROFILE_ENTRY_ID_PATTERN.test(fields.entryId)) return renderNotFound(c);
      if (deleteOwnProfile(deps, auth.user.id, fields.entryId) === 0) return renderNotFound(c);
    }
    return c.redirect('/account/data?notice=profile-deleted', 303);
  });

  app.post('/account/briefs/delete', form, async (c) => {
    const auth = authOf(c);
    const briefId = c.get('form').briefId ?? '';
    if (!BRIEF_ID_PATTERN.test(briefId)) return renderNotFound(c);
    if (!(await deleteOwnBrief(deps, auth.user.id, briefId))) return renderNotFound(c);
    return c.redirect('/account/data?notice=brief-deleted', 303);
  });

  // 风格选择题的缩略图：Skill 示例页的封面（公开的示例内容，只在托管功能开启时提供）
  app.get('/hosted/examples/:file', user, async (c) => {
    if (!deps.hosted) return renderNotFound(c);
    const match = /^([a-z][a-z0-9-]{0,63})\.png$/.exec(c.req.param('file'));
    const dir = match?.[1];
    if (!dir || !listExampleDirs().includes(dir)) return renderNotFound(c);
    try {
      const bytes = await readFile(join(EXAMPLES_DIR, dir, 'cover.png'));
      return c.body(bytes, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
    } catch {
      return renderNotFound(c);
    }
  });
}
