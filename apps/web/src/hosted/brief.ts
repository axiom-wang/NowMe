/**
 * 应用内采访的数据结构（hosted-route 2、D5）：
 * - `InterviewAnswers`：第 1、2 步主人填写 / 点选的内容（存 `briefs.answers_json`）；
 * - `FollowupState`：调用 #1 的抽取结果与追问，以及主人对追问的回答（存 `briefs.followups_json`）；
 * - `StructuredBrief`：调用 #2 / #3 输出的结构化 brief（存 `briefs.brief_json`），
 *   `renderBriefMarkdown` 按 `skill/templates/brief.md` 的结构渲染成 `brief.md`（与本地路线相同）。
 *
 * 模型输出一律经这里的 zod schema 校验；过长的文字截断，不合法的整体拒绝（由调用方重试一次）。
 */
import { MOTION_LEVELS, NM_ID_PATTERN, type MotionLevel, type SceneGuide } from '@nowme/contracts';
import { z } from 'zod';
import type { Wall } from '../db/walls.js';

/** 按 Unicode 码点截断。 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** 去掉控制字符（保留换行与制表符）。 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '');
}

const text = (max: number) =>
  z
    .string()
    .transform((value) => clip(stripControl(value), max))
    .pipe(z.string().min(1));
const optionalText = (max: number) =>
  z
    .string()
    .optional()
    .default('')
    .transform((value) => clip(stripControl(value), max));
const textList = (maxItems: number, maxChars: number) =>
  z
    .array(z.string())
    .optional()
    .default([])
    .transform((items) =>
      items
        .map((item) => clip(stripControl(item), maxChars))
        .filter((item) => item.length > 0)
        .slice(0, maxItems),
    );

// ---------------------------------------------------------------------------
// 主人填写的内容
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  /** 选中的选项原文。 */
  selected: string[];
  /** “直接写”的内容。 */
  text: string;
}

export interface InterviewAnswers {
  material: string;
  intent?: string;
  updates?: string[];
  quick?: Record<string, string>;
  starters?: Record<string, string>;
  wallTopics?: string[];
  choices: Record<string, ChoiceAnswer>;
  /** 选中的示例目录名；空数组表示“你来定”。 */
  styles: string[];
  motion: MotionLevel;
}

export interface FollowupQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface FollowupAnswer {
  selected: string | null;
  text: string;
  skipped: boolean;
}

export interface ReviewEdits {
  aiView: { text: string; drop: boolean }[];
  hooks: { text: string; opener: string; drop: boolean }[];
  keepProfile: number[];
  displayName?: string;
  boundaries?: StructuredBrief['boundaries'];
}

export interface FollowupState {
  reviewEdits?: ReviewEdits;
  correction?: string;
  pending?: boolean;
  facts: string[];
  imageNotes: { file: string; description: string }[];
  missing: { id: string; reason: string }[];
  questions: FollowupQuestion[];
  answers: Record<string, FollowupAnswer>;
}

// ---------------------------------------------------------------------------
// 调用 #1：抽取与追问
// ---------------------------------------------------------------------------

export const followupOutputSchema = z.object({
  facts: textList(12, 120),
  imageNotes: z
    .array(z.object({ file: z.string(), description: z.string() }))
    .optional()
    .default([])
    .transform((items) =>
      items
        .map((item) => ({ file: clip(item.file, 64), description: clip(stripControl(item.description), 120) }))
        .filter((item) => item.description.length > 0)
        .slice(0, 6),
    ),
  missing: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .optional()
    .default([])
    .transform((items) => items.slice(0, 8).map((item) => ({ id: clip(item.id, 40), reason: clip(stripControl(item.reason), 120) }))),
  questions: z
    .array(z.object({ question: text(80), options: textList(4, 40) }))
    .optional()
    .default([])
    .transform((items) => items.filter((item) => item.options.length >= 2)),
});
export type FollowupOutput = z.output<typeof followupOutputSchema>;

export const FOLLOWUP_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    facts: { type: 'array', items: { type: 'string' }, description: '从素材和点选中抽取的事实候选（只写主人说了的，每条一句，最多 12 条）' },
    imageNotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, description: { type: 'string', description: '画面里有什么（客观描述，不猜身份）' } },
        required: ['file', 'description'],
      },
    },
    missing: {
      type: 'array',
      description: '场景指南 mustHave 里还缺的项',
      items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    },
    questions: {
      type: 'array',
      description: '追问，最多 maxFollowUps 个；每个给 2–4 个回答选项（不要写“跳过”，平台会自动加）',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
        required: ['question', 'options'],
      },
    },
  },
  required: ['facts', 'missing', 'questions'],
} as const;

