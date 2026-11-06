/**
 * contracts 2.2 的每一个错误码：至少一个触发用例 + 一个相近但合法、不应误报的用例。
 * `satisfies Record<StaticCode, …>` 保证新增错误码时这里必须补用例。
 * 安全相关的码在 test/security/ 下还有更细的用例。
 */
import { VALIDATION_ISSUE_CODES, type PageFiles, type ValidationIssueCode } from '@nowme/contracts';
import { describe, expect, it } from 'vitest';
import {
  VALID_CARD,
  VALID_MANIFEST,
  codes,
  jpeg,
  makePage,
  makeSkeletonPage,
  png,
  run,
  skeleton,
  summary,
  text,
} from './fixtures.js';

type StaticCode = {
  [K in ValidationIssueCode]: (typeof VALIDATION_ISSUE_CODES)[K]['stage'] extends 'static' ? K : never;
}[ValidationIssueCode];

interface Case {
  trigger: () => PageFiles;
  /** 相近但合法：不应出现该码，且整页没有 error。 */
  clean: () => PageFiles;
}

const withHtml = (html: string, extra: Parameters<typeof makeSkeletonPage>[1] = {}): PageFiles => {
  const files = makeSkeletonPage({}, extra);
  files.set('index.html', text(html));
  return files;
};

const padTo = (bytes: number) => {
  const base = skeleton({ body: '<p id="pad"></p>' });
  const filler = 'a'.repeat(bytes - text(base).length);
  return skeleton({ body: `<p id="pad">${filler}</p>` });
};

const pngOfSize = (bytes: number) => {
  const out = new Uint8Array(bytes);
  out.set(png(1, 1));
  return out;
};

const manyAssets = (count: number) => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i += 1) files[`assets/p${i}.png`] = png(1, 1);
  return files;
};
const manyImgs = (count: number) => Array.from({ length: count }, (_, i) => `<img src="assets/p${i}.png" alt="">`).join('');

