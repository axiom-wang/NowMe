/**
 * 测试夹具：合法示例页、Kit 字体清单、图片字节、页面构造工具。
 */
import { crc32, deflateSync } from 'node:zlib';
import type { KitFont, PageFiles, ValidationReport } from '@nowme/contracts';
import { computeExtraChars, validatePage } from '../src/index.js';

export const KIT_FONTS: KitFont[] = [
  {
    id: 'lxgw-wenkai',
    family: 'LXGW WenKai',
    cjk: true,
    weights: [400, 700],
    license: 'OFL-1.1',
    sourceUrl: 'https://github.com/lxgw/LxgwWenKai',
    files: { '400': 'LXGWWenKai-Regular.ttf', '700': 'LXGWWenKai-Bold.ttf' },
  },
  {
    id: 'noto-serif-sc',
    family: 'Noto Serif SC',
    cjk: true,
    weights: [400, 700, 900],
    license: 'OFL-1.1',
    sourceUrl: 'https://github.com/notofonts/noto-cjk',
    files: { '400': 'NotoSerifSC-Regular.otf', '700': 'NotoSerifSC-Bold.otf', '900': 'NotoSerifSC-Black.otf' },
  },
  {
    id: 'inter',
    family: 'Inter',
    cjk: false,
    weights: [400, 700],
    license: 'OFL-1.1',
    sourceUrl: 'https://github.com/rsms/inter',
    files: { '400': 'Inter-Regular.ttf', '700': 'Inter-Bold.ttf' },
  },
];