// ---------------------------------------------------------------------------
// 调用 #2 / #3：结构化 brief
// ---------------------------------------------------------------------------

const hookSchema = z.object({
  kind: z
    .string()
    .optional()
    .default('')
    .transform((value) => (NM_ID_PATTERN.test(value) ? value : '')),
  text: z
    .string()
    .transform((value) => clip(stripControl(value), 32))
    .pipe(z.string().min(2)),
  opener: text(80),
});

export const briefOutputSchema = z.object({
  displayName: text(24),
  firstScreen: text(120),
  suggestedBlocks: z
    .array(z.string())
    .optional()
    .default([])
    .transform((items) => items.filter((item) => NM_ID_PATTERN.test(item)).slice(0, 8)),
  facts: z
    .array(z.object({ text: z.string(), source: z.string().optional() }))
    .optional()
    .default([])
    .transform((items) =>
      items
        .map((item) => ({
          text: clip(stripControl(item.text), 160),
          source: (item.source === 'owner-file' || item.source === 'profile' ? item.source : 'interview') as BriefFactSource,
        }))
        .filter((item) => item.text.length > 0)
        .slice(0, 16),
    ),
  images: z
    .array(z.object({ file: z.string(), description: z.string() }))
    .optional()
    .default([])
    .transform((items) => items.slice(0, 6).map((item) => ({ file: clip(item.file, 64), description: clip(stripControl(item.description), 120) }))),
  quotes: textList(6, 120),
  highlights: textList(2, 120),
  intentAspect: optionalText(120),
  intentRemember: optionalText(120),
  tone: optionalText(60),
  otherPreferences: optionalText(120),
  boundaries: z
    .object({
      name: optionalText(40),
      school: optionalText(20),
      gradeMajor: optionalText(20),
      photo: optionalText(20),
      hidden: textList(8, 80),
      rejected: textList(8, 80),
    })
    .optional()
    .default({ name: '', school: '', gradeMajor: '', photo: '', hidden: [], rejected: [] }),
  unknowns: textList(10, 120),
  hooks: z
    .array(hookSchema)
    .min(2)
    .transform((items) => items.slice(0, 3)),
  aiView: z
    .array(z.string())
    .transform((items) =>
      items
        .map((item) => clip(stripControl(item), 120))
        .filter((item) => item.length > 0)
        .slice(0, 5),
    )
    .pipe(z.array(z.string()).min(1)),
  mustHaveMissing: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .optional()
    .default([])
    .transform((items) => items.slice(0, 8).map((item) => ({ id: clip(item.id, 40), reason: clip(stripControl(item.reason), 120) }))),
  profileSuggestions: z
    .array(z.object({ category: z.string(), text: z.string() }))
    .optional()
    .default([])
    .transform((items) =>
      items
        .filter((item) => item.category === 'fact' || item.category === 'quote' || item.category === 'boundary' || item.category === 'preference')
        .map((item) => ({ category: item.category as 'fact' | 'quote' | 'preference' | 'boundary', text: clip(stripControl(item.text), 200) }))
        .filter((item) => item.text.length > 0)
        .slice(0, 8),
    ),
});
export const interviewDraftSchema = z.object({ brief: briefOutputSchema, followups: followupOutputSchema });
export type BriefOutput = z.output<typeof briefOutputSchema>;
export type BriefFactSource = 'interview' | 'owner-file' | 'profile';
export type BriefHook = { kind: string; text: string; opener: string };

