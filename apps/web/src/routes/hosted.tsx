import { saveAccountProfile } from '../services/account-profile.js';
/**
 * 平台托管路线的路由（contracts 9 / hosted-route 5）。全部是会话 + CSRF + Origin 的表单路由，忽略 `Authorization` 头；
 * 只有页面主人可访问（`findOwnPage`，否则 404）；网页创作始终可见，未配置自己的 API 时引导到账号设置。
 *
 * “我的资料”（`/account/data`、`/account/profile/delete`、`/account/briefs/delete`）不依赖托管功能是否开启：
 * 主人随时可以查看、删除自己已保存的画像与 brief（S7）。
 */
import type { Context } from 'hono';
import { BRIEF_MATERIAL_MAX_CHARS, BRIEF_ASSET_ID_PATTERN, BRIEF_ID_PATTERN, GENERATION_JOB_ID_PATTERN, NM_ID_PATTERN, PROFILE_ENTRY_ID_PATTERN } from '@nowme/contracts';
import { EXAMPLES_DIR, listExampleDirs, loadExamplesIndex } from '@nowme/skill';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDeps, AppEnv, AppHono, FormFields } from '../context.js';
import { clip, isMotionLevel, type FollowupAnswer, type InterviewAnswers } from '../hosted/brief.js';
import { deleteOwnBrief, deleteOwnProfile } from '../hosted/data.js';
import type { ConfirmEdits, HostedService, StepResult } from '../hosted/service.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findOwnPage, type OwnPage } from '../services/access.js';
import { renderError, renderNotFound } from '../views/errors.js';
import { demoModelError } from '../demo-access.js';
import { BriefPageView, CreateView, JOB_START_ERROR_TEXT, JobView, MyDataView, STEP_ERROR_TEXT, type JobCharge } from '../views/hosted.js';
import { renderPage } from '../views/layout.js';

const STEP_ERRORS = new Set(Object.keys(STEP_ERROR_TEXT));
const JOB_ERRORS = new Set(Object.keys(JOB_START_ERROR_TEXT));
const MAX_STYLES = 2;

function text(fields: FormFields, name: string, max: number): string {
  return clip(fields[name] ?? '', max);
}

