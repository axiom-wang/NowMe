/**
 * Kit 清单：静态文件、主题、组件类、data 属性、CSS 变量与 window.nowme 的 API。
 * 供 render / pages-host / CLI / Skill 使用；测试保证这里列出的每一项都真实存在于 static/ 中。
 */

/** `static/` 下的 Kit 文件（页面以 `/_nowme/kit/v1/<path>` 引用）。 */
export const KIT_STATIC_FILES = [
  { path: 'nowme.css', contentType: 'text/css; charset=utf-8', summary: 'CSS 变量、主题、基础排版、组件与动效类' },
  { path: 'nowme.js', contentType: 'text/javascript; charset=utf-8', summary: 'window.nowme：openLink、减少动效、组件初始化' },
] as const;

export type KitStaticFileName = (typeof KIT_STATIC_FILES)[number]['path'];

export interface KitTheme {
  className: string;
  dark: boolean;
  summary: string;
}

/** 主题类：放在 `<html>`、`<body>` 或任意区块上，设置 `--nm-bg` 等颜色变量与背景、文字颜色。 */
export const KIT_THEMES: readonly KitTheme[] = [
  { className: 'nm-theme-paper', dark: false, summary: '纸张：暖白底、墨色字、朱红点缀（默认）' },
  { className: 'nm-theme-ink', dark: true, summary: '墨夜：近黑底、暖白字、橙色点缀' },
  { className: 'nm-theme-terminal', dark: true, summary: '终端：黑底、荧光绿、琥珀色' },
  { className: 'nm-theme-candy', dark: false, summary: '糖果：浅粉底、亮粉、天蓝、柠檬黄' },
  { className: 'nm-theme-forest', dark: false, summary: '森林：浅灰绿底、墨绿、砖红' },
  { className: 'nm-theme-sunset', dark: false, summary: '七十年代：奶油底、橘红、芥末黄、墨绿' },
  { className: 'nm-theme-mono', dark: false, summary: '黑白：纯白底、纯黑线条、信号橙' },
  { className: 'nm-theme-cobalt', dark: true, summary: '克莱因蓝：钴蓝底、白字、明黄' },
  { className: 'nm-theme-night', dark: true, summary: '星夜：深海军蓝底、星光黄、紫' },
];

export type KitComponentKind = 'layout' | 'type' | 'component' | 'texture' | 'motion' | 'interactive' | 'canvas';

export interface KitComponent {
  /** 稳定 id（文档与 Skill 引用）。 */
  id: string;
  /** 主类名（不含点）；只靠 data 属性工作的组件为 null。 */
  className: string | null;
  kind: KitComponentKind;
  /** 需要 nowme.js 才能工作（没有 JS 时内容仍然完整显示）。 */
  js: boolean;
  /** 一句话说明。 */
  summary: string;
  /** 变体、子元素类名。 */
  parts?: readonly string[];
  /** 相关 data 属性。 */
  attributes?: readonly string[];
}

