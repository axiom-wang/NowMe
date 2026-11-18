# 8. 已采纳的实现细节（T0.2）

- `kitFontSchema` 用 `files`（字重 → 文件名）代替 `file`；授权限 OFL-1.1 / Apache-2.0 / MIT；family 只能是 ASCII；字重为 100–900 整百。
- 其他表的 ID 前缀：`login_codes` 用 `lgc_`、`agent_tokens` 用 `agt_`、`page_credentials` 用 `crd_`。
- 文本长度按 Unicode 码点计算，不能全为空白、不能含控制字符；所有 JSON 对象拒绝未知字段（`manifest.generator` 内部除外）；`manifest.fonts`（可为空数组）与 `extraChars`（可为空字符串）必填。
- 校验器（T1.1）额外拦截：`importmap` / `speculationrules` 脚本、`fencedframe`、`applet`、脚本动态创建的禁用元素、`ping` / `lowsrc` 等资源属性、`navigation.navigate`。`card.json` 中 hook 的 `kind` 不做场景匹配检查（自由文本）。SVG SMIL 动画暂不纳入减少动效规则（已知缺口）。
- API 错误码增加 `INTERNAL_ERROR`（500）；事件 `props` 最多 16 个键；一次提交最多 64 个文件。
- Kit（T1.2）：`fonts.json` 的 `sourceUrl` 要么是以 `/` 结尾的目录地址（文件地址 = `sourceUrl` + 文件名），要么是 `.zip`（按文件名解压）；字体源文件由 `pnpm --filter @nowme/kit fonts:fetch` 下载，不入库。场景指南中“默认勾选”的边界选项暂时写在选项文字里（`（默认勾选）`，允许在括号内附加说明；展示与提交时去掉整段标注）。
- 字体子集的取字范围：`index.html` 源码中出现的全部字符（含属性和脚本）+ 渲染后文字 + `manifest.extraChars`。因此 `extraChars` 只需覆盖源码中完全没有出现的字。
- 系统文件（`isSystemFile`，在 `@nowme/validator` 导出）在提交时由 CLI 过滤、服务端丢弃，不算白名单路径。
- 渲染（T1.3）：页面自我导航和被拦截的请求目前归入 `RENDER_CSP_VIOLATION`；主站 CSP 的 `frame-src <pages>` 已能阻止 iframe 跳到外部地址，5.2 的 `load` 检测用于拦截页面源内部的跳转。服务端渲染不要用 Playwright 的 `serviceWorkers: 'block'`（在沙箱文档中会误报脚本异常）。
- 截图前调用 `nowme.revealAll()`，避免首屏以下的 `.nm-reveal` 内容在整页截图中不可见。
- `loadConfig` 拒绝主站与页面托管同主机名（例外见 10.1 的 `NOWME_ALLOW_SAME_IP_ORIGINS`）、TTL 只接受 1–720 小时、票据密钥至少 32 字符。
