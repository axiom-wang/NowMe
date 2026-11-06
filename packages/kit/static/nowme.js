/*!
 * NOWMe Kit v1 — nowme.js（ES2020，无需构建，挂在 window.nowme）
 *
 * 引用（放在 <head> 里，紧跟 nowme.css，不加 defer/async，这样首屏不会闪）：
 *   <script src="/_nowme/kit/v1/nowme.js"></script>
 *
 * 页面运行在沙箱 iframe 和严格 CSP 下：不能联网、不能存储、不能跳转顶层页面。
 * 外链统一交给平台：元素写 data-nm-href="https://..."，或在脚本里调用 nowme.openLink(url)。
 *
 * 自动初始化（DOMContentLoaded 后，以及之后插入的节点）：
 *   [data-nm-href]         点击 / 回车 / 空格 → nowme.openLink；自动补 role="link" 与 tabindex
 *   .nm-reveal             进入视口时加 .is-visible（父元素 data-nm-stagger 依次出现）
 *   .nm-marquee            复制轨道内容，铺满后无缝循环
 *   [data-nm-typewriter]   子元素是要轮流打出的句子；值写 once 只打一遍
 *   [data-nm-count]        进入视口时数字从 0 滚到目标值（静态文字就是最终值）
 *   canvas[data-nm-particles]  粒子背景：stars | snow | bubbles | dust | links
 *   [data-nm-confetti]     点击时在点击位置撒彩纸（值可写数量）
 *   [data-nm-flip]         点击翻面（配合 .nm-flip 结构）
 *   [data-nm-cycle]        点击切换到下一个子元素；值写 random 随机切换
 *   [data-nm-tilt]         指针悬停时 3D 倾斜（值为最大角度，默认 10）
 *   [data-nm-drag]         可拖动（贴纸、拼贴）
 *
 * 所有动效都尊重 prefers-reduced-motion：减少动效时给出静态画面。
 */
