/** 演示种子（pnpm demo）：走真实提交管线（假渲染器，真实校验），5 张已发布、1 张已提交未发布。 */
import { afterEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../scripts/demo-seed.js';
import { createTestWeb, type TestWeb } from './helpers.js';

let t: TestWeb;
afterEach(async () => {
  await t.close();
});

describe('demo 种子', () => {
  it('组织者 + 6 名成员 + 新同学；5 人已发布，1 人只提交；联系方式有公开有不公开', async () => {
    t = createTestWeb();
    const seed = await seedDemo(t.web);
    expect(seed.members).toHaveLength(6);
    expect(seed.members.filter((m) => m.published)).toHaveLength(5);
    expect(seed.members.some((m) => m.published && !m.contactPublic)).toBe(true);
    expect(seed.members.some((m) => m.published && m.contactPublic)).toBe(true);
    const active = t.db.prepare('SELECT COUNT(*) AS n FROM publications WHERE ended_at IS NULL').get() as { n: number };
    expect(active.n).toBe(5);
    const revisions = t.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE status = 'accepted'").get() as { n: number };
    expect(revisions.n).toBe(6);
    expect(seed.newcomer.instruction.command).toContain('/nowme-page');
    expect(seed.inviteUrl).toContain('/join/');
  });
});
