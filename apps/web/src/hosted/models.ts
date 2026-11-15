/**
 * 模型服务的组装：主站与 worker 进程共用（contracts 12、13）。
 *
 * - 用户自带的模型配置（AES-256-GCM 凭证库，只读 `NOWME_AI_ENCRYPTION_KEY`）；
 * - 平台 AI（Key 只来自 `NOWME_PLATFORM_API_KEY`，S10）；
 * - 非生产环境的假模型（`NOWME_MODEL_FAKE=1` 或测试注入）。
 */
import type { HostedConfig } from '@nowme/contracts';
import type { WebConfig } from '../context.js';
import type { Database } from '../db/index.js';
import type { GenerationJob } from '../db/hosted.js';
import type { ModelLookup } from '../security/model-network.js';
import { createFakeModel } from './fake-model.js';
import type { ModelClient } from './model-client.js';
import { ModelAccessError } from './model-errors.js';
import { createPlatformModel, type PlatformModel } from './platform-model.js';
import { createUserModels, type ModelRole, type ResolvedModel, type UserModels } from './user-models.js';

export interface ModelServicesOptions {
  config: Pick<WebConfig, 'isProduction' | 'hosted' | 'billing'>;
  db: Database;
  now: () => Date;
  log: (message: string) => void;
  /** 只读取 NOWME_AI_ENCRYPTION_KEY、NOWME_AI_ALLOW_LOCAL、NOWME_PLATFORM_API_KEY。 */
  secretEnv?: Readonly<Record<string, string | undefined>>;
  /** 非生产环境假模型注入（`NOWME_MODEL_FAKE=1` 时使用）。 */
  model?: ModelClient;
  /** 非生产环境：把这个客户端当作平台 AI 的模型。 */
  platformModel?: ModelClient;
  modelFetch?: typeof fetch;
  modelLookup?: ModelLookup;
}

export interface ModelServices {
  userModels: UserModels;
  platformModel: PlatformModel;
  /** 假模型（只在非生产环境、`NOWME_MODEL_FAKE=1` 时存在）。 */
  fake: ModelClient | null;
}

export function createModelServices(options: ModelServicesOptions): ModelServices {
  const { config } = options;
  if (config.isProduction && (config.hosted.fake || options.model)) throw new Error('生产环境不能注入测试模型');
  const allowLocal = !config.isProduction && options.secretEnv?.NOWME_AI_ALLOW_LOCAL === '1';
  const userModels = createUserModels(options.db, {
    encryptionKey: options.secretEnv?.NOWME_AI_ENCRYPTION_KEY,
    allowLocal,
    fetch: options.modelFetch,
    lookup: options.modelLookup,
    now: options.now,
  });
  // 平台 AI（contracts 12）：没有配置时不可用，只有自带 Key 的用户能用 AI
  const platformModel = createPlatformModel({
    config: config.billing.platform,
    apiKey: options.secretEnv?.NOWME_PLATFORM_API_KEY,
    allowLocal,
    fetch: options.modelFetch,
    lookup: options.modelLookup,
    client: config.isProduction ? undefined : options.platformModel,
    log: options.log,
  });
  const fake = config.hosted.fake ? (options.model ?? createFakeModel()) : null;
  return { userModels, platformModel, fake };
}

export function fakeResolved(fake: ModelClient, settings: HostedConfig, role: ModelRole): ResolvedModel {
  return { client: fake, endpoint: { ...settings[role], ready: true } };
}

/** worker 取生成 / 修改任务的模型：按入队时记下的来源与配置版本（`model_source` / `model_version`）。 */
export function createJobModelResolver(services: ModelServices, settings: HostedConfig): (job: GenerationJob) => ResolvedModel {
  return (job) => {
    if (services.fake) return fakeResolved(services.fake, settings, 'generate');
    if (job.modelSource === 'own') return services.userModels.resolve(job.ownerId, 'generate', job.modelVersion);
    if (job.modelSource === 'platform') return services.platformModel.resolve('generate');
    throw new ModelAccessError('MODEL_CONFIG');
  };
}
