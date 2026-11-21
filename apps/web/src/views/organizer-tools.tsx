/**
 * 组织者工具的界面（contracts 19）：必答题的编辑与回答、墙上的筛选与回答标签、墙的群像、
 * 组织者后台的“完成度与提醒”。
 *
 * 所有用户写的文字（题目、选项、昵称、群像）都经 JSX 转义按文字输出。
 */
import type { FC } from 'hono/jsx';
import { WALL_QUESTION_LIMITS } from '../constants.js';
import type { QuestionKind, WallQuestion } from '../db/organizer-tools.js';
import type { Wall } from '../db/walls.js';
import { formatDateTime } from '../format.js';
import { PORTRAIT_LIMITS } from '../constants.js';
import type { PortraitState } from '../services/portrait.js';
import type { WallProgress } from '../services/reminders.js';
import { QUESTION_TEMPLATES, TEXT_ANSWER_INDEX, type CardAnswer, type QuestionFormValue, type QuestionStats } from '../services/wall-questions.js';
import { CsrfField, Notice } from './forms.js';

const L = WALL_QUESTION_LIMITS;

/** 后台每道填空题直接列出的回答条数。 */
const ADMIN_TEXT_ANSWERS_SHOWN = 30;

// ---------------------------------------------------------------------------
// 必答题编辑（建墙页与后台共用）
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<QuestionKind, string> = { single: '单选', multi: '多选', text: '填空' };

/** 题型的说明（编辑器里题型按钮下的一行小字）。 */
const KIND_HINT: Record<QuestionKind, string> = {
  single: '只能选一个',
  multi: '可以选几个',
  text: '写一句话',
};

/**
 * 一道题的编辑块。没有脚本时：题目、题型、选项文本框（每行一个）都能直接用，按题型显示 / 隐藏选项用 CSS `:has()`。
 * 有脚本时（static/app.js）：选项文本框换成一行一个的选项列表（回车加下一个、可删除、粘贴多行自动拆开），
 * 列表的内容同步回文本框，提交的字段不变。
 */
