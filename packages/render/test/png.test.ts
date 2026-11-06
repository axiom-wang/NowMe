/**
 * 封面压缩：超过 600 KB 的截图用纯 JS 量化压缩到上限以内，尺寸不变，并通过校验器的 COVER 检查。
 */
import { describe, expect, it } from 'vitest';
import UPNG from 'upng-js';
import { COVER_HEIGHT, COVER_MAX_BYTES, COVER_WIDTH } from '@nowme/contracts';
import { compressPng, coverIssues, pngSize } from '../src/index.js';

/** 750×1000 的彩色噪点图（几乎无法无损压缩，远超 600 KB）。 */
function noisyCover(): Uint8Array {
  const rgba = new Uint8Array(COVER_WIDTH * COVER_HEIGHT * 4);
  let seed = 0x9e3779b9;
  for (let index = 0; index < rgba.length; index += 4) {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    rgba[index] = seed & 0xff;
    rgba[index + 1] = (seed >>> 8) & 0xff;
    rgba[index + 2] = (seed >>> 16) & 0xff;
    rgba[index + 3] = 255;
  }
  return new Uint8Array(UPNG.encode([rgba.buffer], COVER_WIDTH, COVER_HEIGHT, 0));
}

describe('compressPng', () => {
  it('不超过上限时原样返回', () => {
    const small = new Uint8Array(UPNG.encode([new Uint8Array(COVER_WIDTH * COVER_HEIGHT * 4).fill(255).buffer], COVER_WIDTH, COVER_HEIGHT, 0));
    const result = compressPng(small, COVER_MAX_BYTES);
    expect(result.png).toBe(small);
    expect(result.colors).toBeNull();
  });

  it('超过 600 KB 的截图量化到上限以内：750×1000、通过 COVER 检查', () => {
    const noisy = noisyCover();
    expect(noisy.byteLength).toBeGreaterThan(COVER_MAX_BYTES);
    expect(coverIssues(noisy).map((issue) => issue.message).join()).toContain('超过上限');
    const result = compressPng(noisy, COVER_MAX_BYTES);
    expect(result.png.byteLength).toBeLessThanOrEqual(COVER_MAX_BYTES);
    expect(result.colors).not.toBeNull();
    expect(pngSize(result.png)).toEqual({ width: COVER_WIDTH, height: COVER_HEIGHT });
    expect(coverIssues(result.png)).toEqual([]);
  }, 30_000);

  it('pngSize 读 IHDR；不是 PNG 返回 null', () => {
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
