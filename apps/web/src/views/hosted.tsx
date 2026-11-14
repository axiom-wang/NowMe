import { DEMO_MODEL_MISSING, demoModelError } from '../demo-access.js';
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
import type { AiStatus } from '../services/billing.js';
import { CsrfField, Notice, PostButton } from './forms.js';
import { initialOf } from './layout.js';
import { HomeIcon } from './home-icons.js';

export const STEP_ERROR_TEXT: Record<StepError, string> = {
  MODEL_CONFIG: JOB_ERROR_TEXT.MODEL_CONFIG!,
  MODEL_AUTH: JOB_ERROR_TEXT.MODEL_AUTH!,
  MODEL_RATE_LIMITED: JOB_ERROR_TEXT.MODEL_RATE_LIMITED!,
  MODEL_UNAVAILABLE: JOB_ERROR_TEXT.MODEL_UNAVAILABLE!,
  'rate-limited': '今天的采访次数用完了（为防止任务过载，每页每天有运行上限），明天再继续。已填写的内容没有丢。',
  'model-failed': '这一步没成功（AI 没有给出能用的结果）。可以再试一次。',
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
  MODEL_CONFIG: JOB_ERROR_TEXT.MODEL_CONFIG!,
  MODEL_AUTH: JOB_ERROR_TEXT.MODEL_AUTH!,
  MODEL_RATE_LIMITED: JOB_ERROR_TEXT.MODEL_RATE_LIMITED!,
  MODEL_UNAVAILABLE: JOB_ERROR_TEXT.MODEL_UNAVAILABLE!,
  busy: '已经有一个任务在进行，等它结束再开始新的。',
  daily: '今天发起的生成次数太多了，明天再试。',
  'no-brief': '先完成采访并确认“AI 眼中的你”，才能开始生成。',
  'no-revision': '这个版本不能修改（可能没通过校验或已删除）。',
  'bad-block': '选的区块不在这个版本里。',
  'bad-request': `修改要求要写 ${EDIT_REQUEST_LIMITS.min}–${EDIT_REQUEST_LIMITS.max} 个字。`,
  credits: '点数不够，这次没有开始。可以用兑换码补充点数、请组织者给这面墙充额度，或在 AI 设置里填自己的模型 Key（不消耗点数）。',
};

/** 价目的一句话：生成一版 N 点、修改一次 M 点；都为 0 时说明不收。 */
export function priceText(prices: AiStatus['prices']): string {
  if (prices.generate === 0 && prices.edit === 0) return '生成与修改都不收点数';
  return `生成一版页面 ${prices.generate} 点，修改一次 ${prices.edit} 点；没做出新版本不收`;
}

/** 平台 AI 模式下“我现在有多少点可用”。 */
export function allowanceText(ai: AiStatus): string {
  const parts = [ai.wallAllowance > 0 ? `这面墙还能为你出 ${ai.wallAllowance} 点` : '', `你有 ${ai.balance} 点`].filter(Boolean);
  return parts.join('，');
}

export function privacyNote(providers: string, demo = false, platform = false): string {
  const cost = demo ? '模型费用由演示提供者承担' : platform ? '采访不收点数' : '模型费用由服务商向你收取';
  return `你填写的内容和图片会发送给 AI 模型服务（${providers}）用来生成页面，${cost}；资料保存在 NOWMe 平台、只有你自己能看到，不会给组织者或其他成员看；随时可以在“我的资料”里删除。`;
}

const MOTION_OPTIONS = [
  { value: 'calm', label: '安静' },
  { value: 'medium', label: '适中' },
  { value: 'lively', label: '活泼' },
] as const;

export interface CreateViewModel {
  demo?: boolean;
  wall: Wall;
  csrf: string;
  scene: SceneGuide;
  examples: ExampleEntry[];
  overview: HostedOverview;
  error: string | null;
  /** 隐私说明里“发给哪家模型服务”。 */
  providers: string;
}

function base(wall: Wall): string {
  return `/w/${wall.id}/me`;
}

