import { describe, expect, it } from 'vitest';
import {
  cardSchema,
  countCjkFontFaces,
  eventsRequestSchema,
  exchangeRequestSchema,
  generateId,
  generateToken,
  kitFontSchema,
  kitFontsFileSchema,
  manifestSchema,
  MAX_CJK_FONTS,
  REVISION_MAX_FILE_ENTRIES,
  revisionsRequestSchema,
  sceneGuideSchema,
  SKILL_MIN_NODE_VERSION,
  skillArchiveFileName,
  skillPackageManifestSchema,
  type KitFont,
} from '../src/index.js';

// contracts 1.2 的示例
const validCard = {
  schemaVersion: 1,
  displayName: '阿柚',
  tagline: '做过 3 个校园小程序的前端，想找能一起熬夜的设计',
  hooks: [
    {
      id: 'help-frontend',
      kind: 'can-help',
      text: '我能帮你把原型变成能点的页面',
      opener: '你好！我在墙上看到你说能把原型变成能点的页面，我们队正好缺前端，想聊聊吗？',
    },
    { id: 'find-designer', kind: 'looking-for', text: '找会做视觉的队友', opener: '嗨，我是做设计的，看到你在找会做视觉的队友～' },
  ],
};

// contracts 1.3 的示例
const validManifest = {
  schemaVersion: 1,
  sceneType: 'hackathon',
  kitVersion: '1',
  motionLevel: 'medium',
  fonts: [{ id: 'lxgw-wenkai', weights: [400] }],
  extraChars: '',
  blocks: ['hero', 'projects', 'teammate'],
  generator: { agent: 'claude-code', skillVersion: '0.1.0' },
};

const hook = (id: string, text = '我能帮你写前端', opener = '你好，想聊聊吗？') => ({ id, text, opener });
const card = (patch: Record<string, unknown>) => ({ ...validCard, ...patch });
const manifest = (patch: Record<string, unknown>) => ({ ...validManifest, ...patch });
const ok = (result: { success: boolean }) => result.success;

describe('cardSchema', () => {
  it('接受 contracts 示例', () => {
    expect(cardSchema.parse(validCard)).toEqual(validCard);
  });

  it('hooks 必须 2–3 个', () => {
    expect(ok(cardSchema.safeParse(card({ hooks: [hook('a')] })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ hooks: [] })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ hooks: [hook('a'), hook('b')] })))).toBe(true);
    expect(ok(cardSchema.safeParse(card({ hooks: [hook('a'), hook('b'), hook('c')] })))).toBe(true);
    expect(ok(cardSchema.safeParse(card({ hooks: [hook('a'), hook('b'), hook('c'), hook('d')] })))).toBe(false);
  });

  it('hook id 必须匹配 ^[a-z][a-z0-9-]{0,39}$ 且唯一', () => {
    const valid = ['a', 'help-frontend', 'a1', `a${'b'.repeat(39)}`];
    const invalid = ['', 'A', 'Help', '1abc', '-abc', 'a_b', 'a b', '中文', `a${'b'.repeat(40)}`];
    for (const id of valid) expect(ok(cardSchema.safeParse(card({ hooks: [hook(id), hook('zz')] }))), id).toBe(true);
    for (const id of invalid) expect(ok(cardSchema.safeParse(card({ hooks: [hook(id), hook('zz')] }))), id).toBe(false);

    const duplicate = cardSchema.safeParse(card({ hooks: [hook('same'), hook('same')] }));
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues.some((issue) => issue.message.includes('重复'))).toBe(true);
  });

  it('kind 可选，给出时必须是短标识', () => {
    expect(ok(cardSchema.safeParse(card({ hooks: [hook('a'), { ...hook('b'), kind: 'looking-for' }] })))).toBe(true);
    expect(ok(cardSchema.safeParse(card({ hooks: [hook('a'), { ...hook('b'), kind: 'Looking For' }] })))).toBe(false);
  });

  it('displayName 1–24 字符（按码点计数，中文与 emoji 各计 1）', () => {
    expect(ok(cardSchema.safeParse(card({ displayName: '' })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ displayName: '柚' })))).toBe(true);
    expect(ok(cardSchema.safeParse(card({ displayName: '柚'.repeat(24) })))).toBe(true);
    expect(ok(cardSchema.safeParse(card({ displayName: '柚'.repeat(25) })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ displayName: '😀'.repeat(24) })))).toBe(true); // 48 个 UTF-16 code unit
    expect(ok(cardSchema.safeParse(card({ displayName: '😀'.repeat(25) })))).toBe(false);
  });

  it('tagline 1–40 字符', () => {
    expect(ok(cardSchema.safeParse(card({ tagline: '' })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ tagline: '字'.repeat(40) })))).toBe(true);
    expect(ok(cardSchema.safeParse(card({ tagline: '字'.repeat(41) })))).toBe(false);
  });

  it('hook text 2–32 字符，opener 1–80 字符', () => {
    const withHook = (text: string, opener: string) => card({ hooks: [hook('a', text, opener), hook('b')] });
    expect(ok(cardSchema.safeParse(withHook('字', '好')))).toBe(false);
    expect(ok(cardSchema.safeParse(withHook('字字', '好')))).toBe(true);
    expect(ok(cardSchema.safeParse(withHook('字'.repeat(32), '好')))).toBe(true);
    expect(ok(cardSchema.safeParse(withHook('字'.repeat(33), '好')))).toBe(false);
    expect(ok(cardSchema.safeParse(withHook('字字', '')))).toBe(false);
    expect(ok(cardSchema.safeParse(withHook('字字', '好'.repeat(80))))).toBe(true);
    expect(ok(cardSchema.safeParse(withHook('字字', '好'.repeat(81))))).toBe(false);
  });

  it('文本不能只有空白，不能含换行等控制字符', () => {
    expect(ok(cardSchema.safeParse(card({ displayName: '   ' })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ tagline: '第一行\n第二行' })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ displayName: '阿\t柚' })))).toBe(false);
  });

  it('schemaVersion 必须是 1，未知字段报错，缺字段报错', () => {
    expect(ok(cardSchema.safeParse(card({ schemaVersion: 2 })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ schemaVersion: '1' })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ contact: 'wx: abc' })))).toBe(false);
    expect(ok(cardSchema.safeParse(card({ hooks: [{ ...hook('a'), extra: 1 }, hook('b')] })))).toBe(false);
    const { tagline: _omit, ...missing } = validCard;
    expect(ok(cardSchema.safeParse(missing))).toBe(false);
    expect(ok(cardSchema.safeParse(null))).toBe(false);
    expect(ok(cardSchema.safeParse([]))).toBe(false);
  });
});

