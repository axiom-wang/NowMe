/**
 * 无障碍与手机端的页面内检查（不依赖 axe，用浏览器自带的能力）：
 * 横向溢出、标题、landmark、控件与链接的可访问名称、图片 alt、iframe title、引用的 id、`:focus-visible`、
 * 文字对比度（AA）、手机端点击区域与字号。`pageAudit` 在页面里运行，返回问题列表（空数组表示通过）。
 */
import type { Page } from '@playwright/test';

export interface AuditOptions {
  /** 手机视口：额外检查点击区域与字号。 */
  mobile: boolean;
  /** 逐项关闭（例如这一页本来就没有 h1：错误页的结构由别处保证）。 */
  skip?: string[];
}

/** 在页面里运行的检查。必须自包含（不引用外部变量）。 */
export function pageAudit(options: AuditOptions): string[] {
  const problems: string[] = [];
  const skip = new Set(options.skip ?? []);
  const report = (kind: string, message: string) => {
    if (!skip.has(kind)) problems.push(`${kind}: ${message}`);
  };
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${text ? ` "${text}"` : ''}`;
  };
  const visible = (el: Element): boolean => (el as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: false });
  const hiddenByAria = (el: Element): boolean => !!el.closest('[aria-hidden="true"]');
  const all = <T extends Element>(selector: string): T[] => [...document.querySelectorAll<T>(selector)];

  // 1. 横向溢出
  const root = document.documentElement;
  if (root.scrollWidth > innerWidth) {
    const wide = all<HTMLElement>('body *')
      .filter((el) => visible(el) && el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 4)
      .map(describe);
    report('overflow', `scrollWidth ${root.scrollWidth} > ${innerWidth}；${wide.join(' ')}`);
  }

  // 2. 文档基础：lang、title、landmark、跳到主内容
  if (!root.lang) report('document', '缺少 html[lang]');
  if (!document.title.trim()) report('document', '缺少 title');
  const mains = all('main, [role="main"]');
  if (mains.length !== 1) report('landmark', `main 有 ${mains.length} 个`);
  if (all('body > header, body > [role="banner"]').length !== 1) report('landmark', '需要恰好一个顶层 header');
  if (all('body > footer, body > [role="contentinfo"]').length !== 1) report('landmark', '需要恰好一个顶层 footer');
  const navs = all('nav');
  const navNames = navs.map((nav) => nav.getAttribute('aria-label') ?? nav.getAttribute('aria-labelledby') ?? '');
  if (navs.length > 1 && (navNames.some((name) => !name) || new Set(navNames).size !== navNames.length)) report('landmark', `多个 nav 需要各自不同的名称：${navNames.join(' | ')}`);
  const skipLink = document.querySelector<HTMLAnchorElement>('a.skip-link[href^="#"]');
  if (!skipLink) report('skip-link', '缺少“跳到主内容”链接');
  else if (!document.getElementById(skipLink.getAttribute('href')!.slice(1))) report('skip-link', '链接目标不存在');
  else if (skipLink !== all('a[href], button, input, select, textarea, summary, [tabindex]').find((el) => !(el as HTMLElement).hidden)) report('skip-link', '跳到主内容不是第一个可聚焦元素');

  // 3. 标题：一个 h1，层级不跳级
  const headings = all<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]').filter((el) => visible(el) && !hiddenByAria(el));
  const levelOf = (el: HTMLElement) => (el.getAttribute('aria-level') ? Number(el.getAttribute('aria-level')) : Number(el.tagName[1]));
  const h1s = headings.filter((el) => levelOf(el) === 1);
  if (h1s.length !== 1) report('h1', `h1 有 ${h1s.length} 个：${h1s.map(describe).join(' ')}`);
  let previous = 0;
  for (const heading of headings) {
    const level = levelOf(heading);
    if (previous && level > previous + 1) report('heading-order', `${describe(heading)} 从 h${previous} 跳到 h${level}`);
    previous = level;
  }

  // 4. 可访问名称
  const textOf = (el: Element): string => {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent;
      else if (node.nodeType === 1) {
        const child = node as Element;
        if (child.getAttribute('aria-hidden') === 'true' || (child as HTMLElement).hidden) continue;
        if (child.tagName === 'IMG') out += child.getAttribute('alt') ?? '';
        else if (child.tagName === 'SVG' || child.tagName === 'svg') out += child.querySelector('title')?.textContent ?? child.getAttribute('aria-label') ?? '';
        else out += child.getAttribute('aria-label') ?? textOf(child);
      }
    }
    return out;
  };
  const refText = (ids: string) =>
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .map((target) => (target ? (target.getAttribute('aria-label') ?? textOf(target)) : ''))
      .join(' ');
  const nameOf = (el: Element): string => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) return refText(labelledby).trim();
    const label = el.getAttribute('aria-label');
    if (label?.trim()) return label.trim();
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) return [...labels].map((l) => textOf(l)).join(' ').trim();
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return el.value.trim();
    if (el instanceof HTMLInputElement && el.type === 'image') return (el.alt ?? '').trim();
    const own = textOf(el).trim();
    if (own) return own;
    return (el.getAttribute('title') ?? '').trim();
  };
  const controls = all<HTMLElement>('input:not([type="hidden"]), select, textarea').filter((el) => visible(el) || (el as HTMLInputElement).type === 'file' || (el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio');
  for (const control of controls) {
    if (!nameOf(control)) report('control-name', `${describe(control)} name="${control.getAttribute('name') ?? ''}" 没有可访问名称`);
    if (control instanceof HTMLInputElement && control.type === 'text' && !control.hasAttribute('autocomplete') && /email|code|nickname/i.test(control.name)) report('autocomplete', `${describe(control)} 缺少 autocomplete`);
  }
  for (const el of all<HTMLElement>('button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]')) {
    if (!visible(el) || hiddenByAria(el)) continue;
    if (!nameOf(el)) report('name', `${describe(el)} 没有可访问名称`);
  }
  for (const img of all<HTMLImageElement>('img')) {
    if (!img.hasAttribute('alt') && !hiddenByAria(img)) report('img-alt', `${describe(img)} 缺少 alt（装饰图用 alt=""）`);
  }
  for (const frame of all<HTMLIFrameElement>('iframe')) {
    if (!(frame.title ?? '').trim()) report('iframe-title', `${describe(frame)} 缺少 title`);
  }
  for (const svg of all('svg')) {
    if (!hiddenByAria(svg) && !svg.getAttribute('aria-label') && !svg.querySelector('title') && !svg.getAttribute('role')) report('svg', `${describe(svg)} 既不是装饰（aria-hidden）也没有名称`);
  }

  // 5. 引用的 id 必须存在，id 不重复
  const idCount = new Map<string, number>();
  for (const el of all('[id]')) idCount.set(el.id, (idCount.get(el.id) ?? 0) + 1);
  for (const [id, count] of idCount) if (count > 1) report('duplicate-id', `#${id} 出现 ${count} 次`);
  for (const attr of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
    for (const el of all(`[${attr}]`)) {
      for (const id of el.getAttribute(attr)!.split(/\s+/)) {
        if (id && !document.getElementById(id)) report('dangling-ref', `${describe(el)} 的 ${attr}="${id}" 找不到`);
      }
    }
  }
  for (const label of all<HTMLLabelElement>('label[for]')) {
    if (!document.getElementById(label.htmlFor)) report('dangling-ref', `label for="${label.htmlFor}" 找不到控件`);
  }

  // 6. 文字对比度（AA：正文 4.5:1，大字 3:1；渐变 / 图片底的元素跳过）
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const parse = (value: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const over = (top: [number, number, number, number], bottom: [number, number, number]): [number, number, number] => [
    top[0] * top[3] + bottom[0] * (1 - top[3]),
    top[1] * top[3] + bottom[1] * (1 - top[3]),
    top[2] * top[3] + bottom[2] * (1 - top[3]),
  ];
  const luminance = ([r, g, b]: [number, number, number]) => {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  /** 往上找合成后的背景色；遇到渐变 / 图片背景返回 null（无法判断）。 */
  const backgroundOf = (el: Element): [number, number, number] | null => {
    const layers: [number, number, number, number][] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none' && node !== document.body && node !== document.documentElement) return null;
      const bg = parse(style.backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let result: [number, number, number] = [243, 240, 232];
    for (const layer of layers.reverse()) result = over(layer, result);
    return result;
  };
  const opacityOf = (el: Element): number => {
    let value = 1;
    for (let node: Element | null = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !(node.textContent ?? '').trim()) continue;
    seen.add(el);
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName) || !visible(el) || hiddenByAria(el)) continue;
    if (el.closest('[disabled], [aria-disabled="true"], iframe')) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue; // visually-hidden
    const bg = backgroundOf(el);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    // 正文（段落、列表、标签、链接、按钮、表单文字）不小于 14px；徽章 / 眉题 / 步骤标签 / 时间等次要文字不小于 12px
    if (options.mobile && size < 13.99 && /^(P|LI|DD|LABEL|A|BUTTON|SUMMARY|INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.closest('.badge, .chip, .eyebrow, .ai-badge, .sticker, time, .message-badge, .progress__num, .avatar, [class*="badge"], [class*="eyebrow"], .auth__step, .mini-card__label')) report('body-size', `${describe(el)} 字号 ${size.toFixed(1)}px < 14px`);
    if (options.mobile && !skip.has('font-size') && size < 12) report('font-size', `${describe(el)} 字号 ${size.toFixed(1)}px < 12px`);
    if (!bg) continue;
    const alpha = parse(style.color)[3] * opacityOf(el);
    if (alpha < 0.05) continue; // 还没淡入 / 完全透明
    const fg = over([...parse(style.color).slice(0, 3), alpha] as [number, number, number, number], bg);
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) report('contrast', `${describe(el)} 对比度 ${got.toFixed(2)} < ${need}（${style.color} on rgb(${bg.map(Math.round).join(',')}) ${size.toFixed(1)}px）`);
  }
  for (const input of all<HTMLInputElement>('input[placeholder], textarea[placeholder]')) {
    if (!visible(input)) continue;
    const bg = backgroundOf(input);
    if (!bg) continue;
    const color = parse(getComputedStyle(input, '::placeholder').color);
    const got = ratio(over(color, bg), bg);
    if (got < 4.5) report('placeholder-contrast', `${describe(input)} 占位符对比度 ${got.toFixed(2)} < 4.5`);
  }

  // 7. 手机端：点击区域至少 44×44（行内文字链接除外）
  if (options.mobile) {
    const targets = all<HTMLElement>('button, a[href], summary, select, textarea, input:not([type="hidden"]), [role="button"]');
    for (const el of targets) {
      if (!visible(el) || hiddenByAria(el)) continue;
      let rect = el.getBoundingClientRect();
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
        const label = el.labels?.[0];
        const labelRect = label?.getBoundingClientRect();
        if (labelRect && labelRect.width > 0) rect = labelRect;
        else if (rect.width < 2) continue;
      }
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && (el.parentElement.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 2) continue;
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.width < 43.5 || rect.height < 43.5) report('touch-target', `${describe(el)} ${Math.round(rect.width)}×${Math.round(rect.height)} < 44×44`);
    }
  }

  return problems;
}