export const KIT_COMPONENTS: readonly KitComponent[] = [
  // 版式
  { id: 'page', className: 'nm-page', kind: 'layout', js: false, summary: '居中的页面容器（左右留白 --nm-gutter，最大宽度 --nm-page-max）' },
  { id: 'section', className: 'nm-section', kind: 'layout', js: false, summary: '区块上下留白' },
  { id: 'hero', className: 'nm-hero', kind: 'layout', js: false, summary: '首屏区块（顶部对齐，封面截取的就是这里的前 500px）' },
  { id: 'stack', className: 'nm-stack', kind: 'layout', js: false, summary: '纵向排列，--nm-gap 控制间距', parts: ['nm-stack-s', 'nm-stack-l'] },
  { id: 'cluster', className: 'nm-cluster', kind: 'layout', js: false, summary: '横向换行排列' },
  { id: 'grid', className: 'nm-grid', kind: 'layout', js: false, summary: '自适应网格，--nm-min 控制最小列宽' },
  { id: 'split', className: 'nm-split', kind: 'layout', js: false, summary: '两等分栏' },
  { id: 'scroll-x', className: 'nm-scroll-x', kind: 'layout', js: false, summary: '横向滑动画廊（按卡片吸附），--nm-item-width 控制卡片宽度' },
  // 文字
  { id: 'display', className: 'nm-display', kind: 'type', js: false, summary: '超大标题', parts: ['nm-mega', 'nm-h1', 'nm-h2', 'nm-h3', 'nm-lead'] },
  { id: 'kicker', className: 'nm-kicker', kind: 'type', js: false, summary: '标题上方的小字眉题（带短横线）', parts: ['nm-kicker--plain'] },
  { id: 'quote', className: 'nm-quote', kind: 'type', js: false, summary: '引用主人原话（大引号）', parts: ['nm-quote__by'] },
  { id: 'highlight', className: 'nm-highlight', kind: 'type', js: false, summary: '荧光笔划重点' },
  { id: 'underline', className: 'nm-underline', kind: 'type', js: false, summary: '波浪下划线' },
  { id: 'outline-text', className: 'nm-outline-text', kind: 'type', js: false, summary: '空心描边字' },
  { id: 'vertical', className: 'nm-vertical', kind: 'type', js: false, summary: '竖排文字' },
  { id: 'gradient-text', className: 'nm-gradient-text', kind: 'type', js: false, summary: '渐变字（--nm-gradient 自定义渐变）', parts: ['nm-gradient-text--animated'] },
  // 组件
  { id: 'card', className: 'nm-card', kind: 'component', js: false, summary: '卡片', parts: ['nm-card--hard', 'nm-card--glass', 'nm-card--outline'] },
  { id: 'chip', className: 'nm-chip', kind: 'component', js: false, summary: '标签；<button class="nm-chip" aria-pressed> 可做成可切换的选项', parts: ['nm-chips', 'nm-chip--solid', 'nm-chip--accent', 'nm-chip--soft'] },
  { id: 'button', className: 'nm-button', kind: 'component', js: false, summary: '按钮（外链配合 data-nm-href；.nm-arrow 加 ↗）', parts: ['nm-button--accent', 'nm-button--ghost', 'nm-button--hard', 'nm-arrow'] },
  { id: 'sticker', className: 'nm-sticker', kind: 'component', js: false, summary: '贴纸（白色模切描边，--nm-tilt 控制角度）', parts: ['nm-sticker--round', 'nm-sticker--burst', 'nm-sticker--hover'] },
  { id: 'stamp', className: 'nm-stamp', kind: 'component', js: false, summary: '印章（--nm-stamp-color）', parts: ['nm-stamp--round', 'nm-stamp--worn'] },
  { id: 'polaroid', className: 'nm-polaroid', kind: 'component', js: false, summary: '拍立得相框', parts: ['nm-polaroid__photo', 'nm-polaroid__caption'] },
  { id: 'tape', className: 'nm-tape', kind: 'component', js: false, summary: '纸胶带（加在照片、便签上）', parts: ['nm-tape--striped', 'nm-tape--corner'] },
  { id: 'note', className: 'nm-note', kind: 'component', js: false, summary: '便利贴（--nm-note-color）' },
  { id: 'speech', className: 'nm-speech', kind: 'component', js: false, summary: '对话气泡', parts: ['nm-speech--right'] },
  { id: 'terminal', className: 'nm-terminal', kind: 'component', js: false, summary: '终端窗口', parts: ['nm-terminal__bar', 'nm-terminal__title', 'nm-terminal__body', 'nm-prompt', 'nm-cursor'] },
  { id: 'browser', className: 'nm-browser', kind: 'component', js: false, summary: '浏览器窗口框（放 demo 截图）', parts: ['nm-browser__bar', 'nm-browser__url', 'nm-browser__body'] },
  { id: 'phone', className: 'nm-phone', kind: 'component', js: false, summary: '手机框（放小程序 / App 截图）', parts: ['nm-phone__screen'] },
  { id: 'ticket', className: 'nm-ticket', kind: 'component', js: false, summary: '票根（带缺口与虚线副券）', parts: ['nm-ticket__main', 'nm-ticket__stub'] },
  { id: 'timeline', className: 'nm-timeline', kind: 'component', js: false, summary: '时间线', parts: ['nm-timeline__item', 'nm-timeline__time'] },
  { id: 'stat', className: 'nm-stat', kind: 'component', js: false, summary: '大数字 + 说明（只放主人给的真实数字）', parts: ['nm-stat__value', 'nm-stat__label'] },
  { id: 'meter', className: 'nm-meter', kind: 'component', js: false, summary: '进度条（style="--nm-value:.7"）', parts: ['nm-meter--blocks'] },
  { id: 'avatar', className: 'nm-avatar', kind: 'component', js: false, summary: '首字母头像' },
  { id: 'details', className: 'nm-details', kind: 'component', js: false, summary: '折叠问答（<details>）', parts: ['nm-details__body'] },
  { id: 'divider', className: 'nm-divider', kind: 'component', js: false, summary: '虚线 / 波浪分隔线', parts: ['nm-divider--wave'] },
  // 质感
  { id: 'grain', className: 'nm-grain', kind: 'texture', js: false, summary: '颗粒噪点（加在 <body> 上铺满整页）' },
  { id: 'bg-dots', className: 'nm-bg-dots', kind: 'texture', js: false, summary: '圆点 / 方格 / 横线 / 斜纹背景', parts: ['nm-bg-grid', 'nm-bg-lines', 'nm-bg-stripes'] },
  { id: 'glow', className: 'nm-glow', kind: 'texture', js: false, summary: '模糊光晕（--nm-glow-color、--nm-glow-size）' },
  { id: 'blob', className: 'nm-blob', kind: 'texture', js: false, summary: '缓慢变形的流体色块' },
  // 动效
  { id: 'reveal', className: 'nm-reveal', kind: 'motion', js: true, summary: '滚动渐显（up/down/left/right/scale/fade/blur）', attributes: ['data-nm-reveal', 'data-nm-stagger'] },
  { id: 'marquee', className: 'nm-marquee', kind: 'motion', js: true, summary: '跑马灯（JS 复制内容无缝循环）', parts: ['nm-marquee__track', 'nm-marquee--reverse', 'nm-marquee--fade'] },
  { id: 'float', className: 'nm-float', kind: 'motion', js: false, summary: '上下漂浮', parts: ['nm-wiggle', 'nm-spin', 'nm-pulse', 'nm-blink', 'nm-pop-in'] },
  { id: 'shimmer', className: 'nm-shimmer', kind: 'motion', js: false, summary: '一道光扫过' },
  { id: 'scroll-hint', className: 'nm-scroll-hint', kind: 'motion', js: false, summary: '“往下滑”提示箭头' },
  // 交互
  { id: 'flip', className: 'nm-flip', kind: 'interactive', js: true, summary: '点击翻面卡片', parts: ['nm-flip__inner', 'nm-flip__front', 'nm-flip__back'], attributes: ['data-nm-flip'] },
  { id: 'cycle', className: null, kind: 'interactive', js: true, summary: '点一下换一个（data-nm-cycle，值 random 随机）', attributes: ['data-nm-cycle'] },
  { id: 'typewriter', className: null, kind: 'interactive', js: true, summary: '打字机（子元素是要轮流打出的句子）', attributes: ['data-nm-typewriter', 'data-nm-speed'] },
  { id: 'count', className: null, kind: 'interactive', js: true, summary: '数字滚动（data-nm-count）', attributes: ['data-nm-count'] },
  { id: 'tilt', className: null, kind: 'interactive', js: true, summary: '指针 3D 倾斜（data-nm-tilt）', attributes: ['data-nm-tilt'] },
  { id: 'drag', className: null, kind: 'interactive', js: true, summary: '可拖动（data-nm-drag）', attributes: ['data-nm-drag'] },
  // Canvas
  { id: 'particles', className: 'nm-particles', kind: 'canvas', js: true, summary: '粒子背景 <canvas class="nm-particles" data-nm-particles="stars">', attributes: ['data-nm-particles', 'data-nm-color'] },
  { id: 'confetti', className: 'nm-confetti-canvas', kind: 'canvas', js: true, summary: '点击撒彩纸（data-nm-confetti）', attributes: ['data-nm-confetti'] },
];

