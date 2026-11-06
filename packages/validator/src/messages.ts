/**
 * 共用的中文修复指引（W19：每条问题都要告诉 Agent 怎么改）。
 */
import {
  ASSET_EXTENSIONS,
  ASSETS_MAX_COUNT,
  ASSETS_TOTAL_MAX_BYTES,
  ASSET_MAX_BYTES,
  COVER_HEIGHT,
  COVER_WIDTH,
  KIT_CSS_PATH,
  KIT_JS_PATH,
  MAX_CJK_FONTS,
} from '@nowme/contracts';

const MB = 1024 * 1024;

export const HINTS = {
  externalResource:
    '页面只能引用 page/assets/ 下的图片（写成 assets/<文件名>）或 Kit 文件（/_nowme/kit/v1/...）。把图片下载进 page/assets/ 再引用；要跳转的外部链接改用 data-nm-href="https://..." 或 nowme.openLink("https://...")',
  outsideResource:
    '只能引用 assets/ 下的文件或 Kit：把文件移到 page/assets/，写成 assets/<文件名>（不要用 ../、img/ 或以 / 开头的路径；Kit 文件用 /_nowme/kit/v1/ 开头的根路径）',
  dataUri: '内联 data: 只允许 data:image/* 图片；其他内容直接写进页面，或改成 assets/ 下的图片',
  javascriptUrl: '不要用 javascript: 地址：把逻辑写进内联 <script>，用 addEventListener 绑定事件',
  linkHref:
    '外部链接改成 <a data-nm-href="https://...">文字</a>（Kit 会自动绑定点击，由平台确认后打开），或在脚本里调用 nowme.openLink("https://...")；页内跳转用 href="#区块id"',
  insecureLink:
    '外链只允许 https:// 开头的完整地址，例如 data-nm-href="https://github.com/你的名字"；对方网站不支持 https 时不要放这个链接',
  externalUrlInScript:
    '页面不能联网，脚本里的外部地址无法加载。要打开的外链请直接写在 nowme.openLink("https://...") 的参数里或用 data-nm-href；图片请放进 assets/。确认只是展示用的文字可以忽略此警告',
  fontFace:
    '不要自带字体：在 manifest.json 的 fonts 里声明 Kit 字体（例如 { "id": "lxgw-wenkai", "weights": [400] }），CSS 里用 var(--nm-font-<字体id>) 或 Kit 字体的 family 名；平台会按页面用到的字生成子集',
  fontNotInKit:
    '改用 Kit 字体清单（context.json 的 kit.fonts）里的字体，写 var(--nm-font-<字体id>)；或删掉这个名字，只保留通用族名 / 系统字体栈（例如 sans-serif）',
  fontUnknown: '只能使用 Kit 字体清单（context.json 的 kit.fonts）里的字体 id 与它支持的字重',
  fontTooManyCjk: `中文字体每个字重计 1 款，最多 ${MAX_CJK_FONTS} 款：减少中文字体或字重，例如标题和正文共用一款字体，只保留 400 和 700`,
  extraChars:
    '运行 nowme validate（默认自动补全 manifest.extraChars），或手动把这些字加进 manifest.json 的 extraChars；否则这些字会回退到系统字体',
  cssMotion: `引入 Kit 样式 <link rel="stylesheet" href="${KIT_CSS_PATH}">（已内置减少动效规则），或自己加 @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }`,
  scriptMotion:
    '启动动画前先判断减少动效设置：if (nowme.reducedMotion) { 画一帧静态画面; return; }（不用 Kit 时用 matchMedia("(prefers-reduced-motion: reduce)").matches），减少动效时给出静态画面',
  nmIdFormat: '只用小写字母开头、小写字母 / 数字 / 连字符，最长 40 个字符，例如 data-nm-id="my-projects"',
  nmIdTooFew:
    '给页面的主要区块加稳定标识（至少 3 个，页面内唯一），例如 <section data-nm-id="hero">、data-nm-id="projects"、data-nm-id="teammate"',
  nmIdDuplicate: '每个 data-nm-id 在页面内必须唯一：给其中一个区块换个名字',
  blocksMismatch: '让 manifest.json 的 blocks 与页面里的 data-nm-id 保持一致，或者删掉 blocks 字段',
  card: '按 contracts 1.2 修改 card.json：schemaVersion 为 1；displayName 1–24 字；tagline 1–40 字；hooks 2–3 个，每个有 id（小写字母开头）、text（2–32 字）、opener（1–80 字），不要加其他字段',
  manifest:
    '按 contracts 1.3 修改 manifest.json：schemaVersion 为 1；sceneType 为 hackathon / interest / club / general；kitVersion 为 "1"；motionLevel 为 calm / medium / lively；fonts 与 extraChars 必填（可为空）；不要加其他字段',
  cover: `删除 cover.png 后运行 nowme preview --cover 重新生成（${COVER_WIDTH}×${COVER_HEIGHT} 的 PNG 首屏截图）`,
  assetType: `assets/ 只能放 ${ASSET_EXTENSIONS.join(' / ')} 图片，且扩展名要和真实格式一致；SVG 请直接内联在 index.html，字体用 Kit 字体清单`,
  assetName: '文件名只用小写字母、数字、点、下划线、连字符（小写字母或数字开头，最长 64 个字符），assets/ 下最多一层子目录，例如 assets/photos/team-1.jpg',
  assetSize: `单个图片不超过 ${ASSET_MAX_BYTES / MB} MB、合计不超过 ${ASSETS_TOTAL_MAX_BYTES / MB} MB：压缩图片（例如转成 webp、宽度不超过 1500px）或删掉不用的图`,
  assetCount: `assets/ 最多 ${ASSETS_MAX_COUNT} 个文件：删掉不用的图片，或把小图标改成内联 SVG`,
  assetMissing: '把图片放到 page/assets/ 下对应位置，或修正引用路径（区分大小写）',
  assetUnused: '删除没用到的图片（它们仍会被上传并计入体积），或在页面中引用它',
  credentialLeak:
    '立刻从 page/ 中删除它：页面凭证只保存在 ~/.nowme/credentials，绝不能写进页面或随提交上传。如果已经提交或分享过，到应用内断开 Agent 连接，再重新生成指令',
  ignoredFile: 'page/ 只放 index.html、card.json、manifest.json、cover.png 和 assets/ 下的图片；brief、草稿、说明等文件放到 page/ 外面',
  symlink: '不要用符号链接：把真实文件复制到 page/ 里',
  jsSyntax:
    '检查括号、引号、反引号是否成对；内联脚本里不要写 import / export（除非 <script type="module">）；事件属性里只写语句，复杂逻辑放进 <script> 用 addEventListener 绑定',
  forbiddenScriptSrc: `脚本直接写进内联 <script>…</script>；只有 Kit 脚本可以用 <script src="${KIT_JS_PATH}"></script>`,
  forbiddenLink: `只能用 <link rel="stylesheet" href="${KIT_CSS_PATH}"> 引入 Kit 样式；其他样式直接写进 <style>，图标请内联 SVG`,
} as const;

