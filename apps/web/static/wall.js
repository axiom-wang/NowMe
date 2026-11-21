/*
 * 墙上的搜索与按回答筛选（主站 CSP 不允许内联脚本）：在浏览器里筛选已经加载的卡片，不发请求。
 * - 搜索：按名字、一行介绍、接话点、回答；多个词用空格隔开，全部命中才显示。
 * - 筛选（contracts 19.1）：点必答题的选项；同一道题里选了几个就是“任一”，不同题之间是“同时满足”。
 * 没有脚本时搜索框与筛选按钮不起作用，墙照常浏览。
 */
(function () {
  'use strict';
  var board = document.querySelector('[data-wall-board]');
  if (!board) return;
  var input = board.querySelector('[data-wall-search]');
  var filterButtons = Array.prototype.slice.call(board.querySelectorAll('[data-filter]'));
  var clear = board.querySelector('[data-filter-clear]');
  if (!input && filterButtons.length === 0) return;
  var cards = Array.prototype.slice.call(board.querySelectorAll('[data-wall-card]'));
  var count = board.querySelector('[data-wall-count]');
  var countNote = board.querySelector('[data-wall-count-note]');
  var summary = board.querySelector('[data-wall-summary]');
  var defaultCountNote = countNote ? countNote.textContent : '';
  var none = board.querySelector('[data-wall-none]');
  var statusEl = board.querySelector('[data-wall-status]');
  var statusTimer = null;

  /** 选中的筛选：题目位置 → 选项编号的集合。 */
  function selectedFilters() {
    var groups = {};
    filterButtons.forEach(function (button) {
      if (button.getAttribute('aria-pressed') !== 'true') return;
      var key = button.getAttribute('data-filter') || '';
      var question = key.split(':')[0];
      (groups[question] = groups[question] || []).push(key);
    });
    return groups;
  }

  function apply() {
    var terms = input ? input.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
    var groups = selectedFilters();
    var questions = Object.keys(groups);
    var shown = 0;
    cards.forEach(function (card) {
      var text = card.getAttribute('data-search') || '';
      var keys = (card.getAttribute('data-answers') || '').split(' ');
      var match =
        terms.every(function (term) {
          return text.indexOf(term) >= 0;
        }) &&
        questions.every(function (question) {
          return groups[question].some(function (key) {
            return keys.indexOf(key) >= 0;
          });
        });
      card.hidden = !match;
      if (match) shown += 1;
    });
    var filtering = terms.length > 0 || questions.length > 0;
    board.classList.add('is-settled');
    board.classList.toggle('is-filtering', filtering);
    if (count) count.textContent = String(shown);
    if (countNote) countNote.textContent = filtering ? '位符合条件' : defaultCountNote;
    if (summary) summary.hidden = filtering;
    if (none) none.hidden = shown > 0;
    if (clear) clear.hidden = questions.length === 0;
    // 给读屏的结果播报：停下来 0.4 秒后再说，避免每敲一个字都播报
    if (statusEl) {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(function () {
        statusEl.textContent = filtering ? (shown > 0 ? '找到 ' + shown + ' 位' : '没有找到相关的人') : '';
      }, 400);
    }
    // 逛墙空间按筛选结果重新排布
    board.dispatchEvent(new CustomEvent('wall:filtered'));
  }

  if (input) input.addEventListener('input', apply);
  filterButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      apply();
    });
  });
  if (clear) {
    clear.addEventListener('click', function () {
      filterButtons.forEach(function (button) {
        button.setAttribute('aria-pressed', 'false');
      });
      apply();
    });
  }
  // 浏览器后退时会恢复输入框里的字：按恢复后的内容再筛一次
  window.addEventListener('pageshow', function () {
    if (input && input.value) apply();
  });
})();

/*
 * AI 介绍给你的人（contracts 20）：第一次进墙时自动请 AI 介绍一次。
 * 服务端只在“这面墙从没发起过”时给表单加 data-intro-auto；这里在页面加载后把它提交一次（同源，带 CSRF），
 * 拿到的区块 HTML 原地替换，不打断浏览。失败（网络、超时）时恢复成按钮，不自动重试。
 * 没有脚本时它就是一个普通按钮。
 */
