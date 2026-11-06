import { describe, expect, it } from 'vitest';
import {
  cardSchema,
  countCjkFontFaces,
  HTML_MAX_BYTES,
  MAX_CJK_FONTS,
  manifestSchema,
  NM_ID_MIN_COUNT,
  NM_ID_PATTERN,
  SCENE_TYPES,
  type Card,
  type Manifest,
} from '@nowme/contracts';
import { kitFileFromUrl, loadKitFonts } from '@nowme/kit';
import { listExampleDirs, loadExamplesIndex, loadSceneGuide, SKILL_VERSION } from '../src/index.js';
import {
  attribute,
  cjkSet,
  dataAttributeText,
  inlineScripts,
  kitFontsUsed,
  readExample,
  startTags,
  staticText,
  styles,
} from './helpers/pages.js';

const index = loadExamplesIndex();
const kitFonts = loadKitFonts();
const dirs = index.examples.map((item) => item.dir);

describe('examples/index.json', () => {
  it('与 examples/ 下的目录一一对应', () => {
    expect([...dirs].sort()).toEqual(listExampleDirs());
  });

  it('6 个示例：黑客松、兴趣社群、社团招新各 2 个', () => {
    expect(index.schemaVersion).toBe(1);
    expect(index.examples).toHaveLength(6);
    for (const type of ['hackathon', 'interest', 'club'] as const) {
      expect(index.examples.filter((item) => item.sceneType === type)).toHaveLength(2);
    }
    for (const item of index.examples) {
      expect(SCENE_TYPES).toContain(item.sceneType);
      expect(item.style.length).toBeGreaterThan(10);
      expect(item.persona.length).toBeGreaterThan(5);
    }
  });

  it('风格描述彼此不同，主题与字体组合也不同（不是只换配色）', () => {
    expect(new Set(index.examples.map((item) => item.style)).size).toBe(6);
    const themes = dirs.map((dir) => /class="([^"]*nm-theme-[a-z]+[^"]*)"/.exec(readExample(dir).html)?.[1] ?? '');
    expect(new Set(themes).size).toBe(6);
    const fontSets = dirs.map((dir) => ((readExample(dir).manifest as Manifest).fonts.map((font) => font.id).sort().join('+')));
    expect(new Set(fontSets).size).toBe(6);
  });

  it('三档动效都有示例', () => {
    expect(new Set(index.examples.map((item) => item.motionLevel))).toEqual(new Set(['calm', 'medium', 'lively']));
  });
});

