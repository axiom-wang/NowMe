/**
 * 性能：~300 KB 的 index.html 校验 < 300 ms（T1.1 验收标准）。
 */
import { describe, expect, it } from 'vitest';
import { HTML_MAX_BYTES } from '@nowme/contracts';
import { KIT_FONTS, VALID_MANIFEST, makeSkeletonPage, run, text } from './fixtures.js';
import { computeExtraChars, validatePage } from '../src/index.js';

/** 混合了正文、内联样式、SVG、样式表与脚本的大页面，体积接近上限。 */
function bigPage(targetBytes: number): string {
  const sections: string[] = [];
  const styles: string[] = [];
  const scripts: string[] = [];
  let i = 0;
  const size = () => text(sections.join('') + styles.join('') + scripts.join('')).byteLength;
  while (size() < targetBytes - 4000) {
    sections.push(
      `<section class="card-${i}" style="color: #333; padding: ${i % 20}px; background: linear-gradient(90deg, #fff, #eee)">` +
        `<h2 style="font-family: var(--nm-font-lxgw-wenkai), serif">第 ${i} 段：做过的项目与想找的队友</h2>` +
        `<p>这是一段用来撑大页面的中文正文，包含一些标点符号，还有 English words 与数字 ${i}。</p>` +
        `<a href="#card-${i}">锚点</a><button data-nm-href="https://example.com/${i}" onclick="this.blur()">链接</button>` +
        `<svg viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="${(i % 4) + 1}" fill="url(#g)"/></svg></section>\n`,
    );
    styles.push(`.card-${i} { margin: ${i % 7}px; transition: opacity .2s; border-radius: 8px; } .card-${i}:hover { opacity: .9; }\n`);
    scripts.push(`function handler${i}(event) { const el = document.querySelector('.card-${i}'); if (!el) return; el.classList.toggle('on'); el.dataset.count = String(${i}); }\n`);
    i += 1;
  }
  return makeHtml(sections.join(''), styles.join(''), `${scripts.join('')}if (!nowme.reducedMotion) requestAnimationFrame(() => {});`);
}

function makeHtml(body: string, style: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>大页面</title><link rel="stylesheet" href="/_nowme/kit/v1/nowme.css"><style>${style}</style></head><body><section data-nm-id="hero">你好</section><section data-nm-id="projects">项目</section><section data-nm-id="teammate">队友</section>${body}<script src="/_nowme/kit/v1/nowme.js"></script><script>${script}</script></body></html>`;
}

describe('性能', () => {
  it('300 KB 的 index.html 在 300 ms 内校验完', () => {
    const source = bigPage(HTML_MAX_BYTES);
    const bytes = text(source);
    expect(bytes.byteLength).toBeGreaterThan(290 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(HTML_MAX_BYTES);
    const files = makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, fonts: [{ id: 'lxgw-wenkai', weights: [400] }], blocks: undefined } });
    files.set('index.html', bytes);

    // 预热一次（模块加载、JIT），再取多次中最快的一次
    validatePage(makeSkeletonPage(), { kitFonts: KIT_FONTS });
    const timings: number[] = [];
    let report = run(files);
    for (let round = 0; round < 3; round += 1) {
      const start = performance.now();
      report = validatePage(files, { kitFonts: KIT_FONTS });
      timings.push(performance.now() - start);
    }
    expect(report.errors).toEqual([]);
    expect(report.stats.indexHtmlBytes).toBe(bytes.byteLength);
    expect(Math.min(...timings)).toBeLessThan(300);
  });

  it('computeExtraChars 同样快', () => {
    const files = makeSkeletonPage();
    files.set('index.html', text(bigPage(HTML_MAX_BYTES)));
    computeExtraChars(files);
    const start = performance.now();
    computeExtraChars(files);
    expect(performance.now() - start).toBeLessThan(300);
  });

  it('远超上限的文件只报 HTML_TOO_LARGE，不做深入分析', () => {
    const files = makeSkeletonPage();
    files.set('index.html', text(`<!doctype html><p>${'a'.repeat(HTML_MAX_BYTES * 5)}</p>`));
    const start = performance.now();
    const report = run(files);
    expect(performance.now() - start).toBeLessThan(300);
    expect(report.errors.map((issue) => issue.code)).toEqual(['HTML_TOO_LARGE']);
  });
});
