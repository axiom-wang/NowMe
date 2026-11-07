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
    expect(active.n).toBe(5 + 3);
    const revisions = t.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE status = 'accepted'").get() as { n: number };
    expect(revisions.n).toBe(6 + 3);
    expect(seed.newcomer.instruction.command).toContain('/nowme-page');
    expect(seed.inviteUrl).toContain('/join/');
  });

  it('社团墙：同一位组织者，3 名成员各发布一页（复用账号），新同学也已加入', async () => {
    t = createTestWeb();
    const seed = await seedDemo(t.web);
    expect(seed.club.wall.sceneType).toBe('club');
    expect(seed.club.wall.organizerId).toBe(seed.organizer.userId);
    expect(seed.club.members.map((m) => m.exampleDir)).toEqual(['club-newbie-sticker', 'club-senior-quest', 'interest-film-zine']);
    expect(seed.club.members.every((m) => m.published)).toBe(true);
    for (const member of seed.club.members) expect(seed.members.some((m) => m.userId === member.userId)).toBe(true);
    const clubActive = t.db
      .prepare('SELECT COUNT(*) AS n FROM publications pb JOIN pages p ON p.id = pb.page_id WHERE p.wall_id = ? AND pb.ended_at IS NULL')
      .get(seed.club.wall.id) as { n: number };
    expect(clubActive.n).toBe(3);
    expect(t.repos.memberships.findByWallAndUser(seed.club.wall.id, seed.newcomer.userId)?.status).toBe('active');
    expect(seed.club.inviteUrl).toContain('/join/');
  });
});