describe('manifestSchema', () => {
  it('接受 contracts 示例；blocks 与 generator 可省略', () => {
    expect(manifestSchema.parse(validManifest)).toEqual(validManifest);
    const { blocks: _b, generator: _g, ...minimal } = validManifest;
    expect(ok(manifestSchema.safeParse(minimal))).toBe(true);
    expect(ok(manifestSchema.safeParse(manifest({ fonts: [] })))).toBe(true);
  });

  it('sceneType 只能是 hackathon / interest / club / general', () => {
    for (const sceneType of ['hackathon', 'interest', 'club', 'general']) {
      expect(ok(manifestSchema.safeParse(manifest({ sceneType }))), sceneType).toBe(true);
    }
    for (const sceneType of ['party', 'Hackathon', '', null]) {
      expect(ok(manifestSchema.safeParse(manifest({ sceneType }))), String(sceneType)).toBe(false);
    }
  });

  it('motionLevel 只能是 calm / medium / lively', () => {
    for (const motionLevel of ['calm', 'medium', 'lively']) {
      expect(ok(manifestSchema.safeParse(manifest({ motionLevel })))).toBe(true);
    }
    for (const motionLevel of ['none', 'high', 1]) {
      expect(ok(manifestSchema.safeParse(manifest({ motionLevel })))).toBe(false);
    }
  });

  it('kitVersion 只能是字符串 "1"', () => {
    expect(ok(manifestSchema.safeParse(manifest({ kitVersion: '2' })))).toBe(false);
    expect(ok(manifestSchema.safeParse(manifest({ kitVersion: 1 })))).toBe(false);
  });

  it('fonts：id 为短标识且不重复，字重为不重复的 100–900 整百值', () => {
    const fonts = (value: unknown) => manifestSchema.safeParse(manifest({ fonts: value }));
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: [400, 700] }]))).toBe(true);
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: [] }]))).toBe(false);
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: [450] }]))).toBe(false);
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: [0] }]))).toBe(false);
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: [1000] }]))).toBe(false);
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: ['400'] }]))).toBe(false);
    expect(ok(fonts([{ id: 'lxgw-wenkai', weights: [400, 400] }]))).toBe(false);
    expect(ok(fonts([{ id: 'LXGW', weights: [400] }]))).toBe(false);
    expect(ok(fonts([{ id: 'a', weights: [400] }, { id: 'a', weights: [700] }]))).toBe(false);
  });

  it('extraChars 必填（可为空字符串）；blocks 元素为短标识；未知字段报错', () => {
    const { extraChars: _e, ...noExtra } = validManifest;
    expect(ok(manifestSchema.safeParse(noExtra))).toBe(false);
    expect(ok(manifestSchema.safeParse(manifest({ extraChars: '动态生成的字' })))).toBe(true);
    expect(ok(manifestSchema.safeParse(manifest({ blocks: ['Hero'] })))).toBe(false);
    expect(ok(manifestSchema.safeParse(manifest({ brief: '私密内容' })))).toBe(false);
  });
});

