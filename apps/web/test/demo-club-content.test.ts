import { describe, expect, it } from 'vitest';
import { loadKitFonts } from '@nowme/kit';
import { validatePage } from '@nowme/validator';
import { buildDemoClubProfile, DEMO_CLUB_ADDITIONS } from '../scripts/demo-club.js';

describe('山海摄影社新增人物页', () => {
  it.each([0, 1])('人物 %i 的内容、接话点与页面契约正确', (index) => {
    const output = buildDemoClubProfile(index);
    const files = new Map(Object.entries(output.files).map(([path, text]) => [path, Buffer.from(text, 'base64')]));
    const report = validatePage(files, { kitFonts: loadKitFonts() });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    const card = JSON.parse(files.get('card.json')!.toString());
    expect(card.displayName).toBe(DEMO_CLUB_ADDITIONS[index]!.name);
    expect(card.hooks).toEqual(DEMO_CLUB_ADDITIONS[index]!.hooks);
    expect(JSON.parse(files.get('manifest.json')!.toString()).blocks).toEqual(report.stats.blocks);
    const html = files.get('index.html')!.toString();
    expect(html).toContain('插画示意');
    if (index === 0) {
      expect(html).toContain('22 岁，数字媒体专业大四学生');
      expect(html).toContain('用手机拍街道上的光影');
      expect(html).not.toMatch(/<img|手机号|@demo/);
    }
  });
});