/** 第 1、2 步的表单 → InterviewAnswers（只认场景指南里的题目与选项，其他字段忽略）。 */
export function readInterviewAnswers(fields: FormFields, hosted: HostedService, own: OwnPage): InterviewAnswers {
  const scene = hosted.scene(own);
  const choices: InterviewAnswers['choices'] = {};
  for (const question of scene.choiceQuestions) {
    const selected: string[] = [];
    if (question.multi) {
      question.options.forEach((option, index) => {
        if (fields[`q_${question.id}_${index}`] === '1') selected.push(option.replace('（默认勾选）', ''));
      });
    } else {
      const index = Number(fields[`q_${question.id}`]);
      const option = Number.isInteger(index) ? question.options[index] : undefined;
      if (option) selected.push(option);
    }
    choices[question.id] = { selected, text: text(fields, `q_${question.id}_text`, 200) };
  }
  const known = new Set(listExampleDirs());
  const styles = Object.keys(fields)
    .filter((key) => key.startsWith('style_') && fields[key] === '1')
    .map((key) => key.slice('style_'.length))
    .filter((dir) => known.has(dir))
    .slice(0, MAX_STYLES);
  const motion = fields.motion && isMotionLevel(fields.motion) ? fields.motion : 'medium';
  return { material: text(fields, 'material', BRIEF_MATERIAL_MAX_CHARS), choices, styles, motion };
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

function readConfirmEdits(fields: FormFields, counts: { aiView: number; hooks: number; profile: number }): ConfirmEdits {
  return {
    aiView: Array.from({ length: counts.aiView }, (_, index) => ({ text: fields[`ai_${index}`] ?? '', drop: fields[`ai_${index}_drop`] === '1' })),
    hooks: Array.from({ length: counts.hooks }, (_, index) => ({
      text: fields[`hook_${index}_text`] ?? '',
      opener: fields[`hook_${index}_opener`] ?? '',
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

  const renderCreate = (c: Context<AppEnv>, own: OwnPage, hosted: HostedService, error: string | null, status = 200) => {
    const auth = authOf(c);
    return renderPage(c, {
      title: `在这里创作 · ${own.wall.name}`,
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
          }}
        />
      ),
    });
  };

  const afterStep = (c: Context<AppEnv>, own: OwnPage, hosted: HostedService, result: StepResult) => {
    if (result.ok) return c.redirect(`/w/${own.wall.id}/me/create`, 303);
    return renderCreate(c, own, hosted, (deps.demo ? demoModelError(result.error) : null) ?? STEP_ERROR_TEXT[result.error], result.error === 'rate-limited' ? 429 : 422);
  };

  app.get('/w/:wallId/me/create', user, (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const error = c.req.query('error');
    return renderCreate(c, found.own, found.hosted, error && deps.demo && demoModelError(error) ? demoModelError(error) : error && JOB_ERRORS.has(error) ? JOB_START_ERROR_TEXT[error as keyof typeof JOB_START_ERROR_TEXT] : error && STEP_ERRORS.has(error) ? STEP_ERROR_TEXT[error as keyof typeof STEP_ERROR_TEXT] : null);
  });

  app.post('/w/:wallId/me/create/start', uploadForm, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    const answers = readInterviewAnswers(c.get('form'), found.hosted, found.own);
    // 内容安全（contracts 16.1）：在交给模型之前检查
    const verdict = await deps.contentSafety.checkTexts('interview', [answers.material, ...Object.values(answers.choices).map((choice) => choice.text)]);
    if (!verdict.ok) return renderCreate(c, found.own, found.hosted, verdict.message, 422);
    const result = await found.hosted.startInterview(found.own, authOf(c).user.id, answers, c.get('uploads') ?? []);
    return afterStep(c, found.own, found.hosted, result);
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
    });
    const verdict = await deps.contentSafety.checkTexts('interview', [...edits.aiView.map((item) => item.text), ...edits.hooks.flatMap((hook) => [hook.text, hook.opener])]);
    if (!verdict.ok) return renderCreate(c, found.own, found.hosted, verdict.message, 422);
    return afterStep(c, found.own, found.hosted, found.hosted.confirm(found.own, userId, edits));
  });

  app.post('/w/:wallId/me/create/restart', form, async (c) => {
    const found = ownOf(c);
    if (!found) return renderNotFound(c);
    await found.hosted.restart(found.own, authOf(c).user.id);
    return c.redirect(`/w/${found.own.wall.id}/me/create`, 303);
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
    const verdict = await deps.contentSafety.checkText('edit', fields.request);
    if (!verdict.ok) {
      return renderError(c, { status: 400, title: '这条修改要求先不执行', message: verdict.message, back: { href: `/w/${found.own.wall.id}/me`, label: '回到工作区' } });
    }
    const block = fields.block && NM_ID_PATTERN.test(fields.block) ? fields.block : null;
    const result = found.hosted.startJob(found.own, authOf(c).user.id, {
      kind: 'edit',
      baseRevisionId: fields.revisionId ?? null,
      targetBlock: block,
      request: fields.request ?? '',
    });
    if (!result.ok) return c.redirect(`/w/${found.own.wall.id}/me?hosted=${result.error}#hosted`, 303);
    return c.redirect(`/w/${found.own.wall.id}/me/jobs/${result.job.id}`, 303);
  });

  app.get('/w/:wallId/me/jobs/:jobId', user, (c) => {
    const found = ownOf(c);
    const jobId = c.req.param('jobId');
    if (!found || !GENERATION_JOB_ID_PATTERN.test(jobId)) return renderNotFound(c);
    const auth = authOf(c);
    const job = found.hosted.findJob(found.own, auth.user.id, jobId);
    if (!job) return renderNotFound(c);
    const revision = job.revisionId ? deps.repos.revisions.findById(job.revisionId) : null;
    const base = job.baseRevisionId ? deps.repos.revisions.findById(job.baseRevisionId) : null;
    const running = job.status === 'queued' || job.status === 'running';
    return renderPage(c, {
      title: `${job.kind === 'generate' ? '生成' : '修改'}页面 · ${found.own.wall.name}`,
      refreshSeconds: running ? 3 : undefined,
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
        />
      ),
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
      title: `brief · ${own.wall.name}`,
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
    'brief-deleted': 'brief 已删除：采访内容和上传的图片都已清除。',
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
      body: <MyDataView accountLinks={!deps.demo} nickname={auth.user.nickname ?? '我'} avatarVersion={auth.user.avatarVersion} nicknameDraft={nickname} error={error} csrf={auth.session.csrfToken} profile={deps.repos.profileEntries.listForUser(auth.user.id)} briefs={deps.repos.briefs.listForOwner(auth.user.id)} blocked={deps.repos.moderation.listBlockedBy(auth.user.id)} remindersOn={deps.repos.reminders.acceptsReminders(auth.user.id)} notice={null} />,
    });
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