const kitFonts: KitFont[] = [
  {
    id: 'lxgw-wenkai',
    family: 'LXGW WenKai',
    cjk: true,
    weights: [300, 400, 700],
    license: 'OFL-1.1',
    sourceUrl: 'https://github.com/lxgw/LxgwWenKai',
    files: { '300': 'LXGWWenKai-Light.ttf', '400': 'LXGWWenKai-Regular.ttf', '700': 'LXGWWenKai-Bold.ttf' },
  },
  {
    id: 'noto-serif-sc',
    family: 'Noto Serif SC',
    cjk: true,
    weights: [400, 900],
    license: 'OFL-1.1',
    sourceUrl: 'https://github.com/notofonts/noto-cjk',
    files: { '400': 'NotoSerifSC-VF.ttf', '900': 'NotoSerifSC-VF.ttf' },
  },
  {
    id: 'inter',
    family: 'Inter',
    cjk: false,
    weights: [400, 700],
    license: 'OFL-1.1',
    sourceUrl: 'https://github.com/rsms/inter',
    files: { '400': 'Inter-Regular.ttf', '700': 'Inter-Bold.ttf' },
  },
];

describe('countCjkFontFaces（中文字体每个字重计 1 款，合计 ≤ 2）', () => {
  it('按中文字体的字重计数，西文字体不计', () => {
    expect(countCjkFontFaces([], kitFonts)).toBe(0);
    expect(countCjkFontFaces([{ id: 'lxgw-wenkai', weights: [400] }], kitFonts)).toBe(1);
    expect(countCjkFontFaces([{ id: 'lxgw-wenkai', weights: [400, 700] }], kitFonts)).toBe(2);
    expect(
      countCjkFontFaces(
        [
          { id: 'lxgw-wenkai', weights: [400] },
          { id: 'noto-serif-sc', weights: [900] },
        ],
        kitFonts,
      ),
    ).toBe(2);
    expect(
      countCjkFontFaces(
        [
          { id: 'lxgw-wenkai', weights: [400] },
          { id: 'inter', weights: [400, 700] },
        ],
        kitFonts,
      ),
    ).toBe(1);
  });

  it('超过上限的组合', () => {
    const tooMany = countCjkFontFaces(
      [
        { id: 'lxgw-wenkai', weights: [300, 400] },
        { id: 'noto-serif-sc', weights: [400] },
      ],
      kitFonts,
    );
    expect(tooMany).toBe(3);
    expect(tooMany > MAX_CJK_FONTS).toBe(true);
    expect(MAX_CJK_FONTS).toBe(2);
  });

  it('不在 Kit 清单里的字体不计入（由校验器另报 FONT_UNKNOWN）；重复字重只计一次', () => {
    expect(countCjkFontFaces([{ id: 'unknown-font', weights: [400] }], kitFonts)).toBe(0);
    expect(countCjkFontFaces([{ id: 'lxgw-wenkai', weights: [400, 400] }], kitFonts)).toBe(1);
  });
});

describe('kitFontSchema / kitFontsFileSchema', () => {
  it('接受合法的字体项与清单文件', () => {
    for (const font of kitFonts) expect(kitFontSchema.parse(font)).toEqual(font);
    expect(ok(kitFontsFileSchema.safeParse({ schemaVersion: 1, fonts: kitFonts }))).toBe(true);
    expect(ok(kitFontsFileSchema.safeParse({ schemaVersion: 1, fonts: [] }))).toBe(true);
  });

  it('files 的键必须与 weights 一一对应', () => {
    const base = kitFonts[2]!;
    expect(ok(kitFontSchema.safeParse({ ...base, files: { '400': 'Inter-Regular.ttf' } }))).toBe(false);
    expect(ok(kitFontSchema.safeParse({ ...base, files: { ...base.files, '900': 'Inter-Black.ttf' } }))).toBe(false);
  });

  it('授权、来源、family、文件名受限', () => {
    const base = kitFonts[2]!;
    expect(ok(kitFontSchema.safeParse({ ...base, license: 'Proprietary' }))).toBe(false);
    expect(ok(kitFontSchema.safeParse({ ...base, sourceUrl: 'http://example.com/font' }))).toBe(false);
    expect(ok(kitFontSchema.safeParse({ ...base, family: "Inter'; } body { x" }))).toBe(false);
    expect(ok(kitFontSchema.safeParse({ ...base, family: '霞鹜文楷' }))).toBe(false);
    expect(ok(kitFontSchema.safeParse({ ...base, files: { '400': '../x.ttf', '700': 'Inter-Bold.ttf' } }))).toBe(false);
    expect(ok(kitFontSchema.safeParse({ ...base, files: { '400': 'Inter.exe', '700': 'Inter-Bold.ttf' } }))).toBe(false);
  });

  it('清单中字体 id 不能重复', () => {
    expect(ok(kitFontsFileSchema.safeParse({ schemaVersion: 1, fonts: [kitFonts[0], kitFonts[0]] }))).toBe(false);
  });
});

