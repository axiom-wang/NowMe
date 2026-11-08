/** 演示启动专用：将维护者的配置写入体验成员账号，普通启动不读取这些变量。 */
import { defaultModelEndpoint, isModelProvider } from '@nowme/contracts';
import type { WebApp } from '../src/app.js';
import { DEMO_ACCOUNTS } from '../src/demo-access.js';
import type { ModelRole, UserModelInput } from '../src/hosted/user-models.js';

export function provisionDemoModels(web: WebApp, env: Readonly<Record<string, string | undefined>>): boolean {
  if (!web.deps.demo) throw new Error('模型预置只能由演示启动流程执行');
  const configured = Object.entries(env).some(([name, value]) => /^NOWME_DEMO_(?:(?:INTERVIEW|GENERATE)_)?(?:PROVIDER|BASE_URL|MODEL|API_KEY|VISION)$/.test(name) && !!value);
  if (!configured) return false;
  if (!web.deps.userModels.available) throw new Error('请维护者配置 NOWME_AI_ENCRYPTION_KEY 后重新启动演示');
  const read = (role: ModelRole): UserModelInput => {
    const prefix = `NOWME_DEMO_${role.toUpperCase()}_`;
    const value = (suffix: string) => env[`${prefix}${suffix}`] ?? env[`NOWME_DEMO_${suffix}`];
    const provider = value('PROVIDER') ?? '';
    if (!isModelProvider(provider)) throw new Error('请维护者补齐演示模型服务商配置');
    const changedService = (env[`${prefix}PROVIDER`] && env[`${prefix}PROVIDER`] !== env.NOWME_DEMO_PROVIDER)
      || (env[`${prefix}BASE_URL`] && env[`${prefix}BASE_URL`] !== env.NOWME_DEMO_BASE_URL);
    if (changedService && !env[`${prefix}API_KEY`]) throw new Error('独立服务需要独立 Key');
    const model = value('MODEL') ?? '';
    const apiKey = value('API_KEY') ?? '';
    if (!model.trim() || !apiKey.trim()) throw new Error('请维护者补齐演示模型名称与 API Key');
    const vision = value('VISION');
    if (vision !== undefined && vision !== '0' && vision !== '1') throw new Error('演示模型 VISION 只能是 0 或 1');
    return { provider, baseUrl: value('BASE_URL') ?? '', model, apiKey, vision: vision === undefined ? defaultModelEndpoint(provider, role).vision : vision === '1' };
  };
  try {
    const user = web.deps.repos.users.findByEmail(DEMO_ACCOUNTS[0].email);
    if (!user) throw new Error();
    web.deps.userModels.save(user.id, { interview: read('interview'), generate: read('generate') });
    return web.deps.userModels.ready(user.id);
  } catch { throw new Error('演示模型预置失败，请维护者检查服务商、模型、Key 和公网 HTTPS 地址；配置内容不会输出。'); }
}
