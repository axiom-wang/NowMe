/**
 * 必答题（contracts 19.1）：组织者给墙设 0–3 道单选 / 多选题，所有成员都要回答；墙上可以按回答筛选。
 *
 * - 组织者建墙时或在后台编辑（`parseQuestionForm` + `saveQuestions`）；改了题目文字或题型，这道题的回答作废；
 *   只改选项时保留回答，读取时只认仍然存在的选项（`effectiveChoices`）。
 * - 成员在 `/w/:wallId/questions` 回答（`parseAnswerForm` + `saveAnswers`）。没答完的成员打开墙、成员页或工作区时
 *   先被带到回答页（`questionsGate`，路由里调用）。
 * - 可见范围：组织者后台能看到每个有效成员的回答（这就是“接龙 / 问卷”的替代）；墙上只展示**已上墙**成员的回答，
 *   人数统计也只算墙上的卡片。回答页上写明这一点。
 */
import { codePointLength, generateId, isId } from '@nowme/contracts';
import { createHash } from 'node:crypto';
import { WALL_QUESTION_LIMITS } from '../constants.js';
import type { AppDeps, FormFields } from '../context.js';
import { transaction } from '../db/index.js';
import type { QuestionKind, StoredAnswer, WallQuestion } from '../db/organizer-tools.js';

const L = WALL_QUESTION_LIMITS;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

type QuestionDeps = Pick<AppDeps, 'db' | 'repos' | 'now'>;

// ---------------------------------------------------------------------------
// 组织者：题目编辑表单
// ---------------------------------------------------------------------------

/** 一道题的表单值（回显用）。 */
export interface QuestionFormValue {
  id: string;
  prompt: string;
  kind: QuestionKind;
  /** 每行一个选项。 */
  options: string;
}

export interface QuestionDraft {
  /** 已有题目的 ID（编辑时）；新题为 null。 */
  id: string | null;
  /** 在表单里是第几块（0 起，回显错误用）。 */
  index: number;
  prompt: string;
  kind: QuestionKind;
  options: string[];
}

export type ParsedQuestionForm =
  | { ok: true; drafts: QuestionDraft[]; values: QuestionFormValue[] }
  | { ok: false; values: QuestionFormValue[]; errors: Record<number, string> };

