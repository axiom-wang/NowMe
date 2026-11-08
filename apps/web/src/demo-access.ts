/** 仅由演示启动器显式启用，并绑定独立数据目录。身份映射不接受客户端覆盖。 */
export interface DemoAccess { dataDir: string; }
export const DEMO_WALL_NAME = 'NOWMe 演示黑客松';
export const DEMO_ACCOUNTS = [
  { identity: 'member', email: 'newbie@demo.nowme.test', label: '以成员身份体验', description: '体验成员 · 浏览人物墙、接受采访、生成与修改页面，预览后由你确认发布。' },
  { identity: 'organizer', email: 'organizer@demo.nowme.test', label: '以组织者身份体验', description: '体验组织者 · 管理黑客松墙的成员和邀请；不能查看他人的草稿与采访资料。' },
] as const;
export function demoAccountFor(email: string) { return DEMO_ACCOUNTS.find((account) => account.email === email); }
export const DEMO_MODEL_READY = '演示模型已配置，无需填写 API Key。模型费用由演示提供者承担。';
export const DEMO_MODEL_MISSING = '演示模型尚未配置，请维护者补齐服务端模型配置与 NOWME_AI_ENCRYPTION_KEY 后重新启动演示；你仍可浏览墙或使用本地 Agent。';

/** 演示错误不要求评委编辑已锁定的配置，也不回显服务端响应。 */
export function demoModelError(code: string): string | null {
  switch (code) {
    case 'MODEL_CONFIG': return DEMO_MODEL_MISSING;
    case 'MODEL_AUTH': return '演示模型凭证或模型权限被服务商拒绝，请维护者检查配置后重试。';
    case 'MODEL_RATE_LIMITED': return '模型服务限流或演示账号余额不足，请稍后重试；若仍失败，请联系维护者。';
    case 'MODEL_UNAVAILABLE': return '暂时无法连接演示模型服务，请重试；若仍失败，请联系维护者。';
    case 'model-failed': return 'AI 未返回有效结果，请重试；若仍失败，请维护者检查模型兼容性。';
    default: return null;
  }
}
