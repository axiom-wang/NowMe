/**
 * 平台托管路线的页面（contracts 9 / hosted-route 2、3、5）：
 * - `CreateView`：“在这里创作”——按 brief 状态显示 素材与点选 / 追问 / 确认“AI 眼中的你” / 已确认（开始生成）；
 * - `JobView`：生成 / 修改任务的状态（进行中自动刷新）；
 * - `BriefPageView`：查看本页 brief.md；
 * - `MyDataView`：“我的资料”——长期画像与各面墙的 brief，可查看、删除。
 * 模型输出只作为文本插入（hono/jsx 自动转义），不作为 HTML。
 */
import { BRIEF_ASSETS_MAX_COUNT, BRIEF_MATERIAL_MAX_CHARS, EDIT_REQUEST_LIMITS, type SceneGuide } from '@nowme/contracts';
import type { ExampleEntry } from '@nowme/skill';
import type { FC } from 'hono/jsx';
import type { GenerationJob, OwnBriefListItem, ProfileEntry } from '../db/hosted.js';
import type { Wall } from '../db/walls.js';
import { formatDateTime } from '../format.js';
import { isDefaultChecked, isWriteInOption, type StructuredBrief } from '../hosted/brief.js';
import { JOB_ERROR_TEXT, type HostedOverview, type JobStartError, type StepError } from '../hosted/service.js';
import { CsrfField, Notice, PostButton } from './forms.js';

export const STEP_ERROR_TEXT: Record<StepError, string> = {
  'rate-limited': '今天的采访次数用完了（为了控制成本，每页每天有上限），明天再继续。已填写的内容没有丢。',
  'model-failed': '这一步没成功（AI 没有给出能用的结果）。再点一次试试；这不会扣免费次数。',
  'wrong-state': '这一步已经过期了，请从当前步骤继续。',
  'too-many-images': `图片最多 ${BRIEF_ASSETS_MAX_COUNT} 张。`,
  'image-type': '只支持 PNG、JPEG、WebP、GIF 图片。',
  'image-too-large': '单张图片不能超过 2 MB。',
  'need-two-hooks': '接话点至少保留 2 个（缩略卡上要用）。',
  'need-one-sentence': '“AI 眼中的你”至少保留一句。',
  'hook-invalid': '接话点文字要 2–32 个字，开场白 1–80 个字。',
  'note-empty': '先写一句哪里不对，再让它重新整理。',
};

export const JOB_START_ERROR_TEXT: Record<JobStartError, string> = {
  quota: '这面墙的免费次数已经用完了。你仍然可以用本地 Agent 继续修改，或发布已有的版本。',
  busy: '已经有一个任务在进行，等它结束再开始新的。',
  daily: '今天发起的生成次数太多了，明天再试。',
  'no-brief': '先完成采访并确认“AI 眼中的你”，才能开始生成。',
  'no-revision': '这个版本不能修改（可能没通过校验或已删除）。',
  'bad-block': '选的区块不在这个版本里。',
  'bad-request': `修改要求要写 ${EDIT_REQUEST_LIMITS.min}–${EDIT_REQUEST_LIMITS.max} 个字。`,
};

export const PRIVACY_NOTE = '你填写的内容和图片会发送给 Claude API 用来生成页面，保存在 NOWMe 平台、只有你自己能看到，不会给组织者或其他成员看；随时可以在“我的资料”里删除。';

const MOTION_OPTIONS = [
  { value: 'calm', label: '安静' },
  { value: 'medium', label: '适中' },
  { value: 'lively', label: '活泼' },
] as const;

export interface CreateViewModel {
  wall: Wall;
  csrf: string;
  scene: SceneGuide;
  examples: ExampleEntry[];
  overview: HostedOverview;
  error: string | null;
}

function base(wall: Wall): string {
  return `/w/${wall.id}/me`;
}

