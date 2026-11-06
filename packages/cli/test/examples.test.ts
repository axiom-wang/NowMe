/**
 * 6 个 Skill 示例：nowme validate 0 错误、没有 FONT_NOT_IN_KIT；预览渲染 0 个 RENDER_* 问题、封面合规。
 * 预览用例需要 Kit 字体源文件（`pnpm --filter @nowme/kit fonts:fetch`），缺失时跳过并说明原因。
 * 这里不写任何文件（validate 带 --no-fix，预览直接调用 buildRevision）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Manifest } from '@nowme/contracts';
import { KIT_FONTS_DIR, kitFontSourcePath, loadKitFonts } from '@nowme/kit';
import { buildRevision, coverIssues, createRenderer, type Renderer } from '@nowme/render';
import { readPageDir } from '@nowme/validator/node';
import { run, type ValidateOutput } from '../src/index.js';
import { EXAMPLES_DIR, capture } from './helpers.js';

const kitFonts = loadKitFonts();
const examples = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();

function fontsDownloaded(dir: string): boolean {
  const manifest = JSON.parse(readFileSync(join(EXAMPLES_DIR, dir, 'manifest.json'), 'utf8')) as Manifest;
  return manifest.fonts.every((declared) => {
    const font = kitFonts.find((item) => item.id === declared.id);
    return font !== undefined && declared.weights.every((weight) => existsSync(kitFontSourcePath(font, weight, KIT_FONTS_DIR) ?? ''));
  });
}

it('一共 6 个示例', () => {
  expect(examples).toHaveLength(6);
});

describe.each(examples)('示例 %s', (dir) => {
  it('nowme validate：0 个错误，没有 FONT_NOT_IN_KIT，只有 DESIGN.md 的 IGNORED_FILE 警告', async () => {
    const io = capture();
    const code = await run(['validate', join(EXAMPLES_DIR, dir), '--json', '--no-fix'], io.io, { env: {} });
    const output = JSON.parse(io.stdout()) as ValidateOutput;
    expect(output.report.errors).toEqual([]);
    expect(code).toBe(0);
    expect(output.report.warnings.map((issue) => `${issue.code} ${issue.file}`)).toEqual(['IGNORED_FILE DESIGN.md']);
    expect(output.report.stats.scriptOnlyChars).toBe('');
  });
});

describe('示例预览（需要 Kit 字体）', () => {
  let renderer: Renderer;
  beforeAll(async () => {
    renderer = await createRenderer();
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
  });

  for (const dir of examples) {
    const reason = fontsDownloaded(dir) ? '' : '（跳过：Kit 字体源文件未下载，先运行 pnpm --filter @nowme/kit fonts:fetch）';
    it.skipIf(reason !== '')(`${dir}：0 个 RENDER_* 问题，封面 750×1000 ≤ 600 KB，字体子集齐全${reason}`, async () => {
      const files = await readPageDir(join(EXAMPLES_DIR, dir));
      files.delete('cover.png');
      const result = await buildRevision({ files, kitFonts, mode: 'preview', renderer, blockScreenshots: false });
      const renderIssues = [...result.report.errors, ...result.report.warnings].filter((issue) => issue.code.startsWith('RENDER_'));
      expect(renderIssues).toEqual([]);
      expect(result.report.ok).toBe(true);
      expect(result.missingFontSources).toEqual([]);
      expect(result.fonts.length).toBeGreaterThan(0);
      for (const font of result.fonts) expect(font.unsupportedChars, `${font.fontId} ${font.weight}`).toBe('');
      expect(result.coverGenerated).toBe(true);
      expect(coverIssues(result.cover as Uint8Array)).toEqual([]);
      expect(result.renderedText.length).toBeGreaterThan(50);
    }, 90_000);
  }
});
