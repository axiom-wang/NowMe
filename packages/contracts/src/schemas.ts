/**
 * zod schema：card.json（1.2）、manifest.json（1.3）、Kit 字体清单、SceneGuide（7）、Agent API 请求体（4.1）。
 *
 * 文本长度一律按 Unicode 码点计数（`Array.from(s).length`），不按 UTF-16 code unit。
 * 对象一律用 strictObject：出现未知字段即报错（避免无关内容混进 card / manifest 被存储）。
 */
import { z } from 'zod';
import {
  AGENT_EVENT_TYPES,
  CARD_LIMITS,
  EVENT_PROP_KEY_PATTERN,
  EVENT_PROPS_MAX_KEYS,
  KIT_VERSION,
  MOTION_LEVELS,
  NM_ID_PATTERN,
  PAGE_SCHEMA_VERSION,
  SCENE_TYPES,
} from './constants.js';
import { tokenPattern, WALL_ID_PATTERN } from './ids.js';

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 按 Unicode 码点计数的字符串长度（中文、emoji 各计 1 个码点；组合 emoji 计多个）。 */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 单行短文本：码点数在 [min, max]，不能全是空白，不能含换行、制表符等控制字符。
 * （contracts 只规定了长度；“非空白、无控制字符”是 T0.2 补充的约束。）
 */
export function shortText(label: string, min: number, max: number) {
  return z.string().superRefine((value, ctx) => {
    const length = codePointLength(value);
    if (length < min || length > max) {
      ctx.addIssue({ code: 'custom', message: `${label}应为 ${min}–${max} 个字符，当前 ${length} 个` });
    } else if (value.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: `${label}不能只有空白` });
    }
    if (CONTROL_CHARS.test(value)) {
      ctx.addIssue({ code: 'custom', message: `${label}不能包含换行、制表符等控制字符` });
    }
  });
}

const nonEmptyText = z.string().trim().min(1, '不能为空');

/** 短标识：`^[a-z][a-z0-9-]{0,39}$`（data-nm-id、hook id、字体 id 等）。 */
export const slugSchema = z
  .string()
  .regex(NM_ID_PATTERN, '应为小写字母开头、只含小写字母 / 数字 / 连字符、最长 40 个字符的标识');

/** 数组元素按 key 唯一。 */
function uniqueBy<T>(
  items: readonly T[],
  key: (item: T) => unknown,
  ctx: z.RefinementCtx,
  field: string | null,
  label: string,
): void {
  const seen = new Set<unknown>();
  items.forEach((item, index) => {
    const value = key(item);
    if (seen.has(value)) {
      const path = field === null ? [index] : [index, field];
      ctx.addIssue({ code: 'custom', message: `${label}重复：${String(value)}`, path });
    }
    seen.add(value);
  });
}

// ---------------------------------------------------------------------------
// card.json（contracts 1.2）
// ---------------------------------------------------------------------------

export const hookSchema = z.strictObject({
  id: slugSchema,
  /** 可选，取场景指南 hookKinds 中的 kind（是否属于当前场景由校验器判断）。 */
  kind: slugSchema.optional(),
  text: shortText('接话点 text ', CARD_LIMITS.hookText.min, CARD_LIMITS.hookText.max),
  /** 开场白，由 Agent 起草，主人在应用内确认或改写。 */
  opener: shortText('开场白 opener ', CARD_LIMITS.hookOpener.min, CARD_LIMITS.hookOpener.max),
});

export const cardSchema = z.strictObject({
  schemaVersion: z.literal(PAGE_SCHEMA_VERSION),
  displayName: shortText('displayName ', CARD_LIMITS.displayName.min, CARD_LIMITS.displayName.max),
  tagline: shortText('tagline ', CARD_LIMITS.tagline.min, CARD_LIMITS.tagline.max),
  hooks: z
    .array(hookSchema)
    .min(CARD_LIMITS.hooks.min, `接话点 hooks 至少 ${CARD_LIMITS.hooks.min} 个`)
    .max(CARD_LIMITS.hooks.max, `接话点 hooks 最多 ${CARD_LIMITS.hooks.max} 个`)
    .superRefine((hooks, ctx) => uniqueBy(hooks, (hook) => hook.id, ctx, 'id', '接话点 id ')),
});

export type Hook = z.infer<typeof hookSchema>;
export type Card = z.infer<typeof cardSchema>;

// ---------------------------------------------------------------------------
// 字体（manifest.fonts 与 Kit fonts.json）
// ---------------------------------------------------------------------------

/** [T0.2 暂定] 字重只允许 100–900 的整百值（字体子集文件按 `<fontId>-<weight>.woff2` 命名）。 */
export const fontWeightSchema = z
  .int()
  .min(100)
  .max(900)
  .refine((weight) => weight % 100 === 0, '字重应为 100–900 的整百值');