/** 选项可以每行一个，也可以用逗号、顿号隔开。 */
export function splitOptions(text: string): string[] {
  return text
    .split(/[\n\r,，、;；]+/)
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function optionKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 空白的题目块被忽略；题目、选项、题型都按上限校验。字段：`q<i>_id`、`q<i>_prompt`、`q<i>_kind`、`q<i>_options`（i = 0..2）。 */
export function parseQuestionForm(form: FormFields): ParsedQuestionForm {
  const values: QuestionFormValue[] = [];
  const errors: Record<number, string> = {};
  const drafts: QuestionDraft[] = [];
  for (let i = 0; i < L.maxQuestions; i += 1) {
    const value: QuestionFormValue = {
      id: (form[`q${i}_id`] ?? '').trim(),
      prompt: (form[`q${i}_prompt`] ?? '').trim(),
      kind: form[`q${i}_kind`] === 'multi' ? 'multi' : 'single',
      options: (form[`q${i}_options`] ?? '').replace(/\r\n?/g, '\n').trim(),
    };
    values.push(value);
    if (!value.prompt && !value.options) continue;
    const promptLength = codePointLength(value.prompt);
    if (promptLength < L.prompt.min) {
      errors[i] = value.prompt ? `题目至少 ${L.prompt.min} 个字` : '请写上题目，或者清空这道题的选项';
      continue;
    }
    if (promptLength > L.prompt.max) {
      errors[i] = `题目最多 ${L.prompt.max} 个字，现在是 ${promptLength} 个`;
      continue;
    }
    if (CONTROL_CHARS.test(value.prompt)) {
      errors[i] = '题目只能是一行文字';
      continue;
    }
    const options: string[] = [];
    const seen = new Set<string>();
    let problem: string | null = null;
    for (const option of splitOptions(value.options)) {
      const length = codePointLength(option);
      if (length > L.option.max) {
        problem = `选项「${Array.from(option).slice(0, L.option.max).join('')}…」太长了：每个选项最多 ${L.option.max} 个字`;
        break;
      }
      if (CONTROL_CHARS.test(option)) {
        problem = '选项里有不支持的字符';
        break;
      }
      const key = optionKey(option);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(option);
    }
    if (!problem && options.length < L.options.min) problem = `至少写 ${L.options.min} 个选项，每行一个`;
    if (!problem && options.length > L.options.max) problem = `最多 ${L.options.max} 个选项，现在是 ${options.length} 个`;
    if (problem) {
      errors[i] = problem;
      continue;
    }
    drafts.push({ id: isId(value.id, 'wqn') ? value.id : null, index: i, prompt: value.prompt, kind: value.kind, options });
  }
  if (Object.keys(errors).length > 0) return { ok: false, values, errors };
  return { ok: true, drafts, values };
}

/** 已有题目 → 编辑表单的值（不足 3 道时补空白块）。 */
export function questionFormValues(questions: WallQuestion[]): QuestionFormValue[] {
  const values: QuestionFormValue[] = questions.map((question) => ({ id: question.id, prompt: question.prompt, kind: question.kind, options: question.options.join('\n') }));
  while (values.length < L.maxQuestions) values.push({ id: '', prompt: '', kind: 'single', options: '' });
  return values;
}

/** 需要做内容安全检查的文字（题目与选项）。 */
export function questionTexts(drafts: QuestionDraft[]): string[] {
  return drafts.map((draft) => [draft.prompt, ...draft.options].join('\n'));
}

export interface SaveQuestionsResult {
  added: number;
  changed: number;
  removed: number;
  /** 因为题目文字或题型改了而作废了回答的题数。 */
  reset: number;
}

/**
 * 用表单里的题目替换这面墙的题目（一个事务）。表单里带着本墙题目 ID 的视为编辑，其余视为新题；
 * 不在表单里的旧题删除（回答级联删除）。题目文字或题型变了 → 这道题的回答全部作废。
 */
export function saveQuestions(deps: QuestionDeps, wallId: string, drafts: QuestionDraft[]): SaveQuestionsResult {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const existing = new Map(deps.repos.questions.listForWall(wallId).map((question) => [question.id, question]));
    const result: SaveQuestionsResult = { added: 0, changed: 0, removed: 0, reset: 0 };
    const kept = new Set<string>();
    drafts.slice(0, L.maxQuestions).forEach((draft, position) => {
      const before = draft.id ? existing.get(draft.id) : undefined;
      if (before && !kept.has(before.id)) {
        kept.add(before.id);
        const same = before.prompt === draft.prompt && before.kind === draft.kind && before.position === position && before.options.join('\n') === draft.options.join('\n');
        if (same) return;
        if (before.prompt !== draft.prompt || before.kind !== draft.kind) {
          deps.repos.questions.deleteAnswersForQuestion(before.id);
          result.reset += 1;
        }
        deps.repos.questions.update({ ...before, position, prompt: draft.prompt, kind: draft.kind, options: draft.options, updatedAt: nowIso });
        result.changed += 1;
        return;
      }
      deps.repos.questions.insert({ id: generateId('wqn'), wallId, position, prompt: draft.prompt, kind: draft.kind, options: draft.options, createdAt: nowIso, updatedAt: nowIso });
      result.added += 1;
    });
    for (const question of existing.values()) {
      if (kept.has(question.id)) continue;
      deps.repos.questions.remove(wallId, question.id);
      result.removed += 1;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// 回答
// ---------------------------------------------------------------------------

/** 存下的回答在当前题目下还算不算数：只留仍然存在的选项（按题目里的顺序）；单选必须正好一个。无效时为 null。 */
export function effectiveChoices(question: WallQuestion, choices: readonly string[]): string[] | null {
  const chosen = new Set(choices);
  const valid = question.options.filter((option) => chosen.has(option));
  if (valid.length === 0) return null;
  if (question.kind === 'single' && valid.length !== 1) return null;
  return valid;
}

/** 某人在这面墙的有效回答：题目 ID → 选中的选项。 */
export function answersOf(questions: WallQuestion[], stored: StoredAnswer[]): Map<string, string[]> {
  const byQuestion = new Map(stored.map((answer) => [answer.questionId, answer.choices]));
  const result = new Map<string, string[]>();
  for (const question of questions) {
    const choices = effectiveChoices(question, byQuestion.get(question.id) ?? []);
    if (choices) result.set(question.id, choices);
  }
  return result;
}

/** 这面墙所有人的有效回答：用户 ID → (题目 ID → 选项)。 */
export function answersForWall(deps: Pick<AppDeps, 'repos'>, wallId: string, questions: WallQuestion[]): Map<string, Map<string, string[]>> {
  const byUser = new Map<string, StoredAnswer[]>();
  for (const answer of deps.repos.questions.answersForWall(wallId)) {
    const list = byUser.get(answer.userId) ?? [];
    list.push(answer);
    byUser.set(answer.userId, list);
  }
  const result = new Map<string, Map<string, string[]>>();
  for (const [userId, stored] of byUser) result.set(userId, answersOf(questions, stored));
  return result;
}

/** 这个人还有几道题没答（没有题目时为 0）。 */
export function missingCount(deps: Pick<AppDeps, 'repos'>, wallId: string, userId: string): number {
  const questions = deps.repos.questions.listForWall(wallId);
  if (questions.length === 0) return 0;
  const answers = answersOf(questions, deps.repos.questions.answersForUser(wallId, userId));
  return questions.filter((question) => !answers.has(question.id)).length;
}

/** 题目的版本号：回答表单带着它，提交时题目已经变了就让成员再看一眼。 */
export function questionsVersion(questions: WallQuestion[]): string {
  return createHash('sha256')
    .update(JSON.stringify(questions.map((question) => [question.id, question.updatedAt])))
    .digest('base64url')
    .slice(0, 16);
}

export type ParsedAnswers = { ok: true; answers: Map<string, string[]> } | { ok: false; stale: boolean; errors: Record<string, string>; draft: Map<string, string[]> };

/** 回答表单：单选 `a<位置>=<选项序号>`；多选 `a<位置>_<选项序号>=1`；`qv` 是题目版本号。 */
export function parseAnswerForm(questions: WallQuestion[], form: FormFields): ParsedAnswers {
  const draft = new Map<string, string[]>();
  const errors: Record<string, string> = {};
  questions.forEach((question, position) => {
    let chosen: string[] = [];
    if (question.kind === 'single') {
      const raw = form[`a${position}`] ?? '';
      const option = /^\d{1,2}$/.test(raw) ? question.options[Number(raw)] : undefined;
      if (option !== undefined) chosen = [option];
    } else {
      chosen = question.options.filter((_, index) => form[`a${position}_${index}`] === '1');
    }
    draft.set(question.id, chosen);
    if (chosen.length === 0) errors[question.id] = question.kind === 'single' ? '请选一项' : '至少选一项';
  });
  const stale = form.qv !== questionsVersion(questions);
  if (stale || Object.keys(errors).length > 0) return { ok: false, stale, errors, draft };
  return { ok: true, answers: draft };
}

export function saveAnswers(deps: QuestionDeps, wallId: string, userId: string, answers: Map<string, string[]>): void {
  const nowIso = deps.now().toISOString();
  transaction(deps.db, () => {
    for (const [questionId, choices] of answers) deps.repos.questions.saveAnswer(wallId, questionId, userId, choices, nowIso);
    deps.repos.events.record({ type: 'wall_answer', wallId, pageId: null, actorId: userId, props: { questions: answers.size }, createdAt: nowIso });
  });
}

// ---------------------------------------------------------------------------
// 统计与筛选
// ---------------------------------------------------------------------------

export interface OptionCount {
  /** 在题目选项里的位置（筛选用的编号）。 */
  index: number;
  label: string;
  count: number;
}

export interface QuestionStats {
  questionId: string;
  position: number;
  prompt: string;
  kind: QuestionKind;
  options: OptionCount[];
  /** 统计范围里答了这道题的人数。 */
  answered: number;
}

/** 按题目统计：`users` 是统计范围（墙上只算已上墙的人，后台算全部有效成员）。 */
export function questionStats(questions: WallQuestion[], answers: Map<string, Map<string, string[]>>, users: Iterable<string>): QuestionStats[] {
  const scope = [...users];
  return questions.map((question, position) => {
    const counts = new Map<string, number>(question.options.map((option) => [option, 0]));
    let answered = 0;
    for (const userId of scope) {
      const chosen = answers.get(userId)?.get(question.id);
      if (!chosen) continue;
      answered += 1;
      for (const option of chosen) counts.set(option, (counts.get(option) ?? 0) + 1);
    }
    return {
      questionId: question.id,
      position,
      prompt: question.prompt,
      kind: question.kind,
      options: question.options.map((label, index) => ({ index, label, count: counts.get(label) ?? 0 })),
      answered,
    };
  });
}

/** 一个人的回答在墙上的样子：每道题选中的选项（带编号，用于筛选）。 */
export interface CardAnswer {
  position: number;
  prompt: string;
  choices: { index: number; label: string }[];
}

export function cardAnswers(questions: WallQuestion[], answers: Map<string, string[]> | undefined): CardAnswer[] {
  if (!answers) return [];
  return questions.flatMap((question, position) => {
    const chosen = answers.get(question.id);
    if (!chosen) return [];
    return [{ position, prompt: question.prompt, choices: chosen.map((label) => ({ index: question.options.indexOf(label), label })).filter((item) => item.index >= 0) }];
  });
}

/** 建墙页“用例子填”的模板（按场景）。 */
export const QUESTION_TEMPLATES: { label: string; prompt: string; kind: QuestionKind; options: string[] }[] = [
  { label: '比赛：技能', prompt: '你最擅长哪几样？', kind: 'multi', options: ['产品', '设计', '前端', '后端', '算法 / AI', '硬件', '运营 / 市场'] },
  { label: '比赛：组队', prompt: '现在的组队情况', kind: 'single', options: ['已有队伍，还缺人', '想加入一个队', '一个人参赛'] },
  { label: '社团：部门', prompt: '想去哪个部门？', kind: 'single', options: ['宣传部', '技术部', '外联部', '活动部', '还没想好'] },
  { label: '兴趣：程度', prompt: '你玩到什么程度了？', kind: 'single', options: ['刚入门', '玩了一阵', '老玩家'] },
  { label: '通用：来做什么', prompt: '你来这里最想做什么？', kind: 'multi', options: ['认识新朋友', '找人合作', '学点东西', '先随便看看'] },
];