describe.each(dirs)('示例 %s', (dir) => {
  const page = readExample(dir);
  const entry = index.examples.find((item) => item.dir === dir);
  const card = page.card as Card;
  const manifest = page.manifest as Manifest;

  it('是完整的 page/ 目录：index.html、card.json、manifest.json、DESIGN.md，没有 cover.png', () => {
    for (const file of ['index.html', 'card.json', 'manifest.json', 'DESIGN.md']) expect(page.files).toContain(file);
    expect(page.files).not.toContain('cover.png');
    for (const file of page.files) {
      expect(['index.html', 'card.json', 'manifest.json', 'DESIGN.md'].includes(file) || file.startsWith('assets/'), file).toBe(true);
    }
  });

  it('card.json 通过 cardSchema，接话点类型取自场景指南', () => {
    const result = cardSchema.safeParse(page.card);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    const kinds = new Set(loadSceneGuide(manifest.sceneType).hookKinds.map((item) => item.kind));
    for (const hook of card.hooks) expect(kinds.has(hook.kind ?? ''), hook.kind).toBe(true);
  });

  it('manifest.json 通过 manifestSchema，场景与动效与 index.json、<html data-nm-motion> 一致', () => {
    const result = manifestSchema.safeParse(page.manifest);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(manifest.sceneType).toBe(entry?.sceneType);
    expect(manifest.motionLevel).toBe(entry?.motionLevel);
    expect(page.html).toContain(`data-nm-motion="${manifest.motionLevel}"`);
    expect(manifest.generator?.['skillVersion']).toBe(SKILL_VERSION);
  });

  it('manifest 中的字体都在 Kit fonts.json 里（id 与字重），中文字体字重合计 ≤ 2', () => {
    for (const declared of manifest.fonts) {
      const font = kitFonts.find((item) => item.id === declared.id);
      expect(font, declared.id).toBeDefined();
      for (const weight of declared.weights) expect(font?.weights, `${declared.id} ${weight}`).toContain(weight);
    }
    expect(countCjkFontFaces(manifest.fonts, kitFonts)).toBeLessThanOrEqual(MAX_CJK_FONTS);
  });

  it('页面用到的 Kit 字体与 manifest.fonts 声明完全一致；不写 @font-face', () => {
    expect(kitFontsUsed(page.html, kitFonts).sort()).toEqual(manifest.fonts.map((font) => font.id).sort());
    expect(page.html).not.toMatch(/@font-face/i);
  });

  it('页面里写出的 font-weight 都是已声明的字重', () => {
    const declared = new Set(manifest.fonts.flatMap((font) => font.weights));
    for (const match of styles(page.html).matchAll(/(?:font-weight|--nm-display-weight)\s*:\s*(\d{3})/g)) {
      expect(declared.has(Number(match[1])), `font-weight ${match[1]}`).toBe(true);
    }
  });

  it('只以 /_nowme/kit/v1/ 引用 Kit 中真实存在的文件，并且 CSS 与 JS 都引用了', () => {
    const refs = [...page.html.matchAll(/["'(](\/_nowme\/[^"')\s]*)/g)].map((match) => match[1] ?? '');
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) expect(kitFileFromUrl(ref), ref).not.toBeNull();
    expect(page.html).toContain('<link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">');
    expect(page.html).toContain('<script src="/_nowme/kit/v1/nowme.js"></script>');
  });

  it('满足 index.html 基本要求：doctype、charset、viewport、lang="zh-CN"、≤ 300 KB', () => {
    expect(page.html.startsWith('<!doctype html>')).toBe(true);
    expect(page.html).toMatch(/<meta charset="utf-8">/i);
    expect(page.html).toMatch(/<meta name="viewport" content="width=device-width/);
    expect(page.html).toMatch(/<html lang="zh-CN"/);
    expect(page.htmlBytes).toBeLessThanOrEqual(HTML_MAX_BYTES);
  });

  it(`至少 ${NM_ID_MIN_COUNT} 个合法且唯一的 data-nm-id，manifest.blocks 与之一致`, () => {
    const ids = startTags(page.html)
      .map((tag) => attribute(tag.raw, 'data-nm-id'))
      .filter((id): id is string => id !== null);
    expect(ids.length).toBeGreaterThanOrEqual(NM_ID_MIN_COUNT);
    for (const id of ids) expect(NM_ID_PATTERN.test(id), id).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(manifest.blocks).toEqual(ids);
  });

  it('脚本里的中文、脚本会读出来显示的 data 属性里的中文，都在静态文本或 extraChars 中', () => {
    const covered = new Set([...cjkSet(staticText(page.html)), ...cjkSet(manifest.extraChars)]);
    const scriptChars = cjkSet(inlineScripts(page.html).join('\n'));
    const dataChars = cjkSet(dataAttributeText(page.html));
    const missing = [...scriptChars, ...dataChars].filter((char) => !covered.has(char));
    expect(missing.join('')).toBe('');
  });

  it('脚本动效检查减少动效（requestAnimationFrame / .animate( 必须伴随 nowme.reducedMotion）', () => {
    for (const script of inlineScripts(page.html)) {
      if (/requestAnimationFrame|\.animate\(/.test(script)) expect(script).toMatch(/nowme\.reducedMotion|prefers-reduced-motion/);
    }
  });

  it('DESIGN.md 写了感觉、核心视觉、区块安排、用到的 Kit，并声明人物是虚构的', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const design = readFileSync(join(page.path, 'DESIGN.md'), 'utf8');
    for (const heading of ['想给人的感觉', '核心视觉', '区块安排', '用到的 Kit']) expect(design).toContain(heading);
    expect(design).toMatch(/虚构/);
    for (const id of manifest.blocks ?? []) expect(design, id).toContain(`\`${id}\``);
  });
});
