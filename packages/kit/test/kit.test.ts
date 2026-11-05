import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIT_BASE_PATH, KIT_STATIC_DIR, KIT_VERSION, loadKitFonts } from '../src/index.js';

describe('@nowme/kit（占位）', () => {
  it('静态文件目录包含 nowme.css 与 nowme.js', () => {
    expect(existsSync(join(KIT_STATIC_DIR, 'nowme.css'))).toBe(true);
    expect(existsSync(join(KIT_STATIC_DIR, 'nowme.js'))).toBe(true);
  });

  it('fonts.json 通过 kitFontsFileSchema', () => {
    expect(Array.isArray(loadKitFonts())).toBe(true);
  });

  it('Kit 版本与路径来自 contracts', () => {
    expect(KIT_VERSION).toBe('1');
    expect(KIT_BASE_PATH).toBe('/_nowme/kit/v1/');
  });
});