(function (window, document) {
  'use strict';

  var existing = window.nowme;
  if (existing && existing.version === '1') return;

  const win = window;
  const doc = document;
  const root = doc.documentElement;
  const OPEN_LINK_TYPE = 'nowme:open-link';
  const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
  const LINK_SELECTOR = '[data-nm-href]';
  const READY_ATTR = 'data-nm-ready';

  root.classList.add('nm-js');

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function isElement(node) {
    return Boolean(node) && node.nodeType === 1;
  }

  function scopeOf(scope) {
    return scope && typeof scope.querySelectorAll === 'function' ? scope : doc;
  }

  /** scope 内（含 scope 自身）匹配 selector 的元素。 */
  function all(scope, selector) {
    const base = scopeOf(scope);
    const found = toArray(base.querySelectorAll(selector));
    if (base !== doc && isElement(base) && base.matches(selector)) found.unshift(base);
    return found;
  }

  function closest(target, selector) {
    return isElement(target) ? target.closest(selector) : null;
  }

  function report(error) {
    if (win.console && typeof win.console.error === 'function') win.console.error('[nowme]', error);
  }

  function warn(message) {
    if (win.console && typeof win.console.warn === 'function') win.console.warn('[nowme] ' + message);
  }

  function safely(fn) {
    try {
      fn();
    } catch (error) {
      report(error);
    }
  }

  /** 只在第一次调用时返回 true（用 data-nm-ready 标记已初始化的元素）。 */
  function claim(el) {
    if (el.hasAttribute(READY_ATTR)) return false;
    el.setAttribute(READY_ATTR, '');
    return true;
  }

  function readNumber(value, fallback) {
    const number = parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function cssValue(el, name, fallback) {
    if (typeof win.getComputedStyle !== 'function') return fallback;
    const value = win.getComputedStyle(el).getPropertyValue(name).trim();
    return value || fallback;
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /** 可复现的伪随机数（mulberry32）：同一个种子每次得到同一串数，封面截图因此稳定。 */
  function rng(seed) {
    let state = (typeof seed === 'string' ? hashString(seed) : Math.floor(readNumber(seed, 1))) >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
  const caf = typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : function () {};

  function now() {
    return win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now();
  }

  // ---------------------------------------------------------------------------
  // 减少动效
  // ---------------------------------------------------------------------------

  const motionQuery = typeof win.matchMedia === 'function' ? win.matchMedia(REDUCED_QUERY) : null;
  const motionListeners = [];

  function prefersReducedMotion() {
    return Boolean(motionQuery && motionQuery.matches);
  }

  function syncMotionClass() {
    root.classList.toggle('nm-reduced-motion', prefersReducedMotion());
  }

  function onReducedMotionChange(callback) {
    if (typeof callback !== 'function') throw new TypeError('nowme.onReducedMotionChange 需要传入一个函数');
    motionListeners.push(callback);
    return function unsubscribe() {
      const index = motionListeners.indexOf(callback);
      if (index >= 0) motionListeners.splice(index, 1);
    };
  }

  function handleMotionChange() {
    syncMotionClass();
    const reduced = prefersReducedMotion();
    motionListeners.slice().forEach(function (callback) {
      safely(function () {
        callback(reduced);
      });
    });
  }

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', handleMotionChange);
    else if (typeof motionQuery.addListener === 'function') motionQuery.addListener(handleMotionChange);
  }
  syncMotionClass();

  /** 页面在 <html data-nm-motion="calm|medium|lively"> 上声明的动效强度（与 manifest.motionLevel 一致）。 */
  function motionLevel() {
    const value = root.getAttribute('data-nm-motion');
    return value === 'calm' || value === 'lively' ? value : 'medium';
  }

  function motionScale() {
    const level = motionLevel();
    return level === 'calm' ? 0.55 : level === 'lively' ? 1.35 : 1;
  }

  // ---------------------------------------------------------------------------
  // 外链（contracts 5.1）
  // ---------------------------------------------------------------------------

  /** 规范化为 https 地址；不是完整的 https: 地址（或带用户名密码）时返回 null。 */
  function normalizeHttps(value) {
    if (value === null || value === undefined) return null;
    let url;
    try {
      url = new win.URL(String(value).trim());
    } catch (error) {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  }

  /** 请平台在新窗口打开外链（平台会先让访问者确认目标域名）。只接受 https:。 */
  function openLink(value) {
    const url = normalizeHttps(value);
    if (url === null) {
      warn('openLink 只接受完整的 https:// 链接，已忽略：' + String(value));
      return false;
    }
    try {
      win.parent.postMessage({ type: OPEN_LINK_TYPE, url: url }, '*');
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  function isNativelyFocusable(el) {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href');
    return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY';
  }

  /** 原生元素在按键时会自己触发 click（不需要再模拟）。 */
  function activatesNatively(el, key) {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return /^(button|submit|reset|checkbox|radio)$/i.test(el.type || '');
    if (tag === 'A' && el.hasAttribute('href')) return key === 'Enter';
    return false;
  }

  function makeInteractive(el, role) {
    if (!el.hasAttribute('role') && !(role === 'button' && el.tagName === 'BUTTON')) el.setAttribute('role', role);
    if (!el.hasAttribute('tabindex') && !isNativelyFocusable(el)) el.setAttribute('tabindex', '0');
  }

  function decorateLinks(scope) {
    all(scope, LINK_SELECTOR).forEach(function (el) {
      makeInteractive(el, 'link');
      if (normalizeHttps(el.getAttribute('data-nm-href')) === null) {
        el.setAttribute('aria-disabled', 'true');
        warn('data-nm-href 只接受完整的 https:// 链接：' + String(el.getAttribute('data-nm-href')));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 滚动渐显与数字滚动
  // ---------------------------------------------------------------------------

  let revealObserver = null;
  let countObserver = null;

  function show(el) {
    el.classList.add('is-visible');
  }

  function applyStagger(scope) {
    all(scope, '[data-nm-stagger]').forEach(function (parent) {
      const step = readNumber(parent.getAttribute('data-nm-stagger'), 90) || 90;
      let index = 0;
      toArray(parent.children).forEach(function (child) {
        if (!child.classList.contains('nm-reveal')) return;
        child.style.setProperty('--nm-delay', Math.round(index * step) + 'ms');
        index += 1;
      });
    });
  }

  function initReveal(scope) {
    applyStagger(scope);
    const items = all(scope, '.nm-reveal').filter(function (el) {
      return !el.classList.contains('is-visible');
    });
    if (items.length === 0) return;
    if (prefersReducedMotion() || typeof win.IntersectionObserver !== 'function') {
      items.forEach(show);
      return;
    }
    if (revealObserver === null) {
      revealObserver = new win.IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            show(entry.target);
            revealObserver.unobserve(entry.target);
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0 },
      );
    }
    items.forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /** 立刻显示所有 .nm-reveal（截图、打印或减少动效时）。 */
  function revealAll(scope) {
    all(scope, '.nm-reveal').forEach(function (el) {
      show(el);
      if (revealObserver !== null) revealObserver.unobserve(el);
    });
  }

  /** 数字从 0 滚到目标值；静态文字就是最终值，减少动效时不动。返回是否开始了动画。 */
  function countUp(el, options) {
    const opts = Object.assign({ duration: 1400 }, options || {});
    const finalText = el.textContent;
    const source = el.getAttribute('data-nm-count') || finalText || '';
    const target = parseFloat(String(source).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(target) || prefersReducedMotion() || raf === null) return false;
    const decimals = (String(source).split('.')[1] || '').replace(/[^0-9]/g, '').length;
    const start = now();
    function frame(time) {
      const progress = Math.min(1, (time - start) / opts.duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      if (progress < 1 && !prefersReducedMotion()) {
        el.textContent = (target * eased).toFixed(decimals);
        raf(frame);
      } else {
        el.textContent = finalText;
      }
    }
    raf(frame);
    return true;
  }

  function initCounts(scope) {
    const items = all(scope, '[data-nm-count]').filter(claim);
    if (items.length === 0 || prefersReducedMotion() || typeof win.IntersectionObserver !== 'function') return;
    if (countObserver === null) {
      countObserver = new win.IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            countObserver.unobserve(entry.target);
            countUp(entry.target);
          });
        },
        { threshold: 0.4 },
      );
    }
    items.forEach(function (el) {
      countObserver.observe(el);
    });
  }

  // ---------------------------------------------------------------------------
  // 跑马灯
  // ---------------------------------------------------------------------------

  function cloneDecorative(node) {
    const copy = node.cloneNode(true);
    if (isElement(copy)) {
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('inert', '');
      [copy].concat(toArray(copy.querySelectorAll('[id],[data-nm-id],[tabindex],[data-nm-href]'))).forEach(function (el) {
        el.removeAttribute('id');
        el.removeAttribute('data-nm-id');
        if (el.hasAttribute('data-nm-href') || el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      });
    }
    return copy;
  }

  function initMarquee(el) {
    const track = el.querySelector('.nm-marquee__track');
    if (!track || !claim(track)) return;
    const originals = toArray(track.children);
    if (originals.length === 0) return;
    const width = el.clientWidth || 0;
    let guard = 0;
    while (width > 0 && track.scrollWidth < width && guard < 12) {
      originals.forEach(function (item) {
        track.appendChild(cloneDecorative(item));
      });
      guard += 1;
    }
    toArray(track.children).forEach(function (item) {
      track.appendChild(cloneDecorative(item));
    });
  }

  // ---------------------------------------------------------------------------
  // 打字机
  // ---------------------------------------------------------------------------

  function readPhrases(el) {
    const children = toArray(el.children);
    const phrases = children.length > 0
      ? children.map(function (child) { return child.textContent.trim(); })
      : [el.textContent.trim()];
    return phrases.filter(Boolean);
  }

  /**
   * 轮流打出几句话。phrases 省略时读取 el 的子元素。
   * options：typeSpeed / deleteSpeed / pause（毫秒）、loop（默认 true）。
   * 减少动效时直接显示第一句。返回 { stop() }。
   */
  function typewriter(el, phrases, options) {
    if (!isElement(el)) throw new TypeError('nowme.typewriter 需要一个元素');
    const list = (Array.isArray(phrases) && phrases.length > 0 ? phrases : readPhrases(el)).map(String).filter(Boolean);
    const opts = Object.assign({ typeSpeed: 70, deleteSpeed: 35, pause: 1700, startDelay: 400, loop: true }, options || {});
    let timer = 0;
    let stopped = false;
    const controller = {
      stop: function () {
        stopped = true;
        win.clearTimeout(timer);
      },
    };
    if (list.length === 0) return controller;

    if (!el.hasAttribute('aria-hidden') && el.parentNode) {
      const label = doc.createElement('span');
      label.className = 'nm-sr-only';
      label.textContent = list.join(' / ');
      el.parentNode.insertBefore(label, el);
      el.setAttribute('aria-hidden', 'true');
    }

    if (prefersReducedMotion()) {
      if (Array.isArray(phrases) && phrases.length > 0) el.textContent = list[0];
      el.classList.add('is-done');
      return controller;
    }

    let phraseIndex = 0;
    let length = 0;
    let deleting = false;

    function finish(text) {
      el.textContent = text;
      el.classList.add('is-done');
    }

    function tick() {
      if (stopped) return;
      const phrase = list[phraseIndex];
      if (prefersReducedMotion()) {
        finish(phrase);
        return;
      }
      const chars = Array.from(phrase);
      if (!deleting) {
        length += 1;
        el.textContent = chars.slice(0, length).join('');
        if (length < chars.length) {
          timer = win.setTimeout(tick, opts.typeSpeed);
        } else if (!opts.loop && phraseIndex === list.length - 1) {
          finish(phrase);
        } else {
          deleting = true;
          timer = win.setTimeout(tick, opts.pause);
        }
      } else {
        length -= 1;
        el.textContent = chars.slice(0, Math.max(0, length)).join('');
        if (length > 0) {
          timer = win.setTimeout(tick, opts.deleteSpeed);
        } else {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % list.length;
          timer = win.setTimeout(tick, opts.typeSpeed * 4);
        }
      }
    }

    el.textContent = '';
    timer = win.setTimeout(tick, opts.startDelay);
    return controller;
  }

  // ---------------------------------------------------------------------------
  // Canvas：粒子背景
  // ---------------------------------------------------------------------------

  const PARTICLE_PRESETS = {
    stars: { count: 90, speed: 0.04, size: [0.4, 1.7], twinkle: true },
    snow: { count: 70, speed: 0.5, size: [1, 3], fall: 1 },
    bubbles: { count: 24, speed: 0.35, size: [4, 14], fall: -1, ring: true },
    dust: { count: 60, speed: 0.12, size: [0.6, 2.2], twinkle: true },
    links: { count: 44, speed: 0.22, size: [1, 2.2], links: 110 },
  };

  /**
   * 在 canvas 上画粒子背景。options：preset、color、count、speed、seed。
   * 减少动效时只画一帧静态画面；不在视口内或页面隐藏时暂停。返回 { start(), stop(), redraw() }。
   */
  function particles(canvas, options) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('nowme.particles 需要一个 <canvas>');
    const opts = Object.assign({ preset: canvas.getAttribute('data-nm-particles') || 'stars' }, options || {});
    const config = Object.assign({}, PARTICLE_PRESETS[opts.preset] || PARTICLE_PRESETS.stars, opts);
    const ctx = canvas.getContext('2d');
    let running = false;
    let visible = true;
    let frameId = 0;
    let width = 0;
    let height = 0;
    let items = [];
    let pointer = null;

    function redraw() {
      draw(0);
    }

    function stop() {
      running = false;
      caf(frameId);
    }

    function start() {
      if (running || ctx === null || raf === null || prefersReducedMotion() || !visible || doc.hidden) return;
      running = true;
      frameId = raf(loop);
    }

    const controller = { start: start, stop: stop, redraw: redraw };
    if (ctx === null) return controller;

    const random = rng(config.seed === undefined ? opts.preset : config.seed);
    const color = config.color || canvas.getAttribute('data-nm-color') || cssValue(canvas, 'color', '#ffffff');
    canvas.setAttribute('aria-hidden', 'true');

    function between(range) {
      return range[0] + random() * (range[1] - range[0]);
    }

    function seed() {
      const area = Math.max(0.35, Math.min(2.5, (width * height) / (375 * 667)));
      const count = Math.round((config.count || 60) * area * motionScale());
      items = [];
      for (let index = 0; index < count; index += 1) {
        const angle = random() * Math.PI * 2;
        items.push({
          x: random() * width,
          y: random() * height,
          r: between(config.size),
          vx: Math.cos(angle) * config.speed,
          vy: config.fall ? config.fall * config.speed * (0.6 + random()) : Math.sin(angle) * config.speed,
          phase: random() * Math.PI * 2,
        });
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(win.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, rect.width || canvas.clientWidth || 300);
      const nextHeight = Math.max(1, rect.height || canvas.clientHeight || 150);
      const changed = Math.abs(nextWidth - width) > 1 || Math.abs(nextHeight - height) > 1;
      width = nextWidth;
      height = nextHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (changed || items.length === 0) seed();
      draw(0);
    }

    function step() {
      items.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        if (config.fall) p.x += Math.sin((p.y + p.phase * 40) / 40) * 0.25;
        if (p.x < -20) p.x = width + 20;
        if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        if (p.y > height + 20) p.y = -20;
      });
    }

    function draw(time) {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (config.links) {
        const max = config.links;
        ctx.lineWidth = 0.6;
        for (let a = 0; a < items.length; a += 1) {
          for (let b = a + 1; b < items.length; b += 1) {
            const dx = items[a].x - items[b].x;
            const dy = items[a].y - items[b].y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > max) continue;
            ctx.globalAlpha = (1 - distance / max) * 0.5;
            ctx.beginPath();
            ctx.moveTo(items[a].x, items[a].y);
            ctx.lineTo(items[b].x, items[b].y);
            ctx.stroke();
          }
          if (pointer !== null) {
            const px = items[a].x - pointer.x;
            const py = items[a].y - pointer.y;
            const reach = Math.sqrt(px * px + py * py);
            if (reach < max * 1.4) {
              ctx.globalAlpha = (1 - reach / (max * 1.4)) * 0.8;
              ctx.beginPath();
              ctx.moveTo(items[a].x, items[a].y);
              ctx.lineTo(pointer.x, pointer.y);
              ctx.stroke();
            }
          }
        }
      }
      items.forEach(function (p) {
        const twinkle = config.twinkle ? 0.55 + 0.45 * Math.sin(time / 700 + p.phase) : 0.85;
        ctx.globalAlpha = twinkle;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (config.ring) {
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
    }

    function loop(time) {
      if (!running) return;
      step();
      draw(time);
      frameId = raf(loop);
    }

    if (typeof win.ResizeObserver === 'function') {
      new win.ResizeObserver(function () {
        safely(resize);
      }).observe(canvas);
    } else {
      win.addEventListener('resize', function () {
        safely(resize);
      });
    }
    if (typeof win.IntersectionObserver === 'function') {
      new win.IntersectionObserver(function (entries) {
        visible = entries.some(function (entry) {
          return entry.isIntersecting;
        });
        if (visible) start();
        else stop();
      }).observe(canvas);
    }
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) stop();
      else start();
    });
    if (config.links) {
      win.addEventListener('pointermove', function (event) {
        const rect = canvas.getBoundingClientRect();
        pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        if (!running) redraw();
      });
    }
    onReducedMotionChange(function (reduced) {
      if (reduced) {
        stop();
        redraw();
      } else {
        start();
      }
    });

    resize();
    start();
    return controller;
  }

  // ---------------------------------------------------------------------------
  // Canvas：彩纸
  // ---------------------------------------------------------------------------

  /**
   * 撒一次彩纸。options：x、y（视口坐标，默认上方居中）、count、spread（角度）、colors。
   * 减少动效时不撒，返回 false。
   */
  function confetti(options) {
    if (prefersReducedMotion() || raf === null || !doc.body) return false;
    const opts = options || {};
    const viewWidth = win.innerWidth || root.clientWidth || 375;
    const viewHeight = win.innerHeight || root.clientHeight || 667;
    const x = readNumber(opts.x, viewWidth / 2);
    const y = readNumber(opts.y, viewHeight * 0.35);
    const count = Math.round(readNumber(opts.count, 110) * motionScale());
    const spread = readNumber(opts.spread, 75) * (Math.PI / 180);
    const colors = Array.isArray(opts.colors) && opts.colors.length > 0
      ? opts.colors
      : [cssValue(root, '--nm-accent', '#ff4f9a'), cssValue(root, '--nm-accent-2', '#3d7bff'), cssValue(root, '--nm-accent-3', '#ffd23f'), '#ffffff'];

    const canvas = doc.createElement('canvas');
    canvas.className = 'nm-confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return false;
    doc.body.appendChild(canvas);
    const ratio = Math.min(win.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewWidth * ratio);
    canvas.height = Math.round(viewHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const pieces = [];
    for (let index = 0; index < count; index += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const speed = 7 + Math.random() * 9;
      pieces.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.4,
        color: colors[index % colors.length],
        round: Math.random() < 0.3,
      });
    }
    const started = now();

    function frame(time) {
      const age = time - started;
      ctx.clearRect(0, 0, viewWidth, viewHeight);
      let alive = 0;
      pieces.forEach(function (p) {
        p.vy += 0.32;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;
        if (p.y > viewHeight + 40) return;
        alive += 1;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age / 3200);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rotation * 2)));
        }
        ctx.restore();
      });
      if (alive > 0 && age < 3200 && !prefersReducedMotion()) raf(frame);
      else if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    raf(frame);
    return true;
  }

  function burstFrom(el, event) {
    let x;
    let y;
    if (event && event.detail > 0 && (event.clientX || event.clientY)) {
      x = event.clientX;
      y = event.clientY;
    } else {
      const rect = el.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }
    const options = { x: x, y: y };
    const count = readNumber(el.getAttribute('data-nm-confetti'), NaN);
    if (Number.isFinite(count) && count > 0) options.count = count;
    confetti(options);
  }

  // ---------------------------------------------------------------------------
  // 交互小组件：翻面、轮换、倾斜、拖动
  // ---------------------------------------------------------------------------

  function initFlip(el) {
    if (!claim(el)) return;
    makeInteractive(el, 'button');
    el.setAttribute('aria-pressed', el.classList.contains('is-flipped') ? 'true' : 'false');
  }

  function toggleFlip(el) {
    const flipped = el.classList.toggle('is-flipped');
    el.setAttribute('aria-pressed', flipped ? 'true' : 'false');
  }

  function initCycle(el) {
    if (!claim(el)) return;
    const items = toArray(el.children);
    if (items.length === 0) return;
    if (!items.some(function (item) { return item.classList.contains('is-active'); })) items[0].classList.add('is-active');
    makeInteractive(el, 'button');
    el.setAttribute('aria-live', 'polite');
  }

  function advanceCycle(el) {
    const items = toArray(el.children);
    if (items.length < 2) return;
    const current = items.findIndex(function (item) {
      return item.classList.contains('is-active');
    });
    let next = (current + 1) % items.length;
    if (el.getAttribute('data-nm-cycle') === 'random') {
      next = Math.floor(Math.random() * (items.length - 1));
      if (next >= current) next += 1;
    }
    if (current >= 0) items[current].classList.remove('is-active');
    items[next].classList.add('is-active');
    el.dispatchEvent(new win.CustomEvent('nm:cycle', { bubbles: true, detail: { index: next } }));
  }

  function initTilt(el) {
    if (!claim(el)) return;
    const max = readNumber(el.getAttribute('data-nm-tilt'), 10) || 10;
    el.addEventListener('pointermove', function (event) {
      if (prefersReducedMotion() || event.pointerType === 'touch') return;
      const rect = el.getBoundingClientRect();
      const px = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
      const py = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
      el.style.setProperty('--nm-ry', (px * max * 2).toFixed(2) + 'deg');
      el.style.setProperty('--nm-rx', (-py * max * 2).toFixed(2) + 'deg');
    });
    el.addEventListener('pointerleave', function () {
      el.style.setProperty('--nm-rx', '0deg');
      el.style.setProperty('--nm-ry', '0deg');
    });
  }

  function initDrag(el) {
    if (!claim(el)) return;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    let currentX = 0;
    let currentY = 0;
    el.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      if (typeof el.setPointerCapture === 'function') safely(function () { el.setPointerCapture(pointerId); });
      el.classList.add('is-dragging');
      event.preventDefault();
    });
    el.addEventListener('pointermove', function (event) {
      if (event.pointerId !== pointerId) return;
      currentX = baseX + event.clientX - startX;
      currentY = baseY + event.clientY - startY;
      el.style.translate = currentX + 'px ' + currentY + 'px';
    });
    function end(event) {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      baseX = currentX;
      baseY = currentY;
      el.classList.remove('is-dragging');
      el.dispatchEvent(new win.CustomEvent('nm:drop', { bubbles: true, detail: { x: baseX, y: baseY } }));
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------------------
  // 事件委托（点击与键盘）
  // ---------------------------------------------------------------------------

  doc.addEventListener('click', function (event) {
    const confettiEl = closest(event.target, '[data-nm-confetti]');
    if (confettiEl) safely(function () { burstFrom(confettiEl, event); });

    const link = closest(event.target, LINK_SELECTOR);
    if (link) {
      event.preventDefault();
      openLink(link.getAttribute('data-nm-href'));
      return;
    }
    const flip = closest(event.target, '[data-nm-flip]');
    if (flip) toggleFlip(flip);
    const cycle = closest(event.target, '[data-nm-cycle]');
    if (cycle) advanceCycle(cycle);
  });

  doc.addEventListener('keydown', function (event) {
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const el = event.target;
    if (!isElement(el)) return;
    if (!el.matches(LINK_SELECTOR + ',[data-nm-flip],[data-nm-cycle],[data-nm-confetti]')) return;
    if (activatesNatively(el, event.key)) return;
    event.preventDefault();
    el.click();
  });

  // ---------------------------------------------------------------------------
  // 初始化
  // ---------------------------------------------------------------------------

  function typewriterOptions(el) {
    const options = {};
    if (el.getAttribute('data-nm-typewriter') === 'once') options.loop = false;
    const speed = readNumber(el.getAttribute('data-nm-speed'), NaN);
    if (Number.isFinite(speed) && speed > 0) options.typeSpeed = speed;
    return options;
  }

  /** 扫描 scope（默认整个文档）里的 Kit 组件并初始化；重复调用是安全的。 */
  function refresh(scope) {
    safely(function () { decorateLinks(scope); });
    all(scope, '[data-nm-flip]').forEach(function (el) { safely(function () { initFlip(el); }); });
    all(scope, '[data-nm-cycle]').forEach(function (el) { safely(function () { initCycle(el); }); });
    all(scope, '.nm-marquee').forEach(function (el) { safely(function () { initMarquee(el); }); });
    safely(function () { initReveal(scope); });
    safely(function () { initCounts(scope); });
    all(scope, '[data-nm-typewriter]').forEach(function (el) {
      if (claim(el)) safely(function () { typewriter(el, null, typewriterOptions(el)); });
    });
    all(scope, 'canvas[data-nm-particles]').forEach(function (el) {
      if (claim(el)) safely(function () { particles(el); });
    });
    all(scope, '[data-nm-tilt]').forEach(function (el) { safely(function () { initTilt(el); }); });
    all(scope, '[data-nm-drag]').forEach(function (el) { safely(function () { initDrag(el); }); });
  }

  const readyCallbacks = [];
  let booted = false;

  function ready(callback) {
    if (typeof callback !== 'function') throw new TypeError('nowme.ready 需要传入一个函数');
    if (booted) safely(function () { callback(api); });
    else readyCallbacks.push(callback);
  }

  function watchInsertions() {
    if (typeof win.MutationObserver !== 'function' || !doc.body) return;
    new win.MutationObserver(function (records) {
      records.forEach(function (record) {
        toArray(record.addedNodes).forEach(function (node) {
          if (isElement(node) && !node.hasAttribute('inert')) refresh(node);
        });
      });
    }).observe(doc.body, { childList: true, subtree: true });
  }

  function boot() {
    if (booted) return;
    refresh(doc);
    booted = true;
    watchInsertions();
    readyCallbacks.splice(0).forEach(function (callback) {
      safely(function () { callback(api); });
    });
  }

  onReducedMotionChange(function (reduced) {
    if (reduced) revealAll(doc);
  });

  const api = {
    version: '1',
    openLink: openLink,
    onReducedMotionChange: onReducedMotionChange,
    ready: ready,
    refresh: refresh,
    revealAll: revealAll,
    typewriter: typewriter,
    particles: particles,
    confetti: confetti,
    countUp: countUp,
    rng: rng,
  };
  Object.defineProperty(api, 'reducedMotion', { enumerable: true, get: prefersReducedMotion });
  Object.defineProperty(api, 'motionLevel', { enumerable: true, get: motionLevel });
  Object.freeze(api);
  window.nowme = api;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window, document);
