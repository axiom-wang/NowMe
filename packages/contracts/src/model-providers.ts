/**
 * 平台托管路线可接入的模型服务（contracts 9 / hosted-route 1.1）。
 *
 * 两种接口协议覆盖市面上绝大多数服务：
 * - `anthropic`：Anthropic Messages API（Claude）；
 * - `openai`：OpenAI 兼容的 Chat Completions（`POST <baseUrl>/chat/completions`，function calling + 图片 data URL）。
 *   OpenAI、DeepSeek、通义千问（DashScope 兼容模式）、智谱 GLM、Kimi（Moonshot）、豆包（火山方舟）、Gemini（OpenAI 兼容端点）、
 *   OpenRouter、硅基流动、本地 Ollama 等都提供这种接口；其他兼容服务用 `openai-compatible` 并自己填 baseUrl。
 *
 * 预设里的默认模型只是起点，不确定或因账号而异的（例如方舟的接入点 ID、OpenRouter 的模型名）不给默认值，必须配置。
 * API key 不在这里：只从用户账号的加密凭证库读取。
 */

export type ModelProtocol = 'anthropic' | 'openai';

export const MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'deepseek',
  'qwen',
  'zhipu',
  'moonshot',
  'doubao',
  'gemini',
  'openrouter',
  'siliconflow',
  'ollama',
  'openai-compatible',
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelProviderPreset {
  label: string;
  protocol: ModelProtocol;
  /** OpenAI 兼容服务的 API 根地址（含 `/v1` 之类的版本段，不含 `/chat/completions`）；null 表示必须由用户填写。Anthropic 为 null 表示用 SDK 默认地址。 */
  baseUrl: string | null;
  /** 默认的采访模型 / 生成模型；null 表示必须配置。 */
  interviewModel: string | null;
  generateModel: string | null;
  /** 默认是否把图片（上传的照片、预览截图）交给模型。不支持看图的模型收到的是文字占位。 */
  vision: boolean;
  /** 单次回复的输出 token 上限（不同服务上限不同）。 */
  maxOutputTokens: number;
  /** OpenAI 新模型用 `max_completion_tokens`，其他兼容服务用 `max_tokens`。 */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
}

export const MODEL_PROVIDER_PRESETS: Record<ModelProvider, ModelProviderPreset> = {
  anthropic: {
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: null,
    interviewModel: 'claude-haiku-5-5',
    generateModel: 'claude-sonnet-5-5',
    vision: true,
    maxOutputTokens: 32000,
    maxTokensField: 'max_tokens',
  },
  openai: {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    interviewModel: 'gpt-5-mini',
    generateModel: 'gpt-5',
    vision: true,
    maxOutputTokens: 32000,
    maxTokensField: 'max_completion_tokens',
  },
  deepseek: {
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    interviewModel: 'deepseek-chat',
    generateModel: 'deepseek-chat',
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
  qwen: {
    label: '通义千问（阿里云百炼）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    interviewModel: 'qwen-plus',
    generateModel: 'qwen-max',
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
  zhipu: {
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    interviewModel: 'glm-4.5-air',
    generateModel: 'glm-4.5',
    vision: false,
    maxOutputTokens: 16384,
    maxTokensField: 'max_tokens',
  },
  moonshot: {
    label: 'Kimi（月之暗面）',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    interviewModel: null,
    generateModel: null,
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
  doubao: {
    label: '豆包（火山方舟）',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    // 方舟的“模型”通常是你账号下的接入点 ID（ep-...）或模型名，必须配置
    interviewModel: null,
    generateModel: null,
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
  gemini: {
    label: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    interviewModel: 'gemini-2.5-flash',
    generateModel: 'gemini-2.5-pro',
    vision: true,
    maxOutputTokens: 32000,
    maxTokensField: 'max_tokens',
  },
  openrouter: {
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    interviewModel: null,
    generateModel: null,
    vision: false,
    maxOutputTokens: 16384,
    maxTokensField: 'max_tokens',
  },
  siliconflow: {
    label: '硅基流动',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    interviewModel: null,
    generateModel: null,
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
  ollama: {
    label: 'Ollama（本机）',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    interviewModel: null,
    generateModel: null,
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
  'openai-compatible': {
    label: 'OpenAI 兼容服务',
    protocol: 'openai',
    baseUrl: null,
    interviewModel: null,
    generateModel: null,
    vision: false,
    maxOutputTokens: 8192,
    maxTokensField: 'max_tokens',
  },
};

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}