/** FORBIDDEN_API 按类别给出替代方案。 */
export type ApiCategory = 'network' | 'storage' | 'navigation' | 'eval' | 'worker' | 'device';

export const API_HINTS: Record<ApiCategory, string> = {
  network:
    '页面不能联网：把需要的数据直接写进页面（JS 常量，或 <script type="application/json"> 里的数据），图片放进 assets/',
  storage: '页面不能存储数据（cookie、localStorage 等在沙箱里都不可用）：用普通变量保存状态，刷新后重置即可',
  navigation:
    '页面不能跳转、打开新窗口或改动外层页面：外链用 nowme.openLink("https://...") 或 data-nm-href；页内跳转用 element.scrollIntoView() 或 href="#区块id"',
  eval: '不要执行字符串形式的代码：直接写函数，例如 setTimeout(() => { … }, 1000)',
  worker: '页面不能创建 Worker / Service Worker：把计算放在主线程，必要时用 requestAnimationFrame 分帧',
  device: '页面不能访问摄像头、麦克风或定位',
};

/** 禁止的元素 → 修复指引。 */
export function forbiddenElementHint(tag: string): string {
  switch (tag) {
    case 'form':
      return '页面不能提交表单：去掉 <form>，用按钮 + 脚本在页面内处理交互（数据只保存在内存里）';
    case 'base':
      return '删除 <base>，直接写 assets/ 开头的相对路径';
    case 'meta':
      return '删除 <meta http-equiv="refresh">：页面不能自动跳转或刷新';
    case 'link':
      return HINTS.forbiddenLink;
    case 'script':
      return HINTS.forbiddenScriptSrc;
    case 'importmap':
      return '页面是自包含的单文件，不需要 importmap / speculationrules：删除它，把代码直接写进内联脚本';
    default:
      return '页面不能嵌入其他页面、插件或外部内容：视频、地图、作品等请截图放进 assets/，再用 data-nm-href="https://..." 链接过去';
  }
}