const validScene = {
  id: 'hackathon',
  label: '黑客松组队',
  goal: '让队友快速知道你能做什么、在找谁',
  interviewBudgetSeconds: 300,
  assetPrompt: '有没有作品截图或者项目照片？',
  choiceQuestions: [
    { id: 'role', question: '你主要做什么？', options: ['前端', '后端', '设计', '产品'], multi: true, required: true },
  ],
  followUps: [{ direction: '具体做过的项目', examples: ['你最得意的一个项目是什么？'] }],
  maxFollowUps: 3,
  mustHave: [{ id: 'skills', description: '能提供的技能' }],
  hookKinds: [
    { kind: 'can-help', pattern: '我能帮你……' },
    { kind: 'looking-for', pattern: '我在找……' },
  ],
  defaults: { showSchool: true, useNickname: false, contactPublic: true },
  pageGoal: '一屏看懂技能与组队需求',
  suggestedBlocks: ['hero', 'skills', 'projects', 'teammate'],
  visualTone: '清爽、有活力',
  examples: ['hackathon-frontend', 'hackathon-designer'],
};

describe('sceneGuideSchema', () => {
  it('接受合法的场景指南', () => {
    expect(sceneGuideSchema.parse(validScene)).toEqual({ ...validScene, quickQuestions: [], sentenceStarters: [] });
  });

  it('快问快答只接受两个或四个原话选项，题目 id 不重复', () => {
    const q = { id: 'snapshot', question: '凌晨三点你在？', options: ['我在改 bug', '我已经睡了'] };
    expect(sceneGuideSchema.safeParse({ ...validScene, quickQuestions: [q], sentenceStarters: ['我能连讲十分钟的话题是'] }).success).toBe(true);
    expect(sceneGuideSchema.safeParse({ ...validScene, quickQuestions: [{ ...q, options: [...q.options, '我在点外卖'] }] }).success).toBe(false);
    expect(sceneGuideSchema.safeParse({ ...validScene, quickQuestions: [q, q] }).success).toBe(false);
  });

  it('拒绝非法场景、缺字段、重复的接话点类型、少于两个选项', () => {
    expect(ok(sceneGuideSchema.safeParse({ ...validScene, id: 'party' }))).toBe(false);
    const { visualTone: _v, ...missing } = validScene;
    expect(ok(sceneGuideSchema.safeParse(missing))).toBe(false);
    expect(
      ok(sceneGuideSchema.safeParse({ ...validScene, hookKinds: [validScene.hookKinds[0], validScene.hookKinds[0]] })),
    ).toBe(false);
    expect(ok(sceneGuideSchema.safeParse({ ...validScene, hookKinds: [] }))).toBe(false);
    expect(
      ok(
        sceneGuideSchema.safeParse({
          ...validScene,
          choiceQuestions: [{ ...validScene.choiceQuestions[0], options: ['只有一个'] }],
        }),
      ),
    ).toBe(false);
    expect(ok(sceneGuideSchema.safeParse({ ...validScene, interviewBudgetSeconds: 0 }))).toBe(false);
    expect(ok(sceneGuideSchema.safeParse({ ...validScene, examples: ['../etc'] }))).toBe(false);
    expect(ok(sceneGuideSchema.safeParse({ ...validScene, extra: true }))).toBe(false);
  });
});