const CASES = {
  MISSING_FILE: {
    trigger: () => makePage({ files: { 'card.json': null } }),
    clean: () => makePage(),
  },
  HTML_TOO_LARGE: {
    trigger: () => withHtml(padTo(300 * 1024 + 1)),
    clean: () => withHtml(padTo(300 * 1024)),
  },
  HTML_MISSING_VIEWPORT: {
    trigger: () => withHtml(skeleton().replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="viewport" content="initial-scale=1">')),
    clean: () => withHtml(skeleton().replace('content="width=device-width, initial-scale=1"', 'content="initial-scale=1, WIDTH = device-width"')),
  },
  HTML_MISSING_CHARSET: {
    trigger: () => withHtml(skeleton().replace('<meta charset="utf-8">', '')),
    clean: () => withHtml(skeleton().replace('<meta charset="utf-8">', '<meta charset="UTF-8">')),
  },
  HTML_MISSING_DOCTYPE: {
    trigger: () => withHtml(skeleton().replace('<!doctype html>', '')),
    clean: () => withHtml(skeleton().replace('<!doctype html>', '<!-- 注释 -->\n<!DOCTYPE HTML>')),
  },
  HTML_MISSING_LANG: {
    trigger: () => withHtml(skeleton().replace('<html lang="zh-CN">', '<html>')),
    clean: () => withHtml(skeleton().replace('<html lang="zh-CN">', '<html lang="en">')),
  },
  EXTERNAL_RESOURCE: {
    trigger: () => makeSkeletonPage({ body: '<img src="https://cdn.example.com/a.png" alt="">' }),
    clean: () => makeSkeletonPage({ body: '<img src="./assets/a.png" alt=""><p>https://cdn.example.com/a.png</p>' }, { files: { 'assets/a.png': png(1, 1) } }),
  },
  FORBIDDEN_LINK_HREF: {
    trigger: () => makeSkeletonPage({ body: '<a href="https://github.com/ayou">GitHub</a>' }),
    clean: () => makeSkeletonPage({ body: '<a href="#hero">回到顶部</a><a data-nm-href="https://github.com/ayou">GitHub</a>' }),
  },
  INSECURE_OPEN_LINK: {
    trigger: () => makeSkeletonPage({ body: '<button data-nm-href="http://github.com/ayou">GitHub</button>' }),
    clean: () => makeSkeletonPage({ body: '<button data-nm-href="https://github.com/ayou">GitHub</button>', script: "nowme.openLink('https://ayou.dev');" }),
  },
  EXTERNAL_URL_IN_SCRIPT: {
    trigger: () => makeSkeletonPage({ script: "const api = 'https://api.example.com/v1';" }),
    clean: () => makeSkeletonPage({ script: "// https://api.example.com\nnowme.openLink('https://ayou.dev');\ndocument.createElementNS('http://www.w3.org/2000/svg', 'svg');" }),
  },
  FORBIDDEN_ELEMENT: {
    trigger: () => makeSkeletonPage({ body: '<form><button>提交</button></form>' }),
    clean: () => makeSkeletonPage({ body: '<!-- <form></form> --><div class="form">&lt;form&gt;</div>' }),
  },
  FORBIDDEN_API: {
    trigger: () => makeSkeletonPage({ script: "localStorage.setItem('seen', '1');" }),
    clean: () => makeSkeletonPage({ script: "// localStorage.setItem('seen', '1')\nconst store = { fetch() {} }; store.fetch(); const tip = 'fetch(';" }),
  },
  JS_SYNTAX_ERROR: {
    trigger: () => makeSkeletonPage({ script: 'const = ;' }),
    clean: () => makeSkeletonPage({ body: '<script type="application/json">{ not: js, ]</script><script type="x-shader/x-fragment">void main() {}</script>', script: 'const ok = 1;' }),
  },
  NM_ID_TOO_FEW: {
    trigger: () => withHtml(skeleton().replace('<section data-nm-id="teammate">', '<section>')),
    clean: () => withHtml(skeleton().replace('<section data-nm-id="teammate">', '<section data-nm-id="teammate-2">')),
  },
  NM_ID_INVALID: {
    trigger: () => makeSkeletonPage({ body: '<div data-nm-id="About_Me">x</div>' }),
    clean: () => makeSkeletonPage({ body: '<div data-nm-id="about-me-2">x</div>' }),
  },
  NM_ID_DUPLICATE: {
    trigger: () => makeSkeletonPage({ body: '<div data-nm-id="hero">x</div>' }),
    clean: () => makeSkeletonPage({ body: '<div data-nm-id="hero-2">x</div>' }),
  },
  NM_BLOCKS_MISMATCH: {
    trigger: () => makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, fonts: [], blocks: ['hero', 'about'] } }),
    clean: () => makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, fonts: [], blocks: ['teammate', 'hero', 'projects'] } }),
  },
  MOTION_WITHOUT_REDUCED: {
    trigger: () => makeSkeletonPage({ kitCss: false, style: '.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(1turn); } }' }),
    clean: () =>
      makeSkeletonPage({
        kitCss: false,
        style: '.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(1turn); } } @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }',
      }),
  },
  FONT_FACE_FORBIDDEN: {
    trigger: () => makeSkeletonPage({ style: "@font-face { font-family: 'Mine'; src: url(assets/mine.woff2); }" }),
    clean: () =>
      makeSkeletonPage(
        { style: '/* @font-face 不允许 */ body { font-family: var(--nm-font-lxgw-wenkai), sans-serif; }' },
        { manifest: { ...VALID_MANIFEST, fonts: [{ id: 'lxgw-wenkai', weights: [400] }], blocks: undefined } },
      ),
  },
  FONT_UNDECLARED: {
    trigger: () => makeSkeletonPage({ style: 'h1 { font-family: "LXGW WenKai", serif; }' }),
    clean: () =>
      makeSkeletonPage(
        { style: 'h1 { font-family: "LXGW WenKai", serif; }' },
        { manifest: { ...VALID_MANIFEST, fonts: [{ id: 'lxgw-wenkai', weights: [400] }], blocks: undefined } },
      ),
  },
  FONT_NOT_IN_KIT: {
    trigger: () => makeSkeletonPage({ style: 'body { font-family: "Comic Sans MS", cursive; }' }),
    clean: () => makeSkeletonPage({ style: 'body { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }' }),
  },
  FONT_TOO_MANY_CJK: {
    trigger: () =>
      makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, blocks: undefined, fonts: [{ id: 'lxgw-wenkai', weights: [400, 700] }, { id: 'noto-serif-sc', weights: [900] }] } }),
    clean: () =>
      makeSkeletonPage(
        {},
        {
          manifest: {
            ...VALID_MANIFEST,
            blocks: undefined,
            fonts: [
              { id: 'lxgw-wenkai', weights: [400] },
              { id: 'noto-serif-sc', weights: [700] },
              { id: 'inter', weights: [400, 700] },
            ],
          },
        },
      ),
  },
  FONT_UNKNOWN: {
    trigger: () => makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, blocks: undefined, fonts: [{ id: 'inter', weights: [900] }] } }),
    clean: () => makeSkeletonPage({}, { manifest: { ...VALID_MANIFEST, blocks: undefined, fonts: [{ id: 'inter', weights: [400, 700] }] } }),
  },
  EXTRA_CHARS_MISSING: {
    trigger: () => makeSkeletonPage({ script: "document.title = '欢迎光临';" }, { rawManifest: true }),
    clean: () => makeSkeletonPage({ script: "document.title = '欢迎光临';" }),
  },
  CARD_INVALID: {
    trigger: () => makePage({ card: { ...VALID_CARD, hooks: VALID_CARD.hooks.slice(0, 1) } }),
    clean: () => makePage({ card: { ...VALID_CARD, hooks: [...VALID_CARD.hooks, { id: 'third', text: '第三个接话点', opener: '你好呀' }] } }),
  },
  MANIFEST_INVALID: {
    trigger: () => makePage({ manifest: { ...VALID_MANIFEST, sceneType: 'party' } }),
    clean: () => makePage({ manifest: { ...VALID_MANIFEST, sceneType: 'club', motionLevel: 'calm' } }),
  },
  COVER_INVALID: {
    trigger: () => makePage({ files: { 'cover.png': png(375, 500) } }),
    clean: () => makePage({ files: { 'cover.png': png(750, 1000) } }),
  },
  ASSET_TYPE_FORBIDDEN: {
    trigger: () => makeSkeletonPage({ body: '<img src="assets/fake.png" alt="">' }, { files: { 'assets/fake.png': '<script>alert(1)</script>' } }),
    clean: () => makeSkeletonPage({ body: '<img src="assets/real.png" alt=""><img src="assets/photo.jpeg" alt="">' }, { files: { 'assets/real.png': png(1, 1), 'assets/photo.jpeg': jpeg() } }),
  },
  ASSET_TOO_LARGE: {
    trigger: () => makeSkeletonPage({ body: '<img src="assets/big.png" alt="">' }, { files: { 'assets/big.png': pngOfSize(2 * 1024 * 1024 + 1) } }),
    clean: () => makeSkeletonPage({ body: '<img src="assets/big.png" alt="">' }, { files: { 'assets/big.png': pngOfSize(2 * 1024 * 1024) } }),
  },
  ASSETS_TOO_MANY: {
    trigger: () => makeSkeletonPage({ body: manyImgs(21) }, { files: manyAssets(21) }),
    clean: () => makeSkeletonPage({ body: manyImgs(20) }, { files: manyAssets(20) }),
  },
  ASSET_NAME_INVALID: {
    trigger: () => makeSkeletonPage({ body: '<img src="assets/My%20Photo.png" alt="">' }, { files: { 'assets/My Photo.png': png(1, 1) } }),
    clean: () => makeSkeletonPage({ body: '<img src="assets/team/my-photo_2.v1.png" alt="">' }, { files: { 'assets/team/my-photo_2.v1.png': png(1, 1) } }),
  },
  ASSET_MISSING: {
    trigger: () => makeSkeletonPage({ body: '<img src="assets/nope.png" alt="">' }),
    clean: () => makeSkeletonPage({ body: '<img src="assets/yes.png" alt="">' }, { files: { 'assets/yes.png': png(1, 1) } }),
  },
  ASSET_UNUSED: {
    trigger: () => makeSkeletonPage({}, { files: { 'assets/lonely.png': png(1, 1) } }),
    clean: () =>
      makeSkeletonPage(
        { script: "for (let i = 1; i <= 2; i += 1) { const img = new Image(); img.src = 'assets/photo-' + i + '.png'; }" },
        { files: { 'assets/photo-1.png': png(1, 1), 'assets/photo-2.png': png(1, 1) } },
      ),
  },
  CREDENTIAL_LEAK: {
    trigger: () => makeSkeletonPage({ body: '<!-- nmc_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcde -->' }),
    clean: () => makeSkeletonPage({ body: '<p>凭证以 nmc_ 开头（例如 nmc_abc），不要写进页面</p>' }),
  },
  IGNORED_FILE: {
    trigger: () => makePage({ files: { 'brief.md': '# brief' } }),
    clean: () => makePage(),
  },
} satisfies Record<StaticCode, Case>;

describe('contracts 2.2 每个错误码', () => {
  const entries = Object.entries(CASES) as [StaticCode, Case][];

  it('覆盖全部静态错误码', () => {
    const all = Object.entries(VALIDATION_ISSUE_CODES)
      .filter(([, info]) => info.stage === 'static')
      .map(([code]) => code)
      .sort();
    expect(entries.map(([code]) => code).sort()).toEqual(all);
  });

  describe.each(entries)('%s', (code, testCase) => {
    it('触发', () => {
      const report = run(testCase.trigger());
      expect(codes(report), summary(report)).toContain(code);
      const issue = [...report.errors, ...report.warnings].find((item) => item.code === code);
      expect(issue?.severity).toBe(VALIDATION_ISSUE_CODES[code].severity);
      expect(issue?.message).toMatch(/[\u4e00-\u9fff]/);
      expect(issue?.hint).toMatch(/[\u4e00-\u9fff]/);
      if (VALIDATION_ISSUE_CODES[code].severity === 'error') expect(report.ok).toBe(false);
    });

    it('相近但合法的写法不误报', () => {
      const report = run(testCase.clean());
      expect(codes(report), summary(report)).not.toContain(code);
      expect(report.errors, summary(report)).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });
});