/** Kit 识别的 data 属性（nowme.js 或 nowme.css 使用）。 */
export const KIT_DATA_ATTRIBUTES = [
  'data-nm-href',
  'data-nm-reveal',
  'data-nm-stagger',
  'data-nm-typewriter',
  'data-nm-speed',
  'data-nm-count',
  'data-nm-particles',
  'data-nm-color',
  'data-nm-confetti',
  'data-nm-flip',
  'data-nm-cycle',
  'data-nm-tilt',
  'data-nm-drag',
  'data-nm-motion',
] as const;

/** `canvas[data-nm-particles]` 的预设。 */
export const KIT_PARTICLE_PRESETS = ['stars', 'snow', 'bubbles', 'dust', 'links'] as const;

/** nowme.css 在 :root 上声明的设计变量（字体变量另见 fontCssVariable 与 KIT_FONT_ROLE_VARIABLES）。 */
export const KIT_CSS_VARIABLES = {
  color: [
    '--nm-bg', '--nm-surface', '--nm-surface-2', '--nm-fg', '--nm-muted', '--nm-line',
    '--nm-accent', '--nm-accent-2', '--nm-accent-3', '--nm-on-accent', '--nm-focus',
  ],
  space: [
    '--nm-space-1', '--nm-space-2', '--nm-space-3', '--nm-space-4', '--nm-space-5',
    '--nm-space-6', '--nm-space-7', '--nm-space-8', '--nm-space-9', '--nm-gutter', '--nm-page-max',
  ],
  radius: ['--nm-radius-xs', '--nm-radius-s', '--nm-radius-m', '--nm-radius-l', '--nm-radius-xl', '--nm-radius-pill'],
  text: [
    '--nm-text-xs', '--nm-text-s', '--nm-text-m', '--nm-text-l', '--nm-text-xl', '--nm-text-2xl',
    '--nm-text-3xl', '--nm-text-4xl', '--nm-text-5xl', '--nm-text-mega',
    '--nm-leading-tight', '--nm-leading-snug', '--nm-leading', '--nm-tracking-wide', '--nm-display-weight',
  ],
  shadow: ['--nm-shadow-s', '--nm-shadow-m', '--nm-shadow-l', '--nm-shadow-hard'],
  motion: ['--nm-ease-out', '--nm-ease-in-out', '--nm-ease-spring', '--nm-dur-1', '--nm-dur-2', '--nm-dur-3', '--nm-dur-4'],
  texture: ['--nm-grain-blend', '--nm-grain-opacity'],
} as const;