const QuotaLine: FC<{ overview: HostedOverview }> = ({ overview }) => (
  <p class="muted hosted-quota">
    免费次数：剩 <strong>{overview.quota.remaining}</strong> / {overview.quota.total} 次（生成和修改各算一次，失败不扣）
  </p>
);

const Steps: FC<{ current: number }> = ({ current }) => (
  <ol class="progress" aria-label="采访进度">
    {['素材与点选', '追问', '确认“AI 眼中的你”', '生成'].map((label, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'todo';
      return (
        <li class={`progress__step progress__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
          <span class="progress__num" aria-hidden="true">
            {state === 'done' ? '✓' : String(index + 1)}
          </span>
          <span class="progress__label">{label}</span>
        </li>
      );
    })}
  </ol>
);

const InterviewForm: FC<{ model: CreateViewModel }> = ({ model }) => {
  const { scene } = model;
  return (
    <form method="post" action={`${base(model.wall)}/create/start`} enctype="multipart/form-data" class="stack hosted-form">
      <CsrfField token={model.csrf} />
      <section class="card">
        <h2>1. 先贴点关于你的东西</h2>
        <label class="field">
          <span class="field__label">{scene.assetPrompt}</span>
          <textarea name="material" rows={6} maxlength={BRIEF_MATERIAL_MAX_CHARS} placeholder="写好的自我介绍、作品链接、一句话描述都行"></textarea>
        </label>
        <label class="field">
          <span class="field__label">
            图片 <span class="muted">（可选，最多 {BRIEF_ASSETS_MAX_COUNT} 张，每张 2 MB 以内）</span>
          </span>
          <input type="file" name="photos" accept="image/png,image/jpeg,image/webp,image/gif" multiple />
        </label>
      </section>

      <section class="card">
        <h2>2. 点选几道题</h2>
        {scene.choiceQuestions.map((question) => (
          <fieldset class="field hosted-question">
            <legend class="field__label">
              {question.question}
              {question.required ? <span class="badge badge--warn">必答</span> : null}
            </legend>
            <div class="chips">
              {question.options.map((option, index) =>
                question.multi ? (
                  <label class="check chip-check">
                    <input type="checkbox" name={`q_${question.id}_${index}`} value="1" checked={isDefaultChecked(option)} />
                    <span>{option.replace('（默认勾选）', '')}</span>
                  </label>
                ) : (
                  <label class="check chip-check">
                    <input type="radio" name={`q_${question.id}`} value={String(index)} required={question.required} />
                    <span>{option}</span>
                  </label>
                ),
              )}
            </div>
            {question.options.some(isWriteInOption) || !question.multi ? (
              <input type="text" name={`q_${question.id}_text`} maxlength={200} placeholder="想直接写的话写在这里（可选）" class="hosted-writein" />
            ) : null}
          </fieldset>
        ))}

        <fieldset class="field hosted-question">
          <legend class="field__label">页面风格：挑 1–2 个参考（不选就是“你来定”）</legend>
          <div class="style-grid">
            {model.examples.map((example) => (
              <label class="style-option">
                <input type="checkbox" name={`style_${example.dir}`} value="1" />
                <img src={`/hosted/examples/${example.dir}.png`} alt="" loading="lazy" width={150} height={200} />
                <span>{example.style}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset class="field hosted-question">
          <legend class="field__label">动效强度</legend>
          <div class="chips">
            {MOTION_OPTIONS.map((option) => (
              <label class="check chip-check">
                <input type="radio" name="motion" value={option.value} checked={option.value === 'medium'} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
      <p class="muted hosted-privacy">{PRIVACY_NOTE}</p>
      <button type="submit" class="btn btn--primary btn--lg btn--block">
        下一步
      </button>
    </form>
  );
};

const FollowupForm: FC<{ model: CreateViewModel }> = ({ model }) => {
  const followups = model.overview.brief?.followups;
  if (!followups) return null;
  return (
    <form method="post" action={`${base(model.wall)}/create/followups`} class="stack hosted-form">
      <CsrfField token={model.csrf} />
      {followups.facts.length > 0 ? (
        <section class="card card--quiet">
          <h2>我先记下了这些</h2>
          <ul class="hosted-facts">
            {followups.facts.map((fact) => (
              <li>{fact}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section class="card">
        <h2>3. 再问 {followups.questions.length} 个小问题</h2>
        <p class="muted">都可以跳过；回答越具体，页面越像你。</p>
        {followups.questions.map((question) => (
          <fieldset class="field hosted-question">
            <legend class="field__label">{question.question}</legend>
            <div class="chips">
              {question.options.map((option, index) => (
                <label class="check chip-check">
                  <input type="radio" name={`f_${question.id}`} value={String(index)} />
                  <span>{option}</span>
                </label>
              ))}
              <label class="check chip-check">
                <input type="radio" name={`f_${question.id}`} value="skip" checked />
                <span>跳过</span>
              </label>
            </div>
            <input type="text" name={`f_${question.id}_text`} maxlength={200} placeholder="具体说说（可选）" class="hosted-writein" />
          </fieldset>
        ))}
      </section>
      <button type="submit" class="btn btn--primary btn--lg btn--block">
        整理“AI 眼中的你”
      </button>
    </form>
  );
};

const ReviewForm: FC<{ model: CreateViewModel; brief: StructuredBrief; briefMd: string | null }> = ({ model, brief, briefMd }) => (
  <div class="stack">
    <form method="post" action={`${base(model.wall)}/create/confirm`} class="stack hosted-form">
      <CsrfField token={model.csrf} />
      <section class="card">
        <h2>4. 这是 AI 眼中的你</h2>
        <p class="muted">每一句都可以改写或划掉。确认之后才会开始做页面，页面上的每一句话都能在这里找到出处。</p>
        {brief.mustHaveMissing.length > 0 ? (
          <Notice tone="warning">
            还缺这些信息：{brief.mustHaveMissing.map((item) => item.reason).join('；')}。你可以直接确认，缺的部分不会出现在页面上（不会编造）。
          </Notice>
        ) : null}
        <ol class="hosted-aiview">
          {brief.aiView.map((sentence, index) => (
            <li>
              <input type="text" name={`ai_${index}`} value={sentence} maxlength={120} aria-label={`第 ${index + 1} 句`} />
              <label class="check">
                <input type="checkbox" name={`ai_${index}_drop`} value="1" />
                <span>划掉</span>
              </label>
            </li>
          ))}
        </ol>
      </section>
      <section class="card">
        <h2>接话点</h2>
        <p class="muted">别人看到后可以点“想聊这个”来找你；开场白是对方发给你的第一句话。至少保留 2 个。</p>
        <ol class="hosted-hooks">
          {brief.hooks.map((hook, index) => (
            <li class="stack stack--tight">
              <label class="field">
                <span class="field__label">接话点 {index + 1}</span>
                <input type="text" name={`hook_${index}_text`} value={hook.text} maxlength={32} />
              </label>
              <label class="field">
                <span class="field__label">开场白</span>
                <input type="text" name={`hook_${index}_opener`} value={hook.opener} maxlength={80} />
              </label>
              <label class="check">
                <input type="checkbox" name={`hook_${index}_drop`} value="1" />
                <span>划掉这个接话点</span>
              </label>
            </li>
          ))}
        </ol>
      </section>
      {brief.profileSuggestions.length > 0 ? (
        <section class="card card--quiet">
          <h2>记住这些，下次不用再问</h2>
          <p class="muted">勾选的会保存进你的长期画像（只有你能看到，可以在“我的资料”里删除）。这一页的意图不会被记住。</p>
          {brief.profileSuggestions.map((item, index) => (
            <label class="check">
              <input type="checkbox" name={`profile_${index}`} value="1" checked />
              <span>{item.text}</span>
            </label>
          ))}
        </section>
      ) : null}
      <button type="submit" class="btn btn--primary btn--lg btn--block">
        确认，就是我
      </button>
    </form>
    <form method="post" action={`${base(model.wall)}/create/revise`} class="card stack hosted-form">
      <CsrfField token={model.csrf} />
      <label class="field">
        <span class="field__label">哪里不对？写一句，让它重新整理</span>
        <textarea name="note" rows={2} maxlength={300} placeholder="例如：我不是新手了，已经玩了三年"></textarea>
      </label>
      <button type="submit" class="btn btn--ghost">
        重新整理
      </button>
    </form>
    {briefMd ? (
      <details class="card card--quiet">
        <summary>查看完整的 brief</summary>
        <pre class="code code--wrap">{briefMd}</pre>
      </details>
    ) : null}
  </div>
);

const ActiveJobNotice: FC<{ model: CreateViewModel }> = ({ model }) => {
  const job = model.overview.activeJob;
  if (!job) return null;
  return (
    <Notice tone="info">
      正在{job.kind === 'generate' ? '生成' : '修改'}页面… <a href={`${base(model.wall)}/jobs/${job.id}`}>查看进度</a>
    </Notice>
  );
};

const ConfirmedPanel: FC<{ model: CreateViewModel }> = ({ model }) => {
  const brief = model.overview.brief?.brief;
  return (
    <section class="card stack">
      <h2>brief 已确认</h2>
      {brief ? (
        <blockquote class="hosted-quote">
          {brief.aiView.map((sentence) => (
            <p>{sentence}</p>
          ))}
        </blockquote>
      ) : null}
      <div class="actions">
        {model.overview.activeJob ? null : (
          <PostButton
            action={`${base(model.wall)}/generate`}
            csrf={model.csrf}
            label={model.overview.quota.remaining > 0 ? '开始生成页面' : '免费次数已用完'}
            variant="primary"
          />
        )}
        <a class="btn btn--ghost" href={`${base(model.wall)}/brief`}>
          查看 brief
        </a>
        <PostButton
          action={`${base(model.wall)}/create/restart`}
          csrf={model.csrf}
          label="重新采访"
          confirm="重新采访会删除这一页的 brief 和上传的图片（已生成的版本不受影响）。继续吗？"
        />
      </div>
      <p class="muted">生成大约需要一两分钟。生成好的页面会出现在工作区的版本列表里，预览满意后由你确认发布；平台不会替你发布。</p>
    </section>
  );
};

export const CreateView: FC<{ model: CreateViewModel }> = ({ model }) => {
  const view = model.overview.brief;
  const status = view?.record.status ?? 'collecting';
  const step = status === 'collecting' ? 0 : status === 'followups' ? 1 : status === 'review' ? 2 : 3;
  return (
    <div class="container container--form">
      <p class="crumbs">
        <a href="/">我的</a>
        <span aria-hidden="true">/</span>
        <a href={`/w/${model.wall.id}`}>{model.wall.name}</a>
        <span aria-hidden="true">/</span>
        <a href={base(model.wall)}>创作工作区</a>
      </p>
      <h1 class="display form-title">在这里创作</h1>
      <p class="muted">
        {model.scene.label} · 大约 {Math.max(1, Math.round(model.scene.interviewBudgetSeconds / 60))} 分钟。以点选为主，AI 只追问必要的问题。
      </p>
      <Steps current={step} />
      <QuotaLine overview={model.overview} />
      {model.error ? <Notice tone="error">{model.error}</Notice> : null}
      <ActiveJobNotice model={model} />
      {status === 'collecting' ? <InterviewForm model={model} /> : null}
      {status === 'followups' ? <FollowupForm model={model} /> : null}
      {status === 'review' && view?.brief ? <ReviewForm model={model} brief={view.brief} briefMd={view.record.briefMd} /> : null}
      {status === 'confirmed' ? <ConfirmedPanel model={model} /> : null}
      {status !== 'collecting' && status !== 'confirmed' ? (
        <p class="hosted-restart">
          <PostButton action={`${base(model.wall)}/create/restart`} csrf={model.csrf} label="从头再来" confirm="会删除这次采访已填写的内容和图片。继续吗？" />
        </p>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export const JOB_STATUS_TEXT: Record<GenerationJob['status'], string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '完成',
  failed: '没有成功',
  needs_input: '需要你补充一句',
};

export const JobView: FC<{ wall: Wall; job: GenerationJob; revisionNumber: number | null; csrf: string; blocks: string[] }> = ({ wall, job, revisionNumber, csrf, blocks }) => {
  const label = job.kind === 'generate' ? '生成页面' : '修改页面';
  const running = job.status === 'queued' || job.status === 'running';
  return (
    <div class="container container--form">
      <p class="crumbs">
        <a href={base(wall)}>创作工作区</a>
      </p>
      <h1 class="display form-title">{label}</h1>
      <section class="card stack" aria-live="polite">
        <p>
          状态：<span class={`badge ${job.status === 'succeeded' ? 'badge--ok' : job.status === 'failed' ? 'badge--bad' : 'badge--warn'}`}>{JOB_STATUS_TEXT[job.status]}</span>
          <span class="muted"> · {formatDateTime(job.createdAt)} 开始</span>
        </p>
        {running ? <p class="muted">AI 正在按 Skill 写页面、校验、看截图自查……这个页面会自动刷新。大约需要一两分钟。</p> : null}
        {job.status === 'succeeded' && job.revisionId ? (
          <>
            {job.resultMessage ? <p>{job.resultMessage}</p> : null}
            <p>
              已保存为第 {revisionNumber ?? '?'} 版（用掉 1 次免费次数）。预览满意后，在工作区确认缩略卡和联系方式再发布。
            </p>
            <p>
              <a class="btn btn--primary" href={`${base(wall)}?rev=${job.revisionId}#preview-heading`}>
                去预览第 {revisionNumber ?? '?'} 版
              </a>
            </p>
          </>
        ) : null}
        {job.status === 'failed' ? <Notice tone="error">{JOB_ERROR_TEXT[job.errorCode ?? 'INTERNAL'] ?? JOB_ERROR_TEXT.INTERNAL}</Notice> : null}
        {job.status === 'needs_input' ? (
          <>
            <Notice tone="warning">{job.resultMessage ?? '需要你说得再具体一点。'}（这次不扣免费次数）</Notice>
            {job.baseRevisionId ? <EditForm wallId={wall.id} csrf={csrf} revisionId={job.baseRevisionId} blocks={blocks} request={job.requestText ?? ''} /> : null}
          </>
        ) : null}
        {job.kind === 'edit' && job.requestText ? <p class="muted">你的修改要求：{job.requestText}</p> : null}
      </section>
    </div>
  );
};

/** 修改这一版（W08）：可选目标区块 + 日常语言的修改要求。 */
export const EditForm: FC<{ wallId: string; csrf: string; revisionId: string; blocks: string[]; request?: string; revisionNumber?: number }> = ({
  wallId,
  csrf,
  revisionId,
  blocks,
  request,
  revisionNumber,
}) => (
  <form method="post" action={`/w/${wallId}/me/edit`} class="stack hosted-edit">
    <CsrfField token={csrf} />
    <input type="hidden" name="revisionId" value={revisionId} />
    <label class="field">
      <span class="field__label">改哪一块{revisionNumber ? `（第 ${revisionNumber} 版）` : ''}</span>
      <select name="block">
        <option value="">让 AI 判断</option>
        {blocks.map((block) => (
          <option value={block}>{block}</option>
        ))}
      </select>
    </label>
    <label class="field">
      <span class="field__label">想怎么改？</span>
      <textarea name="request" rows={3} required maxlength={EDIT_REQUEST_LIMITS.max} placeholder="例如：首屏的字再大一点；换成蓝色调；再加一句我拿过校赛二等奖">
        {request ?? ''}
      </textarea>
    </label>
    <button type="submit" class="btn btn--accent">
      按这个修改（用 1 次免费次数）
    </button>
  </form>
);

// ---------------------------------------------------------------------------
// brief 与我的资料
// ---------------------------------------------------------------------------

export const BriefPageView: FC<{ wall: Wall; csrf: string; briefMd: string; briefId: string }> = ({ wall, csrf, briefMd, briefId }) => (
  <div class="container container--form">
    <p class="crumbs">
      <a href={base(wall)}>创作工作区</a>
      <span aria-hidden="true">/</span>
      <a href={`${base(wall)}/create`}>在这里创作</a>
    </p>
    <h1 class="display form-title">这一页的 brief</h1>
    <p class="muted">只有你自己能看到。删除后，这一页的采访内容和上传的图片都会清除（已生成的版本不受影响）。</p>
    <pre class="code code--wrap card">{briefMd}</pre>
    <PostButton
      action={`${base(wall)}/brief/delete`}
      csrf={csrf}
      label="删除这份 brief"
      variant="danger"
      fields={{ briefId }}
      confirm="删除后无法恢复。继续吗？"
    />
  </div>
);

const CATEGORY_LABEL: Record<ProfileEntry['category'], string> = { fact: '事实', quote: '原话', preference: '偏好', boundary: '边界' };
const BRIEF_STATUS_LABEL: Record<OwnBriefListItem['status'], string> = { collecting: '采访中', followups: '追问中', review: '待确认', confirmed: '已确认' };

export const MyDataView: FC<{ csrf: string; profile: ProfileEntry[]; briefs: OwnBriefListItem[]; notice: string | null }> = ({ csrf, profile, briefs, notice }) => (
  <div class="container container--form">
    <h1 class="display form-title">我的资料</h1>
    <p class="muted">在应用内创作时保存的长期画像与 brief 都在这里，只有你自己能看到；组织者和其他成员都看不到。</p>
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <section class="card stack" aria-labelledby="profile-heading">
      <h2 id="profile-heading">长期画像（{profile.length} 条）</h2>
      {profile.length === 0 ? (
        <p class="muted">还没有。确认 brief 时勾选“记住这些”，下次采访就不用再问。</p>
      ) : (
        <ul class="hosted-profile">
          {profile.map((entry) => (
            <li>
              <span class="badge">{CATEGORY_LABEL[entry.category]}</span> {entry.text}
              <span class="muted"> · {entry.confirmation === 'owner-stated' ? '你明确说过' : '你确认过'} · {formatDateTime(entry.updatedAt)}</span>
              <PostButton action="/account/profile/delete" csrf={csrf} label="删除" fields={{ entryId: entry.id }} />
            </li>
          ))}
        </ul>
      )}
      {profile.length > 0 ? (
        <PostButton action="/account/profile/delete" csrf={csrf} label="全部删除" variant="danger" fields={{ all: '1' }} confirm="删除全部长期画像？无法恢复。" />
      ) : null}
    </section>
    <section class="card stack" aria-labelledby="briefs-heading">
      <h2 id="briefs-heading">各面墙的 brief（{briefs.length} 份）</h2>
      {briefs.length === 0 ? (
        <p class="muted">还没有。</p>
      ) : (
        <ul class="hosted-profile">
          {briefs.map((item) => (
            <li>
              <strong>{item.wallName}</strong>
              <span class="muted">
                {' '}
                · {BRIEF_STATUS_LABEL[item.status]} · {formatDateTime(item.updatedAt)}
                {item.wallClosed ? ' · 墙已关闭' : item.membershipStatus !== 'active' ? ' · 你已不在这面墙' : ''}
              </span>
              {!item.wallClosed && item.membershipStatus === 'active' ? (
                <a href={`/w/${item.wallId}/me/brief`}> 查看</a>
              ) : null}
              <PostButton action="/account/briefs/delete" csrf={csrf} label="删除" fields={{ briefId: item.id }} confirm="删除这份 brief 和上传的图片？无法恢复。" />
            </li>
          ))}
        </ul>
      )}
    </section>
  </div>
);