const ModelNotice: FC<{ overview: HostedOverview; demo?: boolean }> = ({ overview, demo }) => {
  if (!demo && overview.ai.mode === 'platform') {
    return (
      <p class="muted">
        使用 NOWMe 的 AI：采访不收点数；{priceText(overview.ai.prices)}。{allowanceText(overview.ai)}。 <a href="/account/credits">点数</a>
      </p>
    );
  }
  return (
    <p class="muted">{demo ? DEMO_MODEL_MISSING : overview.modelReady ? '使用你的 AI API，模型费用由服务商向你收取；失败请求也可能计费。' : '请先配置你自己的 AI API，已有资料与页面不受影响。'} {!demo ? <a href="/account/ai">AI 设置</a> : null}</p>
  );
};

const STEP_LABELS = [
  { label: '认识你', detail: '素材、兴趣和一点偏好' },
  { label: '聊两句', detail: 'AI 只追问必要的问题' },
  { label: '确认资料', detail: '看看“AI 眼中的你”' },
  { label: '生成页面', detail: '预览满意，再亲自发布' },
];

const Steps: FC<{ current: number }> = ({ current }) => (
  <ol class="progress" aria-label="采访进度">
    {STEP_LABELS.map(({ label, detail }, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'todo';
      return (
        <li class={`progress__step progress__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
          <span class="progress__num" aria-hidden="true">{state === 'done' ? '✓' : String(index + 1)}</span>
          <span class="progress__label">{label}<small>{detail}</small></span>
        </li>
      );
    })}
  </ol>
);

const SectionHeading: FC<{ number: string; title: string; hint: string; optional?: boolean }> = ({ number, title, hint, optional }) => (
  <header class="create-section__head">
    <span class="create-section__number" aria-hidden="true">{number}</span>
    <div><h2>{title}{optional ? <span class="create-optional">可选</span> : null}</h2><p>{hint}</p></div>
  </header>
);

const InterviewForm: FC<{ model: CreateViewModel }> = ({ model }) => {
  const { scene } = model;
  const saved = model.overview.brief?.answers;
  return (
    <form method="post" action={`${base(model.wall)}/create/start`} enctype="multipart/form-data" class="stack hosted-form create-interview" data-interview>
      <CsrfField token={model.csrf} />
      <section class="card create-section">
        <SectionHeading number="01" title="先分享一点关于你" hint="一句话、一张照片，都可以成为灵感。没有素材也可以直接往下选。" optional />
        <label class="field">
          <span class="field__label">关于你的素材</span>
          <span class="field__hint" id="material-hint">{scene.assetPrompt}</span>
          <textarea name="material" rows={4} maxlength={BRIEF_MATERIAL_MAX_CHARS} aria-describedby="material-hint" placeholder="比如：周末喜欢钻进山里，最近在练习用胶片记录路上的小事……">{saved?.material ?? ''}</textarea>
        </label>
        <div class="create-material-meta"><span>自我介绍、作品链接，或一个小细节</span><span data-material-count aria-label="素材字数">{saved?.material.length ?? 0} / {BRIEF_MATERIAL_MAX_CHARS}</span></div>
        <label class="create-upload">
          <input type="file" name="photos" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-describedby="photos-hint photos-status" />
          <span class="create-upload__icon" aria-hidden="true"><HomeIcon name="plus" /></span>
          <span><strong>添加几张能代表你的照片</strong><span id="photos-hint">生活照、作品、你的桌面都行 · 最多 {BRIEF_ASSETS_MAX_COUNT} 张，每张 2 MB 以内</span></span>
          <span class="create-upload__action" aria-hidden="true">选择图片</span>
        </label>
        <p class="field__hint create-upload__status" id="photos-status" data-photo-status role="status">{model.overview.brief?.assets.length ? `已保存 ${model.overview.brief.assets.length} 张图片；不选择新图片时继续使用。` : '支持 PNG、JPEG、WebP、GIF'}</p>
        <div class="create-photo-list" data-photo-list></div>
      </section>

      <section class="card create-section">
        <SectionHeading number="02" title="点选几下，认识你多一点" hint="凭直觉选就好。除了标记必答的问题，其他都可以跳过。" />
        <div class="create-questions">
          {scene.choiceQuestions.map((question) => {
            const prompt = question.question.replace(/【(?:先选这个|必答)】/g, '');
            const parts = /^(.*?)（([^）]+)）$/.exec(prompt);
            return (
              <fieldset class="field hosted-question">
                <legend class="field__label">{parts?.[1] ?? prompt}{question.required ? <span class="create-required">必答</span> : <span class="create-question-type">{question.multi ? '可多选' : '可跳过'}</span>}</legend>
                {parts ? <p class="field__hint">{parts[2]}</p> : null}
                <div class="chips">
                  {question.options.map((option, index) =>
                    question.multi ? (
                      <label class="check chip-check">
                        <input type="checkbox" name={`q_${question.id}_${index}`} value="1" data-write-in={isWriteInOption(option) ? '' : undefined} checked={saved ? saved.choices[question.id]?.selected.includes(option.replace('（默认勾选）', '')) : isDefaultChecked(option)} />
                        <span>{option.replace('（默认勾选）', '')}</span>
                      </label>
                    ) : (
                      <label class="check chip-check">
                        <input type="radio" name={`q_${question.id}`} value={String(index)} data-write-in={isWriteInOption(option) || /只写|^其他/.test(option) ? '' : undefined} checked={saved?.choices[question.id]?.selected.includes(option)} required={question.required} />
                        <span>{option}</span>
                      </label>
                    ),
                  )}
                </div>
                {question.options.some(isWriteInOption) || !question.multi ? (
                  <details class="create-writein" open={!!saved?.choices[question.id]?.text}>
                    <summary>想自己写，或补充一句？</summary>
                    <label class="field"><span class="visually-hidden">{parts?.[1] ?? prompt}：补充说明</span><input type="text" name={`q_${question.id}_text`} maxlength={200} value={saved?.choices[question.id]?.text ?? ''} placeholder="用你自己的话说说（可选）" class="hosted-writein" /></label>
                  </details>
                ) : null}
              </fieldset>
            );
          })}
        </div>
      </section>

      <section class="card create-section">
        <SectionHeading number="03" title="选一种，你喜欢的样子" hint="挑 1–2 个风格参考，也可以不选，让 AI 来发挥。" optional />
        <fieldset class="field hosted-question create-styles">
          <legend class="visually-hidden">页面风格</legend>
          <div class="style-grid">
            {model.examples.map((example) => {
              const [title, ...description] = example.style.split('：');
              return (
                <label class="style-option">
                  <input type="checkbox" name={`style_${example.dir}`} value="1" checked={saved?.styles.includes(example.dir)} aria-label={example.style} />
                  <span class="style-option__check" aria-hidden="true">✓</span>
                  <img src={`/hosted/examples/${example.dir}.png`} alt="" loading="lazy" width={300} height={400} />
                  <span class="style-option__copy"><strong>{title}</strong><small>{description.join('：')}</small></span>
                </label>
              );
            })}
          </div>
          <p class="field__hint create-style-status" data-style-status role="status">{saved?.styles.length ? `已选 ${saved.styles.length} / 2 个参考` : '还没想好？不选也没关系。'}</p>
        </fieldset>
        <fieldset class="field hosted-question create-motion">
          <legend class="field__label">让页面动起来<span class="create-question-type">动效强度</span></legend>
          <div class="chips">
            {MOTION_OPTIONS.map((option) => (
              <label class="check chip-check">
                <input type="radio" name="motion" value={option.value} checked={option.value === (saved?.motion ?? 'medium')} />
                <span>{option.label}<small>{option.value === 'calm' ? '安静地展示' : option.value === 'medium' ? '一点灵动，刚刚好' : '多一点互动惊喜'}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
      <div class="create-submit">
        <div class="create-submit__privacy"><HomeIcon name="eye" /><p class="muted hosted-privacy">{privacyNote(model.providers, model.demo, model.overview.ai.mode === 'platform')}</p></div>
        <div class="create-submit__action"><p>接下来，AI 会和你聊两句。<small>确认资料后，才开始生成页面。</small></p><button type="submit" class="btn btn--primary btn--lg">下一步<HomeIcon name="arrow" /></button></div>
      </div>
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
            label="开始生成页面"
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
    <div class="container create-page">
      <nav class="crumbs create-crumbs" aria-label="当前位置">
        <a href="/">我的</a><span aria-hidden="true">/</span>
        <a href={`/w/${model.wall.id}`}>{model.wall.name}</a><span aria-hidden="true">/</span>
        <a href={base(model.wall)}>创作工作区</a>
      </nav>
      <header class="create-intro">
        <div><p class="create-eyebrow"><span aria-hidden="true">✳</span> 每一面，都是你</p><h1>在这里创作<span class="create-intro__dot" aria-hidden="true">.</span></h1><p class="create-intro__lead">不用从空白页开始。和 AI 聊聊，做一页有个性的自己。</p></div>
        <p class="create-duration"><span>约 <strong>{Math.max(1, Math.round(model.scene.interviewBudgetSeconds / 60))}</strong> 分钟</span><small>完成这次小采访</small></p>
      </header>
      <div class="create-layout">
        <aside class="create-journey" aria-label="创作流程">
          <p class="create-journey__title">你的创作旅程<span>0{step + 1} / 04</span></p>
          <Steps current={step} />
          {model.demo && model.overview.modelReady ? null : <div class={`create-model${model.overview.modelReady ? ' create-model--ready' : ''}`}>
            <p class="create-model__title"><span aria-hidden="true"></span>{model.overview.ai.mode === 'platform' ? 'AI 已就绪' : model.overview.modelReady ? '你的 AI 已就绪' : '先连接你的 AI'}</p>
            <ModelNotice overview={model.overview} demo={model.demo} />
          </div>}
          <p class="create-journey__note"><HomeIcon name="eye" /><span>资料先留给自己。<br />页面由你预览、确认发布。</span></p>
          <a class="create-back" href={base(model.wall)}>← 返回创作工作区</a>
        </aside>
        <div class="create-content">
          {model.error ? <Notice tone="error">{model.error}</Notice> : null}
          <ActiveJobNotice model={model} />
          {!model.overview.modelReady && status === 'collecting' ? <section class="card create-empty"><HomeIcon name="pencil" /><h2>连接 AI，开始认识你</h2><p>{model.demo ? DEMO_MODEL_MISSING : '先在 AI 设置中添加你的模型服务，再回来开始这次小采访。'}</p>{!model.demo ? <a class="btn btn--primary" href="/account/ai">前往 AI 设置<HomeIcon name="arrow" /></a> : null}</section> : null}
          {model.overview.modelReady && status === 'collecting' ? <InterviewForm model={model} /> : null}
          {status === 'followups' ? <FollowupForm model={model} /> : null}
          {status === 'review' && view?.brief ? <ReviewForm model={model} brief={view.brief} briefMd={view.record.briefMd} /> : null}
          {status === 'confirmed' ? <ConfirmedPanel model={model} /> : null}
          {status !== 'collecting' && status !== 'confirmed' ? <div class="hosted-restart"><PostButton action={`${base(model.wall)}/create/restart`} csrf={model.csrf} label="从头再来" confirm="会删除这次采访已填写的内容和图片。继续吗？" /></div> : null}
        </div>
      </div>
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

/** 任务的点数情况：扣了多少、由谁付、有没有退回（没有扣过点时为 null）。 */
export interface JobCharge {
  credits: number;
  payer: 'wall' | 'user';
  refunded: boolean;
}

export const JobView: FC<{ demo?: boolean; wall: Wall; job: GenerationJob; revisionNumber: number | null; csrf: string; blocks: string[]; charge?: JobCharge | null; platform?: boolean }> = ({ wall, job, revisionNumber, csrf, blocks, demo, charge = null, platform = false }) => {
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
        {charge ? (
          <p class="muted job-charge">
            {charge.refunded
              ? `这次没有做出新版本，${charge.credits} 点已退回${charge.payer === 'wall' ? '这面墙的额度' : '你的余额'}。`
              : `${running ? '已预扣' : '这次用了'} ${charge.credits} 点（${charge.payer === 'wall' ? '这面墙的额度，组织者为你付' : '你的点数'}）${running ? '；没做出新版本会全额退回' : ''}。`}
          </p>
        ) : null}
        {job.status === 'succeeded' && job.revisionId ? (
          <>
            {job.resultMessage ? <p>{job.resultMessage}</p> : null}
            <p>
              已保存为第 {revisionNumber ?? '?'} 版。预览满意后，在工作区确认缩略卡和联系方式再发布。
            </p>
            <p>
              <a class="btn btn--primary" href={`${base(wall)}?rev=${job.revisionId}#preview-heading`}>
                去预览第 {revisionNumber ?? '?'} 版
              </a>
            </p>
          </>
        ) : null}
        {job.status === 'failed' ? <><Notice tone="error">{(demo ? demoModelError(job.errorCode ?? '') : null) ?? JOB_ERROR_TEXT[job.errorCode ?? 'INTERNAL'] ?? JOB_ERROR_TEXT.INTERNAL}</Notice><p class="muted">{demo ? '请重试；若仍失败，请维护者检查模型权限、余额和连接。费用由演示提供者承担。' : platform ? '可以再试一次；一直不行的话，过一会儿再来。' : <>模型服务商可能已收取调用费用。<a href="/account/ai">检查 AI 设置</a></>}</p></> : null}
        {job.status === 'failed' ? job.kind === 'generate'
          ? <PostButton action={`${base(wall)}/generate`} csrf={csrf} label="重新生成页面" />
          : job.baseRevisionId ? <EditForm wallId={wall.id} csrf={csrf} revisionId={job.baseRevisionId} blocks={blocks} request={job.requestText ?? ''} /> : null : null}
        {job.status === 'needs_input' ? (
          <>
            <Notice tone="warning">{job.resultMessage ?? '需要你说得再具体一点。'}</Notice>
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
      按这个修改
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

const ProfileRow: FC<{ entry: ProfileEntry; csrf: string }> = ({ entry, csrf }) => (
  <li class="profile-row">
    <span class="profile-category">{CATEGORY_LABEL[entry.category]}</span>
    <p>{entry.text}</p>
    <details class="profile-menu">
      <summary aria-label={`管理画像：${entry.text}`}><span aria-hidden="true">···</span></summary>
      <div class="profile-menu__panel">
        <p class="muted">{entry.confirmation === 'owner-stated' ? '你明确说过' : '你确认过'}<br />{formatDateTime(entry.updatedAt)}</p>
        <PostButton action="/account/profile/delete" csrf={csrf} label="删除这条画像" variant="danger" fields={{ entryId: entry.id }} confirm="删除这条画像？无法恢复。" />
      </div>
    </details>
  </li>
);

export const MyDataView: FC<{ nickname: string; avatarVersion?: string | null | undefined; nicknameDraft?: string; error?: string; csrf: string; profile: ProfileEntry[]; briefs: OwnBriefListItem[]; notice: string | null }> = ({ nickname, avatarVersion, nicknameDraft, error, csrf, profile, briefs, notice }) => (
  <div class="profile-page">
    <header class="profile-intro">
      <h1>我的资料</h1>
      <p>在应用内创作时保存的长期画像与 brief 都在这里。<br />只有你自己能看到；组织者和其他成员都看不到。</p>
    </header>
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <section class="profile-card profile-identity" aria-label="个人资料">
      <span class="profile-avatar" aria-hidden="true">{avatarVersion ? <img src={`/account/avatar?v=${avatarVersion}`} alt="" /> : initialOf(nickname)}</span>
      <div class="profile-identity__copy">
        <h2>{nickname}</h2>
        <p>{profile.find((entry) => entry.category === 'fact')?.text ?? '从一次采访开始，让 AI 慢慢认识你。'}</p>
      </div>
      <details class="profile-editor" open={!!error}>
        <summary class="profile-button"><HomeIcon name="pencil" />编辑资料</summary>
        <form method="post" action="/account/profile" enctype="multipart/form-data" class="stack profile-edit-form">
          <CsrfField token={csrf} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <label>昵称<input type="text" name="nickname" value={nicknameDraft ?? nickname} required autocomplete="nickname" aria-describedby="nickname-help" /></label>
          <p id="nickname-help" class="muted">1–24 个字。昵称和头像会显示在账号导航和同墙聊天中。</p>
          <label>头像<input type="file" name="avatar" accept="image/png,image/jpeg,image/webp" aria-describedby="avatar-help" /></label>
          <p id="avatar-help" class="muted">支持 PNG、JPEG、WebP，2 MB 以内；保存时自动居中裁成正方形。</p>
          {avatarVersion ? <label class="profile-remove-avatar"><input type="checkbox" name="removeAvatar" value="1" />移除当前头像，恢复昵称首字</label> : null}
          <div><button type="submit" class="profile-button profile-button--save">保存资料</button></div>
        </form>
      </details>
    </section>
    <section class="profile-card profile-entries" aria-labelledby="profile-heading">
      <div class="profile-section-heading">
        <h2 id="profile-heading">长期画像（{profile.length} 条）</h2>
        <details class="profile-help">
          <summary><HomeIcon name="plus" />如何添加</summary>
          <div class="profile-help__panel">在墙的创作工作区完成采访，确认 brief 时勾选“记住这些”，就能保存新的画像。<a href="/">前往我的墙 <span aria-hidden="true">→</span></a></div>
        </details>
      </div>
      {profile.length === 0 ? (
        <div class="profile-empty"><p>还没有长期画像</p><span>确认 brief 时勾选“记住这些”，下次采访就不用再问。</span></div>
      ) : (
        <>
          <ul class="profile-list">{profile.slice(0, 6).map((entry) => <ProfileRow entry={entry} csrf={csrf} />)}</ul>
          {profile.length > 6 ? <details class="profile-more">
            <summary class="profile-button"><span class="profile-more__closed">展开全部 {profile.length} 条</span><span class="profile-more__open">收起画像</span><HomeIcon name="chevron" /></summary>
            <ul class="profile-list">{profile.slice(6).map((entry) => <ProfileRow entry={entry} csrf={csrf} />)}</ul>
          </details> : null}
          <details class="profile-clear"><summary>管理全部画像</summary><PostButton action="/account/profile/delete" csrf={csrf} label="全部删除" variant="danger" fields={{ all: '1' }} confirm="删除全部长期画像？无法恢复。" /></details>
        </>
      )}
    </section>
    <section class="profile-card profile-briefs" aria-labelledby="briefs-heading">
      <h2 id="briefs-heading">各面墙的 brief（{briefs.length} 份）</h2>
      {briefs.length === 0 ? <div class="profile-empty"><p>还没有保存的 brief</p><span>在墙里完成采访后，你的创作资料会出现在这里。</span></div> : (
        <ul class="profile-brief-list">{briefs.map((item) => (
          <li>
            <div><h3>{item.wallName}</h3><p class="muted">{BRIEF_STATUS_LABEL[item.status]} · {formatDateTime(item.updatedAt)}{item.wallClosed ? ' · 墙已关闭' : item.membershipStatus !== 'active' ? ' · 你已不在这面墙' : ''}</p></div>
            <div class="profile-brief-actions">
              {!item.wallClosed && item.membershipStatus === 'active' ? <a class="profile-button" href={`/w/${item.wallId}/me/brief`}>查看</a> : null}
              <PostButton action="/account/briefs/delete" csrf={csrf} label="删除" fields={{ briefId: item.id }} confirm="删除这份 brief 和上传的图片？无法恢复。" />
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  </div>
);