export const BRIEF_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    displayName: { type: 'string', description: '页面上用的名字（按边界：真名或主人给的昵称），≤ 24 字' },
    firstScreen: { type: 'string', description: '首屏必须呈现什么（结合场景 pageGoal 与本页意图）' },
    suggestedBlocks: { type: 'array', items: { type: 'string' }, description: '建议区块 data-nm-id（小写字母开头）' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, source: { type: 'string', enum: ['interview', 'owner-file', 'profile'] } },
        required: ['text'],
      },
    },
    images: {
      type: 'array',
      items: { type: 'object', properties: { file: { type: 'string' }, description: { type: 'string' } }, required: ['file', 'description'] },
    },
    quotes: { type: 'array', items: { type: 'string' }, description: '主人原话，原样保留' },
    highlights: { type: 'array', items: { type: 'string' }, description: '最有意思的 1–2 个细节' },
    intentAspect: { type: 'string', description: '这面墙想突出哪一面' },
    intentRemember: { type: 'string', description: '希望别人看完记住什么' },
    tone: { type: 'string' },
    otherPreferences: { type: 'string' },
    boundaries: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '真名 / 昵称“……”' },
        school: { type: 'string', description: '显示 / 不显示' },
        gradeMajor: { type: 'string', description: '显示 / 不显示' },
        photo: { type: 'string', description: '可以 / 不可以' },
        hidden: { type: 'array', items: { type: 'string' } },
        rejected: { type: 'array', items: { type: 'string' } },
      },
    },
    unknowns: { type: 'array', items: { type: 'string' }, description: '采访中没有得到、生成时不得猜测的信息' },
    hooks: {
      type: 'array',
      description: '接话点候选 2–3 个',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '场景指南 hookKinds 中的 kind' },
          text: { type: 'string', description: '2–32 字' },
          opener: { type: 'string', description: '访客发给主人的第一句话，≤ 80 字' },
        },
        required: ['text', 'opener'],
      },
    },
    aiView: { type: 'array', items: { type: 'string' }, description: '“AI 眼中的你”：3–5 句通顺的话，尽量用主人自己的说法' },
    mustHaveMissing: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    },
    profileSuggestions: {
      type: 'array',
      description: '建议写回长期画像的条目（只写长期信息；本页意图不写）',
      items: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['fact', 'quote', 'preference', 'boundary'] }, text: { type: 'string' } },
        required: ['category', 'text'],
      },
    },
  },
  required: ['displayName', 'firstScreen', 'facts', 'hooks', 'aiView', 'unknowns'],
} as const;

export const INTERVIEW_DRAFT_TOOL_SCHEMA = { type: 'object', properties: { brief: BRIEF_TOOL_SCHEMA, followups: FOLLOWUP_TOOL_SCHEMA }, required: ['brief', 'followups'] };

/** 存进 `brief_json` 的结构化 brief：模型输出 + 平台从表单确定的字段（风格、动效不信任模型）。 */
export interface StructuredBrief extends BriefOutput {
  styles: string[];
  motion: MotionLevel;
  /** 主人在确认页划掉 / 改写后的版本由 `applyOwnerEdits` 写回 hooks 与 aiView。 */
  confirmedAt: string | null;
  /** 成功修改后的主人原始要求，保留事实与更正的上下文。 */
  ownerEdits?: string[];
  /** 主人已作出的记忆选择，重新整理不擅自重新勾选。 */
  profileSelection?: string[];
}

export function toStructuredBrief(output: BriefOutput, answers: InterviewAnswers): StructuredBrief {
  return { ...output, styles: answers.styles, motion: answers.motion, confirmedAt: null };
}

export function isMotionLevel(value: string): value is MotionLevel {
  return (MOTION_LEVELS as readonly string[]).includes(value);
}

const MOTION_LABEL: Record<MotionLevel, string> = { calm: '安静（calm）', medium: '适中（medium）', lively: '活泼（lively）' };
export const SOURCE_LABEL: Record<BriefFactSource, string> = { interview: '本次采访', 'owner-file': '主人提供的文件', profile: '长期画像' };

function line(value: string | undefined, fallback = '（未提供）'): string {
  return value && value.trim().length > 0 ? value : fallback;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '｜').replace(/\n/g, ' ');
}