/** 只指向系统字体栈的语义字体变量（contracts 1.1）。 */
export const KIT_SYSTEM_FONT_VARIABLES = ['--nm-font-sans', '--nm-font-serif', '--nm-font-mono'] as const;

/** Kit 组件使用的角色字体变量；默认指向系统字体栈，页面可以改成 Kit 字体。 */
export const KIT_FONT_ROLE_VARIABLES = ['--nm-font-body', '--nm-font-display', '--nm-font-code', '--nm-font-hand'] as const;

export interface KitJsApiMember {
  name: string;
  kind: 'property' | 'function';
  signature: string;
  summary: string;
}

/** `window.nowme` 的成员。 */
export const KIT_JS_API: readonly KitJsApiMember[] = [
  { name: 'version', kind: 'property', signature: "'1'", summary: 'Kit 版本' },
  { name: 'openLink', kind: 'function', signature: 'openLink(url: string): boolean', summary: '请平台打开 https 外链（postMessage nowme:open-link）；非 https 返回 false' },
  { name: 'reducedMotion', kind: 'property', signature: 'boolean', summary: '实时反映 prefers-reduced-motion: reduce' },
  { name: 'onReducedMotionChange', kind: 'function', signature: 'onReducedMotionChange(cb: (reduced: boolean) => void): () => void', summary: '订阅减少动效设置的变化，返回取消订阅函数' },
  { name: 'motionLevel', kind: 'property', signature: "'calm' | 'medium' | 'lively'", summary: '<html data-nm-motion> 声明的动效强度' },
  { name: 'ready', kind: 'function', signature: 'ready(cb: (nowme) => void): void', summary: 'Kit 初始化完成后执行' },
  { name: 'refresh', kind: 'function', signature: 'refresh(scope?: Element): void', summary: '重新扫描并初始化 scope 内的 Kit 组件（动态插入的节点会自动处理）' },
  { name: 'revealAll', kind: 'function', signature: 'revealAll(scope?: Element): void', summary: '立刻显示所有 .nm-reveal' },
  { name: 'typewriter', kind: 'function', signature: 'typewriter(el, phrases?, options?): { stop() }', summary: '打字机效果' },
  { name: 'particles', kind: 'function', signature: 'particles(canvas, options?): { start(), stop(), redraw() }', summary: 'Canvas 粒子背景' },
  { name: 'confetti', kind: 'function', signature: 'confetti(options?): boolean', summary: '撒一次彩纸；减少动效时不撒' },
  { name: 'countUp', kind: 'function', signature: 'countUp(el, options?): boolean', summary: '数字从 0 滚到目标值' },
  { name: 'rng', kind: 'function', signature: 'rng(seed: number | string): () => number', summary: '可复现的伪随机数（生成式图形用，封面截图稳定）' },
];
