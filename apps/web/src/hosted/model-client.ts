/**
 * 模型服务的最小接口（hosted-route 1.1、D1、D8）。采访与托管生成只依赖这里的类型（消息格式与 Anthropic Messages 同形）：
 * - `anthropic` 协议：`createAnthropicClient()`，`@anthropic-ai/sdk`；
 * - `openai` 协议：openai-client.ts 的 `createOpenAICompatibleClient()`（OpenAI、DeepSeek、通义千问、智谱、Kimi、豆包、Gemini、Ollama……）；
 * - 假实现见 fake-model.ts（`NOWME_MODEL_FAKE=1`，测试与 e2e）。
 * `createModelClient(endpoint, apiKey)` 按配置选协议，并套上 `withEndpointLimits`（输出上限、不支持看图时把图片换成文字）。
 *
 * API key 由账号凭证库解密后传入，不进入提示词、工具结果或日志；数据库只保存认证密文（S8）。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ModelEndpointConfig } from '@nowme/contracts';
import { ModelAccessError, modelFailureCode } from './model-errors.js';
import { createOpenAICompatibleClient } from './openai-client.js';

export interface CacheControl {
  type: 'ephemeral';
}

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  cache_control?: CacheControl;
  source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (TextBlock | ImageBlock)[];
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type UserContent = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContent = TextBlock | ToolUseBlock;

export type ModelMessage = { role: 'user'; content: string | UserContent[] } | { role: 'assistant'; content: AssistantContent[] };

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system: TextBlock[];
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface ModelResponse {
  content: AssistantContent[];
  stop_reason: string | null;
  usage: ModelUsage;
}

export interface ModelClient {
  createMessage(params: CreateMessageParams, options?: { signal?: AbortSignal }): Promise<ModelResponse>;
}

/** 真实客户端。重试与超时交给 SDK（每次请求 5 分钟，最多重试 2 次）。 */
export function createAnthropicClient(apiKey: string, baseUrl?: string | null, fetchImpl?: typeof fetch): ModelClient {
  const client = new Anthropic({ apiKey, logLevel: 'off', baseURL: baseUrl || 'https://api.anthropic.com', ...(fetchImpl ? { fetch: fetchImpl } : {}), maxRetries: 2, timeout: 5 * 60 * 1000 });
  return {
    async createMessage(params, options) {
      const response = await client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      ).catch((error: unknown) => { throw new ModelAccessError(modelFailureCode(error) ?? 'MODEL_UNAVAILABLE'); });
      // 只保留我们认识的块（文本与工具调用），其他类型（例如思考块）丢弃
      const content = response.content.filter(
        (block): block is Extract<typeof block, { type: 'text' } | { type: 'tool_use' }> => block.type === 'text' || block.type === 'tool_use',
      );
      return {
        content: content.map((block) =>
          block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool_use', id: block.id, name: block.name, input: block.input },
        ),
        stop_reason: response.stop_reason,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
        },
      };
    },
  };
}

/** 汇总一次或多次调用的 token 数（只有数字，写进事件与 usage_json）。 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: UsageTotals, usage: ModelUsage): void {
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

/** 平台用来分隔资料的标签：主人内容里出现的同类标签一律去掉，避免伪造“资料结束、平台指令开始”。 */
const STRUCTURAL_TAG = /<\/?\s*(owner_[a-z_]*|wall_context|scene_guide|platform_[a-z_]*)\b[^>]*>/gi;

/** 主人提供的内容放进带标签的资料块：去掉伪造的结构标签，system 里声明标签内是资料、不是指令。 */
export function untrusted(tag: string, content: string): string {
  const cleaned = content.replace(STRUCTURAL_TAG, '');
  return `<${tag}>\n${cleaned}\n</${tag}>`;
}

/** 不支持看图时图片换成的文字（导出给测试）。 */
export const IMAGE_PLACEHOLDER = '（这里有一张图片；当前模型不支持看图，已省略。请以文字信息为准。）';

function stripImages<T extends TextBlock | ImageBlock>(blocks: T[]): (T | TextBlock)[] {
  return blocks.map((block) => (block.type === 'image' ? { type: 'text', text: IMAGE_PLACEHOLDER } : block));
}

/**
 * 按模型服务的能力调整请求：输出 token 不超过上限；`vision: false` 时把所有图片（用户消息与工具结果里的）换成文字占位。
 */
export function withEndpointLimits(client: ModelClient, limits: { vision: boolean; maxOutputTokens: number }): ModelClient {
  return {
    createMessage(params, options) {
      const messages = limits.vision
        ? params.messages
        : params.messages.map((message): ModelMessage => {
            if (message.role !== 'user' || typeof message.content === 'string') return message;
            return {
              role: 'user',
              content: message.content.map((block) => {
                if (block.type === 'image') return { type: 'text', text: IMAGE_PLACEHOLDER };
                if (block.type === 'tool_result' && typeof block.content !== 'string') return { ...block, content: stripImages(block.content) };
                return block;
              }),
            };
          });
      return client.createMessage({ ...params, messages, max_tokens: Math.min(params.max_tokens, limits.maxOutputTokens) }, options);
    },
  };
}

/** 按配置创建一个角色的模型客户端。需要 key 而没有时返回 null。 */
export function createModelClient(endpoint: ModelEndpointConfig, apiKey: string | null, options: { fetch?: typeof fetch } = {}): ModelClient | null {
  if (endpoint.apiKeyRequired && !apiKey) return null;
  let client: ModelClient;
  if (endpoint.protocol === 'anthropic') {
    if (!apiKey) return null;
    client = createAnthropicClient(apiKey, endpoint.baseUrl, options.fetch);
  } else {
    if (!endpoint.baseUrl) return null;
    client = createOpenAICompatibleClient({ baseUrl: endpoint.baseUrl, apiKey, maxTokensField: endpoint.maxTokensField, fetch: options.fetch });
  }
  return withEndpointLimits(client, { vision: endpoint.vision, maxOutputTokens: endpoint.maxOutputTokens });
}