const encoder = new TextEncoder();
export const text = (value: string): Uint8Array => encoder.encode(value);
export const json = (value: unknown): Uint8Array => text(JSON.stringify(value, null, 2));

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(text(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 真正的 PNG（RGBA，全透明）。 */
export function png(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 只有 JPEG 魔数与结尾标记的字节（校验器只看魔数）。 */
export function jpeg(size = 64): Uint8Array {
  const out = new Uint8Array(Math.max(size, 8));
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

export function gif(): Uint8Array {
  return text('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;');
}

export function webp(): Uint8Array {
  const out = new Uint8Array(16);
  out.set(text('RIFF'), 0);
  out.set(text('WEBPVP8 '), 8);
  return out;
}

export const VALID_CARD = {
  schemaVersion: 1,
  displayName: '阿柚',
  tagline: '做过 3 个校园小程序的前端，想找能一起熬夜的设计',
  hooks: [
    { id: 'help-frontend', kind: 'can-help', text: '我能帮你把原型变成能点的页面', opener: '你好！我在墙上看到你说能把原型变成能点的页面，想聊聊吗？' },
    { id: 'find-designer', kind: 'looking-for', text: '找会做视觉的队友', opener: '嗨，我是做设计的，看到你在找会做视觉的队友～' },
  ],
};

export const VALID_MANIFEST = {
  schemaVersion: 1,
  sceneType: 'hackathon',
  kitVersion: '1',
  motionLevel: 'medium',
  fonts: [
    { id: 'lxgw-wenkai', weights: [400] },
    { id: 'inter', weights: [400, 700] },
  ],
  extraChars: '',
  blocks: ['hero', 'projects', 'teammate'],
  generator: { agent: 'claude-code', skillVersion: '0.1.0' },
};

/** 合法示例页：Kit 链接、data-nm-id、nowme.openLink、Canvas + reduced-motion 检查、清单字体、assets 图片。 */
export const VALID_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>阿柚 · 黑客松</title>
  <link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">
  <style>
    :root { --accent: #ff7a59; --title-font: var(--nm-font-lxgw-wenkai); }
    body { margin: 0; font-family: var(--nm-font-lxgw-wenkai), "PingFang SC", -apple-system, sans-serif; }
    h2 { font: 700 20px/1.4 Inter, var(--nm-font-sans); }
    .hero { background: url("assets/hero.png") center / cover no-repeat; animation: float 3s ease-in-out infinite; }
    .badge { background-image: image-set("assets/badge.webp" 1x); }
    .tag::before { content: "✦ 新"; }
    @keyframes float { from { transform: translateY(0); } to { transform: translateY(-6px); } }
  </style>
</head>
<body>
  <!-- 注释里的 <iframe src="https://example.com"> 与 fetch("https://x") 不算 -->
  <header class="hero" data-nm-id="hero">
    <h1>阿柚</h1>
    <p>做过 3 个校园小程序的前端</p>
    <img src="./assets/avatar.jpg" srcset="assets/avatar.jpg 1x, assets/photos/avatar-2x.jpg 2x" alt="阿柚的头像">
  </header>
  <section data-nm-id="projects">
    <h2>做过的项目</h2>
    <a href="#teammate">去看我想找的队友</a>
    <button type="button" data-nm-href="https://github.com/ayou">GitHub 主页</button>
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="">
    <svg viewBox="0 0 10 10" width="20" height="20" aria-hidden="true">
      <defs><linearGradient id="g"><stop offset="0" stop-color="#f60"/></linearGradient></defs>
      <circle cx="5" cy="5" r="4" fill="url(#g)"/>
      <use href="#g"/>
    </svg>
    <span class="badge">徽章</span>
    <img src="assets/loading.gif" alt="">
  </section>
  <section data-nm-id="teammate">
    <h2>想找的队友</h2>
    <canvas id="sky" width="375" height="200"></canvas>
    <p id="typer"></p>
    <button type="button" id="blog" onclick="this.blur()">看看我的博客</button>
  </section>
  <script type="application/json" id="quotes">["一起熬夜吧"]</script>
  <script src="/_nowme/kit/v1/nowme.js"></script>
  <script>
    // fetch("https://evil.example") 只是注释
    const canvas = document.getElementById('sky');
    const ctx = canvas.getContext('2d');
    const stars = Array.from({ length: 30 }, (_, i) => ({ x: (i * 47) % 375, y: (i * 29) % 200 }));
    function draw(t) {
      ctx.clearRect(0, 0, 375, 200);
      ctx.font = '12px "LXGW WenKai"';
      for (const s of stars) ctx.fillRect((s.x + t / 40) % 375, s.y, 2, 2);
    }
    if (nowme.reducedMotion) {
      draw(0);
    } else {
      const loop = (t) => { draw(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    document.getElementById('blog').addEventListener('click', () => nowme.openLink('https://ayou.dev/blog'));
    const quotes = JSON.parse(document.getElementById('quotes').textContent);
    const words = ['写代码到天亮', '设计师快来', ...quotes];
    let index = 0;
    setInterval(() => { document.getElementById('typer').textContent = words[index++ % words.length]; }, 2000);
    const ns = 'http://www.w3.org/2000/svg';
    document.querySelector('svg').appendChild(document.createElementNS(ns, 'circle'));
    const photo = new Image();
    photo.src = 'assets/photos/' + 'avatar-2x.jpg';
  </script>
</body>
</html>
`;

export interface PageParts {
  html?: string;
  card?: unknown;
  manifest?: unknown;
  /** 额外文件或覆盖（值为 null 表示删除）。 */
  files?: Record<string, Uint8Array | string | null>;
  /** 不自动补全 extraChars。 */
  rawManifest?: boolean;
}

export function validAssets(): Record<string, Uint8Array> {
  return {
    'assets/hero.png': png(4, 4),
    'assets/avatar.jpg': jpeg(),
    'assets/photos/avatar-2x.jpg': jpeg(),
    'assets/badge.webp': webp(),
    'assets/loading.gif': gif(),
  };
}

/** 构造页面文件；默认就是合法示例页。manifest.extraChars 默认用 computeExtraChars 补全。 */
export function makePage(parts: PageParts = {}): PageFiles {
  const files: PageFiles = new Map();
  files.set('index.html', text(parts.html ?? VALID_HTML));
  files.set('card.json', json(parts.card ?? VALID_CARD));
  files.set('cover.png', png(750, 1000));
  for (const [path, bytes] of Object.entries(validAssets())) files.set(path, bytes);
  for (const [path, value] of Object.entries(parts.files ?? {})) {
    if (value === null) files.delete(path);
    else files.set(path, typeof value === 'string' ? text(value) : value);
  }
  const manifest = parts.manifest ?? VALID_MANIFEST;
  files.set('manifest.json', json(manifest));
  if (!parts.rawManifest && typeof manifest === 'object' && manifest !== null && 'extraChars' in manifest) {
    const filled = { ...(manifest as Record<string, unknown>), extraChars: computeExtraChars(files) };
    files.set('manifest.json', json(filled));
  }
  if (parts.files && 'manifest.json' in parts.files) {
    const value = parts.files['manifest.json'];
    if (value === null) files.delete('manifest.json');
    else if (value !== undefined) files.set('manifest.json', typeof value === 'string' ? text(value) : value);
  }
  return files;
}

/**
 * 最小合法页骨架：可替换 head / style / body / script 片段（用于单条规则的触发与不误报用例）。
 * 默认引入 Kit 样式（CSS 动效视为已处理），带 3 个 data-nm-id。
 */
export function skeleton(parts: { head?: string; style?: string; body?: string; script?: string; kitCss?: boolean } = {}): string {
  const kitCss = parts.kitCss ?? true;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>测试页</title>
${kitCss ? '<link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">' : ''}
${parts.head ?? ''}
<style>
body { margin: 0; }
${parts.style ?? ''}
</style>
</head>
<body>
<section data-nm-id="hero"><h1>你好</h1></section>
<section data-nm-id="projects"><p>项目</p></section>
<section data-nm-id="teammate"><p>队友</p></section>
${parts.body ?? ''}
<script src="/_nowme/kit/v1/nowme.js"></script>
<script>
${parts.script ?? ''}
</script>
</body>
</html>
`;
}

/** 用骨架页构造只含必要文件的页面（manifest 没有 blocks、fonts 为空）。 */
export function makeSkeletonPage(
  parts: Parameters<typeof skeleton>[0] = {},
  extra: Omit<PageParts, 'html'> = {},
): PageFiles {
  const files: PageFiles = new Map();
  files.set('index.html', text(skeleton(parts)));
  files.set('card.json', json(extra.card ?? VALID_CARD));
  for (const [path, value] of Object.entries(extra.files ?? {})) {
    if (value === null) files.delete(path);
    else files.set(path, typeof value === 'string' ? text(value) : value);
  }
  const manifest = (extra.manifest ?? { ...VALID_MANIFEST, fonts: [], blocks: undefined }) as Record<string, unknown>;
  files.set('manifest.json', json(manifest));
  if (!extra.rawManifest && 'extraChars' in manifest) {
    files.set('manifest.json', json({ ...manifest, extraChars: computeExtraChars(files) }));
  }
  if (extra.files && 'manifest.json' in extra.files) {
    const value = extra.files['manifest.json'];
    if (value === null) files.delete('manifest.json');
    else if (value !== undefined) files.set('manifest.json', typeof value === 'string' ? text(value) : value);
  }
  return files;
}

export function run(files: PageFiles): ValidationReport {
  return validatePage(files, { kitFonts: KIT_FONTS });
}

export function codes(report: ValidationReport): string[] {
  return [...report.errors, ...report.warnings].map((issue) => issue.code);
}

export function issuesOf(report: ValidationReport, code: string) {
  return [...report.errors, ...report.warnings].filter((issue) => issue.code === code);
}

/** 断言报告里没有任何问题时的可读输出。 */
export function summary(report: ValidationReport): string {
  return [...report.errors, ...report.warnings].map((issue) => `${issue.code} ${issue.file}:${issue.line ?? '-'} ${issue.message}`).join('\n');
}