export async function audit(page: Page, options: AuditOptions): Promise<string[]> {
  // 等入场动画走完（无限循环的除外），否则对比度会按动画中间帧计算
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  return page.evaluate(pageAudit, options);
}

/**
 * 用键盘 Tab 走一遍页面：每个聚焦的元素都要有可见的焦点提示（轮廓 / 阴影，或紧邻的装饰元素有），并且没有键盘陷阱。
 * 返回问题列表与走过的元素数。
 */
export async function auditFocus(page: Page, limit = 60): Promise<{ problems: string[]; visited: number }> {
  const problems: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  const seen = new Set<string>();
  let visited = 0;
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      // 页面 iframe：焦点进入后，焦点提示由用户页面自己负责
      if (el.tagName === 'IFRAME') return { name: 'iframe', ok: true, covered: false, key: `iframe${el.getAttribute('src')}` };
      const describe = (node: Element) => `<${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/)[0]}` : ''}> "${(node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 20)}"`;
      const drawn = (node: Element): boolean => {
        const style = getComputedStyle(node);
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)';
        return outline || (style.boxShadow !== 'none' && style.boxShadow !== '');
      };
      let ok = drawn(el);
      // 视觉隐藏的原生控件（自定义勾选框 / 单选）：焦点提示画在紧邻的元素或所在标签上
      if (!ok) {
        const label = el.closest('label');
        const sibling = el.nextElementSibling;
        const candidates = [label, sibling, label?.querySelector('.check__box, .chip-check__label, span')].filter(Boolean) as Element[];
        ok = candidates.some(drawn) || (!!label && label.matches(':has(:focus-visible)') && drawn(label));
      }
      const rect = el.getBoundingClientRect();
      return { name: describe(el), ok, covered: rect.width === 0 || rect.height === 0, key: `${el.tagName}${el.id}${el.getAttribute('name') ?? ''}${el.getAttribute('href') ?? ''}${rect.x}${rect.y}` };
    });
    if (!info) break; // 回到浏览器界面：一圈走完
    if (seen.has(info.key)) break;
    seen.add(info.key);
    visited += 1;
    if (!info.ok) problems.push(`focus: ${info.name} 聚焦后没有可见的焦点提示`);
  }
  return { problems, visited };
}