const weightList = z
  .array(fontWeightSchema)
  .min(1, '至少一个字重')
  .superRefine((weights, ctx) => uniqueBy(weights, (weight) => weight, ctx, null, '字重'));

/**
 * [T0.2 暂定] Kit 字体允许的授权（SPDX 标识），均允许子集化与网页分发。
 * 需要别的授权时改这里并经总规划师确认。
 */
export const KIT_FONT_LICENSES = ['OFL-1.1', 'Apache-2.0', 'MIT'] as const;

/** CSS font-family 名：ASCII 字母数字、空格、连字符（会被写进 `@font-face` 与 CSS 变量，限制字符集防注入）。 */
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,62}[A-Za-z0-9])?$/;
/** 字体源文件名（位于 `packages/kit/fonts/`，由下载脚本获取，不入库）。 */
const FONT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:ttf|otf|woff2?)$/;

/**
 * Kit 字体清单中的一项（`packages/kit/fonts.json` 的 `fonts[]`，也出现在 AgentContext.kit.fonts）。
 *
 * 与任务说明 `{ id, family, cjk, weights, license, sourceUrl, file }` 的差异：
 * 把单个 `file` 改为 `files`（字重 → 文件名），因为静态字体每个字重是独立文件；
 * 可变字体可以让多个字重指向同一个文件。
 */
export const kitFontSchema = z
  .strictObject({
    /** 稳定 ID，manifest.fonts[].id 引用它，例如 `lxgw-wenkai`。 */
    id: slugSchema,
    /** CSS font-family 名，页面通过它或 `var(--nm-font-<id>)` 使用。 */
    family: z.string().regex(FONT_FAMILY_PATTERN, 'family 只能含 ASCII 字母、数字、空格、连字符'),
    /** 是否中文字体：中文字体每个字重计 1 款，合计 ≤ MAX_CJK_FONTS。 */
    cjk: z.boolean(),
    /** 支持的字重。 */
    weights: weightList,
    /** SPDX 授权标识。 */
    license: z.enum(KIT_FONT_LICENSES),
    /** 下载来源（https）。 */
    sourceUrl: z.url({ protocol: /^https$/, error: 'sourceUrl 应为 https 地址' }),
    /** 字重（字符串形式，如 "400"）→ 源字体文件名。键必须与 weights 一致。 */
    files: z.record(z.string().regex(/^[1-9]00$/), z.string().regex(FONT_FILE_PATTERN, '字体文件名不合法')),
  })
  .superRefine((font, ctx) => {
    const expected = new Set(font.weights.map(String));
    const actual = new Set(Object.keys(font.files));
    const same = expected.size === actual.size && [...expected].every((weight) => actual.has(weight));
    if (!same) {
      ctx.addIssue({ code: 'custom', message: 'files 的键必须与 weights 一一对应', path: ['files'] });
    }
  });

export type KitFont = z.infer<typeof kitFontSchema>;

/** `packages/kit/fonts.json` 整个文件。 */
export const kitFontsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fonts: z.array(kitFontSchema).superRefine((fonts, ctx) => uniqueBy(fonts, (font) => font.id, ctx, 'id', '字体 id ')),
});

export type KitFontsFile = z.infer<typeof kitFontsFileSchema>;

export const manifestFontSchema = z.strictObject({
  id: slugSchema,
  weights: weightList,
});

export type ManifestFont = z.infer<typeof manifestFontSchema>;

/**
 * manifest.fonts 中中文字体的款数：每个中文字体的每个字重计 1 款（contracts 1.3）。
 * 不在 Kit 清单里的 id 不计入（由校验器另报 FONT_UNKNOWN）。
 */
export function countCjkFontFaces(
  fonts: readonly Pick<ManifestFont, 'id' | 'weights'>[],
  kitFonts: readonly Pick<KitFont, 'id' | 'cjk'>[],
): number {
  const cjkIds = new Set(kitFonts.filter((font) => font.cjk).map((font) => font.id));
  const faces = new Set<string>();
  for (const font of fonts) {
    if (!cjkIds.has(font.id)) continue;
    for (const weight of font.weights) faces.add(`${font.id}:${weight}`);
  }
  return faces.size;
}

