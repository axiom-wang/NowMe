# 5. 安全不变量（必须有自动化测试）

| # | 不变量 | 最低测试要求 |
| --- | --- | --- |
| S1 | 展示用户页面的 iframe 只有 `sandbox="allow-scripts"`，不含 `allow-same-origin`、`allow-top-navigation*`、`allow-forms`、`allow-popups*`、`allow-modals`；`src` 指向 `NOWME_PAGES_ORIGIN` | 解析所有展示页面的路由（成员页、工作区预览、公开链接）输出的 HTML；**浏览器测试**：恶意页面在 iframe 内尝试读 cookie、`fetch` 主站与外部、`localStorage`、改 `top.location`、提交表单、`window.open`，全部失败，主站 URL 不变，探针服务器收不到请求；iframe 自我导航（`location = 'https://...'`）被主站检测并重置（见 5.2） |
| S2 | 页面托管对页面文档返回严格 CSP：`default-src 'none'`；`script-src 'unsafe-inline' <pages>/_nowme/kit/`；`style-src 'unsafe-inline' <pages>/_nowme/kit/`；`img-src <pages>/v/<ticket>/assets/ <pages>/_nowme/kit/ data: blob:`；`media-src` 同 `img-src`；`font-src <pages>/v/<ticket>/_fonts/`；`connect-src 'none'`；`form-action 'none'`；`base-uri 'none'`；`frame-ancestors <web>`（预览时为预览外壳源）；`sandbox allow-scripts`；无 `'unsafe-eval'`。字体子集响应（`/v/<ticket>/_fonts/*`）必须带 `Access-Control-Allow-Origin: *`（沙箱文档的源是 `null`，没有 CORS 头时 Chromium 拒绝加载字体）。另加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 禁用摄像头/麦克风/定位等、不设任何 cookie | 对 pages-host 响应头逐项断言；CSP 构造函数单测；渲染管线用同一构造函数 |
| S3 | 一次性 token：只能换取一次；过期无效；只对签发它的那一页、那一面墙有效；换取后该页旧凭证全部失效；数据库只存哈希 | API 集成测试覆盖每一条 |
| S4 | 页面凭证不能发布：凭证调用发布、恢复、撤下、公开链接、删除、组织者操作等任何主站路由都无效且不改变状态；凭证不能当会话用；凭证不写进 `page/`、不随提交上传；校验器拦截凭证字符串 | 用凭证逐个调用所有改变状态的主站路由并断言数据库无变化；CLI 测试断言 `page/` 中无凭证、上传内容无凭证 |
| S5 | 组织者看不到私密内容：组织者后台只有昵称、加入时间、发布状态，以及成员自己在墙内公开回答的必答题（第 19 节）；组织者无法访问他人的工作区、版本、未发布内容、未公开的联系方式；本地路线的 brief / 画像从不上传 | 组织者身份请求他人工作区、版本预览、票据签发 → 404；后台 HTML 不含版本 ID、未发布 card 内容、私密联系方式；提交接口丢弃白名单外文件 |
| S6 | 非成员看不到墙：未登录、非成员、已退出、已移除的用户访问墙、成员页、封面、chat 接口都拿不到内容；pages-host 无票据、票据伪造、过期、篡改版本 ID 时拒绝；被移除成员立即失去访问且其页面立即下墙；关闭的墙对所有人不可见；关闭公开链接后旧链接失效 | 集成测试覆盖每种身份 × 每个路由；pages-host 票据测试 |

S7、S8（第 9 节）、S9（第 11 节）、S10（第 12 节）与 S1–S6 同等要求自动化测试。

主站自身也设 CSP：`default-src 'self'`、`frame-src <pages>`、`script-src 'self'`、`style-src 'self'`、`img-src 'self' data:`、`form-action 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`（主站不用内联脚本和内联样式）。主站校验 `Host` 头：不等于 `NOWME_WEB_ORIGIN` 的主机时返回 421 或重定向到 `NOWME_WEB_ORIGIN`（cookie 不按端口隔离，不能让主站在页面托管的主机名下签发 cookie）。主站的其他安全头见 10.4。

## 5.1 `nowme.openLink` 协议

Kit 调用 `parent.postMessage({ type: 'nowme:open-link', url }, '*')`。主站监听时校验 `event.source === iframe.contentWindow`、`url` 为 `https:`，弹出确认（显示目标域名），用户确认后 `window.open(url, '_blank', 'noopener,noreferrer')`。其他消息一律忽略。

## 5.2 iframe 自我导航

沙箱允许 iframe 导航它自己，CSP 也不管导航，所以页面脚本运行时拼出的 `location = '...'` 能把 iframe 带到外部网站（钓鱼、记录访客 IP）。主站展示页面时监听 iframe 的 `load` 事件：第一次加载之后再次触发 `load`，即视为页面自我导航，立即把 `src` 重置为空白页并在 iframe 外提示“这个页面试图跳转，已拦截”。需要浏览器测试覆盖。

## 5.3 展示模式与墙内连播

成员页、公开链接页与工作区预览的 `PageFrame` 都有“放大看”：舞台铺满窗口，并尝试对主站的 `figure` 请求全屏；不支持或拒绝全屏时固定舞台仍可使用。iframe 始终保持 **375×667 逻辑视口**，只通过 `transform: scale(...)` 整体等比缩放，不提供更宽视口。进入与退出只改外层 class 和 CSSOM 自定义属性，**不移动、不重建 iframe**，避免二次 `load` 被 5.2 误判；沙箱、票据与页面 CSP 不变。

只有成员页提供“上一位 / 下一位”和方向键连播。切换通过 `GET /w/:wallId/p/:pageId/stage` 重新授权并取当前发布票据，用 `cloneNode(false)` 继承原 iframe 属性后替换；新节点从 0 计算 `load`，不解除全屏，也不增加浏览器历史。顺序为 `listPublished` 的 `published_at, rowid`，过滤与查看者互相拉黑的人，首尾循环；单人墙不显示切换按钮。接口失败保留当前页；退出时若已切到别人，跳转到对应成员页。iframe 不加 `allow` / `allowfullscreen`，用户页面自己不能发起全屏。
