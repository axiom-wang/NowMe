/**
 * 直接改文字 + 真实渲染（contracts 22.2）：新版本照常经过渲染，封面由平台重新截图，渲染文字里是新名字，
 * 新加的字进入字体子集。Kit 字体源文件缺失时跳过。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { manifestSchema } from '@nowme/contracts';
import { hasKitFontSource } from '@nowme/kit';
import { pngSize } from '@nowme/render';
import { EXAMPLES_DIR } from '@nowme/skill';
import { createRenderProcessor } from '../src/services/processor.js';
import { revisionDir } from '../src/services/revision-storage.js';
import { KIT_FONTS } from './helpers.js';
import { newRevisionId, postTextEdit, segmentIndex, textEditScenario, type TextEditScenario } from './text-edit-helpers.js';

const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(EXAMPLES_DIR, 'hackathon-terminal', 'manifest.json'), 'utf8')));
const fontsAvailable = manifest.fonts.every(({ id, weights }) => {
  const font = KIT_FONTS.find((item) => item.id === id);
  return font !== undefined && weights.every((weight) => hasKitFontSource(font, weight));
});

describe.skipIf(!fontsAvailable)('直接改文字：真实渲染', () => {
  let s: TextEditScenario | undefined;
  afterAll(async () => {
    await s?.t.close();
  });

  it('新名字出现在渲染文字里，封面重新生成，字体子集变化', { timeout: 120_000 }, async () => {
    s = await textEditScenario({ processor: createRenderProcessor() });
    const { t, owner, wall, base } = s;
    const response = await postTextEdit(t, owner, wall.id, { revisionId: base.id, [`t_${segmentIndex('林舟')}`]: '林洲鑫' });
    expect(response.status).toBe(303);
    const revision = t.repos.revisions.findById(newRevisionId(response)!)!;
    expect(revision.renderedText).toContain('林洲鑫');
    const dir = revisionDir(t.dataDir, revision.id);
    expect(pngSize(readFileSync(join(dir, 'cover.png')))).toEqual({ width: 750, height: 1000 });
    expect((JSON.parse(revision.renderJson ?? '{}') as { coverGenerated?: boolean }).coverGenerated).toBe(true);
    const font = `served/_fonts/${manifest.fonts[0]!.id}-${manifest.fonts[0]!.weights[0]}.woff2`;
    expect(readFileSync(join(dir, font)).equals(readFileSync(join(revisionDir(t.dataDir, base.id), font)))).toBe(false);
  });
});
