/**
 * 平台 AI（contracts 12）：没有自己模型 Key 的用户用平台的模型服务。
 *
 * - API key 只来自环境变量 `NOWME_PLATFORM_API_KEY`：不入库、不进提示词与工具结果、不写日志、不在任何页面显示（S10）。
 * - 与用户自带的服务走同一套出站保护：只允许公网 HTTPS、逐次解析 DNS 并固定连接地址、拒绝重定向。
 * - 模型服务出错时，用户只看到“暂时用不了”（`MODEL_UNAVAILABLE`）：真实的错误类别（凭证被拒、限流……）是运营要处理的事，
 *   只写进服务端日志，不让用户去检查一个他看不到的配置。
 */
import type { BillingConfig, ModelEndpointConfig } from '@nowme/contracts';
import { createModelFetch, validateModelUrl, type ModelLookup } from '../security/model-network.js';
import { createModelClient, type ModelClient } from './model-client.js';
import { ModelAccessError, modelFailureCode, modelFailureStatus } from './model-errors.js';
import type { ModelRole, ResolvedModel } from './user-models.js';

export interface PlatformModel {
  /** 平台 AI 能不能用（配置了模型服务并且有 key）。 */
  readonly available: boolean;
  /** 取平台的模型客户端。不可用时抛 `ModelAccessError('MODEL_CONFIG')`。 */
  resolve(role: ModelRole): ResolvedModel;
}

export interface PlatformModelOptions {
  config: BillingConfig['platform'];
  /** `NOWME_PLATFORM_API_KEY`。 */
  apiKey: string | undefined;
  allowLocal: boolean;
  fetch?: typeof fetch;
  lookup?: ModelLookup;
  /** 测试注入：直接用这个客户端当作平台的模型（不需要 key）。 */
  client?: ModelClient;
  log: (message: string) => void;
}

export function createPlatformModel(options: PlatformModelOptions): PlatformModel {
  const { config, log } = options;
  const apiKey = options.apiKey?.trim() || null;
  if (apiKey && (apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey))) throw new Error('NOWME_PLATFORM_API_KEY 格式不对');
  if (!config) return { available: false, resolve: () => { throw new ModelAccessError('MODEL_CONFIG'); } };

  const clients = new Map<ModelRole, ModelClient | null>();
  const build = (role: ModelRole, endpoint: ModelEndpointConfig): ModelClient | null => {
    if (options.client) return options.client;
    // 地址必须是公网 HTTPS（开发环境可显式允许本机）；不合法时在启动阶段就报出来
    if (endpoint.baseUrl) {
      try {
        validateModelUrl(endpoint.baseUrl, options.allowLocal);
      } catch {
        throw new Error(`平台 AI 的服务地址不可用（NOWME_PLATFORM_BASE_URL 必须是公网 HTTPS 地址）：${role}`);
      }
    }
    return createModelClient(endpoint, apiKey, { fetch: createModelFetch({ allowLocal: options.allowLocal, lookup: options.lookup, transport: options.fetch }) });
  };
  for (const role of ['interview', 'generate'] as const) clients.set(role, build(role, config[role]));
  const available = [...clients.values()].every((client) => client !== null);

  return {
    available,
    resolve(role) {
      const inner = clients.get(role);
      if (!inner) throw new ModelAccessError('MODEL_CONFIG');
      return {
        endpoint: config[role],
        client: {
          async createMessage(params, callOptions) {
            try {
              return await inner.createMessage(params, callOptions);
            } catch (error) {
              if (callOptions?.signal?.aborted) throw error;
              log(`[web] 平台 AI 调用失败（${role}）：${modelFailureCode(error) ?? 'UNKNOWN'}${modelFailureStatus(error) ? `，HTTP ${modelFailureStatus(error)}` : ''}`);
              throw new ModelAccessError('MODEL_UNAVAILABLE', modelFailureStatus(error));
            }
          },
        },
      };
    },
  };
}
