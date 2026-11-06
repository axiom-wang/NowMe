/**
 * 渲染检查的问题（contracts 2.3）：中文 message + hint，级别取自 contracts 的错误码表。
 */
import { RENDER_SLOW_MS, RENDER_TIMEOUT_MS, RENDER_VIEWPORT, PAGE_INDEX_FILE, severityOf, type ValidationIssue, type ValidationIssueCode } from '@nowme/contracts';

export type RenderIssueCode = Extract<ValidationIssueCode, `RENDER_${string}`>;

const MAX_TEXT = 240;

export function clipText(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

export const RENDER_HINTS = {
  script: '对照报错位置修复脚本；常见原因：元素不存在就调用方法、用了被禁用的 API（存储、联网、eval）、依赖了没有引入的库。改完重新运行 nowme preview',
  csp: '页面不能加载外部资源或联网：图片放进 assets/ 并用相对路径引用，外链用 data-nm-href 或 nowme.openLink；不要用 fetch / XHR / WebSocket / eval / 表单 / 弹窗 / 顶层跳转',
  navigation: '不要改 location、不要让页面跳到别的地址；外链用 data-nm-href 或 nowme.openLink。平台展示时会拦截跳转并把页面重置为空白',
  console: '检查对应脚本；如果只是调试输出，删掉 console.error',
  slow: '压缩 assets/ 里的大图（单张建议 ≤ 300 KB）、减少 Canvas 粒子数量、不要在加载时做大量同步计算',
  blank: '检查内容是不是全靠脚本生成而脚本出错了；页面至少要有名字和一行介绍这样的静态文字',
  timeout: '检查有没有死循环（while (true)、无限递归、同步的大循环）或一直加载不完的资源',
  crash: '页面让浏览器标签页崩溃了：检查是否分配了过大的 Canvas / 数组，或有无限递归',
  failed: '把报错原文告诉开发者；如果重复出现，先简化页面脚本再试',
} as const;

export function renderIssue(code: RenderIssueCode, message: string, hint: string, line?: number): ValidationIssue {
  const issue: ValidationIssue = { code, severity: severityOf(code), file: PAGE_INDEX_FILE, message, hint };
  if (line !== undefined && Number.isInteger(line) && line > 0) issue.line = line;
  return issue;
}

export const renderMessages = {
  scriptError: (text: string) => `渲染时脚本抛出了未捕获的异常：${clipText(text)}`,
  cspViolation: (text: string) => `渲染时被内容安全策略或沙箱拦截：${clipText(text)}`,
  blockedRequest: (url: string, navigation: boolean) =>
    navigation ? `页面试图跳转到 ${clipText(url, 120)}，已拦截` : `页面试图访问 ${clipText(url, 120)}，已拦截`,
  selfNavigation: (count: number) => `页面加载完成后又发生了 ${count} 次跳转（自我导航），平台展示时会被拦截并重置为空白页`,
  consoleError: (text: string) => `渲染时 console.error 输出：${clipText(text)}`,
  slow: (ms: number) =>
    `在 ${RENDER_VIEWPORT.width}×${RENDER_VIEWPORT.height} 视口下页面 load 用了 ${ms} ms，超过 ${RENDER_SLOW_MS} ms`,
  blank: () => '渲染后页面上没有任何文字',
  timeout: (ms: number = RENDER_TIMEOUT_MS) => `页面在 ${Math.round(ms / 1000)} 秒内没有完成渲染（加载超时或脚本卡死）`,
  crash: () => '渲染时浏览器标签页崩溃了',
  failed: (text: string) => `渲染失败：${clipText(text)}`,
};
