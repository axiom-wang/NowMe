/**
 * 点数（contracts 12）测试共用：开启平台 AI 的测试主站（平台的模型用确定性的假模型，用户没有自己的 Key）、兑换码、余额。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeModel } from '../src/hosted/fake-model.js';
import { createRedeemCodes, userAccount, wallAccount } from '../src/services/billing.js';
import { createTestWeb, type TestSession, type TestWeb, type TestWebOptions } from './helpers.js';
import { createFakePreviewer, type HostedTestWeb } from './hosted-helpers.js';
import { post } from './publish-helpers.js';

/** 平台 AI 开启（deepseek 预设 + 假模型客户端）；没有 NOWME_MODEL_FAKE，所以用户都“没有自己的 Key”。 */
export function createPlatformTestWeb(options: TestWebOptions & { env?: Record<string, string> } = {}): HostedTestWeb {
  const fake = createFakeModel();
  const previewer = createFakePreviewer();
  const tempRoot = mkdtempSync(join(tmpdir(), 'nowme-billing-tmp-'));
  const t = createTestWeb({ ...options, env: { NOWME_PLATFORM_PROVIDER: 'deepseek', ...options.env }, platformModel: fake, previewer, hostedTempRoot: tempRoot });
  const close = t.close;
  return {
    ...t,
    fake,
    previewer,
    tempRoot,
    leftoverJobDirs: () => readdirSync(tempRoot),
    async close() {
      await close();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export function balanceOf(t: TestWeb, userId: string): number {
  return t.repos.credits.balanceOf(userAccount(userId));
}

export function wallBalanceOf(t: TestWeb, wallId: string): number {
  return t.repos.credits.balanceOf(wallAccount(wallId));
}

/** 生成一个兑换码并返回明文。 */
export function newCode(t: TestWeb, credits: number, options: { expiresAt?: string } = {}): string {
  return createRedeemCodes(t.web.deps, { count: 1, credits, expiresAt: options.expiresAt ?? null })[0] as string;
}

/** 走兑换表单给用户充点数。 */
export async function topUp(t: TestWeb, session: TestSession, credits: number): Promise<void> {
  const response = await post(t, session, '/account/credits/redeem', { code: newCode(t, credits) });
  if (response.status !== 303) throw new Error(`兑换失败：${response.status}`);
}
