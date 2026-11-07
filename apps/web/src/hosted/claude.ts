/**
 * Claude API 的最小接口（hosted-route D1、D8）。采访与托管生成只依赖这里的类型：
 * - 真实实现 `createAnthropicClaude(apiKey)`：`@anthropic-ai/sdk` 的 Messages API；
 * - 假实现见 fake-claude.ts（`NOWME_CLAUDE_FAKE=1`，测试与 e2e）。
 *
 * API key 只在进程入口从环境变量读出后传给 `createAnthropicClaude`，不进入配置对象、提示词、工具结果、日志或数据库（S8）。
 */
import Anthropic from '@anthropic-ai/sdk';

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

export type ClaudeMessage = { role: 'user'; content: string | UserContent[] } | { role: 'assistant'; content: AssistantContent[] };

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
  messages: ClaudeMessage[];
  tools?: ToolDefinition[];
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface ClaudeResponse {
  content: AssistantContent[];
  stop_reason: string | null;
  usage: ClaudeUsage;
}

export interface ClaudeClient {
  createMessage(params: CreateMessageParams, options?: { signal?: AbortSignal }): Promise<ClaudeResponse>;
}

/** 真实客户端。重试与超时交给 SDK（每次请求 5 分钟，最多重试 2 次）。 */
export function createAnthropicClaude(apiKey: string): ClaudeClient {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
  return {
    async createMessage(params, options) {
      const response = await client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      );
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

export function addUsage(total: UsageTotals, usage: ClaudeUsage): void {
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