describe('Agent API 请求体', () => {
  it('exchange：{ wallId, token }', () => {
    const wallId = generateId('wal');
    const token = generateToken('agentToken');
    expect(exchangeRequestSchema.parse({ wallId, token })).toEqual({ wallId, token });
    expect(ok(exchangeRequestSchema.safeParse({ wallId: 'wal_x', token }))).toBe(false);
    expect(ok(exchangeRequestSchema.safeParse({ wallId, token: generateToken('pageCredential') }))).toBe(false);
    expect(ok(exchangeRequestSchema.safeParse({ wallId, token, extra: 1 }))).toBe(false);
    expect(ok(exchangeRequestSchema.safeParse({ wallId }))).toBe(false);
  });

  it('exchange：可选的 client 自报版本，版本号格式严格', () => {
    const wallId = generateId('wal');
    const token = generateToken('agentToken');
    const client = { cliVersion: '0.1.0', skillVersion: '0.1.0' };
    expect(exchangeRequestSchema.parse({ wallId, token, client })).toEqual({ wallId, token, client });
    expect(ok(exchangeRequestSchema.safeParse({ wallId, token, client: { cliVersion: '0.1.0', skillVersion: null } }))).toBe(true);
    expect(ok(exchangeRequestSchema.safeParse({ wallId, token, client: { cliVersion: '0.1.0' } }))).toBe(false);
    expect(ok(exchangeRequestSchema.safeParse({ wallId, token, client: { ...client, extra: 1 } }))).toBe(false);
    for (const bad of ['1', '1.0', 'v1.0.0', '1.0.0-<script>', '1.0.0-' + 'a'.repeat(25), '99999.0.0']) {
      expect(ok(exchangeRequestSchema.safeParse({ wallId, token, client: { ...client, cliVersion: bad } }))).toBe(false);
    }
  });

  it('Skill 包清单', () => {
    const manifest = {
      name: 'nowme-page',
      version: '0.1.0',
      file: skillArchiveFileName('0.1.0'),
      sha256: 'a'.repeat(64),
      bytes: 1234,
      minNode: SKILL_MIN_NODE_VERSION,
    };
    expect(manifest.file).toBe('nowme-page-0.1.0.tar.gz');
    expect(ok(skillPackageManifestSchema.safeParse(manifest))).toBe(true);
    expect(ok(skillPackageManifestSchema.safeParse({ ...manifest, url: 'http://localhost:3000/skill/nowme-page-0.1.0.tar.gz' }))).toBe(true);
    expect(ok(skillPackageManifestSchema.safeParse({ ...manifest, name: 'other' }))).toBe(false);
    expect(ok(skillPackageManifestSchema.safeParse({ ...manifest, file: '../x.tar.gz' }))).toBe(false);
    expect(ok(skillPackageManifestSchema.safeParse({ ...manifest, sha256: 'A'.repeat(64) }))).toBe(false);
  });

  it('revisions：{ files: { 路径: base64 } }', () => {
    const files = {
      'index.html': Buffer.from('<!doctype html>').toString('base64'),
      'card.json': Buffer.from('{}').toString('base64'),
      'brief.md': Buffer.from('白名单外的文件由服务端忽略，不在 schema 层报错').toString('base64'),
    };
    expect(ok(revisionsRequestSchema.safeParse({ files }))).toBe(true);
    expect(ok(revisionsRequestSchema.safeParse({ files: {} }))).toBe(true);
    expect(ok(revisionsRequestSchema.safeParse({ files: { 'index.html': 'not base64!' } }))).toBe(false);
    expect(ok(revisionsRequestSchema.safeParse({ files: { 'index.html': 123 } }))).toBe(false);
    expect(ok(revisionsRequestSchema.safeParse({ files: { '': 'AAAA' } }))).toBe(false);
    expect(ok(revisionsRequestSchema.safeParse({ files: [] }))).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: REVISION_MAX_FILE_ENTRIES + 1 }, (_, i) => [`assets/${i}.png`, 'AAAA']),
    );
    expect(ok(revisionsRequestSchema.safeParse({ files: many }))).toBe(false);
  });

  it('events：type ∈ fetch / validate / preview / generate / submit，props 只接受数字和布尔值', () => {
    for (const type of ['fetch', 'validate', 'preview', 'generate', 'submit']) {
      expect(ok(eventsRequestSchema.safeParse({ type })), type).toBe(true);
    }
    expect(ok(eventsRequestSchema.safeParse({ type: 'agent_fetch' }))).toBe(false);
    expect(ok(eventsRequestSchema.safeParse({ type: 'publish' }))).toBe(false);
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: { ok: true, durationMs: 120, errorCount: 0 } }))).toBe(
      true,
    );
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: { note: '内容' } }))).toBe(false);
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: { nested: { a: 1 } } }))).toBe(false);
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: { list: [1] } }))).toBe(false);
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: { n: Number.POSITIVE_INFINITY } }))).toBe(false);
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: { 'bad key': 1 } }))).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]));
    expect(ok(eventsRequestSchema.safeParse({ type: 'validate', props: tooMany }))).toBe(false);
  });
});