const QuestionItem: FC<{ value: QuestionFormValue; index: number; error?: string }> = ({ value, index, error }) => {
  const errorId = error ? `q${index}-error` : undefined;
  return (
    <div class={`question-editor__item${error ? ' field--invalid' : ''}`} data-question-item>
      <input type="hidden" name={`q${index}_id`} value={value.id} />
      <div class="question-editor__head">
        <span class="question-editor__num" aria-hidden="true">
          {index + 1}
        </span>
        <label class="question-editor__prompt">
          <span class="visually-hidden">第 {index + 1} 题的题目</span>
          <input
            type="text"
            name={`q${index}_prompt`}
            value={value.prompt}
            maxlength={L.prompt.max}
            placeholder={index === 0 ? '题目，例如：你最擅长哪几样？' : '题目（留空就不加这道题）'}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={errorId}
          />
        </label>
        <button type="button" class="question-editor__remove" hidden data-question-remove aria-label={`删除第 ${index + 1} 题`} title="删除这道题">
          ×
        </button>
      </div>
      <div class="question-editor__kinds" role="radiogroup" aria-label={`第 ${index + 1} 题的题型`}>
        {(['single', 'multi', 'text'] as const).map((kind) => (
          <label class={`kind-option kind-option--${kind}`}>
            <input type="radio" name={`q${index}_kind`} value={kind} checked={value.kind === kind} />
            <span class="kind-option__icon" aria-hidden="true"></span>
            <span class="kind-option__text">
              <span class="kind-option__label">{KIND_LABEL[kind]}</span>
              <span class="kind-option__hint">{KIND_HINT[kind]}</span>
            </span>
          </label>
        ))}
      </div>
      <div class="question-editor__choices" data-question-choices>
        <label class="field">
          <span class="field__label">
            选项 <span class="muted">（{L.options.min}–{L.options.max} 个，每个最多 {L.option.max} 字；每行一个）</span>
          </span>
          <textarea name={`q${index}_options`} rows={4} placeholder={index === 0 ? '设计\n前端\n后端' : ''} aria-invalid={error ? 'true' : undefined} aria-describedby={errorId} data-question-options>
            {value.options}
          </textarea>
        </label>
      </div>
      <p class="question-editor__text-preview" data-question-text>
        <span class="question-editor__fake-input" aria-hidden="true">
          成员在这里写一句话……
        </span>
        <span class="muted">每人写一句（最多 {L.answer.max} 字），显示在 TA 的卡片上、能被搜到，不参与筛选。不能写联系方式和链接。</span>
      </p>
      {error ? (
        <span class="field__error" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
};

export const QuestionEditor: FC<{ values: QuestionFormValue[]; errors?: Record<number, string>; intro?: boolean }> = ({ values, errors = {}, intro = true }) => (
  <fieldset class="field question-editor" data-question-editor>
    <legend class="field__label">
      必答题 <span class="muted">（可选，最多 {L.maxQuestions} 道）</span>
    </legend>
    {intro ? (
      <p class="field__hint muted">
        每个加入的人都要先答完才能进墙，墙上可以按选择题的回答筛选人；你在后台能看到每个人的回答，不用再发接龙和问卷。比如比赛问“技能”和“是否有队”，社团问“想去哪个部门”，也可以用填空题请大家写一句“想做的项目”。
      </p>
    ) : null}
    <div class="question-editor__templates" hidden data-question-templates>
      <span class="muted">用例子填：</span>
      {QUESTION_TEMPLATES.map((template) => (
        <button type="button" class="btn btn--ghost btn--small" data-question-template={JSON.stringify({ prompt: template.prompt, kind: template.kind, options: template.options.join('\n') })}>
          {template.label}
        </button>
      ))}
    </div>
    {values.map((value, index) => (
      <QuestionItem value={value} index={index} error={errors[index]} />
    ))}
    <button type="button" class="question-editor__add" hidden data-question-add>
      + 再加一道题
    </button>
  </fieldset>
);

// ---------------------------------------------------------------------------
// 成员回答（GET /w/:wallId/questions）
// ---------------------------------------------------------------------------

export interface AnswerViewProps {
  wall: Wall;
  questions: WallQuestion[];
  version: string;
  csrf: string;
  next: string;
  /** 已选的选项（回显）。 */
  selected: Map<string, string[]>;
  errors?: Record<string, string>;
  stale?: boolean;
  /** 已经答过（修改回答）。 */
  editing: boolean;
}

export const AnswerView: FC<AnswerViewProps> = ({ wall, questions, version, csrf, next, selected, errors = {}, stale, editing }) => (
  <div class="container container--form">
    <section class="card card--form answer-card">
      <p class="eyebrow">{wall.name}</p>
      <h1 class="display form-title">{editing ? '修改我的回答' : `先答 ${questions.length} 道题`}</h1>
      <p class="muted">组织者请大家都答一下，方便在墙上按回答找人。组织者能看到你的回答；你的页面挂上墙后，墙上的人也能看到并按回答筛选。随时可以回来修改。</p>
      {stale ? <Notice tone="warning">组织者刚刚改了题目，请再看一眼再提交。</Notice> : null}
      {Object.keys(errors).length > 0 && !stale ? <Notice tone="error">还有题没答，见下面的提示。</Notice> : null}
      <form method="post" action={`/w/${wall.id}/questions`} class="stack">
        <CsrfField token={csrf} />
        <input type="hidden" name="qv" value={version} />
        <input type="hidden" name="next" value={next} />
        {questions.map((question, position) => {
          const chosen = new Set(selected.get(question.id) ?? []);
          const error = errors[question.id];
          return (
            <fieldset class={`field answer-question${error ? ' field--invalid' : ''}`} aria-describedby={error ? `a${position}-error` : undefined}>
              <legend class="field__label">
                {position + 1}. {question.prompt} <span class="muted">（{question.kind === 'multi' ? '可多选' : question.kind === 'text' ? '填空' : '单选'}）</span>
              </legend>
              {question.kind === 'text' ? (
                <div class="answer-text">
                  <input
                    type="text"
                    name={`a${position}`}
                    value={selected.get(question.id)?.[0] ?? ''}
                    maxlength={L.answer.max}
                    required
                    autocomplete="off"
                    placeholder="写一句话"
                    aria-label={question.prompt}
                    aria-invalid={error ? 'true' : undefined}
                    aria-describedby={error ? `a${position}-error` : `a${position}-hint`}
                  />
                  <span class="field__hint muted" id={`a${position}-hint`}>
                    最多 {L.answer.max} 字，会显示在你的卡片上；不写联系方式和链接。
                  </span>
                </div>
              ) : (
              <div class="answer-options">
                {question.options.map((option, index) => (
                  <label class="answer-option">
                    {question.kind === 'multi' ? (
                      <input type="checkbox" name={`a${position}_${index}`} value="1" checked={chosen.has(option)} />
                    ) : (
                      <input type="radio" name={`a${position}`} value={String(index)} checked={chosen.has(option)} required />
                    )}
                    <span>{option}</span>
                  </label>
                ))}
              </div>
              )}
              {error ? (
                <span class="field__error" id={`a${position}-error`}>
                  {error}
                </span>
              ) : null}
            </fieldset>
          );
        })}
        <button type="submit" class="btn btn--primary btn--block btn--lg">
          {editing ? '保存回答' : '答好了，进墙'}
        </button>
      </form>
    </section>
  </div>
);

// ---------------------------------------------------------------------------
// 墙上：卡片的回答标签与筛选
// ---------------------------------------------------------------------------

/** 卡片的筛选编号：`<题目位置>:<选项编号>`，空格分隔（填空题不参与筛选）。 */
export function answerKeys(answers: CardAnswer[]): string {
  return answers
    .flatMap((answer) => answer.choices.filter((choice) => choice.index !== TEXT_ANSWER_INDEX).map((choice) => `${answer.position}:${choice.index}`))
    .join(' ');
}

export const CardAnswerTags: FC<{ answers: CardAnswer[] }> = ({ answers }) =>
  answers.length > 0 ? (
    <span class="wall-card__answers">
      {answers.flatMap((answer) =>
        answer.choices.map((choice) =>
          answer.kind === 'text' ? (
            <span class="answer-tag answer-tag--text" title={`${answer.prompt}：${choice.label}`}>
              {choice.label}
            </span>
          ) : (
            <span class="answer-tag" title={answer.prompt}>
              {choice.label}
            </span>
          ),
        ),
      )}
    </span>
  ) : null;

/** 墙上有人选了的选择题（填空题没有可筛选的选项）。 */
function filterable(questions: QuestionStats[]): QuestionStats[] {
  return questions.filter((question) => question.kind !== 'text' && question.options.some((option) => option.count > 0));
}

/** 筛选条：每道选择题一行，点选项筛选（同一题内“或”，不同题之间“且”）。需要脚本，没有脚本时只是一张统计。 */
export const WallFilters: FC<{ questions: QuestionStats[] }> = ({ questions }) =>
  filterable(questions).length > 0 ? (
    <div class="wall-filters" data-wall-filters>
      {filterable(questions).map((question) => (
        <div class="wall-filters__row" role="group" aria-label={question.prompt}>
          <span class="wall-filters__prompt">{question.prompt}</span>
          {question.options
            .filter((option) => option.count > 0)
            .map((option) => (
              <button type="button" class="filter-chip" aria-pressed="false" data-filter={`${question.position}:${option.index}`}>
                {option.label} <span class="filter-chip__count">{option.count}</span>
              </button>
            ))}
        </div>
      ))}
      <button type="button" class="btn btn--ghost btn--small wall-filters__clear" hidden data-filter-clear>
        清除筛选
      </button>
    </div>
  ) : null;

// ---------------------------------------------------------------------------
// 墙的群像
// ---------------------------------------------------------------------------

export const PortraitPanel: FC<{ wall: Wall; state: PortraitState; shareText: string | null; organizer: boolean; csrf: string; error?: string | null }> = ({ wall, state, shareText, organizer, csrf, error }) => {
  if (state.kind !== 'ready' && !organizer) return null;
  return (
    <section class="card portrait" id="portrait" data-busy-scope aria-labelledby="portrait-heading">
      <div class="portrait__head">
        <h2 id="portrait-heading">墙的群像</h2>
        {state.kind === 'ready' ? (
          <span class="muted portrait__meta">
            AI 根据 {state.view.pageCount} 位成员上墙的卡片归纳 · {formatDateTime(state.view.createdAt)}
          </span>
        ) : null}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {state.kind === 'ready' ? (
        <>
          {state.view.summary ? <p class="portrait__summary">{state.view.summary}</p> : null}
          <div class="portrait__grid">
          {state.view.themes.length > 0 ? (
            <div class="portrait__block">
              <h3 class="portrait__label">大家最想聊</h3>
              <ul class="portrait__themes">
                {state.view.themes.map((theme) => (
                  <li class="portrait-theme">
                    <span class="portrait-theme__title">{theme.title}</span>
                    <span class="portrait-theme__count">{theme.count} 人</span>
                    {theme.detail ? <span class="portrait-theme__detail">{theme.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.view.stats
            .filter((stat) => stat.answered > 0 && stat.kind !== 'text' && stat.options.length > 0)
            .map((stat) => (
              <div class="portrait__block">
                <h3 class="portrait__label">{stat.prompt}</h3>
                <ul class="portrait__bars">
                  {stat.options
                    .filter((option) => option.count > 0)
                    .sort((a, b) => b.count - a.count)
                    .map((option) => (
                      <li class="portrait-bar">
                        <span class="portrait-bar__label">{option.label}</span>
                        <meter class="portrait-bar__meter" min="0" max={String(Math.max(1, stat.answered))} value={String(option.count)} aria-hidden="true"></meter>
                        <span class="portrait-bar__count">{option.count} 人</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
          <p class="muted portrait__note">话题人数是 AI 归类的结果，可能有出入；题目的人数按大家的回答统计。{state.view.updated > 0 ? `生成后有 ${state.view.updated} 位成员更新了页面。` : ''}</p>
          {shareText ? (
            <details class="portrait__share">
              <summary>发到群里</summary>
              <pre class="portrait__share-text" id="nm-portrait-text">
                {shareText}
              </pre>
              <button type="button" class="btn btn--primary btn--small" data-copy="nm-portrait-text">
                复制群像文字
              </button>
            </details>
          ) : null}
        </>
      ) : organizer ? (
        <p class="muted">
          {state.kind === 'hidden'
            ? '有成员撤下了页面或离开了这面墙，原来的群像已停止展示。重新生成一份吧。'
            : `让 AI 读一遍墙上所有人的卡片，归纳“这群人里多少人会什么、大家最想聊什么”，全墙成员都能看到，可以直接复制发到群里。至少 ${PORTRAIT_LIMITS.minPages} 人上墙后可以生成。`}
        </p>
      ) : null}
      {organizer ? (
        <form method="post" action={`/w/${wall.id}/admin/portrait`} class="portrait__action" data-busy-label="AI 正在读墙上的卡片……">
          <CsrfField token={csrf} />
          <button type="submit" class="btn btn--ghost btn--small">
            {state.kind === 'ready' ? '重新生成群像' : '生成群像'}
          </button>
          <p data-busy-status role="status" hidden></p>
        </form>
      ) : null}
    </section>
  );
};

// ---------------------------------------------------------------------------
// 组织者后台：完成度与提醒
// ---------------------------------------------------------------------------

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export const ProgressPanel: FC<{ wall: Wall; progress: WallProgress; groupText: string; csrf: string; remindedCount: number | null }> = ({ wall, progress, groupText, csrf, remindedCount }) => {
  const remind = progress.remind;
  const pendingPublish = progress.unpublished.filter((member) => member.role !== 'organizer');
  const pendingAnswer = progress.unanswered.filter((member) => member.role !== 'organizer');
  return (
    <section class="card wall-progress" id="progress" aria-labelledby="progress-heading">
      <h2 id="progress-heading">完成度与提醒</h2>
      {remindedCount !== null ? (
        <Notice tone="success">{remindedCount > 0 ? `已经给 ${remindedCount} 位成员发了提醒邮件。` : '现在没有可以提醒的人。'}</Notice>
      ) : null}
      <div class="wall-progress__meters">
        <div class="progress-meter">
          <span class="progress-meter__label">已发布</span>
          <span class="progress-meter__value">
            {progress.published} / {progress.total}
          </span>
          <meter class="progress-meter__bar" min="0" max={String(Math.max(1, progress.total))} value={String(progress.published)} aria-label={`已发布 ${percent(progress.published, progress.total)}%`}></meter>
        </div>
        {progress.answered !== null ? (
          <div class="progress-meter">
            <span class="progress-meter__label">答完必答题</span>
            <span class="progress-meter__value">
              {progress.answered} / {progress.total}
            </span>
            <meter class="progress-meter__bar" min="0" max={String(Math.max(1, progress.total))} value={String(progress.answered)} aria-label={`答完必答题 ${percent(progress.answered, progress.total)}%`}></meter>
          </div>
        ) : null}
      </div>
      {pendingPublish.length > 0 ? (
        <div class="wall-progress__list">
          <h3>还没发布（{pendingPublish.length}）</h3>
          <p class="name-chips">{pendingPublish.map((member) => <span class="name-chip">{member.nickname || '成员'}</span>)}</p>
        </div>
      ) : null}
      {pendingAnswer.length > 0 ? (
        <div class="wall-progress__list">
          <h3>还没答完必答题（{pendingAnswer.length}）</h3>
          <p class="name-chips">{pendingAnswer.map((member) => <span class="name-chip">{member.nickname || '成员'}</span>)}</p>
        </div>
      ) : null}
      {progress.withdrawn > 0 ? <p class="muted">另有 {progress.withdrawn} 人撤下了页面，不会提醒他们。</p> : null}
      {pendingPublish.length === 0 && pendingAnswer.length === 0 ? <p class="muted">大家都已经发布了{progress.questionCount > 0 ? '，也答完了必答题' : ''}。</p> : null}

      <form method="post" action={`/w/${wall.id}/admin/remind`} class="wall-progress__remind" data-confirm={remind.targets.length > 0 ? `给 ${remind.targets.length} 位成员发提醒邮件？` : undefined}>
        <CsrfField token={csrf} />
        <button type="submit" class="btn btn--primary" disabled={remind.targets.length === 0}>
          {remind.targets.length > 0 ? `一键提醒 ${remind.targets.length} 人` : '没有可以提醒的人'}
        </button>
        <p class="field-help">
          用固定的邮件模板提醒还没发布或没答完题的人，你看不到大家的邮箱。同一个人 48 小时内最多提醒一次，同一面墙最多三次。
          {remind.limited > 0 ? ` ${remind.limited} 人最近已经提醒过。` : ''}
          {remind.declined > 0 ? ` ${remind.declined} 人不接收提醒邮件。` : ''}
          {progress.lastBatch ? ` 上次提醒：${formatDateTime(progress.lastBatch.at)}，${progress.lastBatch.count} 人。` : ''}
        </p>
      </form>
      {pendingPublish.length > 0 || pendingAnswer.length > 0 ? (
        <details class="wall-progress__group">
          <summary>也可以发到群里</summary>
          <pre class="wall-progress__group-text" id="nm-remind-text">
            {groupText}
          </pre>
          <button type="button" class="btn btn--ghost btn--small" data-copy="nm-remind-text">
            复制群提醒文字
          </button>
        </details>
      ) : null}
    </section>
  );
};

/** 后台的必答题区块：当前题目的回答统计 + 编辑表单。 */
export const AdminQuestions: FC<{
  wall: Wall;
  stats: QuestionStats[];
  /** 填空题：题目 ID → 有效成员写的回答（后台展示，最多 `ADMIN_TEXT_ANSWERS_SHOWN` 条）。 */
  textAnswers: Map<string, string[]>;
  total: number;
  values: QuestionFormValue[];
  errors?: Record<number, string>;
  csrf: string;
  notice?: string | null;
}> = ({
  wall,
  stats,
  textAnswers,
  total,
  values,
  errors,
  csrf,
  notice,
}) => (
  <section class="card admin-questions" id="questions" aria-labelledby="questions-heading">
    <h2 id="questions-heading">必答题</h2>
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    {stats.length > 0 ? (
      <>
        {stats.map((stat) => (
          <div class="admin-questions__stat">
            <h3>
              {stat.prompt} <span class="muted">（{KIND_LABEL[stat.kind]} · {stat.answered} / {total} 人答了）</span>
            </h3>
            {stat.kind === 'text' ? (
              (textAnswers.get(stat.questionId) ?? []).length > 0 ? (
                <ul class="admin-questions__texts">
                  {(textAnswers.get(stat.questionId) ?? []).slice(0, ADMIN_TEXT_ANSWERS_SHOWN).map((text) => (
                    <li>{text}</li>
                  ))}
                  {(textAnswers.get(stat.questionId) ?? []).length > ADMIN_TEXT_ANSWERS_SHOWN ? <li class="muted">……其余见成员列表与 CSV</li> : null}
                </ul>
              ) : null
            ) : (
              <p class="name-chips">
                {stat.options.map((option) => (
                  <span class="name-chip">
                    {option.label} <strong>{option.count}</strong>
                  </span>
                ))}
              </p>
            )}
          </div>
        ))}
        <p class="muted">
          每个人的回答在下面的成员列表里；也可以 <a href={`/w/${wall.id}/admin/members.csv`}>下载成员名单（CSV）</a>。
        </p>
      </>
    ) : (
      <p class="muted">还没有必答题。加上之后，已经在墙里的人下次打开墙时也会先被请去回答。</p>
    )}
    <details class="admin-questions__edit" open={!!errors && Object.keys(errors).length > 0}>
      <summary class="btn btn--ghost btn--small">{stats.length > 0 ? '修改题目' : '添加必答题'}</summary>
      <form method="post" action={`/w/${wall.id}/admin/questions`} class="stack">
        <CsrfField token={csrf} />
        <QuestionEditor values={values} errors={errors} intro={false} />
        <p class="field-help">改了题目文字或题型（单选 / 多选 / 填空），这道题的回答会清空，大家需要重新回答；只增删选项时保留原来的回答（选了被删除选项的人需要重新选）。</p>
        <button type="submit" class="btn btn--primary">
          保存必答题
        </button>
      </form>
    </details>
  </section>
);
