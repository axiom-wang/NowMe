# 2. 校验规则（`packages/validator`）

## 2.1 接口

```ts
type PageFiles = Map<string, Uint8Array>;           // key 为 page/ 内的相对路径，用 "/" 分隔
interface ValidationIssue {
  code: string;                // 见 2.2，大写蛇形
  severity: 'error' | 'warning';
  file: string;                // 例如 "index.html"
  line?: number;               // 1 起
  message: string;             // 中文：哪里有什么问题
  hint: string;                // 中文：怎么修（W19：给出修复指引或替代方案）
}
interface ValidationReport {
  ok: boolean;                 // 没有 error 即为 true
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: {
    indexHtmlBytes: number; assetBytes: number; assetCount: number;
    blocks: string[]; fontsUsed: string[]; cjkFontCount: number;
    scriptOnlyChars: string;   // 脚本字符串里出现、静态文本里没有的中文字符
    ignoredFiles: string[];    // 不会上传的文件
  };
  validatorVersion: string;
}
validatePage(files: PageFiles, opts?: { kitFonts?: KitFont[] }): ValidationReport;  // 纯函数，服务端复用；kitFonts 由调用方从 @nowme/kit 传入
computeExtraChars(files: PageFiles): string;                                        // 供 nowme validate 自动补全 manifest.extraChars
readPageDir(dir: string): Promise<PageFiles>;                                         // node 辅助
```

静态校验是**尽早发现问题**的手段，真正的安全边界是第 5 节的沙箱与 CSP；校验宁可多报警告，也不能因启发式误判放过明确违规。

## 2.2 规则与错误码

| 码 | 级别 | 规则 |
| --- | --- | --- |
| `MISSING_FILE` | error | 缺 `index.html` / `card.json` / `manifest.json` |
| `HTML_TOO_LARGE` | error | `index.html` > 300 KB |
| `HTML_MISSING_VIEWPORT` / `HTML_MISSING_CHARSET` / `HTML_MISSING_DOCTYPE` | error | 见 1.1 |
| `HTML_MISSING_LANG` | warning | 缺 `lang` |
| `EXTERNAL_RESOURCE` | error | 资源属性（`src`、`href`、`srcset`、`poster`、`background`、`xlink:href`、`data`、`action`、`formaction`）或 CSS `url()` / `@import` 中出现 `http:`、`https:`、`//`、`ws:`、`file:` 等非允许引用 |
| `FORBIDDEN_LINK_HREF` | error | `<a href>` 不是 `#...`（外链请用 `data-nm-href` 或 `nowme.openLink`） |
| `INSECURE_OPEN_LINK` | error | `data-nm-href` / `openLink` 的地址不是 `https:` |
| `EXTERNAL_URL_IN_SCRIPT` | warning | 脚本字符串中有 `http(s)://`，且不在 `nowme.openLink(...)` 的参数里 |
| `FORBIDDEN_ELEMENT` | error | `<form>`、`<iframe>`、`<frame>`、`<object>`、`<embed>`、`<base>`、`<portal>`、`<meta http-equiv="refresh">`；`<link>` 除指向 Kit 的 `rel=stylesheet` 外一律禁止；`<script src>` 只能指向 Kit |
| `FORBIDDEN_API` | error | 脚本（含 `on*` 属性）中出现：`fetch(`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`sendBeacon`、`RTCPeerConnection`、`WebTransport`、`localStorage`、`sessionStorage`、`indexedDB`、`caches.`、`document.cookie`、`cookieStore`、`window.open`、`window.top`、`top.location`、`parent.location`、`location.href =`、`location.assign`、`location.replace`、`serviceWorker`、`importScripts`、`new Worker`、`new SharedWorker`、动态 `import(`、`eval(`、`new Function`、`setTimeout("..."`、`getUserMedia`、`geolocation` |
| `JS_SYNTAX_ERROR` | error | 内联脚本无法解析 |
| `NM_ID_TOO_FEW` / `NM_ID_INVALID` / `NM_ID_DUPLICATE` | error | 见 1.1 |
| `NM_BLOCKS_MISMATCH` | warning | `manifest.blocks` 与页面 `data-nm-id` 不一致 |
| `MOTION_WITHOUT_REDUCED` | error | 按 1.1 的动效规则未处理 `prefers-reduced-motion`（没引入 `nowme.css` 的 CSS 动效；或脚本动效没有检查 `nowme.reducedMotion` / `prefers-reduced-motion`） |
| `FONT_FACE_FORBIDDEN` | error | 出现 `@font-face`、字体 data URI |
| `FONT_UNDECLARED` | error | 用了 Kit 字体但 `manifest.fonts` 未声明 |
| `FONT_NOT_IN_KIT` | warning | `font-family` 中出现既非 Kit 字体、也非通用族名 / 常见系统字体的名字（会回退到系统字体） |
| `FONT_TOO_MANY_CJK` | error | 中文字体字重合计 > 2 |
| `FONT_UNKNOWN` | error | `manifest.fonts` 中的 id 或字重不在 Kit 清单里 |
| `EXTRA_CHARS_MISSING` | warning | 脚本中的中文字符不在静态文本或 `extraChars` 中（`nowme validate` 会自动补全） |
| `CARD_INVALID` / `MANIFEST_INVALID` | error | JSON 解析失败或不符合 1.2 / 1.3 |
| `COVER_INVALID` | error | 不是 PNG、尺寸不对或超过体积 |
| `ASSET_TYPE_FORBIDDEN` / `ASSET_TOO_LARGE` / `ASSETS_TOO_MANY` / `ASSET_NAME_INVALID` | error | 见 1.4 |
| `ASSET_MISSING` | error | `index.html` 引用了不存在的 `assets/` 文件 |
| `ASSET_UNUSED` | warning | `assets/` 里有未被引用的文件 |
| `CREDENTIAL_LEAK` | error | 任意文件中出现形如 `nm[ct]_[A-Za-z0-9_-]{16,}` 的凭证，或出现名为 `credentials` 的文件 |
| `IGNORED_FILE` | warning | 不在 1 节白名单中的文件（不会上传） |

## 2.3 服务端额外检查（渲染阶段，`packages/render`）

| 码 | 级别 | 规则 |
| --- | --- | --- |
| `RENDER_SCRIPT_ERROR` | error | 渲染时出现未捕获异常 |
| `RENDER_CSP_VIOLATION` | error | 渲染时出现 `securitypolicyviolation` |
| `RENDER_CONSOLE_ERROR` | warning | `console.error` |
| `RENDER_SLOW` | warning | 375×667 视口下 `load` 超过 3000 ms [原型默认] |
| `RENDER_BLANK` | warning | 渲染后文字为空 |
| `RENDER_FAILED` | error | 渲染超时（10 s）或浏览器崩溃 |