/** 按 `skill/templates/brief.md` 的结构渲染 brief.md（标题与顺序与本地路线一致）。 */
export function renderBriefMarkdown(brief: StructuredBrief, wall: Pick<Wall, 'name' | 'description' | 'sceneType' | 'organizerNote'>, scene: SceneGuide): string {
  const out: string[] = [];
  out.push(`# brief：${wall.name}`, '');
  out.push('> 保存在 NOWMe 平台，只有你自己能看到；组织者和其他成员都看不到。你可以随时在“我的资料”里删除。');
  out.push('> 由 NOWMe 应用内采访整理；你确认“AI 眼中的你”之后才用于生成。');
  out.push(`> 场景：${wall.sceneType}　确认时间：${brief.confirmedAt ?? '（未确认）'}`, '');

  out.push('## 墙的情境', '');
  out.push(`- 名称：${wall.name}`);
  out.push(`- 简介：${line(wall.description, '无')}`);
  out.push(`- 场景类型：${scene.label}（${wall.sceneType}）`);
  out.push(`- 组织者的一句话：${line(wall.organizerNote ?? '', '无')}`, '');

  out.push('## 页面目标', '');
  out.push(`- 首屏必须呈现：${brief.firstScreen}`);
  const examples = brief.styles.length > 0 ? `${brief.styles.join('、')}（主人选的风格）` : `你来定；场景推荐 ${scene.examples.join('、')}`;
  out.push(`- 推荐的示例页：${examples}`);
  out.push(`- 建议区块（data-nm-id）：${(brief.suggestedBlocks.length > 0 ? brief.suggestedBlocks : scene.suggestedBlocks).join('、')}`, '');

  out.push('## 事实与素材', '');
  if (brief.facts.length === 0 && brief.images.length === 0) out.push('- （无）');
  for (const fact of brief.facts) out.push(`- ${fact.text}　〔来源：${SOURCE_LABEL[fact.source]}〕`);
  for (const image of brief.images) out.push(`- 图片：\`assets/${image.file}\` —— ${image.description}　〔来源：主人提供〕`);
  out.push('');

  if (brief.ownerEdits?.length) {
    out.push('主人后续补充与更正（原文；只把明确的自述作为事实，视觉要求不当作经历；更正优先于旧事实）：');
    for (const edit of brief.ownerEdits) out.push(`- ${edit}`);
    out.push('');
  }
  out.push('## 原话', '');
  if (brief.quotes.length === 0) out.push('- （无）');
  for (const quote of brief.quotes) out.push(`- “${quote}”`);
  out.push('');

  out.push('## 重点细节', '');
  if (brief.highlights.length === 0) out.push('1. （无）');
  brief.highlights.forEach((item, index) => out.push(`${index + 1}. ${item}`));
  out.push('');

  out.push('## 本页意图', '');
  out.push(`- 这面墙想突出哪一面：${line(brief.intentAspect)}`);
  out.push(`- 希望别人看完记住：${line(brief.intentRemember)}`, '');

  out.push('## 表达偏好', '');
  out.push(`- 风格参考：${brief.styles.length > 0 ? brief.styles.join('、') : '你来定'}`);
  out.push(`- 动效强度：${MOTION_LABEL[brief.motion]}`);
  out.push(`- 语气：${line(brief.tone, '（未指定）')}`);
  out.push(`- 其他：${line(brief.otherPreferences, '（无）')}`, '');

  out.push('## 表达边界', '');
  out.push(`- 名字：${line(brief.boundaries.name, brief.displayName)}`);
  out.push(`- 学校：${line(brief.boundaries.school, '不显示')}`);
  out.push(`- 年级与专业：${line(brief.boundaries.gradeMajor, '不显示')}`);
  out.push(`- 本人照片：${line(brief.boundaries.photo, '不可以')}`);
  out.push(`- 不展示的信息：${brief.boundaries.hidden.length > 0 ? brief.boundaries.hidden.join('；') : '（无）'}`);
  out.push(`- 不接受的表达：${brief.boundaries.rejected.length > 0 ? brief.boundaries.rejected.join('；') : '（无）'}`);
  out.push('- 联系方式：不写进页面（主人在应用内发布时设置，通过“想聊这个”展示）', '');

  out.push('## 未知与不要猜', '');
  if (brief.unknowns.length === 0) out.push('- （无）');
  for (const item of brief.unknowns) out.push(`- ${item}`);
  for (const item of brief.mustHaveMissing) out.push(`- 缺少：${item.reason}`);
  out.push('');

  out.push('## 接话点候选', '');
  out.push('| # | kind | 接话点 text（2–32 字） | 开场白 opener（访客口吻，≤ 80 字） |');
  out.push('| --- | --- | --- | --- |');
  brief.hooks.forEach((hook: BriefHook, index: number) =>
    out.push(`| ${index + 1} | ${escapeCell(hook.kind)} | ${escapeCell(hook.text)} | ${escapeCell(hook.opener)} |`),
  );
  out.push('');

  out.push('## AI 眼中的你', '');
  for (const sentence of brief.aiView) out.push(`> ${sentence}`);
  out.push('');
  return out.join('\n');
}

/** 场景指南里“默认勾选”的选项（contracts 8：暂时写在选项文字里）。 */
export function isDefaultChecked(option: string): boolean {
  return /（默认勾选[^）]*）/.test(option);
}

/** 去掉场景配置里的默认勾选标注，展示与提交使用同一份文字。 */
export function choiceLabel(option: string): string {
  return option.replace(/（默认勾选[^）]*）/g, '');
}

/** 选项是“直接写”类（选中后需要填文本）。 */
export function isWriteInOption(option: string): boolean {
  return /直接写/.test(option);
}
