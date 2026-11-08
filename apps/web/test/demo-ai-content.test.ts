import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { loadKitFonts } from '@nowme/kit';
import { validatePage } from '@nowme/validator';
import { buildDemoProfile, DEMO_EXTRA_WALLS } from '../scripts/demo-content.js';
import { DEMO_AI_PUBLISHED_INDICES } from '../scripts/demo-ai/index.js';

const plan = DEMO_EXTRA_WALLS[0]!;

describe('AI 共创的独立人物作品页', () => {
  it.each(DEMO_AI_PUBLISHED_INDICES)('人物 %i 保留原始事实与接话点，遵守页面与字体契约', (index) => {
    const profile = plan.profiles[index]!;
    const output = buildDemoProfile(plan, index);
    const files = new Map(Object.entries(output.files).map(([path, content]) => [path, Buffer.from(content, 'base64')]));
    const report = validatePage(files, { kitFonts: loadKitFonts() });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    const html = files.get('index.html')!.toString();
    // Text nodes, rather than source substrings, permit typographic markup and escaped punctuation.
    const textOf = (node: ReturnType<typeof parse>): string => {
      const visit = (item: unknown): string => {
        const value = item as { nodeName: string; value?: string; childNodes?: unknown[] };
        return value.nodeName === '#text' ? value.value ?? '' : (value.childNodes ?? []).map(visit).join('');
      };
      return visit(node);
    };
    const text = textOf(parse(html));
    for (const fact of [profile.name, profile.role, profile.headline, profile.about, profile.work, profile.offering, profile.looking]) {
      expect(text).toContain(fact);
    }
    const card = JSON.parse(files.get('card.json')!.toString());
    expect(card.displayName).toBe(profile.name);
    expect(card.hooks.map((hook: { text: string }) => hook.text)).toEqual([profile.offering, profile.looking]);
    expect(report.stats.blocks.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(files.get('manifest.json')!.toString()).blocks).toEqual(report.stats.blocks);
  });

  it('不再复用同一份 DOM 结构和区块顺序', () => {
    const structures = DEMO_AI_PUBLISHED_INDICES.map((index) => {
      const html = Buffer.from(buildDemoProfile(plan, index).files['index.html']!, 'base64').toString();
      const node = parse(html);
      const visit = (item: unknown): string => {
        const value = item as { nodeName: string; childNodes?: unknown[] };
        if (['#text', 'style', 'head'].includes(value.nodeName)) return '';
        return `${value.nodeName}(${(value.childNodes ?? []).map(visit).join('')})`;
      };
      return visit(node);
    });
    expect(new Set(structures).size).toBe(6);
  });

  it('未创建者不能从旧通用模板生成一个虚假页面', () => {
    for (const index of [0, 7, 8, 9]) expect(() => buildDemoProfile(plan, index)).toThrow('尚未创建页面');
  });
});
