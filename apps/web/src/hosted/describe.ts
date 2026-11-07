/** 启动日志与 demo 说明里显示托管路线用的模型服务（不含 key）。 */
import type { HostedConfig } from '@nowme/contracts';

export function describeHostedModels(settings: HostedConfig): string {
  if (settings.fake) return '假模型客户端，生成的是简单的测试页';
  return '用户账号配置的模型服务';
}

/** 隐私说明里写“发给谁”：两个角色用同一家服务时只写一次。 */
export function hostedProviderLabels(settings: HostedConfig): string {
  if (settings.fake) return '测试用的假模型';
  const labels = [settings.interview.label, settings.generate.label];
  return [...new Set(labels)].join('、');
}
