/**
 * OpenAI 兼容服务（hosted-route 1.1）：请求 / 响应转换、能力限制（看图、输出上限）、重试，
 * 以及用模拟的 OpenAI 兼容服务（DeepSeek 预设）走通应用内采访与托管生成。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLES_DIR } from '@nowme/skill';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_PLACEHOLDER, withEndpointLimits, type CreateMessageParams, type ModelClient } from '../src/hosted/model-client.js';
import { ModelAccessError, modelFailureStatus } from '../src/hosted/model-errors.js';
import { createOpenAICompatibleClient, fromChatResponse, toChatRequest, type ChatCompletionRequest } from '../src/hosted/openai-client.js';
import { createUser, seedWall, type TestWeb } from './helpers.js';
import { completeInterview, createFakePreviewer, generate, joinAs, type HostedTestWeb } from './hosted-helpers.js';
import { createTestWeb } from './helpers.js';

const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0K' } };

const PARAMS: CreateMessageParams = {
  model: 'deepseek-chat',
  max_tokens: 32000,
  system: [
    { type: 'text', text: '运行说明' },
    { type: 'text', text: 'Skill 全文', cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: '任务' }, PNG] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '先看看' },
        { type: 'tool_use', id: 'call_1', name: 'preview_page', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '{"ok":true}' }, { type: 'text', text: '截图：封面' }, PNG], cache_control: { type: 'ephemeral' } },
      ],
    },
  ],
  tools: [{ name: 'finish', description: '结束', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } }],
  tool_choice: { type: 'tool', name: 'finish' },
};

describe('请求与响应转换', () => {
  it('system 合并、cache_control 去掉、工具结果变 tool 消息、截图放进随后的 user 消息、tool_choice 映射', () => {
    const request = toChatRequest(PARAMS, 'max_completion_tokens');
    expect(request.messages[0]).toEqual({ role: 'system', content: '运行说明\n\nSkill 全文' });
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '任务' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
      ],
    });
    expect(request.messages[2]).toEqual({
      role: 'assistant',
      content: '先看看',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'preview_page', arguments: '{}' } }],
    });
    expect(request.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}\n截图：封面' });
    expect(request.messages[4]?.role).toBe('user');
    expect(JSON.stringify(request.messages[4])).toContain('image_url');
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'finish' } });
    expect(request.tools?.[0]).toEqual({ type: 'function', function: { name: 'finish', description: '结束', parameters: { type: 'object', properties: {} } } });
    expect(request.max_completion_tokens).toBe(32000);
    expect(request.max_tokens).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('cache_control');
    expect(toChatRequest({ ...PARAMS, tool_choice: { type: 'any' } }).tool_choice).toBe('required');
    expect(toChatRequest({ ...PARAMS, tool_choice: { type: 'auto' } }).max_tokens).toBe(32000);
  });

  it('tool_calls → tool_use；参数不是 JSON 时不崩；用量里命中缓存的部分记为 cacheRead', () => {
    const response = fromChatResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_a', function: { name: 'write_page_file', arguments: '{"path":"index.html","content":"x"}' } },
              { id: 'call_b', function: { name: 'validate_page', arguments: '{not json' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    });
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'write_page_file', input: { path: 'index.html', content: 'x' } },
      { type: 'tool_use', id: 'call_b', name: 'validate_page', input: { _invalidArguments: true } },
    ]);
    expect(response.usage).toEqual({ input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 });
    // DeepSeek 的缓存字段
    expect(fromChatResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4 } }).usage.cache_read_input_tokens).toBe(4);
    expect(fromChatResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }).stop_reason).toBe('refusal');
    expect(() => fromChatResponse({})).toThrow();
  });

  it('不支持看图时，用户消息与工具结果里的图片都换成文字；输出上限被收紧', async () => {
    let seen: CreateMessageParams | null = null;
    const inner: ModelClient = {
      async createMessage(params) {
        seen = params;
        return { content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
    await withEndpointLimits(inner, { vision: false, maxOutputTokens: 8192 }).createMessage(PARAMS);
    const text = JSON.stringify(seen);
    expect(text).not.toContain('"type":"image"');
    expect(text).toContain(IMAGE_PLACEHOLDER);
    expect((seen as unknown as CreateMessageParams).max_tokens).toBe(8192);
    await withEndpointLimits(inner, { vision: true, maxOutputTokens: 64000 }).createMessage(PARAMS);
    expect(JSON.stringify(seen)).toContain('"type":"image"');
    expect((seen as unknown as CreateMessageParams).max_tokens).toBe(32000);
  });

  it('429 / 5xx 重试，4xx 不重试；错误信息不回显响应体', async () => {
    const statuses = [429, 503, 200];
    let calls = 0;
    const fetchMock = (async () => {
      const status = statuses[calls] ?? 200;
      calls += 1;
      return status === 200
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status })
        : new Response('{"error":"secret echo of your prompt"}', { status });
    }) as typeof fetch;
    const client = createOpenAICompatibleClient({ baseUrl: 'https://llm.example.com/v1', apiKey: 'k', fetch: fetchMock, retryDelayMs: 0 });
    const response = await client.createMessage(PARAMS);
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toBe(3);

    calls = 0;
    const bad = createOpenAICompatibleClient({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'k',
      retryDelayMs: 0,
      fetch: (async () => {
        calls += 1;
        return new Response('{"error":"secret echo of your prompt"}', { status: 400 });
      }) as typeof fetch,
    });
    const error = (await bad.createMessage(PARAMS).then(
      () => new Error('没有抛错'),
      (caught: unknown) => caught as Error,
    )) as Error;
    expect(calls).toBe(1);
    expect(error.message).toBe('模型服务返回 400');
    expect(error.message).not.toContain('secret echo');
    expect(modelFailureStatus(new ModelAccessError('MODEL_UNAVAILABLE', modelFailureStatus(error)))).toBe(400);
  });

  it('连接中断等临时网络错误会重试；地址或 DNS 校验失败不重试', async () => {
    let calls = 0;
    const flaky = createOpenAICompatibleClient({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'k',
      retryDelayMs: 0,
      fetch: (async () => {
        calls += 1;
        if (calls < 3) throw new ModelAccessError('MODEL_UNAVAILABLE');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect((await flaky.createMessage(PARAMS)).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls).toBe(3);

    calls = 0;
    const blocked = createOpenAICompatibleClient({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'k',
      retryDelayMs: 0,
      fetch: (async () => {
        calls += 1;
        throw new ModelAccessError('MODEL_CONFIG');
      }) as typeof fetch,
    });
    await expect(blocked.createMessage(PARAMS)).rejects.toMatchObject({ code: 'MODEL_CONFIG' });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 模拟的 OpenAI 兼容服务：用 Skill 示例页按轮次调用工具
// ---------------------------------------------------------------------------

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: ChatCompletionRequest;
}

function example(file: string): string {
  return readFileSync(join(EXAMPLES_DIR, 'hackathon-terminal', file), 'utf8');
}

function toolCall(name: string, args: unknown) {
  return { id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function reply(message: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3000, completion_tokens: 200, prompt_cache_hit_tokens: 2500 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function createMockOpenAIServer() {
  const recorded: Recorded[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatCompletionRequest;
    recorded.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const choice = body.tool_choice;
    if (typeof choice === 'object' && choice.function.name === 'submit_followups') {
      return reply({ content: null, tool_calls: [toolCall('submit_followups', { facts: ['做过 3 个校园小程序'], missing: [], questions: [] })] });
    }
    if (typeof choice === 'object' && choice.function.name === 'submit_brief') {
      return reply({
        content: null,
        tool_calls: [
          toolCall('submit_brief', {
            displayName: '阿柚',
            firstScreen: '名字与想找的队友',
            facts: [{ text: '做过 3 个校园小程序', source: 'interview' }],
            hooks: [
              { kind: 'can-help', text: '我能帮你写前端', opener: '你好，想聊聊前端' },
              { kind: 'looking-for', text: '找会设计的队友', opener: '我是做设计的' },
            ],
            aiView: ['你是阿柚，一个做小程序的前端。'],
            unknowns: [],
            profileSuggestions: [{ category: 'fact', text: '做过 3 个校园小程序' }],
          }),
        ],
      });
    }
    const turn = body.messages.filter((message) => message.role === 'assistant').length + 1;
    switch (turn) {
      case 1:
        return reply({
          content: '设计构想：借终端示例的结构。',
          tool_calls: [
            toolCall('write_page_file', { path: 'index.html', content: example('index.html') }),
            toolCall('write_page_file', { path: 'card.json', content: example('card.json') }),
            toolCall('write_page_file', { path: 'manifest.json', content: example('manifest.json') }),
          ],
        });
      case 2:
        return reply({ content: null, tool_calls: [toolCall('validate_page', {})] });
      case 3:
        return reply({ content: null, tool_calls: [toolCall('preview_page', {})] });
      default:
        return reply({ content: null, tool_calls: [toolCall('finish', { outcome: 'done', message: '做好了' })] });
    }
  }) as typeof fetch;
  return { fetch: fetchMock, recorded };
}

let t: TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('OpenAI 兼容服务走通托管路线', () => {
  it('DeepSeek 预设：采访与生成都走 /chat/completions，key 只在 Authorization 头里，不支持看图的模型收不到图片', async () => {
    const key = 'sk-deepseek-SECRET-0123456789';
    const server = createMockOpenAIServer();
    const previewer = createFakePreviewer();
    const env = { NOWME_MODEL_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: key };
    const web = createTestWeb({ env, secretEnv: { NOWME_AI_ENCRYPTION_KEY: 'ab'.repeat(32) }, modelLookup: async () => [{ address: '93.184.216.34', family: 4 }], modelFetch: server.fetch, previewer });
    t = web;
    expect(web.web.deps.hosted).not.toBeNull();
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId);
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');
    const settings = { provider: 'deepseek', baseUrl: '', model: '', apiKey: key, vision: false };
    web.web.deps.userModels.save(owner.session.userId, { interview: settings, generate: settings });
    await completeInterview(web, wall, owner);
    const job = (await generate(web as HostedTestWeb, wall, owner)).job;
    expect(job).toMatchObject({ status: 'succeeded', charged: false });
    const revision = web.repos.revisions.findById(job?.revisionId ?? '');
    expect(revision).toMatchObject({ source: 'hosted', status: 'accepted' });
    expect(job?.usage.cacheReadTokens).toBeGreaterThan(0);

    expect(server.recorded.length).toBeGreaterThanOrEqual(6);
    for (const request of server.recorded) {
      expect(request.url).toBe('https://api.deepseek.com/v1/chat/completions');
      expect(request.headers.authorization).toBe(`Bearer ${key}`);
      expect(request.body.model).toBe('deepseek-chat');
      expect(request.body.max_tokens).toBeLessThanOrEqual(8192);
      expect(JSON.stringify(request.body)).not.toContain(key);
      expect(JSON.stringify(request.body)).not.toContain('image_url'); // deepseek-chat 不看图：上传的照片与截图都换成文字
      expect(request.body.messages[0]?.role).toBe('system');
    }
    // 生成请求的 system 是固定的 Skill 内容（便于服务端前缀缓存），主人内容在用户消息里
    const generation = server.recorded.filter((request) => request.body.tool_choice === 'auto');
    expect(String(generation[0]?.body.messages[0]?.content)).toContain('nowme-page');
    expect(String(generation[0]?.body.messages[0]?.content)).not.toContain('你是阿柚，一个做小程序的前端。');
    expect(JSON.stringify(generation[0]?.body.messages[1])).toContain('你是阿柚，一个做小程序的前端。');
    expect(JSON.stringify(web.config)).not.toContain(key);
  });

  it('看图的服务（Gemini 预设）收到图片 data URL', async () => {
    const server = createMockOpenAIServer();
    const env = { NOWME_MODEL_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-key' };
    const web = createTestWeb({ env, secretEnv: { NOWME_AI_ENCRYPTION_KEY: 'ab'.repeat(32) }, modelLookup: async () => [{ address: '93.184.216.34', family: 4 }], modelFetch: server.fetch, previewer: createFakePreviewer() });
    t = web;
    const organizerId = createUser(web, 'org@example.com', '组织者');
    const { wall } = seedWall(web, organizerId);
    const owner = await joinAs(web, wall, 'a@example.com', '阿柚');
    const settings = { provider: 'gemini', baseUrl: '', model: '', apiKey: 'g-key', vision: true };
    web.web.deps.userModels.save(owner.session.userId, { interview: settings, generate: settings });
    await completeInterview(web, wall, owner);
    expect(server.recorded[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(JSON.stringify(server.recorded[0]?.body)).toContain('data:image/jpeg;base64,');
  });

  it('需要用户 Key 而没有：入口可见，不能调用', () => {
    const web = createTestWeb({ env: { NOWME_MODEL_PROVIDER: 'deepseek' }, secretEnv: {} });
    t = web;
    expect(web.web.deps.hosted).not.toBeNull();
    expect(web.web.deps.userModels.ready('missing-user')).toBe(false);
  });
});

describe('文字里的 JSON（不严格调用工具的服务）', () => {
  it('从文字或 ```json 代码块里取出 JSON；取不到时返回 undefined', async () => {
    const { jsonFromText } = await import('../src/hosted/interview.js');
    expect(jsonFromText([{ type: 'text', text: '好的：\n```json\n{"facts":["a"],"missing":[],"questions":[]}\n```' }])).toEqual({ facts: ['a'], missing: [], questions: [] });
    expect(jsonFromText([{ type: 'text', text: '{"a":1}' }])).toEqual({ a: 1 });
    expect(jsonFromText([{ type: 'text', text: '没有 JSON' }])).toBeUndefined();
    expect(jsonFromText([{ type: 'text', text: '{坏的}' }])).toBeUndefined();
  });
});