// ---------------------------------------------------------------------------
// manifest.json（contracts 1.3）
// ---------------------------------------------------------------------------

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(PAGE_SCHEMA_VERSION),
  sceneType: z.enum(SCENE_TYPES),
  kitVersion: z.literal(KIT_VERSION),
  motionLevel: z.enum(MOTION_LEVELS),
  /** 只能是 Kit fonts.json 中的 id 与其支持的字重（跨文件检查由校验器做：FONT_UNKNOWN / FONT_TOO_MANY_CJK）。 */
  fonts: z
    .array(manifestFontSchema)
    .superRefine((fonts, ctx) => uniqueBy(fonts, (font) => font.id, ctx, 'id', '字体 id ')),
  /** 脚本动态生成、静态 HTML 中没有的字；`nowme validate` 自动补全。 */
  extraChars: z.string(),
  /** 可选；给出时应与页面中的 data-nm-id 一致（不一致为警告）。 */
  blocks: z.array(slugSchema).optional(),
  /** 可选，自由填写。 */
  generator: z.record(z.string(), z.unknown()).optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;

// ---------------------------------------------------------------------------
// SceneGuide（contracts 7）
// ---------------------------------------------------------------------------

/** skill/examples/ 下的目录名。 */
const exampleDirSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, '示例目录名只能含小写字母、数字、连字符');

export const sceneGuideSchema = z.strictObject({
  id: z.enum(SCENE_TYPES),
  label: nonEmptyText,
  goal: nonEmptyText,
  interviewBudgetSeconds: z.int().positive(),
  assetPrompt: nonEmptyText,
  choiceQuestions: z
    .array(
      z.strictObject({
        id: slugSchema,
        question: nonEmptyText,
        options: z.array(nonEmptyText).min(2, '至少两个选项'),
        multi: z.boolean(),
        required: z.boolean(),
      }),
    )
    .superRefine((items, ctx) => uniqueBy(items, (item) => item.id, ctx, 'id', '问题 id ')),
  followUps: z.array(z.strictObject({ direction: nonEmptyText, examples: z.array(nonEmptyText) })),
  maxFollowUps: z.int().nonnegative(),
  mustHave: z
    .array(z.strictObject({ id: slugSchema, description: nonEmptyText }))
    .superRefine((items, ctx) => uniqueBy(items, (item) => item.id, ctx, 'id', 'mustHave id ')),
  hookKinds: z
    .array(z.strictObject({ kind: slugSchema, pattern: nonEmptyText }))
    .min(1, '至少一种接话点类型')
    .superRefine((items, ctx) => uniqueBy(items, (item) => item.kind, ctx, 'kind', '接话点类型 ')),
  defaults: z.strictObject({ showSchool: z.boolean(), useNickname: z.boolean(), contactPublic: z.boolean() }),
  pageGoal: nonEmptyText,
  suggestedBlocks: z.array(slugSchema),
  visualTone: nonEmptyText,
  examples: z.array(exampleDirSchema),
});

export type SceneGuide = z.infer<typeof sceneGuideSchema>;

// ---------------------------------------------------------------------------
// Agent API 请求体（contracts 4.1）
// ---------------------------------------------------------------------------

/**
 * `POST /api/agent/exchange`。
 * 注意：token 格式不对时，服务端仍应返回 401 TOKEN_INVALID（与不存在、已用、过期一致），不要返回 400。
 */
export const exchangeRequestSchema = z.strictObject({
  wallId: z.string().regex(WALL_ID_PATTERN, 'wallId 格式不对'),
  token: z.string().regex(tokenPattern('agentToken'), 'token 格式不对'),
});

export type ExchangeRequest = z.infer<typeof exchangeRequestSchema>;

/** [T0.2 暂定] 一次提交最多的文件条目数（白名单最多 4 个顶层文件 + 20 个资源）。 */
export const REVISION_MAX_FILE_ENTRIES = 64;

/**
 * `POST /api/agent/revisions`：`{ files: { "<相对路径>": "<base64>" } }`。
 * 这里只校验结构；路径是否在白名单内由服务端用 isPageUploadPath 过滤（白名单外的忽略，不报错）。
 */
export const revisionsRequestSchema = z.strictObject({
  files: z
    .record(z.string().min(1).max(512), z.base64('文件内容应为 base64'))
    .refine((files) => Object.keys(files).length <= REVISION_MAX_FILE_ENTRIES, {
      message: `一次最多提交 ${REVISION_MAX_FILE_ENTRIES} 个文件`,
    }),
});

export type RevisionsRequest = z.infer<typeof revisionsRequestSchema>;

/** `POST /api/agent/events`：`props` 只接受数字和布尔值，不含任何内容。 */
export const eventsRequestSchema = z.strictObject({
  type: z.enum(AGENT_EVENT_TYPES),
  props: z
    .record(z.string().regex(EVENT_PROP_KEY_PATTERN, '属性名不合法'), z.union([z.number(), z.boolean()]))
    .refine((props) => Object.keys(props).length <= EVENT_PROPS_MAX_KEYS, {
      message: `props 最多 ${EVENT_PROPS_MAX_KEYS} 个`,
    })
    .optional(),
});

export type EventsRequest = z.infer<typeof eventsRequestSchema>;
