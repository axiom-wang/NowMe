import { parse } from 'acorn';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_LINK_MESSAGE_TYPE } from '@nowme/contracts';
import { KIT_DATA_ATTRIBUTES, KIT_JS_API } from '../src/index.js';
import { flush, KIT_CSS_SOURCE, KIT_JS_SOURCE, loadKit, type KitHarness } from './helpers/kit-window.js';

let harness: KitHarness | null = null;

function setup(options: Parameters<typeof loadKit>[0] = {}): KitHarness {
  harness = loadKit(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('nowme.js 语法与 API', () => {
  it('是 ES2020 脚本（不用 ES2021+ 语法），可以不经构建直接运行', () => {
    expect(() => parse(KIT_JS_SOURCE, { ecmaVersion: 2020, sourceType: 'script' })).not.toThrow();
  });

  it('window.nowme 暴露清单中的全部成员，类型一致，且对象被冻结', () => {
    const { nowme } = setup();
    for (const member of KIT_JS_API) {
      expect(member.name in nowme, member.name).toBe(true);
      const value = (nowme as unknown as Record<string, unknown>)[member.name];
      if (member.kind === 'function') expect(typeof value, member.name).toBe('function');
      else expect(typeof value, member.name).not.toBe('function');
    }
    expect(nowme.version).toBe('1');
    expect(Object.isFrozen(nowme)).toBe(true);
  });

  it('给 <html> 加 nm-js 类（CSS 据此只在有 JS 时隐藏待渐显的内容）', () => {
    const { doc } = setup();
    expect(doc.documentElement.classList.contains('nm-js')).toBe(true);
  });

  it('清单里的每个 data 属性都被 nowme.js 或 nowme.css 使用', () => {
    for (const attribute of KIT_DATA_ATTRIBUTES) {
      expect(KIT_JS_SOURCE.includes(attribute) || KIT_CSS_SOURCE.includes(attribute), attribute).toBe(true);
    }
  });

  it('重复执行 nowme.js 不会重复绑定（点击只发一条消息）', () => {
    const kit = setup({ html: '<span id="go" data-nm-href="https://example.com/">go</span>' });
    const first = kit.nowme;
    kit.runAgain();
    expect((kit.win as unknown as { nowme: unknown }).nowme).toBe(first);
    kit.doc.getElementById('go')?.click();
    expect(kit.messages).toHaveLength(1);
  });

  it('ready 在初始化完成后执行回调', () => {
    const { nowme } = setup();
    let received: unknown = null;
    nowme.ready((api) => {
      received = api;
    });
    expect(received).toBe(nowme);
  });

  it('motionLevel 读取 <html data-nm-motion>，缺省为 medium', () => {
    expect(setup().nowme.motionLevel).toBe('medium');
  });

  it('motionLevel 为 calm / lively 时如实返回', async () => {
    const kit = setup({ motionLevel: 'calm' });
    expect(kit.nowme.motionLevel).toBe('calm');
    kit.doc.documentElement.setAttribute('data-nm-motion', 'lively');
    expect(kit.nowme.motionLevel).toBe('lively');
    kit.doc.documentElement.setAttribute('data-nm-motion', 'wild');
    expect(kit.nowme.motionLevel).toBe('medium');
  });

  it('rng 同一种子得到同一串数', () => {
    const { nowme } = setup();
    const a = nowme.rng('xiaozhou');
    const b = nowme.rng('xiaozhou');
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    for (const value of seqA) expect(value >= 0 && value < 1).toBe(true);
    expect(nowme.rng(1)()).not.toBe(nowme.rng(2)());
  });
});

describe('nowme.openLink（contracts 5.1）', () => {
  it('向 parent 发送 { type: "nowme:open-link", url }，目标源为 "*"', () => {
    const { nowme, messages } = setup();
    expect(nowme.openLink('https://example.com/demo?x=1#top')).toBe(true);
    expect(messages).toEqual([
      { message: { type: OPEN_LINK_MESSAGE_TYPE, url: 'https://example.com/demo?x=1#top' }, targetOrigin: '*' },
    ]);
    expect(Object.keys(messages[0]?.message as object)).toEqual(['type', 'url']);
  });

  it('把地址规范化后再发送', () => {
    const { nowme, messages } = setup();
    nowme.openLink('  HTTPS://Example.COM  ');
    expect(messages[0]?.message).toEqual({ type: OPEN_LINK_MESSAGE_TYPE, url: 'https://example.com/' });
  });

  it.each([
    'http://example.com/',
    'javascript:alert(1)',
    'data:text/html,hi',
    '//example.com/x',
    'example.com',
    '/relative/path',
    'https://user:secret@example.com/',
    'ftp://example.com/',
    '',
  ])('拒绝非 https 地址：%s', (url) => {
    const { nowme, messages } = setup();
    expect(nowme.openLink(url)).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it.each([null, undefined, 42, {}])('拒绝非字符串参数：%s', (value) => {
    const { nowme, messages } = setup();
    expect(nowme.openLink(value)).toBe(false);
    expect(messages).toHaveLength(0);
  });
});

describe('[data-nm-href] 自动绑定', () => {
  const html = `
    <div id="card" data-nm-href="https://example.com/card"><span id="inner">看作品</span></div>
    <a id="anchor" href="#top" data-nm-href="https://example.com/anchor">锚点</a>
    <button id="btn" data-nm-href="https://example.com/btn">按钮</button>
    <span id="custom" role="button" tabindex="-1" data-nm-href="https://example.com/custom">自定义</span>
    <span id="bad" data-nm-href="http://example.com/insecure">不安全</span>`;

  it('补上 role="link" 与 tabindex="0"，不覆盖已有的 role / tabindex，原生可聚焦元素不加 tabindex', () => {
    const { doc } = setup({ html });
    const card = doc.getElementById('card');
    expect(card?.getAttribute('role')).toBe('link');
    expect(card?.getAttribute('tabindex')).toBe('0');
    expect(doc.getElementById('anchor')?.hasAttribute('tabindex')).toBe(false);
    expect(doc.getElementById('btn')?.hasAttribute('tabindex')).toBe(false);
    expect(doc.getElementById('custom')?.getAttribute('role')).toBe('button');
    expect(doc.getElementById('custom')?.getAttribute('tabindex')).toBe('-1');
  });

  it('点击元素或其子元素时打开链接，并阻止默认行为', () => {
    const { doc, win, messages } = setup({ html });
    doc.getElementById('inner')?.click();
    const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    doc.getElementById('anchor')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(messages.map((item) => (item.message as { url: string }).url)).toEqual([
      'https://example.com/card',
      'https://example.com/anchor',
    ]);
  });

  it.each(['Enter', ' '])('键盘 %j 激活非原生元素', (key) => {
    const { doc, win, messages } = setup({ html });
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    doc.getElementById('card')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(messages).toHaveLength(1);
    expect((messages[0]?.message as { url: string }).url).toBe('https://example.com/card');
  });

  it('原生 <button> 按键时交给浏览器自己触发 click（不重复打开）', () => {
    const { doc, win, messages } = setup({ html });
    const event = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    doc.getElementById('btn')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(messages).toHaveLength(0);
    doc.getElementById('btn')?.click();
    expect(messages).toHaveLength(1);
  });

  it('非 https 的 data-nm-href 标记 aria-disabled，点击不发送消息', () => {
    const { doc, messages } = setup({ html });
    const bad = doc.getElementById('bad');
    expect(bad?.getAttribute('aria-disabled')).toBe('true');
    bad?.click();
    expect(messages).toHaveLength(0);
  });

  it('之后插入的元素也会被补上 role 与 tabindex，并能点击', async () => {
    const { doc, win, messages } = setup();
    const late = doc.createElement('div');
    late.id = 'late';
    late.setAttribute('data-nm-href', 'https://example.com/late');
    doc.body.appendChild(late);
    await flush(win);
    expect(late.getAttribute('role')).toBe('link');
    expect(late.getAttribute('tabindex')).toBe('0');
    late.click();
    expect(messages).toHaveLength(1);
  });

  it('其他按键不触发', () => {
    const { doc, win, messages } = setup({ html });
    doc.getElementById('card')?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(messages).toHaveLength(0);
  });
});

describe('nowme.reducedMotion 跟随 matchMedia', () => {
  it('初始值来自 prefers-reduced-motion', () => {
    expect(setup({ reducedMotion: false }).nowme.reducedMotion).toBe(false);
  });

  it('初始为减少动效', () => {
    const kit = setup({ reducedMotion: true });
    expect(kit.nowme.reducedMotion).toBe(true);
    expect(kit.doc.documentElement.classList.contains('nm-reduced-motion')).toBe(true);
  });

  it('系统设置变化时实时更新，并通知 onReducedMotionChange 的订阅者；取消订阅后不再通知', () => {
    const kit = setup({ reducedMotion: false });
    const seen: boolean[] = [];
    const unsubscribe = kit.nowme.onReducedMotionChange((reduced) => seen.push(reduced));
    kit.motion.set(true);
    expect(kit.nowme.reducedMotion).toBe(true);
    expect(kit.doc.documentElement.classList.contains('nm-reduced-motion')).toBe(true);
    kit.motion.set(false);
    expect(kit.nowme.reducedMotion).toBe(false);
    expect(kit.doc.documentElement.classList.contains('nm-reduced-motion')).toBe(false);
    unsubscribe();
    kit.motion.set(true);
    expect(seen).toEqual([true, false]);
  });

  it('兼容只有 addListener 的旧版 MediaQueryList', () => {
    const kit = setup({ reducedMotion: false, legacyMediaQuery: true });
    const seen: boolean[] = [];
    kit.nowme.onReducedMotionChange((reduced) => seen.push(reduced));
    kit.motion.set(true);
    expect(kit.nowme.reducedMotion).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('onReducedMotionChange 拒绝非函数参数', () => {
    const { nowme } = setup();
    expect(() => nowme.onReducedMotionChange('nope' as unknown as () => void)).toThrow(TypeError);
  });

  it('一个订阅者抛错不影响其他订阅者', () => {
    const kit = setup();
    const seen: boolean[] = [];
    const errors: unknown[] = [];
    kit.win.console.error = (...args: unknown[]) => errors.push(args);
    kit.nowme.onReducedMotionChange(() => {
      throw new Error('boom');
    });
    kit.nowme.onReducedMotionChange((reduced) => seen.push(reduced));
    kit.motion.set(true);
    expect(seen).toEqual([true]);
    expect(errors).toHaveLength(1);
  });
});

describe('动效组件尊重减少动效', () => {
  const revealHtml = `
    <section data-nm-stagger="120">
      <p class="nm-reveal" id="r1">一</p><p class="nm-reveal" id="r2">二</p><p id="plain">三</p><p class="nm-reveal" id="r3">四</p>
    </section>`;

  it('减少动效时 .nm-reveal 立即可见', () => {
    const { doc } = setup({ html: revealHtml, reducedMotion: true });
    for (const id of ['r1', 'r2', 'r3']) expect(doc.getElementById(id)?.classList.contains('is-visible')).toBe(true);
  });

  it('data-nm-stagger 给子元素依次设置 --nm-delay', () => {
    const { doc } = setup({ html: revealHtml });
    expect(doc.getElementById('r1')?.style.getPropertyValue('--nm-delay')).toBe('0ms');
    expect(doc.getElementById('r2')?.style.getPropertyValue('--nm-delay')).toBe('120ms');
    expect(doc.getElementById('r3')?.style.getPropertyValue('--nm-delay')).toBe('240ms');
  });

  it('切换到减少动效时，尚未出现的 .nm-reveal 全部显示；revealAll 也能手动显示', () => {
    const kit = setup({ html: revealHtml });
    kit.motion.set(true);
    expect(kit.doc.getElementById('r3')?.classList.contains('is-visible')).toBe(true);

    const other = setup({ html: revealHtml });
    other.nowme.revealAll();
    expect(other.doc.getElementById('r2')?.classList.contains('is-visible')).toBe(true);
  });

  it('打字机：减少动效时保留静态的第一句，不开始打字', async () => {
    const kit = setup({ html: '<h1><span id="tw" data-nm-typewriter><span>写后端的</span><span>也画原型的</span></span></h1>', reducedMotion: true });
    await flush(kit.win, 50);
    const el = kit.doc.getElementById('tw');
    expect(el?.children).toHaveLength(2);
    expect(el?.classList.contains('is-done')).toBe(true);
  });

  it('打字机：正常情况下逐字打出并在 once 模式结束', async () => {
    const kit = setup();
    const el = kit.doc.createElement('span');
    kit.doc.body.appendChild(el);
    kit.nowme.typewriter(el, ['你好呀'], { startDelay: 0, typeSpeed: 2, loop: false });
    await flush(kit.win, 120);
    expect(el.textContent).toBe('你好呀');
    expect(el.classList.contains('is-done')).toBe(true);
    // 读屏软件读到完整句子，而不是逐字变化
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.previousElementSibling?.textContent).toBe('你好呀');
  });

  it('彩纸：减少动效时不撒，返回 false，也不插入 canvas', () => {
    const kit = setup({ reducedMotion: true, canvas: true, raf: true });
    expect(kit.nowme.confetti()).toBe(false);
    expect(kit.doc.querySelector('canvas')).toBeNull();
    expect(kit.raf).not.toHaveBeenCalled();
  });

  it('彩纸：正常情况下插入全屏 canvas 并开始动画', () => {
    const kit = setup({ canvas: true, raf: true });
    expect(kit.nowme.confetti({ x: 100, y: 100, count: 10 })).toBe(true);
    expect(kit.doc.querySelector('canvas.nm-confetti-canvas')).not.toBeNull();
    expect(kit.raf).toHaveBeenCalled();
  });

  it('粒子：减少动效时只画一帧静态画面，不启动动画循环', () => {
    const kit = setup({ html: '<canvas id="sky" data-nm-particles="stars"></canvas>', reducedMotion: true, canvas: true, raf: true });
    const canvas = kit.doc.getElementById('sky');
    const context = kit.contexts.get(canvas);
    expect(context?.arc).toHaveBeenCalled();
    expect(kit.raf).not.toHaveBeenCalled();
  });

  it('粒子：正常情况下启动循环；切换到减少动效时停止并重画静态帧', () => {
    const kit = setup({ html: '<canvas id="sky" data-nm-particles="links"></canvas>', canvas: true, raf: true });
    expect(kit.raf).toHaveBeenCalledTimes(1);
    const context = kit.contexts.get(kit.doc.getElementById('sky'));
    const drawsBefore = context?.clearRect?.mock.calls.length ?? 0;
    kit.motion.set(true);
    expect(context?.clearRect?.mock.calls.length).toBeGreaterThan(drawsBefore);
    expect(kit.win.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('数字滚动：减少动效时不动', () => {
    const kit = setup({ html: '<span id="n" data-nm-count="42">42</span>', reducedMotion: true, raf: true });
    expect(kit.nowme.countUp(kit.doc.getElementById('n'))).toBe(false);
    expect(kit.doc.getElementById('n')?.textContent).toBe('42');
  });

  it('跑马灯：复制的内容对读屏隐藏、不可聚焦，且不复制 data-nm-id', () => {
    const kit = setup({
      html: '<div class="nm-marquee" data-nm-id="ticker"><div class="nm-marquee__track"><span data-nm-id="item">React</span><span data-nm-href="https://example.com/">Go</span></div></div>',
    });
    const children = Array.from(kit.doc.querySelectorAll('.nm-marquee__track > *'));
    expect(children.length).toBe(4);
    const clones = children.slice(2);
    for (const clone of clones) {
      expect(clone.getAttribute('aria-hidden')).toBe('true');
      expect(clone.hasAttribute('inert')).toBe(true);
      expect(clone.hasAttribute('data-nm-id')).toBe(false);
    }
    expect(clones[1]?.getAttribute('tabindex')).toBe('-1');
    expect(kit.doc.querySelectorAll('[data-nm-id="item"]')).toHaveLength(1);
  });
});

describe('交互小组件', () => {
  it('data-nm-flip：点击或回车翻面，同步 aria-pressed', () => {
    const kit = setup({ html: '<div id="f" class="nm-flip" data-nm-flip><div class="nm-flip__inner"><div class="nm-flip__front">正</div><div class="nm-flip__back">反</div></div></div>' });
    const flip = kit.doc.getElementById('f');
    expect(flip?.getAttribute('role')).toBe('button');
    expect(flip?.getAttribute('aria-pressed')).toBe('false');
    flip?.click();
    expect(flip?.classList.contains('is-flipped')).toBe(true);
    expect(flip?.getAttribute('aria-pressed')).toBe('true');
    flip?.dispatchEvent(new kit.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(flip?.classList.contains('is-flipped')).toBe(false);
  });

  it('data-nm-cycle：点击切换到下一个子元素，循环回到第一个', () => {
    const kit = setup({ html: '<div id="c" data-nm-cycle><p>一</p><p>二</p><p>三</p></div>' });
    const cycle = kit.doc.getElementById('c');
    const active = () => Array.from(cycle?.children ?? []).findIndex((child) => child.classList.contains('is-active'));
    expect(active()).toBe(0);
    cycle?.click();
    expect(active()).toBe(1);
    cycle?.click();
    cycle?.click();
    expect(active()).toBe(0);
  });

  it('data-nm-cycle="random"：每次都换到另一个', () => {
    const kit = setup({ html: '<div id="c" data-nm-cycle="random"><p>一</p><p>二</p><p>三</p></div>' });
    const cycle = kit.doc.getElementById('c');
    let previous = 0;
    for (let index = 0; index < 20; index += 1) {
      cycle?.click();
      const current = Array.from(cycle?.children ?? []).findIndex((child) => child.classList.contains('is-active'));
      expect(current).not.toBe(previous);
      previous = current;
    }
  });

  it('data-nm-confetti 与 data-nm-href 可以同时使用', () => {
    const kit = setup({ html: '<button id="b" data-nm-confetti="20" data-nm-href="https://example.com/">来聊</button>', canvas: true, raf: true });
    kit.doc.getElementById('b')?.click();
    expect(kit.messages).toHaveLength(1);
    expect(kit.doc.querySelector('canvas.nm-confetti-canvas')).not.toBeNull();
  });
});
