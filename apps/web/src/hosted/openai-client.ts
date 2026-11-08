/**
 * OpenAI 兼容的 Chat Completions 客户端（hosted-route 1.1）：OpenAI、DeepSeek、通义千问、智谱、Kimi、豆包、Gemini（兼容端点）、
 * OpenRouter、硅基流动、Ollama 等。用 `fetch` 直接调用 `POST <baseUrl>/chat/completions`，不引入额外 SDK。
 *
 * 采访与生成内部统一使用 model-client.ts 的消息格式（与 Anthropic Messages 同形），这里负责双向转换：
 * - system 块 → 一条 `system` 消息（`cache_control` 去掉；这些服务大多按前缀自动缓存，固定内容放在最前面即可命中）；
 * - 用户消息里的 `tool_result` → `tool` 消息；工具结果里的图片 → 紧随其后的一条 `user` 消息（`tool` 消息只能放文字）；
 * - 图片 → `image_url`（data URL）；
 * - assistant 的 `tool_use` ↔ `tool_calls`；`tool_choice` 映射到 auto / required / 指定函数；
 * - 用量：`prompt_tokens` 中命中缓存的部分（`prompt_tokens_details.cached_tokens` 或 DeepSeek 的 `prompt_cache_hit_tokens`）记为 cacheRead。
 *
 * API key 只放在 `Authorization` 头里，不进 URL、不进请求体、不进错误信息（S8）。
 */
import { ModelAccessError } from './model-errors.js';
import type {
  AssistantContent,
  CreateMessageParams,
  ImageBlock,
  ModelClient,
  ModelMessage,
  ModelResponse,
  TextBlock,
  ToolResultBlock,
} from './model-client.js';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    prompt_cache_hit_tokens?: number;
  };
}

export interface OpenAICompatibleOptions {
  /** API 根地址，例如 `https://api.deepseek.com/v1`（不含 `/chat/completions`）。 */
  baseUrl: string;
  /** null：不发 Authorization 头（本地 Ollama 等）。 */
  apiKey: string | null;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** 测试注入。 */
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
  /** 重试前的等待（毫秒），测试可设为 0。 */
  retryDelayMs?: number;
}

export class ModelApiError extends Error {
  override name = 'ModelApiError';
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

function imageUrl(block: ImageBlock): ContentPart {
  return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
}

function toolResultText(block: ToolResultBlock): string {
  const text = typeof block.content === 'string' ? block.content : block.content.filter((item): item is TextBlock => item.type === 'text').map((item) => item.text).join('\n');
  return block.is_error ? `错误：${text}` : text;
}

/** 内部格式 → Chat Completions 请求（导出给测试）。 */
export function toChatRequest(params: CreateMessageParams, maxTokensField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  const system = params.system.map((block) => block.text).join('\n\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const message of params.messages) {
    messages.push(...convertMessage(message));
  }

  const request: ChatCompletionRequest = { model: params.model, messages, [maxTokensField]: params.max_tokens };
  if (params.tools && params.tools.length > 0) {
    request.tools = params.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    const choice = params.tool_choice;
    request.tool_choice = !choice || choice.type === 'auto' ? 'auto' : choice.type === 'any' ? 'required' : { type: 'function', function: { name: choice.name } };
  }
  return request;
}

function convertMessage(message: ModelMessage): ChatMessage[] {
  if (message.role === 'assistant') {
    const text = message.content.filter((block): block is TextBlock => block.type === 'text').map((block) => block.text).join('\n');
    const calls = message.content.filter((block) => block.type === 'tool_use');
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0
          ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) }
          : {}),
      },
    ];
  }
  if (typeof message.content === 'string') return [{ role: 'user', content: message.content }];

  const out: ChatMessage[] = [];
  const trailing: ContentPart[] = [];
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block) || '（空）' });
      if (typeof block.content !== 'string') {
        const images = block.content.filter((item): item is ImageBlock => item.type === 'image');
        if (images.length > 0) {
          trailing.push({ type: 'text', text: `（上面工具返回的 ${images.length} 张截图，顺序同工具结果里的说明）` });
          for (const image of images) trailing.push(imageUrl(image));
        }
      }
    } else if (block.type === 'text') {
      trailing.push({ type: 'text', text: block.text });
    } else {
      trailing.push(imageUrl(block));
    }
  }
  if (trailing.length > 0) {
    const onlyText = trailing.every((part) => part.type === 'text');
    out.push({ role: 'user', content: onlyText ? trailing.map((part) => (part as { text: string }).text).join('\n\n') : trailing });
  }
  return out;
}

const FINISH_REASONS: Record<string, string> = { tool_calls: 'tool_use', function_call: 'tool_use', stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };

let callCounter = 0;

/** Chat Completions 响应 → 内部格式（导出给测试）。 */
export function fromChatResponse(body: ChatCompletionResponse): ModelResponse {
  const choice = body.choices?.[0];
  if (!choice?.message) throw new ModelApiError(null, '模型服务返回的内容格式不对（没有 choices）');
  const content: AssistantContent[] = [];
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    if (!call.function?.name) continue;
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      // 参数不是合法 JSON：交给工具报“缺少参数”，模型下一轮可以改正
      input = { _invalidArguments: true };
    }
    callCounter += 1;
    content.push({ type: 'tool_use', id: call.id || `call_${Date.now()}_${callCounter}`, name: call.function.name, input });
  }
  const prompt = body.usage?.prompt_tokens ?? 0;
  const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? body.usage?.prompt_cache_hit_tokens ?? 0;
  const hasCalls = content.some((block) => block.type === 'tool_use');
  return {
    content,
    stop_reason: hasCalls ? 'tool_use' : (FINISH_REASONS[choice.finish_reason ?? ''] ?? choice.finish_reason ?? null),
    usage: {
      input_tokens: Math.max(0, prompt - cached),
      output_tokens: body.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function createOpenAICompatibleClient(options: OpenAICompatibleOptions): ModelClient {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  return {
    async createMessage(params, callOptions) {
      const body = JSON.stringify(toChatRequest(params, options.maxTokensField));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      let lastError: ModelApiError = new ModelApiError(null, '模型服务请求失败');
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (attempt > 0 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
        const signals = [AbortSignal.timeout(timeoutMs), ...(callOptions?.signal ? [callOptions.signal] : [])];
        let response: Response;
        try {
          response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.any(signals), redirect: 'manual' });
        } catch (error) {
          if (callOptions?.signal?.aborted) throw new ModelApiError(null, '请求已取消');
          // 地址、DNS 校验失败等配置问题不重试；连接中断、DNS 超时等临时网络错误按普通失败重试。
          if (error instanceof ModelAccessError && error.code !== 'MODEL_UNAVAILABLE') throw error;
          lastError = new ModelApiError(null, '连不上模型服务');
          continue;
        }
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ModelApiError(response.status, '模型服务地址不允许跳转'); }
        if (response.ok) return fromChatResponse((await response.json()) as ChatCompletionResponse);
        // 错误信息不回显响应体（可能含请求内容）；只记状态码
        lastError = new ModelApiError(response.status, `模型服务返回 ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
        if (!RETRY_STATUS.has(response.status)) break;
      }
      throw lastError;
    },
  };
}
