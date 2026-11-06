/**
 * 在一个全新的 happy-dom 窗口里运行 static/nowme.js，并替换 matchMedia、postMessage、
 * requestAnimationFrame 与 canvas 2D 上下文，便于断言 Kit 的行为。
 */
import { readFileSync } from 'node:fs';
import { Window, type HTMLElement } from 'happy-dom';
import { vi, type Mock } from 'vitest';
import { kitStaticFilePath } from '../../src/index.js';

export const KIT_JS_SOURCE = readFileSync(kitStaticFilePath('nowme.js'), 'utf8');
export const KIT_CSS_SOURCE = readFileSync(kitStaticFilePath('nowme.css'), 'utf8');

type MotionListener = (event: { matches: boolean; media: string }) => void;

/** 可控的 MediaQueryList（prefers-reduced-motion）。 */
export class FakeMediaQueryList {
  readonly media = '(prefers-reduced-motion: reduce)';
  matches: boolean;
  private readonly listeners = new Set<MotionListener>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(type: string, listener: MotionListener): void {
    if (type === 'change') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: MotionListener): void {
    if (type === 'change') this.listeners.delete(listener);
  }

  /** 模拟用户在系统里切换“减少动态效果”。 */
  set(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches, media: this.media });
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** 只有旧式 addListener 的 MediaQueryList（部分旧版 WebView）。 */
export class LegacyMediaQueryList {
  readonly media = '(prefers-reduced-motion: reduce)';
  matches: boolean;
  private readonly listeners = new Set<MotionListener>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addListener(listener: MotionListener): void {
    this.listeners.add(listener);
  }

  set(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches, media: this.media });
  }
}

export interface NowmeApi {
  readonly version: string;
  readonly reducedMotion: boolean;
  readonly motionLevel: 'calm' | 'medium' | 'lively';
  openLink(url: unknown): boolean;
  onReducedMotionChange(callback: (reduced: boolean) => void): () => void;
  ready(callback: (api: NowmeApi) => void): void;
  refresh(scope?: unknown): void;
  revealAll(scope?: unknown): void;
  typewriter(el: unknown, phrases?: string[] | null, options?: Record<string, unknown>): { stop(): void };
  particles(canvas: unknown, options?: Record<string, unknown>): { start(): void; stop(): void; redraw(): void };
  confetti(options?: Record<string, unknown>): boolean;
  countUp(el: unknown, options?: Record<string, unknown>): boolean;
  rng(seed: number | string): () => number;
}

export interface PostedMessage {
  message: unknown;
  targetOrigin: unknown;
}

/** happy-dom 的 getElementById 返回 Element；测试里的元素都是 HTMLElement。 */
export type KitDocument = { getElementById(id: string): HTMLElement | null } & Window['document'];

export interface KitHarness {
  win: Window;
  doc: KitDocument;
  nowme: NowmeApi;
  motion: FakeMediaQueryList | LegacyMediaQueryList;
  messages: PostedMessage[];
  raf: Mock;
  /** 每个 canvas 的假 2D 上下文（方法都是 vi.fn）。 */
  contexts: Map<unknown, Record<string, Mock>>;
  /** 再执行一次 nowme.js（检查幂等）。 */
  runAgain(): void;
  close(): Promise<void>;
}

export interface HarnessOptions {
  html?: string;
  reducedMotion?: boolean;
  legacyMediaQuery?: boolean;
  /** 提供假的 canvas 2D 上下文（happy-dom 默认返回 null）。 */
  canvas?: boolean;
  /** 提供 requestAnimationFrame（只记录调用，不执行回调）。 */
  raf?: boolean;
  /** 在执行 nowme.js 之前设置 <html data-nm-motion>。 */
  motionLevel?: string;
}

function fakeContext(): Record<string, Mock> {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(object, property) {
      if (!(property in object)) object[property] = vi.fn();
      return object[property];
    },
    set(object, property, value) {
      object[property] = value;
      return true;
    },
  }) as Record<string, Mock>;
}

export function loadKit(options: HarnessOptions = {}): KitHarness {
  const win = new Window({ url: 'https://pages.example/v/ticket/', width: 375, height: 667 });
  const doc = win.document;
  if (options.motionLevel !== undefined) doc.documentElement.setAttribute('data-nm-motion', options.motionLevel);
  doc.body.innerHTML = options.html ?? '';

  const motion = options.legacyMediaQuery
    ? new LegacyMediaQueryList(options.reducedMotion ?? false)
    : new FakeMediaQueryList(options.reducedMotion ?? false);
  const originalMatchMedia = win.matchMedia.bind(win);
  Object.defineProperty(win, 'matchMedia', {
    configurable: true,
    value: (query: string) => (query.includes('prefers-reduced-motion') ? motion : originalMatchMedia(query)),
  });

  const messages: PostedMessage[] = [];
  Object.defineProperty(win, 'postMessage', {
    configurable: true,
    value: (message: unknown, targetOrigin: unknown) => {
      messages.push({ message, targetOrigin });
    },
  });

  const raf = vi.fn(() => 1);
  if (options.raf) {
    Object.defineProperty(win, 'requestAnimationFrame', { configurable: true, value: raf });
    Object.defineProperty(win, 'cancelAnimationFrame', { configurable: true, value: vi.fn() });
  } else {
    Object.defineProperty(win, 'requestAnimationFrame', { configurable: true, value: undefined });
  }

  const contexts = new Map<unknown, Record<string, Mock>>();
  if (options.canvas) {
    const prototype = Object.getPrototypeOf(doc.createElement('canvas')) as { getContext: unknown };
    Object.defineProperty(prototype, 'getContext', {
      configurable: true,
      value(this: unknown) {
        let context = contexts.get(this);
        if (context === undefined) {
          context = fakeContext();
          contexts.set(this, context);
        }
        return context;
      },
    });
  }

  const run = () => {
    // 与浏览器里一样：nowme.js 是一个以 (window, document) 为参数的 IIFE。
    new Function('window', 'document', KIT_JS_SOURCE)(win, doc);
  };
  run();

  const nowme = (win as unknown as { nowme: NowmeApi }).nowme;
  return {
    win,
    doc: doc as KitDocument,
    nowme,
    motion,
    messages,
    raf,
    contexts,
    runAgain: run,
    close: () => win.happyDOM.close(),
  };
}

/** 等待 MutationObserver 等微任务执行完。 */
export function flush(win: Window, ms = 0): Promise<void> {
  return new Promise((resolve) => win.setTimeout(resolve, ms));
}
