/** 账号模型配置与 AES-256-GCM 凭证库。所有读取均绑定当前会话用户。 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { defaultModelEndpoint, isModelProvider, type ModelEndpointConfig } from '@nowme/contracts';
import type { Database } from '../db/index.js';
import { transaction } from '../db/index.js';
import { createModelFetch, validateModelUrl, type ModelLookup } from '../security/model-network.js';
import { createModelClient, type ModelClient } from './model-client.js';
import { ModelAccessError, modelFailureCode, modelFailureStatus } from './model-errors.js';

export type ModelRole = 'interview' | 'generate';
interface ModelRow { endpoint_json: string; encrypted_key: string | null; version: string; }
export interface UserModelSummary { endpoint: ModelEndpointConfig; hasKey: boolean; }
export interface UserModelsOptions {
  encryptionKey?: string;
  allowLocal: boolean;
  fetch?: typeof fetch;
  lookup?: ModelLookup;
  now: () => Date;
}
export interface UserModelInput { provider: string; baseUrl: string; model: string; apiKey: string; vision: boolean; }
export interface ResolvedModel { endpoint: ModelEndpointConfig; client: ModelClient; }

export function createUserModels(db: Database, options: UserModelsOptions) {
  if (options.encryptionKey && !/^[a-fA-F0-9]{64}$/.test(options.encryptionKey)) throw new Error('NOWME_AI_ENCRYPTION_KEY 必须是 64 位十六进制随机密钥');
  const key = options.encryptionKey ? Buffer.from(options.encryptionKey, 'hex') : null;
  const select = db.prepare('SELECT endpoint_json, encrypted_key, version FROM user_model_settings WHERE user_id = ? AND role = ?');
  const rowFor = (userId: string, role: ModelRole) => select.get(userId, role) as unknown as ModelRow | undefined;
  const aad = (userId: string, role: ModelRole, version: string, endpoint: string) => Buffer.from(JSON.stringify([userId, role, version, endpoint]));
  function decrypt(row: ModelRow, userId: string, role: ModelRole): string | null {
    if (!key) throw new ModelAccessError('MODEL_CONFIG');
    if (!row.encrypted_key) return null;
    try {
      const bytes = Buffer.from(row.encrypted_key, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(aad(userId, role, row.version, row.endpoint_json));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw new ModelAccessError('MODEL_CONFIG'); }
  }
  function summary(userId: string, role: ModelRole): UserModelSummary | null {
    const row = rowFor(userId, role);
    if (!row) return null;
    const endpoint = JSON.parse(row.endpoint_json) as ModelEndpointConfig;
    return { endpoint: { ...endpoint, ready: !!key && (!endpoint.apiKeyRequired || !!row.encrypted_key), hasApiKey: !!row.encrypted_key }, hasKey: !!row.encrypted_key };
  }
  function prepare(userId: string, role: ModelRole, input: UserModelInput) {
    if (!key || !isModelProvider(input.provider)) throw new ModelAccessError('MODEL_CONFIG');
    const endpoint = defaultModelEndpoint(input.provider, role);
    const rawUrl = input.baseUrl.trim() || endpoint.baseUrl || (endpoint.protocol === 'anthropic' ? 'https://api.anthropic.com' : '');
    endpoint.baseUrl = validateModelUrl(rawUrl, options.allowLocal).toString().replace(/\/+$/, '');
    endpoint.model = input.model.trim() || endpoint.model;
    if (!endpoint.model || !/^[A-Za-z0-9][A-Za-z0-9._\-:@/\[\]]{0,199}$/.test(endpoint.model)) throw new ModelAccessError('MODEL_CONFIG');
    endpoint.vision = input.vision;
    const previous = rowFor(userId, role);
    const previousEndpoint = previous ? JSON.parse(previous.endpoint_json) as ModelEndpointConfig : null;
    // 仅允许相同服务地址沿用旧 Key；切换服务必须重新填写，避免误发给另一家。
    const sameService = previousEndpoint?.provider === endpoint.provider && previousEndpoint.baseUrl === endpoint.baseUrl;
    const apiKey = input.apiKey.trim() || (previous && sameService ? decrypt(previous, userId, role) : null);
    if ((endpoint.apiKeyRequired && !apiKey) || (apiKey && (apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey)))) throw new ModelAccessError('MODEL_CONFIG');
    endpoint.ready = true;
    endpoint.hasApiKey = !!apiKey;
    const version = randomUUID();
    let encrypted: string | null = null;
    if (apiKey) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(userId, role, version, JSON.stringify(endpoint)));
      const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
      encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    }
    return { endpoint, encrypted, version };
  }
  const write = db.prepare(`INSERT INTO user_model_settings(user_id, role, endpoint_json, encrypted_key, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, role) DO UPDATE SET endpoint_json=excluded.endpoint_json, encrypted_key=excluded.encrypted_key, version=excluded.version, updated_at=excluded.updated_at`);
  return {
    available: !!key,
    summary,
    ready(userId: string) { return !!summary(userId, 'interview')?.endpoint.ready && !!summary(userId, 'generate')?.endpoint.ready; },
    save(userId: string, inputs: Record<ModelRole, UserModelInput>, shared = false) {
      transaction(db, () => {
        if (shared) {
          const previous = rowFor(userId, 'interview');
          const previousEndpoint = previous ? JSON.parse(previous.endpoint_json) as ModelEndpointConfig : null;
          const currentUrl = inputs.interview.baseUrl.trim() || defaultModelEndpoint(isModelProvider(inputs.interview.provider) ? inputs.interview.provider : 'anthropic').baseUrl || 'https://api.anthropic.com';
          const canReuse = previous && previousEndpoint?.provider === inputs.interview.provider && previousEndpoint.baseUrl === currentUrl.replace(/\/+$/, '');
          inputs = { ...inputs, generate: { ...inputs.interview, model: inputs.generate.model, apiKey: inputs.interview.apiKey.trim() || (canReuse ? decrypt(previous, userId, 'interview') ?? '' : '') } };
        }
        const prepared = (['interview', 'generate'] as const).map((role) => [role, prepare(userId, role, inputs[role])] as const);
        for (const [role, value] of prepared) write.run(userId, role, JSON.stringify(value.endpoint), value.encrypted, value.version, options.now().toISOString());
      });
    },
    delete(userId: string) { db.prepare('DELETE FROM user_model_settings WHERE user_id = ?').run(userId); },
    resolve(userId: string, role: ModelRole): ResolvedModel {
      const row = rowFor(userId, role);
      const metadata = summary(userId, role);
      if (!key || !row || !metadata?.endpoint.ready) throw new ModelAccessError('MODEL_CONFIG');
      const authorize = () => {
        if (rowFor(userId, role)?.version !== row.version) throw new ModelAccessError('MODEL_CONFIG');
      };
      const fetchImpl = createModelFetch({ allowLocal: options.allowLocal, lookup: options.lookup, transport: options.fetch, authorize });
      return {
        endpoint: metadata.endpoint,
        client: {
          async createMessage(params, callOptions) {
            // 每轮重新读取，删除、更换后已排队或进行中的旧任务不能继续用旧凭证。
            const current = rowFor(userId, role);
            if (!current || current.version !== row.version) throw new ModelAccessError('MODEL_CONFIG');
            const client = createModelClient(metadata.endpoint, decrypt(current, userId, role), { fetch: fetchImpl });
            if (!client) throw new ModelAccessError('MODEL_CONFIG');
            try { return await client.createMessage(params, callOptions); }
            catch (error) { throw new ModelAccessError(modelFailureCode(error) ?? 'MODEL_UNAVAILABLE', modelFailureStatus(error)); }
          },
        },
      };
    },
  };
}
export type UserModels = ReturnType<typeof createUserModels>;
