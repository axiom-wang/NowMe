/**
 * 应用内采访：首次一次输出草稿与可选追问（submit_interview），补充或更正才重新整理（submit_brief）。
 * 都用采访模型，强制调用指定工具得到结构化输出，经 zod 校验；不合法时重试一次。
 * 主人的内容（素材、点选、追问回答、修正意见、画像）与组织者写的墙情境都用 `untrusted()` 包成资料块。
 */
import type { SceneGuide } from '@nowme/contracts';
import type { ZodType } from 'zod';
import type { BriefAsset, ProfileEntry } from '../db/hosted.js';
import type { Wall } from '../db/walls.js';
import {
  BRIEF_TOOL_SCHEMA,
  INTERVIEW_DRAFT_TOOL_SCHEMA, interviewDraftSchema,
  briefOutputSchema,
  type BriefOutput,
  type FollowupOutput,
  type FollowupState,
  type InterviewAnswers,
} from './brief.js';
import { addUsage, emptyUsage, untrusted, type ModelClient, type ImageBlock, type TextBlock, type UsageTotals } from './model-client.js';
import { modelFailureCode, type ModelAccessCode } from './model-errors.js';
import { interviewSystem } from './prompts.js';

export interface InterviewContext {
  wall: Pick<Wall, 'name' | 'description' | 'sceneType' | 'organizerNote'>;
  scene: SceneGuide;
  answers: InterviewAnswers;
  profile: ProfileEntry[];
  knownAnswers?: { question: string; answers: string[] }[];
  /** 上传的图片与内容（只在调用 #1 交给模型）。 */
  images: { asset: BriefAsset; bytes: Uint8Array }[];
}

export class InterviewError extends Error {
  override name = 'InterviewError';
  constructor(
    readonly code: 'API_ERROR' | 'BAD_OUTPUT',
    readonly usage: UsageTotals,
    readonly accessCode?: ModelAccessCode | null,
  ) {
    super(code);
  }
}

export interface InterviewCallResult<T> {
  output: T;
  usage: UsageTotals;
}

function wallBlock(context: Pick<InterviewContext, 'wall'>): string {
  const { wall } = context;
  return untrusted(
    'wall_context',
    JSON.stringify({ name: wall.name, description: wall.description, sceneType: wall.sceneType, organizerNote: wall.organizerNote }, null, 2),
  );
}

function sceneBlock(scene: SceneGuide): string {
  return untrusted('scene_guide', JSON.stringify(scene, null, 2));
}

function profileBlock(profile: ProfileEntry[]): string {
  if (profile.length === 0) return untrusted('owner_profile', '（主人还没有长期画像）');
  return untrusted('owner_profile', profile.map((entry) => `- [${entry.category}] ${entry.text}（${entry.confirmation}）`).join('\n'));
}

export function choicesText(context: Pick<InterviewContext, 'scene' | 'answers'>): string {
  const lines: string[] = [];
  for (const question of context.scene.choiceQuestions) {
    const answer = context.answers.choices[question.id];
    const picked = answer?.selected ?? [];
    const written = answer?.text?.trim() ?? '';
    const value = [...picked, ...(written ? [`直接写：${written}`] : [])].join('；') || '（跳过）';
    lines.push(`- ${question.question} → ${value}`);
  }
  for (const update of context.answers.updates ?? []) lines.push(`- 主人后续补充与更正 → ${update}`);
  if (context.answers.intent) lines.push(`- 这面墙想突出哪一面 → ${context.answers.intent}`);
  for (const [id, value] of Object.entries(context.answers.quick ?? {})) {
    if (context.scene.quickQuestions.find((q) => q.id === id)?.options.includes(value)) lines.push(`- 主人点选的原话 → ${value}`);
  }
  for (const [index, value] of Object.entries(context.answers.starters ?? {})) {
    const stem = context.scene.sentenceStarters[Number(index)];
    if (stem && value) lines.push(`- 主人填空 → ${stem}${value}`);
  }
  for (const topic of context.answers.wallTopics ?? []) lines.push(`- 主人明确选中想聊的话题 → ${topic}`);
  lines.push(`- 风格参考 → ${context.answers.styles.length > 0 ? context.answers.styles.join('、') : '你来定'}`);
  lines.push(`- 动效强度 → ${context.answers.motion}`);
  return lines.join('\n');
}

function followupAnswersText(state: FollowupState): string {
  if (state.questions.length === 0) return '（没有追问）';
  return state.questions
    .map((question) => {
      const answer = state.answers[question.id];
      const value = !answer || answer.skipped ? '（跳过）' : [answer.selected, answer.text.trim()].filter(Boolean).join('；') || '（跳过）';
      return `- ${question.question} → ${value}`;
    })
    .join('\n');
}

