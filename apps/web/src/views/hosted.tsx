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
import { choiceLabel, type InterviewAnswers, isDefaultChecked, isWriteInOption, type StructuredBrief } from '../hosted/brief.js';
import { JOB_ERROR_TEXT, type HostedOverview, type JobStartError, type StepError } from '../hosted/service.js';
import { similarEntries } from '../hosted/profile.js';
import type { KnownContext } from '../hosted/known-context.js';
import type { AiStatus } from '../services/billing.js';
import { creationRoute, creditGap, type CreationRoute } from '../services/workspace-stage.js';
import { CsrfField, ImagePicker, Notice, PostButton } from './forms.js';
import { initialOf } from './layout.js';
import { HomeIcon } from './home-icons.js';
import { BlockedList } from './moderation.js';
import { JobProgress } from './progress.js';
import { progressView, type ProgressView } from '../services/progress.js';
import type { BlockedUserRow } from '../db/moderation.js';

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
  'need-two-hooks': '接话点至少保留 2 个（墙上的小卡片要用）。',
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
  'no-revision': '这一版不能修改（可能没做成或已删除）。',
  'bad-block': '选的那一块不在这一版里。',
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

/** 给人看的资料：brief.md 与本地路线同一格式，只把标题里的 “brief” 换成“资料”（不改存储的文件）。 */
export function displayBriefMd(markdown: string): string {
  return markdown.replace(/^# brief：/, '# 资料：');
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
  submittedAnswers?: InterviewAnswers | undefined;
  known?: KnownContext;
  error: string | null;
  /** 隐私说明里“发给哪家模型服务”。 */
  providers: string;
  /** 刚通过邀请加入（`?welcome=1`）：显示欢迎语与“先去墙上看看”。 */
  welcome?: boolean;
}

function base(wall: Wall): string {
  return `/w/${wall.id}/me`;
}

const ModelNotice: FC<{ overview: HostedOverview }> = ({ overview }) => {
  if (overview.ai.mode === 'platform') {
    return (
      <p class="muted">
        使用 NOWMe 的 AI：采访不收点数；{priceText(overview.ai.prices)}。{allowanceText(overview.ai)}。 <a href="/account/credits">点数</a>
      </p>
    );
  }
  return (
    <p class="muted">使用你的 AI API，模型费用由服务商向你收取；失败请求也可能计费。 <a href="/account/ai">AI 设置</a></p>
  );
};

const STEP_LABELS = [
  { label: '认识你', detail: '素材、兴趣和一点偏好' },
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

const InterviewForm: FC<{ model: CreateViewModel; route: CreationRoute }> = ({ model, route }) => {
  const { scene } = model;
  const saved = model.submittedAnswers ?? model.overview.brief?.answers;
  return (
    <form method="post" action={`${base(model.wall)}/create/start`} enctype="multipart/form-data" class="stack hosted-form create-interview" data-interview>
      <CsrfField token={model.csrf} />
      {model.known && (model.known.profile.length > 0 || model.known.knownAnswers.length > 0) ? <section class="card">
        <h2>这些已经记下了，不用再填</h2>
        <ul>{model.known.profile.slice(0, 3).map((p) => <li>{p.text}</li>)}{model.known.knownAnswers.map((a) => <li>{a.question}：{a.answers.join('、')}</li>)}</ul>
        <a href="/account/data">{model.known.profile.length > 3 ? `查看全部 ${model.known.profile.length} 条与更正画像` : '更正我的画像'}</a>
      </section> : null}
      <section class="card stack">
        <h2>{model.known?.fast ? '这次只说你想突出的那一面' : '先从一句好回答的开始'}</h2>
        {!model.known?.fast || saved ? <>
          {scene.quickQuestions.map((q) => <fieldset class="field"><legend>{q.question}</legend><div class="chips">{q.options.map((o, i) => <label class="check chip-check"><input type="radio" name={`quick_${q.id}`} value={String(i)} checked={saved?.quick?.[q.id] === o} /><span>{o}</span></label>)}</div></fieldset>)}
          {scene.sentenceStarters.map((stem, i) => <label class="field"><span>{stem}＿＿</span><input type="text" name={`starter_${i}`} maxlength={200} value={saved?.starters?.[String(i)] ?? ''} placeholder="接一句就好，也可以留空" /></label>)}
        </> : null}
        <label class="field"><span class="field__label">这面墙想突出哪一面？</span><input type="text" name="intent" maxlength={200} value={saved?.intent ?? ''} placeholder="比如：会做游戏，也想找人一起打磨一个小作品" /></label>
        {model.known?.topics.length ? <fieldset class="field"><legend>墙上正在聊这些，你也想聊哪个？</legend><p class="muted">点选只表示想聊，不代表你有相关经历。</p><div class="chips">{model.known.topics.map((topic, i) => <label class="check chip-check"><input type="checkbox" name={`topic_${i}`} value="1" checked={saved?.wallTopics?.includes(topic)} /><span>{topic}</span></label>)}</div></fieldset> : null}
      </section>
      <details class="stack" open={!model.known?.fast || !!saved}><summary>{model.known?.fast ? '补充素材或调整已有回答（可选）' : '更多素材与场景问题（都可以稍后补充）'}</summary>
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
        <SectionHeading number="02" title="点选几下，认识你多一点" hint="凭直觉选就好。已知的不用重复，缺的也可以在确认时补充。" />
        <div class="create-questions">
          {scene.choiceQuestions.map((question) => {
            const prompt = question.question.replace(/^【(?:先选这个|必答|重要)】/, '');
            const parts = /^(.*?)（([^）]+)）$/.exec(prompt);
            const reused = !saved ? model.known?.choices[question.id] : undefined;
            if (reused) return <div class="card card--quiet"><p>{question.question}：{[...reused.selected, reused.text].filter(Boolean).join('；')}</p><label class="check"><input type="checkbox" name={`reuse_${question.id}`} value="1" checked /><span>沿用已确认的回答</span></label><label class="field"><span>这次改成（取消沿用后填写）</span><input type="text" name={`q_${question.id}_text`} maxlength={200} /></label></div>;
            if (question.id === 'boundaries') return null;
            const selected = saved?.choices[question.id]?.selected ?? [];
            return (
              <fieldset class="field hosted-question">
                <legend class="field__label">{parts?.[1] ?? prompt}{question.required ? <span class="create-required">建议补充</span> : <span class="create-question-type">{question.multi ? '可多选' : '可跳过'}</span>}</legend>
                {parts ? <p class="field__hint">{parts[2]}</p> : null}
                <div class="chips">
                  {question.options.map((option, index) => {
                    if (!question.multi && !question.required && option === '跳过') return null;
                    return question.multi ? (
                      <label class="check chip-check">
                        <input type="checkbox" name={`q_${question.id}_${index}`} value="1" data-write-in={isWriteInOption(option) ? '' : undefined} checked={saved ? saved.choices[question.id]?.selected.includes(choiceLabel(option)) : isDefaultChecked(option)} />
                        <span>{choiceLabel(option)}</span>
                      </label>
                    ) : (
                      <label class="check chip-check">
                        <input type="radio" name={`q_${question.id}`} value={String(index)} data-write-in={isWriteInOption(option) || /只写|^其他/.test(option) ? '' : undefined} checked={selected.includes(option)} required={false} />
                        <span>{option}</span>
                      </label>
                    );
                  })}
                  {!question.multi && !question.required ? (
                    <label class="check chip-check">
                      <input type="radio" name={`q_${question.id}`} value="skip" checked={selected.length === 0 || selected.includes('跳过')} />
                      <span>跳过</span>
                    </label>
                  ) : null}
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

      <details class="card create-section"><summary>风格与动效（可以看到草稿后再调）</summary>
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
      </details>
      </details>
      <div class="create-submit">
        <CreateRouteNotice model={model} route={route} />
        <div class="create-submit__privacy"><HomeIcon name="eye" /><p class="muted hosted-privacy">{privacyNote(model.providers, model.demo, model.overview.ai.mode === 'platform')}</p></div>
        <div class="create-submit__action"><p>接下来，直接看“AI 眼中的你”。<small>确认资料后，才开始生成页面。</small></p><button type="submit" class="btn btn--primary btn--lg">下一步<HomeIcon name="arrow" /></button></div>
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
      <section class="card">
        <h2>再问 {followups.questions.length} 个小问题</h2>
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
                <input type="radio" name={`f_${question.id}`} value="skip" />
                <span>跳过</span>
              </label>
            </div>
            <input type="text" name={`f_${question.id}_text`} maxlength={200} placeholder="具体说说（可选）" aria-label={`${question.question}：具体说说（可选）`} class="hosted-writein" />
          </fieldset>
        ))}
      </section>
      {followups.facts.length > 0 ? (
        <details class="card card--quiet">
          <summary>看看 AI 已经记下了什么</summary>
          <ul class="hosted-facts">{followups.facts.map((fact) => <li>{fact}</li>)}</ul>
        </details>
      ) : null}
      <button type="submit" class="btn btn--primary btn--lg btn--block">
        整理“AI 眼中的你”
      </button>
    </form>
  );
};

const ReviewFollowup: FC<{ question: import('../hosted/brief.js').FollowupQuestion; answer?: import('../hosted/brief.js').FollowupAnswer | undefined }> = ({ question, answer }) => (
  <details class="create-writein" open={!!answer && !answer.skipped}>
    <summary>补一个例子：{question.question}</summary>
    <fieldset class="field hosted-question"><legend class="visually-hidden">{question.question}</legend>
      <div class="chips">{question.options.map((option, index) => <label class="check chip-check"><input type="radio" name={`f_${question.id}`} value={String(index)} checked={answer?.selected === option} /><span>{option}</span></label>)}</div>
      <input type="text" name={`f_${question.id}_text`} maxlength={200} value={answer?.text ?? ''} placeholder="补一个例子（可选）" aria-label={`${question.question}：补一个例子`} />
    </fieldset>
  </details>
);

const ReviewForm: FC<{ model: CreateViewModel; brief: StructuredBrief; briefMd: string | null }> = ({ model, brief, briefMd }) => {
  const pending = model.overview.brief?.followups?.reviewEdits;
  const original = brief;
  if (pending) brief = {
    ...brief,
    displayName: pending.displayName ?? brief.displayName,
    boundaries: pending.boundaries ?? brief.boundaries,
    aiView: brief.aiView.map((sentence, i) => pending.aiView[i]?.text ?? sentence),
    hooks: brief.hooks.map((hook, i) => ({ ...hook, text: pending.hooks[i]?.text ?? hook.text, opener: pending.hooks[i]?.opener ?? hook.opener })),
    profileSelection: original.profileSuggestions.filter((_, i) => pending.keepProfile.includes(i)).map((p) => p.text),
  };
  return (
  <div class="stack">
    <form method="post" action={`${base(model.wall)}/create/confirm`} class="stack hosted-form">
      <CsrfField token={model.csrf} />
      <section class="card stack">
        <h2>先确认名字与展示边界</h2>
        <label class="field"><span>页面上的显示名</span><input type="text" name="displayName" maxlength={24} required value={brief.displayName} /></label>
        <label class="check"><input type="checkbox" name="showSchool" value="1" checked={brief.boundaries.school === '显示'} /><span>可以显示学校</span></label>
        <label class="check"><input type="checkbox" name="showGradeMajor" value="1" checked={brief.boundaries.gradeMajor === '显示'} /><span>可以显示年级和专业</span></label>
        <label class="check"><input type="checkbox" name="showPhoto" value="1" checked={brief.boundaries.photo === '可以'} /><span>可以展示本人照片</span></label>
        <label class="field"><span>不想展示的信息</span><input type="text" name="hidden" maxlength={300} value={brief.boundaries.hidden.join('；')} /></label>
        <p class="muted">联系方式不写进页面；没有提供的学校、经历不会猜测。</p>
      </section>
      <section class="card">
        <h2>这是 AI 眼中的你</h2>
        <p class="muted">每一句都可以改写或划掉。确认之后才会开始做页面，页面上的每一句话都能在这里找到出处。</p>
        {brief.mustHaveMissing.length > 0 ? (
          <Notice tone="warning">
            还缺这些信息：{brief.mustHaveMissing.map((item) => item.reason).join('；')}。你可以直接确认，缺的部分不会出现在页面上（不会编造）。
          </Notice>
        ) : null}
        <ol class="hosted-aiview">
          {brief.aiView.map((sentence, index) => (
            <li>
              <details><summary>{sentence} <small>点开改写</small></summary><textarea class="hosted-review-text" name={`ai_${index}`} rows={3} maxlength={120} aria-label={`第 ${index + 1} 句`}>{sentence}</textarea></details>
              {model.overview.brief?.followups?.questions[index] ? <ReviewFollowup question={model.overview.brief.followups.questions[index]!} answer={model.overview.brief.followups.pending ? model.overview.brief.followups.answers[model.overview.brief.followups.questions[index]!.id] : undefined} /> : null}
              <label class="check">
                <input type="checkbox" name={`ai_${index}_drop`} value="1" checked={pending?.aiView[index]?.drop} />
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
              <details><summary>{hook.text} <small>点开改写</small></summary><label class="field">
                <span class="field__label">接话点 {index + 1}</span>
                <textarea class="hosted-review-text" name={`hook_${index}_text`} rows={3} maxlength={32}>{hook.text}</textarea>
              </label>
              <label class="field">
                <span class="field__label">开场白</span>
                <textarea class="hosted-review-text" name={`hook_${index}_opener`} rows={10} maxlength={80}>{hook.opener}</textarea>
              </label>
              </details><label class="check">
                <input type="checkbox" name={`hook_${index}_drop`} value="1" checked={pending?.hooks[index]?.drop} />
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
              <input type="checkbox" name={`profile_${index}`} value="1" checked={brief.profileSelection ? brief.profileSelection.includes(item.text) : true} />
              <span>{item.text}</span>
            </label>
          ))}
        </section>
      ) : null}
      {model.overview.brief?.followups?.questions.length ? <div class="stack"><p class="muted">不补充可以直接确认；补充后先重新整理给你看。</p>{model.overview.brief.followups.questions.slice(brief.aiView.length).map((question) => <ReviewFollowup question={question} answer={model.overview.brief?.followups?.pending ? model.overview.brief.followups.answers[question.id] : undefined} />)}<button name="reviewAction" value="compose" class="btn btn--ghost" type="submit">用补充内容重新整理</button></div> : null}
      <button type="submit" class="btn btn--primary btn--lg btn--block">
        确认，就是我
      </button>
    </form>

    <form method="post" action={`${base(model.wall)}/create/revise`} class="card stack hosted-form">
      <CsrfField token={model.csrf} />
      <label class="field">
        <span class="field__label">哪里不对？写一句，让它重新整理</span>
        <textarea name="note" rows={2} maxlength={300} placeholder="例如：我不是新手了，已经玩了三年">{model.overview.brief?.followups?.correction ?? ''}</textarea>
      </label>
      <button type="submit" class="btn btn--ghost">
        重新整理
      </button>
    </form>
    {briefMd ? (
      <details class="card card--quiet">
        <summary>查看完整的资料</summary>
        <pre class="code code--wrap">{displayBriefMd(briefMd)}</pre>
      </details>
    ) : null}
  </div>
  );
};

const ActiveJobNotice: FC<{ model: CreateViewModel }> = ({ model }) => {
  const job = model.overview.activeJob;
  if (!job) return null;
  return (
    <Notice tone="info">
      正在{job.kind === 'generate' ? '生成' : '修改'}页面… <a href={`${base(model.wall)}/jobs/${job.id}`}>查看进度</a>
    </Notice>
  );
};

/** 点数不够 / 平台 AI 没开放时，采访页上的说明（不甩错误码）。 */
const CreateRouteNotice: FC<{ model: CreateViewModel; route: CreationRoute }> = ({ model, route }) => {
  if (model.demo) return null;
  if (route === 'credits') {
    const gap = creditGap(model.overview.ai, 'generate');
    return (
      <Notice tone="warning">
        采访不收点数；用 NOWMe 的 AI 生成一版页面要 {gap.price} 点，你现在能用 {gap.available} 点。可以先采访，生成前<a href="/account/credits">用兑换码补充点数</a>，或者请组织者给这面墙充一点额度。
      </Notice>
    );
  }
  return null;
};

const ConfirmedPanel: FC<{ model: CreateViewModel; route: CreationRoute }> = ({ model, route }) => {
  const brief = model.overview.brief?.brief;
  const canRun = model.demo || route === 'platform' || route === 'own';
  return (
    <section class="card stack">
      <h2>资料确认好了</h2>
      {brief ? (
        <blockquote class="hosted-quote">
          {brief.aiView.map((sentence) => (
            <p>{sentence}</p>
          ))}
        </blockquote>
      ) : null}
      <p class="muted">AI 会按你确认的资料做一页你自己，一般要几分钟。做好后先给你预览，你确认了才会发布到墙上；平台不会替你发布。</p>
      {canRun && !model.demo ? <ModelNotice overview={model.overview} /> : null}
      {canRun ? null : route === 'credits' ? (
        <Notice tone="warning">
          点数不够：生成一版要 {creditGap(model.overview.ai, 'generate').price} 点，你现在能用 {creditGap(model.overview.ai, 'generate').available} 点。可以用兑换码补充点数，或者请组织者给这面墙充一点额度；也可以在“我的页面”的“更多方式”里改用自己的模型 Key。
        </Notice>
      ) : (
        <Notice tone="warning">这里暂时没有可以直接用的 AI。在 AI 设置里填自己的模型 Key 后就能生成；也可以在“我的页面”的“更多方式”里用你自己电脑上的 AI 助手。</Notice>
      )}
      <div class="actions">
        {model.overview.activeJob ? null : canRun ? (
          <PostButton action={`${base(model.wall)}/generate`} csrf={model.csrf} label="生成页面" variant="primary" />
        ) : route === 'credits' ? (
          <a class="btn btn--primary" href="/account/credits">去兑换点数</a>
        ) : (
          <a class="btn btn--primary" href="/account/ai">填写自己的模型 Key</a>
        )}
        <a class="btn btn--ghost" href={`${base(model.wall)}/brief`}>
          看看我的资料
        </a>
        <PostButton
          action={`${base(model.wall)}/create/restart`}
          csrf={model.csrf}
          label="重新采访"

        />
      </div>
    </section>
  );
};

/** 平台 AI 没开放、自己也没配置：说明原因与两种办法。 */
const SetupPanel: FC<{ model: CreateViewModel }> = ({ model }) => (
  <section class="card create-empty">
    <HomeIcon name="pencil" />
    <h2>先准备好 AI</h2>
    {model.demo ? (
      <p>{DEMO_MODEL_MISSING}</p>
    ) : (
      <>
        <p>这里暂时没有可以直接用的 AI，需要你自己准备一个。两种办法任选一种：</p>
        <ul class="next-help__list">
          <li>有模型服务的 Key（比如 DeepSeek、通义千问）？在 AI 设置里填一次，就能在这里采访和生成，费用由服务商向你收取。</li>
          <li>电脑上装了 AI 编程助手？回到“我的页面”，在“更多方式”里生成一条指令交给它。</li>
        </ul>
        <div class="actions">
          <a class="btn btn--primary" href="/account/ai">填写自己的模型 Key<HomeIcon name="arrow" /></a>
          <a class="btn btn--ghost" href={`${base(model.wall)}#more-ways`}>用自己电脑上的 AI 助手</a>
        </div>
      </>
    )}
  </section>
);

export const CreateView: FC<{ model: CreateViewModel }> = ({ model }) => {
  const view = model.overview.brief;
  const status = view?.record.status ?? 'collecting';
  const step = status === 'collecting' ? 0 : status === 'followups' || status === 'review' ? 1 : 2;
  const route = creationRoute(model.overview.ai, 'generate');
  return (
    <div class="container create-page" data-step={status}>
      <nav class="crumbs create-crumbs" aria-label="当前位置">
        <a href="/">我的</a><span aria-hidden="true">/</span>
        <a class="crumbs__wall" href={`/w/${model.wall.id}`} title={model.wall.name}>{model.wall.name}</a><span aria-hidden="true">/</span>
        <a href={base(model.wall)}>我的页面</a>
      </nav>
      {model.welcome ? (
        <Notice tone="success">
          欢迎加入「{model.wall.name}」！花几分钟做一页你自己，挂到墙上让大家认识你。想先逛逛？<a href={`/w/${model.wall.id}`}>先去墙上看看</a>
        </Notice>
      ) : null}
      <header class="create-intro">
        <div><p class="create-eyebrow"><span aria-hidden="true">✳</span> 每一面，都是你</p><h1>做一页你自己<span class="create-intro__dot" aria-hidden="true">.</span></h1><p class="create-intro__lead">不用从空白页开始。回答几个问题，AI 帮你做一页有个性的自己。</p></div>
        <p class="create-duration"><span>约 <strong>{Math.max(1, Math.round(model.scene.interviewBudgetSeconds / 60))}</strong> 分钟</span><small>完成这次小采访</small></p>
      </header>
      <div class="create-layout">
        <aside class="create-journey" aria-label="创作流程">
          <p class="create-journey__title">你的创作旅程<span>0{step + 1} / 03</span></p>
          <Steps current={step} />
          {status === 'collecting' && !model.demo && model.overview.modelReady ? <div class="create-model">
            <p class="create-model__title"><span aria-hidden="true"></span>{model.overview.ai.mode === 'platform' ? 'AI 已就绪' : '你的 AI 已就绪'}</p>
            <ModelNotice overview={model.overview} />
          </div> : null}
          <p class="create-journey__note"><HomeIcon name="eye" /><span>资料先留给自己。<br />页面由你预览、确认发布。</span></p>
          <a class="create-back" href={base(model.wall)}>← 回到我的页面</a>
        </aside>
        <section class="create-content" id="create-step" tabindex={-1} aria-label={STEP_LABELS[step]!.label}>
          {model.error ? <Notice tone="error">{model.error}</Notice> : null}
          <ActiveJobNotice model={model} />
          {!model.overview.modelReady && status === 'collecting' ? <SetupPanel model={model} /> : null}
          {model.overview.modelReady && status === 'collecting' ? <InterviewForm model={model} route={route} /> : null}
          {status === 'followups' ? <FollowupForm model={model} /> : null}
          {status === 'review' && view?.brief ? <ReviewForm model={model} brief={view.brief} briefMd={view.record.briefMd} /> : null}
          {status === 'confirmed' ? <ConfirmedPanel model={model} route={route} /> : null}
          {status !== 'collecting' && status !== 'confirmed' ? <div class="hosted-restart"><PostButton action={`${base(model.wall)}/create/restart`} csrf={model.csrf} label="补充上次的回答" /></div> : null}
        </section>
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

export const JobView: FC<{
  demo?: boolean;
  wall: Wall;
  job: GenerationJob;
  revisionNumber: number | null;
  csrf: string;
  blocks: string[];
  charge?: JobCharge | null;
  platform?: boolean;
  progress?: ProgressView | null;
  pollMs?: number;
  emailOn?: boolean;
}> = ({ wall, job, revisionNumber, csrf, blocks, demo, charge = null, platform = false, progress = null, pollMs = 3000, emailOn = false }) => {
  const label = job.kind === 'generate' ? '生成页面' : '修改页面';
  const running = job.status === 'queued' || job.status === 'running';
  return (
    <div class="container container--form job-page">
      <nav class="crumbs" aria-label="当前位置">
        <a class="crumbs__wall" href={`/w/${wall.id}`} title={wall.name}>{wall.name}</a>
        <span aria-hidden="true">/</span>
        <a href={base(wall)}>我的页面</a>
      </nav>
      <h1 class="display form-title job-page__title">{label}</h1>
      <section class="card job-card stack">
        {running ? (
          <JobProgress wallId={wall.id} jobId={job.id} kind={job.kind} view={progress ?? progressView(null)} pollMs={pollMs} emailOn={emailOn} />
        ) : (
          <p>
            <span class={`badge ${job.status === 'succeeded' ? 'badge--ok' : job.status === 'failed' ? 'badge--bad' : 'badge--warn'}`}>{JOB_STATUS_TEXT[job.status]}</span>
            <span class="muted"> · {formatDateTime(job.createdAt)} 开始</span>
          </p>
        )}
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
            <p>做好了，这是你的第 {revisionNumber ?? '?'} 版。看看满不满意：满意就确认发布，不满意可以接着改。</p>
            <p>
              <a class="btn btn--primary btn--lg" href={`${base(wall)}?rev=${job.revisionId}#preview-heading`}>
                去预览第 {revisionNumber ?? '?'} 版
              </a>
            </p>
          </>
        ) : null}
        {job.status === 'failed' ? <><Notice tone="error">{(demo ? demoModelError(job.errorCode ?? '') : null) ?? JOB_ERROR_TEXT[job.errorCode ?? 'INTERNAL'] ?? JOB_ERROR_TEXT.INTERNAL}</Notice><p class="muted">{demo ? '请重试；若仍失败，请维护者检查模型权限、余额和连接。费用由演示提供者承担。' : platform ? '可以再试一次；一直不行的话，过一会儿再来。' : <>模型服务商可能已收取调用费用。<a href="/account/ai">检查 AI 设置</a></>}</p></> : null}
        {job.status === 'failed' ? job.kind === 'generate'
          ? <PostButton action={`${base(wall)}/generate`} csrf={csrf} label="再生成一次" variant="primary" />
          : job.baseRevisionId ? <EditForm wallId={wall.id} csrf={csrf} revisionId={job.baseRevisionId} blocks={blocks} request={job.requestText ?? ''} rememberFacts={job.rememberFacts} /> : null : null}
        {job.status === 'needs_input' ? (
          <>
            <Notice tone="warning">{job.resultMessage ?? '需要你说得再具体一点。'}</Notice>
            {job.baseRevisionId ? <EditForm wallId={wall.id} csrf={csrf} revisionId={job.baseRevisionId} blocks={blocks} request={job.requestText ?? ''} rememberFacts={job.rememberFacts} /> : null}
          </>
        ) : null}
        {job.kind === 'edit' && job.requestText ? <p class="muted">你的修改要求：{job.requestText}</p> : null}
      </section>
      <p class="job-page__back">
        <a class="link-block" href={base(wall)}>← 回到我的页面</a>
      </p>
    </div>
  );
};

/** 修改这一版（W08）：可选目标区块 + 日常语言的修改要求。 */
export const EditForm: FC<{ wallId: string; csrf: string; revisionId: string; blocks: string[]; request?: string; targetBlock?: string; revisionNumber?: number; rememberFacts?: boolean | undefined }> = ({
  wallId,
  csrf,
  revisionId,
  blocks,
  request,
  targetBlock,
  revisionNumber,
  rememberFacts = false,
}) => (
  <form method="post" action={`/w/${wallId}/me/edit`} class="stack hosted-edit">
    <CsrfField token={csrf} />
    <input type="hidden" name="revisionId" value={revisionId} />
    <label class="field">
      <span class="field__label">改哪一块{revisionNumber ? `（第 ${revisionNumber} 版）` : ''}</span>
      <select name="block">
        <option value="">让 AI 判断</option>
        {blocks.map((block) => (
          <option value={block} selected={block === targetBlock}>{block}</option>
        ))}
      </select>
    </label>
    <label class="field">
      <span class="field__label">想怎么改？</span>
      <textarea name="request" rows={3} required maxlength={EDIT_REQUEST_LIMITS.max} placeholder="例如：首屏的字再大一点；换成蓝色调；再加一句我拿过校赛二等奖">
        {request ?? ''}
      </textarea>
    </label>
    <div class="chips" data-edit-shortcuts>{['更大胆', '换配色', '更安静', '首屏换一个细节'].map((text) => <button type="submit" name="shortcut" value={text} formnovalidate class="btn btn--ghost btn--small">{text}</button>)}</div>
    <label class="check"><input type="checkbox" name="rememberFacts" value="1" checked={rememberFacts} /><span>这次说的新事实，要记住吗？勾选后用于以后同类场景；无论是否勾选，都会保留在本页资料里。</span></label>
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
    <nav class="crumbs" aria-label="当前位置">
      <a href={base(wall)}>我的页面</a>
      <span aria-hidden="true">/</span>
      <a href={`${base(wall)}/create`}>采访</a>
    </nav>
    <h1 class="display form-title">这一页的资料</h1>
    <p class="muted">这是 AI 根据采访整理、你确认过的资料，做页面时只用这些。只有你自己能看到。删除后，这一页的采访内容和上传的图片都会清除（已做好的版本不受影响）。</p>
    <pre class="code code--wrap card">{displayBriefMd(briefMd)}</pre>
    <PostButton
      action={`${base(wall)}/brief/delete`}
      csrf={csrf}
      label="删除这份资料"
      variant="danger"
      fields={{ briefId }}
      confirm="删除后无法恢复。继续吗？"
    />
  </div>
);

const CATEGORY_LABEL: Record<ProfileEntry['category'], string> = { fact: '事实', quote: '原话', preference: '偏好', boundary: '边界' };
const BRIEF_STATUS_LABEL: Record<OwnBriefListItem['status'], string> = { collecting: '采访中', followups: '追问中', review: '待确认', confirmed: '已确认' };

const SCOPES = { all: '所有场景', hackathon: '黑客松 / 创业营', interest: '兴趣社群', club: '社团', general: '通用场景' };
const scopeLabel = (scope?: string) => scope?.startsWith('wall:') ? '只在来源墙' : SCOPES[(scope ?? 'all') as keyof typeof SCOPES] ?? '所有场景';
const ProfileEntryForm: FC<{ csrf: string; entry?: ProfileEntry; similar?: ProfileEntry[] }> = ({ csrf, entry, similar = [] }) => <form method="post" action="/account/profile/entry" class="stack">
  <CsrfField token={csrf} />{entry ? <input type="hidden" name="entryId" value={entry.id} /> : null}
  <label class="field"><span>要记住的一句话</span><textarea name="text" required maxlength={200} rows={3}>{entry?.text ?? ''}</textarea></label>
  <label class="field"><span>类型</span><select name="category">{Object.entries(CATEGORY_LABEL).map(([key, label]) => <option value={key} selected={key === (entry?.category ?? 'fact')}>{label}</option>)}</select></label>
  <label class="field"><span>适用范围</span><select name="scope">{Object.entries(SCOPES).map(([key, label]) => <option value={key} selected={key === (entry?.scope ?? 'all')}>{label}</option>)}{entry?.scope?.startsWith('wall:') ? <option value={entry.scope} selected>只在来源墙</option> : null}</select></label>
  {similar.length ? <label class="field"><span>发现相似条目；合并时请在上方写完整内容</span><select name="mergeId"><option value="">不合并</option>{similar.map((e) => <option value={e.id}>{e.text}</option>)}</select></label> : null}
  <button class="btn btn--ghost" type="submit">{entry ? '保存修改' : '添加画像'}</button>
</form>;

const ProfileRow: FC<{ entry: ProfileEntry; csrf: string; entries: ProfileEntry[]; briefs: OwnBriefListItem[] }> = ({ entry, csrf, entries, briefs }) => (
  <li class="profile-row">
    <span class="profile-category">{CATEGORY_LABEL[entry.category]}</span>
    <div><p>{entry.text}</p><p class="muted">适用：{scopeLabel(entry.scope)} · 来源：{entry.sourceWallId ? briefs.find((b) => b.wallId === entry.sourceWallId)?.wallName ?? '此前的墙' : entry.source === 'owner-file' ? '自己添加' : '早期采访'}</p>
    </div>
    <details class="profile-menu" data-dismissable>
      <summary aria-label={`管理画像：${entry.text}`}><span aria-hidden="true">···</span></summary>
      <div class="popover profile-menu__panel">
        <details class="profile-editor"><summary>编辑或合并</summary><ProfileEntryForm csrf={csrf} entry={entry} similar={similarEntries(entry, entries)} /></details>
        <p class="muted">{entry.confirmation === 'owner-stated' ? '你明确说过' : '你确认过'}<br />{formatDateTime(entry.updatedAt)}</p>
        <PostButton action="/account/profile/delete" csrf={csrf} label="删除这条画像" variant="danger" fields={{ entryId: entry.id }} confirm="删除这条画像？无法恢复。" />
      </div>
    </details>
  </li>
);

export const MyDataView: FC<{ accountLinks?: boolean; nickname: string; avatarVersion?: string | null | undefined; nicknameDraft?: string; error?: string; csrf: string; profile: ProfileEntry[]; briefs: OwnBriefListItem[]; notice: string | null; blocked?: BlockedUserRow[]; remindersOn?: boolean; notifyEmail?: boolean }> = ({ accountLinks, nickname, avatarVersion, nicknameDraft, error, csrf, profile, briefs, notice, blocked = [], remindersOn = true, notifyEmail = true }) => (
  <div class="profile-page">
    <header class="profile-intro">
      <h1>我的资料</h1>
    </header>
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <section class="card profile-card profile-identity" aria-label="个人资料">
      <span class="profile-avatar" aria-hidden="true">{avatarVersion ? <img src={`/account/avatar?v=${avatarVersion}`} alt="" /> : initialOf(nickname)}</span>
      <div class="profile-identity__copy">
        <h2>{nickname}</h2>
        <p>{profile.find((entry) => entry.category === 'fact')?.text ?? '从一次采访开始，让 AI 慢慢认识你。'}</p>
      </div>
      <details class="profile-editor" open={!!error}>
        <summary class="btn btn--ghost btn--small"><HomeIcon name="pencil" />编辑资料</summary>
        <form method="post" action="/account/profile" enctype="multipart/form-data" class="stack profile-edit-form">
          <CsrfField token={csrf} />
          {error ? <Notice tone="error" id="profile-error">{error}</Notice> : null}
          <label>昵称<input type="text" name="nickname" value={nicknameDraft ?? nickname} required autocomplete="nickname" aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'profile-error nickname-help' : 'nickname-help'} /></label>
          <p id="nickname-help" class="muted">1–24 个字。昵称和头像会显示在账号导航和同墙聊天中。</p>
          <ImagePicker id="profile-avatar-file" name="avatar" label="头像" describedBy="avatar-help" />
          <p id="avatar-help" class="muted">支持 PNG、JPEG、WebP，2 MB 以内；保存时自动居中裁成正方形。</p>
          {avatarVersion ? <label class="profile-remove-avatar"><input type="checkbox" name="removeAvatar" value="1" />移除当前头像，恢复昵称首字</label> : null}
          <div><button type="submit" class="btn btn--primary btn--small">保存资料</button></div>
        </form>
      </details>
    </section>
    <section class="card profile-card profile-entries" aria-labelledby="profile-heading">
      <div class="profile-section-heading">
        <h2 id="profile-heading">长期画像（{profile.length} 条）</h2>
        <details class="profile-help" data-dismissable>
          <summary><HomeIcon name="plus" />如何添加</summary>
          <div class="popover profile-help__panel">在墙里完成一次采访，确认资料时勾选“记住这些”，就能保存新的画像。<a href="/">前往我的墙 <span aria-hidden="true">→</span></a></div>
        </details>
      </div>
      <details class="card card--quiet"><summary>手动添加一条画像</summary><ProfileEntryForm csrf={csrf} /></details>
      {profile.length === 0 ? (
        <div class="profile-empty"><p>还没有长期画像</p><span>确认资料时勾选“记住这些”，下次采访就不用再问。</span></div>
      ) : (
        <>
          <ul class="profile-list">{profile.slice(0, 6).map((entry) => <ProfileRow entry={entry} csrf={csrf} entries={profile} briefs={briefs} />)}</ul>
          {profile.length > 6 ? <details class="profile-more">
            <summary class="btn btn--ghost btn--small"><span class="profile-more__closed">展开全部 {profile.length} 条</span><span class="profile-more__open">收起画像</span><HomeIcon name="chevron" /></summary>
            <ul class="profile-list">{profile.slice(6).map((entry) => <ProfileRow entry={entry} csrf={csrf} entries={profile} briefs={briefs} />)}</ul>
          </details> : null}
          <details class="profile-clear"><summary>管理全部画像</summary><PostButton action="/account/profile/delete" csrf={csrf} label="全部删除" variant="danger" fields={{ all: '1' }} confirm="删除全部长期画像？无法恢复。" /></details>
        </>
      )}
    </section>
    <section class="card profile-card profile-briefs" aria-labelledby="briefs-heading">
      <h2 id="briefs-heading">各面墙的采访资料（{briefs.length} 份）</h2>
      {briefs.length === 0 ? <div class="profile-empty"><p>还没有保存的采访资料</p><span>在墙里完成采访后，你的创作资料会出现在这里。</span></div> : (
        <ul class="profile-brief-list">{briefs.map((item) => (
          <li>
            <div><h3>{item.wallName}</h3><p class="muted">{BRIEF_STATUS_LABEL[item.status]} · {formatDateTime(item.updatedAt)}{item.wallClosed ? ' · 墙已关闭' : item.membershipStatus !== 'active' ? ' · 你已不在这面墙' : ''}</p></div>
            <div class="profile-brief-actions">
              {!item.wallClosed && item.membershipStatus === 'active' ? <a class="btn btn--ghost btn--small" href={`/w/${item.wallId}/me/brief`}>查看</a> : null}
              <PostButton action="/account/briefs/delete" csrf={csrf} label="删除" fields={{ briefId: item.id }} confirm="删除这份资料和上传的图片？无法恢复。" />
            </div>
          </li>
        ))}</ul>
      )}
    </section>
    <BlockedList csrf={csrf} blocked={blocked} />
    <section class="card profile-card" id="notifications" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">提醒邮件</h2>
      <form method="post" action="/account/notifications" class="stack">
        <CsrfField token={csrf} />
        <input type="hidden" name="jobEmail" value="0" />
        <label class="check">
          <input type="checkbox" name="jobEmail" value="1" checked={notifyEmail} />
          <span>页面做好（或没做成）时，如果我已经离开页面，发邮件告诉我</span>
        </label>
        <input type="hidden" name="reminders" value="0" />
        <label class="check">
          <input type="checkbox" name="reminders" value="1" checked={remindersOn} />
          <span>接收组织者的提醒邮件（提醒还没发布页面、没答完必答题的人；同一面墙 48 小时内最多一封）</span>
        </label>
        <div><button type="submit" class="btn btn--ghost btn--small">保存</button></div>
      </form>
    </section>
    {accountLinks ? (
      <section class="card profile-card" aria-labelledby="account-heading">
        <h2 id="account-heading">账号</h2>
        <p class="muted">把你在 NOWMe 的页面文件和资料下载成一个 zip；或者彻底注销账号。</p>
        <div class="profile-brief-actions">
          <a class="btn btn--ghost btn--small" href="/account/export">导出我的数据</a>
          <a class="btn btn--ghost btn--small" href="/account/delete">注销账号</a>
        </div>
      </section>
    ) : null}
  </div>
);