(function () {
  'use strict';
  var form = document.querySelector('form[data-intro-auto]');
  if (!form || typeof window.fetch !== 'function') return;
  var scope = form.closest('[data-intros]');
  if (!scope) return;
  var status = scope.querySelector('[data-busy-status]');
  var buttons = Array.prototype.slice.call(scope.querySelectorAll('button'));

  function setBusy(on) {
    scope.classList.toggle('is-busy', on);
    if (on) scope.setAttribute('aria-busy', 'true');
    else scope.removeAttribute('aria-busy');
    buttons.forEach(function (button) {
      button.disabled = on;
    });
    if (status) status.textContent = on ? form.getAttribute('data-busy-label') || '' : '';
  }

  var body = new URLSearchParams(new FormData(form));
  body.set('fragment', '1');
  setBusy(true);
  fetch(form.action, { method: 'POST', body: body, credentials: 'same-origin', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(120000) })
    .then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    })
    .then(function (html) {
      var holder = document.createElement('div');
      holder.innerHTML = html;
      var next = holder.querySelector('[data-intros]');
      if (!next) throw new Error('fragment');
      scope.replaceWith(next);
      // 墙上被介绍的人的卡片也打上标记（与刷新后服务端渲染的一致）
      (next.getAttribute('data-intro-pages') || '').split(' ').filter(Boolean).forEach(function (pageId) {
        document.querySelectorAll('[data-wall-card] a.wall-card__link[href$="/p/' + pageId + '"] .wall-card__poster').forEach(function (poster) {
          if (poster.querySelector('.wall-card__talk')) return;
          var badge = document.createElement('span');
          badge.className = 'wall-card__talk wall-card__talk--intro';
          badge.textContent = '✦ AI 介绍';
          poster.appendChild(badge);
        });
      });
      var heading = next.querySelector('h2');
      var live = next.querySelector('[data-busy-status]');
      // 只给读屏播报“结果出来了”，不在页面上多显示一行
      if (live && heading) {
        live.classList.add('visually-hidden');
        live.textContent = heading.textContent || '';
      }
    })
    .catch(function () {
      setBusy(false);
      if (status) status.textContent = '这次没连上，点上面的按钮再试一次。';
    });
})();


/*
 * 逛墙空间：把墙上的海报排成一面可以拖动、缩放的墙。
 * - 桌面：墙在左，右边一栏一直显示一个人的详情（一进来是第一位成员），点海报换人；
 * - 手机：一屏大约两列海报，边上露出下一列；点海报时镜头靠近、居中，底部升起资料卡；
 *   关掉（×、Esc 或往下拖）后镜头回到刚才的位置和缩放；“回到全墙”一键看全部。
 * - 只重新排布服务端已经输出的卡片与 <template> 详情，不发请求、不运行页面；“想聊这个”就是成员页上的同一个表单；
 * - 拖动、滚轮 / 触控板、双指、方向键和 +/- 都能逛；松手后带一点惯性，海报随移动轻轻摆动；
 * - “已探索”只记在本机 localStorage，不上报，对方也不会知道；
 * - 没有脚本时就是原来的网格；减少动态效果时不做惯性、摆动与过渡。
 */