/** 从文字回复里取出第一个 JSON 对象（允许包在 ```json 代码块里）。取不到返回 undefined。 */
export function jsonFromText(content: { type: string; text?: string }[]): unknown {
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

async function callTool<T>(
  client: ModelClient,
  model: string,
  toolName: string,
  toolDescription: string,
  schema: Record<string, unknown>,
  parser: ZodType<T>,
  content: (TextBlock | ImageBlock)[],
): Promise<InterviewCallResult<T>> {
  const usage = emptyUsage();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await client.createMessage({
        model,
        max_tokens: 4096,
        system: interviewSystem(),
        messages: [{ role: 'user', content }],
        tools: [{ name: toolName, description: toolDescription, input_schema: schema }],
        tool_choice: { type: 'tool', name: toolName },
      });
    } catch (error) {
      throw new InterviewError('API_ERROR', usage, modelFailureCode(error));
    }
    addUsage(usage, response.usage);
    const call = response.content.find((block) => block.type === 'tool_use' && block.name === toolName);
    // 有些 OpenAI 兼容服务不严格遵守“必须调用指定工具”，会把 JSON 直接写在文字里：同样经 zod 校验后接受
    const input = call && call.type === 'tool_use' ? call.input : jsonFromText(response.content);
    if (input !== undefined) {
      const parsed = parser.safeParse(input);
      if (parsed.success) return { output: parsed.data, usage };
    }
  }
  throw new InterviewError('BAD_OUTPUT', usage);
}

/** 调用 #1：抽取事实候选、缺项与追问。 */
export async function runInterviewDraft(client: ModelClient, model: string, context: InterviewContext): Promise<InterviewCallResult<{ brief: BriefOutput; followups: FollowupOutput }>> {
  const content: (TextBlock | ImageBlock)[] = [
    {
      type: 'text',
      text: [
        '第一次调用：同时整理可直接确认的 brief 草稿和可选追问。不要等待追问回答才整理。',
        wallBlock(context),
        sceneBlock(context.scene),
        profileBlock(context.profile),
        untrusted('owner_wall_answers', JSON.stringify(context.knownAnswers ?? [])),
        untrusted('owner_material', context.answers.material.trim() || '（主人没有贴素材）'),
        untrusted('owner_choices', choicesText(context)),
        context.images.length > 0 ? `主人上传了 ${context.images.length} 张图片（文件名见每张图前的说明），请在 imageNotes 里客观描述画面。` : '主人没有上传图片。',
      ].join('\n\n'),
    },
  ];
  for (const { asset, bytes } of context.images) {
    content.push({ type: 'text', text: `图片文件名：${asset.fileName}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: asset.mime, data: Buffer.from(bytes).toString('base64') } });
  }
  content.push({ type: 'text', text: `最多 ${context.scene.maxFollowUps} 个追问。请调用 submit_interview。` });
  const result = await callTool(client, model, 'submit_interview', '同时返回 brief 草稿和可选追问', INTERVIEW_DRAFT_TOOL_SCHEMA, interviewDraftSchema, content);
  result.output.followups.questions = result.output.followups.questions.slice(0, context.scene.maxFollowUps);
  return result;
}

/** 调用 #2（correction 为空）/ #3（带主人的修正意见）：整理结构化 brief。 */
export async function runComposeBrief(
  client: ModelClient,
  model: string,
  context: Omit<InterviewContext, 'images'> & { imageFiles: string[] },
  state: FollowupState,
  correction: { previous: BriefOutput; note: string } | null,
): Promise<InterviewCallResult<BriefOutput>> {
  const parts = [
    correction ? '这是第 4 步：主人对上一版 brief 提了修正意见，请按意见重新整理。' : '这是第 4 步：整理 brief。',
    wallBlock(context),
    sceneBlock(context.scene),
    profileBlock(context.profile),
    untrusted('owner_wall_answers', JSON.stringify(context.knownAnswers ?? [])),
    untrusted('owner_material', context.answers.material.trim() || '（主人没有贴素材）'),
    untrusted('owner_choices', choicesText(context)),
    untrusted('owner_facts', state.facts.map((fact) => `- ${fact}`).join('\n') || '（无）'),
    untrusted('owner_followup_answers', followupAnswersText(state)),
    untrusted(
      'owner_images',
      context.imageFiles.length > 0
        ? context.imageFiles
            .map((file) => `- ${file}：${state.imageNotes.find((note) => note.file === file)?.description ?? '（没有描述）'}`)
            .join('\n')
        : '（无）',
    ),
  ];
  if (correction) {
    parts.push(untrusted('owner_previous_brief', JSON.stringify(correction.previous, null, 2)));
    parts.push(untrusted('owner_correction', correction.note));
  }
  parts.push('图片文件名只能用上面列出的。请调用 submit_brief。');
  return callTool(client, model, 'submit_brief', '返回整理好的结构化 brief', BRIEF_TOOL_SCHEMA, briefOutputSchema, [{ type: 'text', text: parts.join('\n\n') }]);
}
