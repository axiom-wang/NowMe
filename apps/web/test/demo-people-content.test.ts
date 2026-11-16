/** demo-people/ 里真实生成后保存的人物页：仍然通过页面契约校验，卡片与页面内容对得上人。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardSchema } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { validatePage } from '@nowme/validator';
import { DEMO_CLUB_PLANS, DEMO_MEMBER_PLANS, DEMO_PEOPLE_DIR } from '../scripts/demo-seed.js';

const PEOPLE: Record<string, { name: string; wall: string }> = {
  'hack-chengye': { name: '程野', wall: 'NOWMe 演示黑客松' },
  'hack-fangtang': { name: '方棠', wall: 'NOWMe 演示黑客松' },
  'hack-zhuyiyi': { name: '祝一一', wall: '' },
  'club-hechuan': { name: '贺川', wall: '山海摄影社' },
  'club-maidong': { name: '麦冬', wall: '山海摄影社' },
};

describe('演示人物页（demo-people）', () => {
  it('目录与种子计划一一对应', () => {
    const planned = [...DEMO_MEMBER_PLANS, ...DEMO_CLUB_PLANS].filter((plan) => plan.people).map((plan) => plan.dir).sort();
    const dirs = readdirSync(DEMO_PEOPLE_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(dirs).toEqual(planned);
    expect(dirs).toEqual(Object.keys(PEOPLE).sort());
  });

  it.each(Object.entries(PEOPLE))('%s 通过校验，卡片有 2–3 个接话点，页面里没有联系方式', (dir, person) => {
    const root = join(DEMO_PEOPLE_DIR, dir);
    const files = new Map(readdirSync(root).map((name) => [name, readFileSync(join(root, name))]));
    expect([...files.keys()].sort()).toEqual(['card.json', 'index.html', 'manifest.json']);
    const report = validatePage(files, { kitFonts: loadKitFonts() });
    expect(report.errors).toEqual([]);
    const card = cardSchema.parse(JSON.parse(files.get('card.json')!.toString()));
    expect(card.displayName).toBe(person.name);
    expect(card.hooks.length).toBeGreaterThanOrEqual(2);
    const html = files.get('index.html')!.toString();
    expect(html).toContain(person.name);
    expect(html).toContain(person.wall);
    expect(html).not.toMatch(/@demo\.nowme|微信号|手机号|https?:\/\/(?!www\.w3\.org)/);
  });
});