(function () {
  'use strict';
  var root = document.documentElement;
  var board = document.querySelector('[data-wall-board]');
  var space = board ? board.querySelector('[data-wall-space]') : null;
  if (!space || typeof window.requestAnimationFrame !== 'function') {
    // 墙上还没有人：wall-boot.js 打的空间标记不适用
    root.classList.remove('nm-wall-space');
    return;
  }
  var stage = space.querySelector('.wall-space__stage');
  var viewport = space.querySelector('[data-space-viewport]');
  var track = space.querySelector('[data-space-track]');
  var light = space.querySelector('[data-space-light]');
  var hud = space.querySelector('[data-space-hud]');
  var panel = space.querySelector('[data-space-panel]');
  if (!stage || !viewport || !track || !hud || !panel) {
    root.classList.remove('nm-wall-space');
    return;
  }

  var wide = window.matchMedia('(min-width: 1000px)');
  var sheet = panel.querySelector('[data-space-card]');
  var grip = panel.querySelector('[data-space-grip]');
  var coverBox = panel.querySelector('[data-space-cover]');
  var detailBox = panel.querySelector('[data-space-detail]');
  var chat = panel.querySelector('[data-space-chat]');
  var hookField = panel.querySelector('[data-space-hook]');
  var openLink = panel.querySelector('[data-space-open]');
  var openLabel = panel.querySelector('[data-space-open-label]');
  var exploredCount = hud.querySelector('[data-space-explored]');
  var totalCount = hud.querySelector('[data-space-total]');
  var meter = hud.querySelector('[data-space-meter]');
  var searchToggle = board.querySelector('[data-space-search-toggle]');
  var searchInput = board.querySelector('[data-wall-search]');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  var wallId = board.getAttribute('data-wall-id') || '';
  var EXPLORED_KEY = 'nowme:wall-explored:' + wallId;
  var EDGE = 24;
  var MIN_SCALE = 0.4;
  var MAX_SCALE = 1.9;

  function read(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (_) { /* 隐私模式等：不记也能用 */ }
  }

  var cards = Array.prototype.slice.call(track.querySelectorAll('[data-wall-card]'));
  var active = false;
  var selected = null;
  var cam = { x: 0, y: 0, s: 1 };
  var base = 1;
  var whole = 1;
  var size = { vw: 0, vh: 0, cw: 0, ch: 0 };
  var frame = 0;
  var motion = null;
  // 手机上打开资料卡前的镜头：关掉后回到这里
  var returnCam = null;

  // ---- 探索进度（只在本机） ----
  var explored = {};
  (function () {
    var saved = read(EXPLORED_KEY);
    if (!saved) return;
    try {
      JSON.parse(saved).forEach(function (id) { if (typeof id === 'string') explored[id] = true; });
    } catch (_) { /* 坏数据就从头算 */ }
  })();
  function updateExplored() {
    var seen = 0;
    cards.forEach(function (card) {
      var id = card.getAttribute('data-page-id') || '';
      var on = !!explored[id];
      card.classList.toggle('is-explored', on);
      if (on) seen += 1;
    });
    exploredCount.textContent = String(seen);
    totalCount.textContent = String(cards.length);
    meter.style.setProperty('--explored', cards.length ? String(seen / cards.length) : '0');
  }
  function markExplored(card) {
    var id = card.getAttribute('data-page-id') || '';
    if (!id || explored[id]) return;
    explored[id] = true;
    var ids = cards.map(function (item) { return item.getAttribute('data-page-id') || ''; }).filter(function (item) { return explored[item]; });
    write(EXPLORED_KEY, JSON.stringify(ids));
    updateExplored();
  }

  // ---- 镜头 ----
  /** 手机上资料卡开着时，镜头可以越过墙边一些，让靠边的海报也能居中。 */
  function slack() {
    return !wide.matches && selected ? Math.max(size.vw, size.vh) * 0.6 : 0;
  }
  function clampAxis(value, view, content, extra) {
    if (content <= view - EDGE * 2) {
      var middle = (view - content) / 2;
      return Math.min(middle + extra, Math.max(middle - extra, value));
    }
    return Math.min(EDGE + extra, Math.max(view - content - EDGE - extra, value));
  }
  function minScale() {
    return Math.min(MIN_SCALE, base, whole);
  }
  function clamp() {
    var extra = slack();
    cam.s = Math.min(MAX_SCALE, Math.max(minScale(), cam.s));
    cam.x = clampAxis(cam.x, size.vw, size.cw * cam.s, extra);
    cam.y = clampAxis(cam.y, size.vh, size.ch * cam.s, extra);
  }
  var sway = 0;
  function render() {
    frame = 0;
    track.style.transform = 'translate3d(' + cam.x.toFixed(2) + 'px,' + cam.y.toFixed(2) + 'px,0) scale(' + cam.s.toFixed(4) + ')';
    track.style.setProperty('--sway', sway.toFixed(3));
    // 墙面的纸纹随镜头一起移动、缩放，看起来是整面墙在动
    stage.style.setProperty('--pan-x', cam.x.toFixed(1) + 'px');
    stage.style.setProperty('--pan-y', cam.y.toFixed(1) + 'px');
    stage.style.setProperty('--pan-s', cam.s.toFixed(3));
  }
  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(render);
  }
  function stopMotion() {
    if (motion) window.cancelAnimationFrame(motion.id);
    motion = null;
  }
  function settleSway() {
    if (reduced.matches || Math.abs(sway) < 0.01) { sway = 0; schedule(); return; }
    sway *= 0.82;
    schedule();
    window.requestAnimationFrame(settleSway);
  }
  /** 平滑移动到目标位置（减少动态效果时直接跳过去）。 */
  function animateTo(x, y, s, duration) {
    stopMotion();
    var from = { x: cam.x, y: cam.y, s: cam.s };
    // 先按目标缩放算出合法位置
    cam.x = x; cam.y = y; cam.s = s; clamp();
    var target = { x: cam.x, y: cam.y, s: cam.s };
    cam.x = from.x; cam.y = from.y; cam.s = from.s;
    if (reduced.matches) {
      cam.x = target.x; cam.y = target.y; cam.s = target.s;
      schedule();
      return;
    }
    var start = performance.now();
    var length = duration || 420;
    motion = { id: 0 };
    function step(now) {
      var t = Math.min(1, (now - start) / length);
      var e = 1 - Math.pow(1 - t, 3);
      cam.x = from.x + (target.x - from.x) * e;
      cam.y = from.y + (target.y - from.y) * e;
      cam.s = from.s + (target.s - from.s) * e;
      render();
      if (t < 1 && motion) motion.id = window.requestAnimationFrame(step);
      else motion = null;
    }
    motion.id = window.requestAnimationFrame(step);
  }
  function zoomAt(px, py, nextScale, smooth) {
    var limit = Math.min(MAX_SCALE, Math.max(minScale(), nextScale));
    var wx = (px - cam.x) / cam.s;
    var wy = (py - cam.y) / cam.s;
    var x = px - wx * limit;
    var y = py - wy * limit;
    if (smooth) { animateTo(x, y, limit); return; }
    stopMotion();
    cam.s = limit; cam.x = x; cam.y = y;
    clamp();
    schedule();
  }
  /** 卡片在墙面坐标里的位置（不受 transform 影响）。 */
  function boxOf(card) {
    return { x: card.offsetLeft, y: card.offsetTop, w: card.offsetWidth, h: card.offsetHeight };
  }
  /** 把一张海报移进可见范围（已经完整可见就不动）。 */
  function reveal(card) {
    var box = boxOf(card);
    var left = cam.x + box.x * cam.s;
    var right = left + box.w * cam.s;
    var top = cam.y + box.y * cam.s;
    var bottom = top + box.h * cam.s;
    var x = cam.x;
    var y = cam.y;
    if (left < EDGE) x += EDGE - left;
    else if (right > size.vw - EDGE) x -= right - (size.vw - EDGE);
    if (top < 0) y -= top;
    else if (bottom > size.vh) y -= bottom - size.vh;
    if (Math.abs(x - cam.x) > 1 || Math.abs(y - cam.y) > 1) animateTo(x, y, cam.s);
  }
  /** 手机：镜头靠近这张海报，放在资料卡上方那块地方的正中（页面本身不滚动）。 */
  function focusOn(card) {
    var box = boxOf(card);
    var rect = viewport.getBoundingClientRect();
    var sheetTop = window.innerHeight - panel.offsetHeight;
    var visible = Math.max(120, Math.min(rect.bottom, sheetTop) - rect.top);
    var s = Math.min(MAX_SCALE, (size.vw * 0.62) / box.w, (visible - 24) / box.h);
    var x = size.vw / 2 - (box.x + box.w / 2) * s;
    var y = visible / 2 - (box.y + box.h / 2) * s;
    animateTo(x, y, s, 520);
  }
  /** 回到全墙：整面墙都放进视野。 */
  function showWhole() {
    animateTo((size.vw - size.cw * whole) / 2, (size.vh - size.ch * whole) / 2, whole, 520);
  }

  // ---- 排布 ----
  /** 舞台高度：从舞台顶部铺到首屏底部（手机上让出底部导航），太矮时保底。 */
  var fittedFor = '';
  function fitStage() {
    var nav = document.querySelector('.site-nav');
    var navHeight = nav && window.getComputedStyle(nav).position === 'fixed' ? nav.offsetHeight : 0;
    var top = stage.getBoundingClientRect().top + window.scrollY;
    // 手机地址栏收起 / 展开只改变一点高度：宽度没变且高度变化不大时不重排，避免抖动
    var key = window.innerWidth + 'x' + Math.round(window.innerHeight / 120) + (wide.matches ? 'w' : 'n');
    if (key === fittedFor && stage.style.height) return;
    fittedFor = key;
    var floor = wide.matches ? 420 : 320;
    var height = Math.max(floor, window.innerHeight - top - navHeight);
    stage.style.height = Math.round(height) + 'px';
  }
  function shown(item) {
    return !item.hidden && window.getComputedStyle(item).display !== 'none';
  }
  function layout(keep) {
    if (!active) return;
    fitStage();
    var items = Array.prototype.filter.call(track.children, shown);
    size.vw = viewport.clientWidth;
    // 操作条叠在墙面底部：排布与镜头只用它上面的那部分高度
    size.vh = viewport.clientHeight - (hud.offsetHeight ? hud.offsetHeight + 16 : 0);
    var rows;
    if (wide.matches) {
      rows = Math.max(1, Math.min(3, items.length));
    } else {
      // 手机：排成大约四列宽的一面墙，横竖都能拖
      rows = Math.max(2, Math.ceil(items.length / 4));
    }
    track.style.setProperty('--rows', String(rows));
    size.cw = track.offsetWidth;
    size.ch = track.offsetHeight;
    var columns = Math.max(1, Math.ceil(items.length / rows));
    var column = size.cw / columns;
    whole = Math.min(1, (size.vw - EDGE) / Math.max(1, size.cw), (size.vh - 8) / Math.max(1, size.ch));
    var ratio = cam.s / base;
    if (wide.matches) {
      // 桌面：三行正好占满墙面高度
      base = Math.min(1.25, (size.vh - 8) / Math.max(1, size.ch));
    } else {
      // 手机：一列约占屏宽的 44%，一屏两列，边上露出第三列
      base = Math.min(1.25, (size.vw * 0.44) / Math.max(1, column));
    }
    if (keep) {
      cam.s = base * ratio;
    } else {
      cam.s = base;
      cam.x = wide.matches ? EDGE : 4;
      cam.y = wide.matches ? (size.vh - size.ch * cam.s) / 2 : 0;
    }
    clamp();
    render();
  }

  // ---- 拖动、双指、惯性 ----
  var pointers = new Map();
  var drag = null;
  var pinch = null;
  var suppressClick = false;
  var history = [];

  function localPoint(event) {
    var rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  viewport.addEventListener('pointerdown', function (event) {
    if (!active || (event.pointerType === 'mouse' && event.button !== 0)) return;
    stopMotion();
    var point = localPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      var pair = Array.from(pointers.values());
      pinch = { dist: distance(pair[0], pair[1]), scale: cam.s };
      drag = null;
      try { viewport.setPointerCapture(event.pointerId); } catch (_) { /* 已经结束 */ }
      return;
    }
    drag = { id: event.pointerId, sx: point.x, sy: point.y, cx: cam.x, cy: cam.y, moving: false };
    history = [{ x: point.x, y: point.y, t: event.timeStamp }];
  });
  viewport.addEventListener('pointermove', function (event) {
    if (!active) return;
    var point = localPoint(event);
    if (finePointer.matches && light) {
      stage.style.setProperty('--lx', (point.x / Math.max(1, size.vw) * 100).toFixed(1) + '%');
      stage.style.setProperty('--ly', (point.y / Math.max(1, size.vh) * 100).toFixed(1) + '%');
      track.style.setProperty('--sx', ((size.vw / 2 - point.x) / size.vw * 10).toFixed(1) + 'px');
    }
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point);
    if (pinch && pointers.size >= 2) {
      var pair = Array.from(pointers.values());
      var mid = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
      zoomAt(mid.x, mid.y, pinch.scale * distance(pair[0], pair[1]) / Math.max(1, pinch.dist), false);
      suppressClick = true;
      return;
    }
    if (!drag || drag.id !== event.pointerId) return;
    var dx = point.x - drag.sx;
    var dy = point.y - drag.sy;
    if (!drag.moving) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.moving = true;
      viewport.classList.add('is-dragging');
      try { viewport.setPointerCapture(event.pointerId); } catch (_) { /* 已经结束 */ }
    }
    var lastX = cam.x;
    cam.x = drag.cx + dx;
    cam.y = drag.cy + dy;
    clamp();
    if (!reduced.matches) sway = Math.max(-1, Math.min(1, sway * 0.6 + (cam.x - lastX) * 0.08));
    history.push({ x: point.x, y: point.y, t: event.timeStamp });
    if (history.length > 5) history.shift();
    schedule();
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      drag = null;
      return;
    }
    if (!drag || drag.id !== event.pointerId) return;
    var moved = drag.moving;
    drag = null;
    viewport.classList.remove('is-dragging');
    if (!moved) return;
    suppressClick = true;
    window.setTimeout(function () { suppressClick = false; }, 0);
    var first = history[0];
    var last = history[history.length - 1];
    var span = first && last && last.t > first.t ? last.t - first.t : 0;
    var vx = span ? (last.x - first.x) / span : 0;
    var vy = span ? (last.y - first.y) / span : 0;
    if (reduced.matches || Math.hypot(vx, vy) < 0.08 || event.type === 'pointercancel') { settleSway(); return; }
    // 惯性：松手后继续滑一段，逐渐停下
    stopMotion();
    var gx = vx * 16;
    var gy = vy * 16;
    motion = { id: 0 };
    function glide() {
      gx *= 0.93;
      gy *= 0.93;
      var before = { x: cam.x, y: cam.y };
      cam.x += gx;
      cam.y += gy;
      clamp();
      sway = Math.max(-1, Math.min(1, gx * 0.06));
      render();
      var still = cam.x === before.x && cam.y === before.y;
      if (Math.hypot(gx, gy) > 0.4 && !still && motion) motion.id = window.requestAnimationFrame(glide);
      else { motion = null; settleSway(); }
    }
    motion.id = window.requestAnimationFrame(glide);
  }
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);
  viewport.addEventListener('dragstart', function (event) {
    if (active) event.preventDefault();
  });
  viewport.addEventListener('click', function (event) {
    if (!active) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    var target = event.target;
    var link = target instanceof Element ? target.closest('a.wall-card__link') : null;
    var card = link ? link.closest('[data-wall-card]') : null;
    if (!card) return;
    // 带修饰键（新标签页打开等）时保持原来的链接行为
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    select(card, false);
  }, true);

  viewport.addEventListener('wheel', function (event) {
    if (!active) return;
    var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.vw : 1;
    var dx = event.deltaX * unit;
    var dy = event.deltaY * unit;
    if (event.ctrlKey) {
      // 触控板双指缩放 / Ctrl + 滚轮
      event.preventDefault();
      var point = localPoint(event);
      zoomAt(point.x, point.y, cam.s * Math.exp(-dy * 0.0035), false);
      return;
    }
    stopMotion();
    var before = { x: cam.x, y: cam.y };
    if (Math.abs(dx) > Math.abs(dy)) {
      cam.x -= dx;
    } else if (size.ch * cam.s > size.vh) {
      // 墙比视野高：竖向滚轮先上下逛
      cam.y -= dy;
      clamp();
      if (cam.y === before.y) cam.x -= dy;
    } else {
      // 竖向滚轮横着逛墙；到头了再交还给页面滚动
      cam.x -= dy;
    }
    clamp();
    if (cam.x !== before.x || cam.y !== before.y) {
      event.preventDefault();
      if (!reduced.matches) { sway = Math.max(-1, Math.min(1, (cam.x - before.x) * 0.03)); window.requestAnimationFrame(settleSway); }
      schedule();
    }
  }, { passive: false });

  viewport.addEventListener('keydown', function (event) {
    if (!active || event.target !== viewport) return;
    var step = 140;
    var handled = true;
    if (event.key === 'ArrowLeft') animateTo(cam.x + step, cam.y, cam.s);
    else if (event.key === 'ArrowRight') animateTo(cam.x - step, cam.y, cam.s);
    else if (event.key === 'ArrowUp') animateTo(cam.x, cam.y + step, cam.s);
    else if (event.key === 'ArrowDown') animateTo(cam.x, cam.y - step, cam.s);
    else if (event.key === 'Home') animateTo(EDGE, cam.y, cam.s);
    else if (event.key === 'End') animateTo(size.vw - size.cw * cam.s - EDGE, cam.y, cam.s);
    else if (event.key === '+' || event.key === '=') zoomAt(size.vw / 2, size.vh / 2, cam.s * 1.25, true);
    else if (event.key === '-' || event.key === '_') zoomAt(size.vw / 2, size.vh / 2, cam.s / 1.25, true);
    else handled = false;
    if (handled) event.preventDefault();
  });
  // Tab 到某张海报时，把它移进视野
  track.addEventListener('focusin', function (event) {
    if (!active) return;
    var target = event.target;
    var item = target instanceof Element ? target.closest('li') : null;
    if (item && item.parentElement === track) reveal(item);
  });
  stage.addEventListener('pointerleave', function () {
    stage.style.removeProperty('--lx');
    stage.style.removeProperty('--ly');
    track.style.removeProperty('--sx');
  });

  hud.addEventListener('click', function (event) {
    var target = event.target;
    var button = target instanceof Element ? target.closest('button') : null;
    if (!button) return;
    if (button.hasAttribute('data-space-overview')) {
      if (selected && !wide.matches) closeSheet(false, false);
      returnCam = null;
      showWhole();
      return;
    }
    var stepDir = Number(button.getAttribute('data-space-step') || 0);
    var zoomDir = Number(button.getAttribute('data-space-zoom') || 0);
    if (stepDir) animateTo(cam.x - stepDir * size.vw * 0.7, cam.y, cam.s);
    if (zoomDir) zoomAt(size.vw / 2, size.vh / 2, cam.s * (zoomDir > 0 ? 1.25 : 0.8), true);
  });

  // ---- 详情 ----
  function chooseHook(button) {
    detailBox.querySelectorAll('[data-hook-id]').forEach(function (item) {
      item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
    });
    hookField.value = button.getAttribute('data-hook-id') || '';
  }
  detailBox.addEventListener('click', function (event) {
    var target = event.target;
    var button = target instanceof Element ? target.closest('[data-hook-id]') : null;
    if (button) chooseHook(button);
  });

  /** 把这个人放进详情。auto：桌面上一进来自动选的第一位，不算“看过”、不抢焦点、不动镜头。 */
  function select(card, auto) {
    var link = card.querySelector('a.wall-card__link');
    var template = card.querySelector('template[data-card-detail]');
    if (!link || !template) return;
    var opening = !selected || !panel.classList.contains('is-open');
    if (!wide.matches && opening && !returnCam) returnCam = { x: cam.x, y: cam.y, s: cam.s };
    if (selected) selected.classList.remove('is-selected');
    selected = card;
    card.classList.add('is-selected');
    var own = card.getAttribute('data-own') === '1';
    var href = link.getAttribute('href') || '#';

    coverBox.textContent = '';
    var cover = card.querySelector('.wall-card__cover');
    if (cover && wide.matches) {
      var copy = cover.cloneNode(true);
      var image = copy.querySelector('img');
      if (image) image.setAttribute('loading', 'eager');
      coverBox.appendChild(copy);
    }
    detailBox.textContent = '';
    detailBox.appendChild(template.content.cloneNode(true));
    var hooks = detailBox.querySelectorAll('[data-hook-id]');
    chat.hidden = own || hooks.length === 0;
    if (!chat.hidden) {
      chat.setAttribute('action', href + '/chat');
      chooseHook(hooks[0]);
    }
    openLink.setAttribute('href', href);
    openLabel.textContent = own ? '看看我的页面' : '看看 TA 的页面';

    sheet.hidden = false;
    // 重新播放一次换人的动画
    sheet.classList.remove('is-entering');
    void sheet.offsetWidth;
    sheet.classList.add('is-entering');
    panel.scrollTop = 0;
    board.classList.add('has-selection');
    if (auto) return;
    markExplored(card);
    if (wide.matches) {
      reveal(card);
    } else {
      panel.classList.add('is-open');
      panel.style.removeProperty('transform');
      window.requestAnimationFrame(function () { if (selected === card) focusOn(card); });
    }
    var heading = detailBox.querySelector('.space-detail__name');
    if (heading) heading.focus({ preventScroll: true });
  }
  /** 手机：收起资料卡；镜头回到打开前的位置和缩放。 */
  function closeSheet(restoreFocus, restoreCam) {
    var card = selected;
    if (selected) selected.classList.remove('is-selected');
    selected = null;
    panel.classList.remove('is-open', 'is-dragging');
    panel.style.removeProperty('transform');
    board.classList.remove('has-selection');
    // 先还焦点（聚焦会把海报移进视野），再把镜头带回打开前的位置
    if (restoreFocus && card) {
      var link = card.querySelector('a.wall-card__link');
      if (link) link.focus({ preventScroll: true });
    }
    if (restoreCam && returnCam) animateTo(returnCam.x, returnCam.y, returnCam.s, 480);
    returnCam = null;
  }
  function firstVisibleCard() {
    for (var i = 0; i < cards.length; i += 1) if (!cards[i].hidden) return cards[i];
    return null;
  }
  /** 桌面：详情一栏一直有人；墙上一个人都没有（筛选后）时显示提示。 */
  function ensureSelection() {
    if (!wide.matches) return;
    if (selected && !selected.hidden) return;
    var card = firstVisibleCard();
    if (card) select(card, true);
    else {
      if (selected) selected.classList.remove('is-selected');
      selected = null;
      sheet.hidden = true;
      board.classList.remove('has-selection');
    }
  }

  panel.querySelectorAll('[data-space-close]').forEach(function (button) {
    button.addEventListener('click', function () { closeSheet(true, true); });
  });
  // AI 帮我找人 / 问问这面墙：不在页面底部显示，从详情里打开，放进对话框
  var assist = document.querySelector('[data-space-assist-dialog]');
  var assistSlot = assist ? assist.querySelector('[data-space-assist-slot]') : null;
  var ASSIST_IDS = ['intros', 'ask', 'portrait'];
  function openAssist(id) {
    if (!assist || !assistSlot || typeof assist.showModal !== 'function') return false;
    var section = document.getElementById(id);
    if (!section) return false;
    if (section.parentElement !== assistSlot) {
      assistSlot.textContent = '';
      assistSlot.appendChild(section);
    }
    var heading = section.querySelector('h2');
    assist.setAttribute('aria-label', heading ? (heading.textContent || '').trim() : '');
    if (!assist.open) assist.showModal();
    assist.scrollTop = 0;
    return true;
  }
  if (assist) {
    var assistClose = assist.querySelector('[data-space-assist-close]');
    if (assistClose) assistClose.addEventListener('click', function () { assist.close(); });
    // 点对话框外面（背景）也关上
    assist.addEventListener('click', function (event) {
      if (event.target === assist) assist.close();
    });
    assist.addEventListener('close', function () {
      if (ASSIST_IDS.indexOf(window.location.hash.slice(1)) >= 0) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    });
  }
  board.addEventListener('click', function (event) {
    var target = event.target;
    var link = target instanceof Element ? target.closest('a[href^="#"]') : null;
    if (!link || link.hasAttribute('data-space-open')) return;
    var id = (link.getAttribute('href') || '').slice(1);
    if (ASSIST_IDS.indexOf(id) < 0) return;
    if (!wide.matches && selected) closeSheet(false, false);
    if (openAssist(id)) {
      event.preventDefault();
      window.history.replaceState(null, '', '#' + id);
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !active || !selected) return;
    if (!wide.matches && panel.classList.contains('is-open')) closeSheet(true, true);
    else if (wide.matches) {
      var link = selected.querySelector('a.wall-card__link');
      if (link && panel.contains(document.activeElement)) link.focus({ preventScroll: true });
    }
  });

  // 手机：按住资料卡顶上那一条往下拖，超过一段距离（或甩得快）就收起
  if (grip) {
    var sheetDrag = null;
    grip.addEventListener('pointerdown', function (event) {
      if (wide.matches || !panel.classList.contains('is-open')) return;
      sheetDrag = { id: event.pointerId, y: event.clientY, t: event.timeStamp, dy: 0 };
      panel.classList.add('is-dragging');
      try { grip.setPointerCapture(event.pointerId); } catch (_) { /* 已经结束 */ }
    });
    grip.addEventListener('pointermove', function (event) {
      if (!sheetDrag || sheetDrag.id !== event.pointerId) return;
      sheetDrag.dy = Math.max(0, event.clientY - sheetDrag.y);
      panel.style.transform = 'translateY(' + sheetDrag.dy.toFixed(1) + 'px)';
    });
    var dropSheet = function (event) {
      if (!sheetDrag || sheetDrag.id !== event.pointerId) return;
      var fast = sheetDrag.dy / Math.max(1, event.timeStamp - sheetDrag.t) > 0.5;
      var far = sheetDrag.dy > Math.min(140, panel.offsetHeight * 0.3);
      sheetDrag = null;
      panel.classList.remove('is-dragging');
      if (fast || far) closeSheet(false, true);
      else panel.style.removeProperty('transform');
    };
    grip.addEventListener('pointerup', dropSheet);
    grip.addEventListener('pointercancel', dropSheet);
  }

  // 手机上搜索收成图标：点开展开输入框，清空后失焦再收起
  if (searchToggle && searchInput) {
    var setSearching = function (on) {
      board.classList.toggle('is-searching', on);
      searchToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    searchToggle.addEventListener('click', function () {
      var on = !board.classList.contains('is-searching');
      setSearching(on);
      if (on) searchInput.focus();
      fittedFor = '';
      layout(true);
    });
    searchInput.addEventListener('blur', function () {
      if (!searchInput.value && board.classList.contains('is-searching')) {
        setSearching(false);
        fittedFor = '';
        layout(true);
      }
    });
    if (searchInput.value) setSearching(true);
  }
  if (wide.addEventListener) {
    wide.addEventListener('change', function () {
      if (!active) return;
      if (selected) closeSheet(false, false);
      fittedFor = '';
      layout(false);
      ensureSelection();
    });
  }

  // ---- 启动 ----
  var resizeFrame = 0;
  function onResize() {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(function () {
      resizeFrame = 0;
      layout(true);
    });
  }
  function start() {
    active = true;
    board.classList.add('is-space');
    root.classList.add('nm-wall-space');
    hud.hidden = false;
    panel.hidden = false;
    if (searchToggle) searchToggle.hidden = false;
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', '墙面：拖动、双指缩放或用方向键浏览');
    layout(false);
    ensureSelection();
    window.addEventListener('resize', onResize);
    // 提交问墙 / AI 介绍后回到 #ask、#intros：直接打开对话框看结果
    var hash = window.location.hash.slice(1);
    if (ASSIST_IDS.indexOf(hash) >= 0) openAssist(hash);
  }
  board.addEventListener('wall:filtered', function () {
    if (!active) return;
    if (selected && selected.hidden && !wide.matches) closeSheet(false, false);
    fittedFor = '';
    layout(false);
    ensureSelection();
  });

  updateExplored();
  start();
  // 字体与封面加载后高度可能变化，再排一次
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layout(true); });
  window.addEventListener('load', function () { layout(true); });
})();
