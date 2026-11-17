/*
 * 展示用户页面的 iframe 的客户端脚本（contracts 5.1、5.2）。由布局在 <head> 中同步加载：
 * 必须在 iframe 第一次 load 之前注册监听，否则第一次 load 会被漏掉，自我导航就数不准。
 *
 * 只处理带 data-nm-page-frame 属性的 iframe（views/page-frame.tsx）。
 *
 * 5.1 nowme.openLink：Kit 在 iframe 里调用 parent.postMessage({ type: 'nowme:open-link', url }, '*')。
 *     只认 event.source === 某个页面 iframe 的 contentWindow、url 为 https:；弹出确认（显示目标域名），
 *     用户确认后 window.open(url, '_blank', 'noopener,noreferrer')。其他消息一律忽略。
 * 5.2 自我导航：iframe 第一次 load 之后再次触发 load，即视为页面自我导航，立即把 src 重置为空白页，
 *     并在 iframe 外提示“这个页面试图跳转，已拦截”。
 */
(function () {
  'use strict';

  var FRAME_ATTR = 'data-nm-page-frame';
  var OPEN_LINK_TYPE = 'nowme:open-link';
  var BLANK = 'about:blank';
  /** 两次确认弹窗的最小间隔（防止页面不停地弹）。 */
  var PROMPT_INTERVAL_MS = 1000;
  /** 用户连续拒绝这么多次之后，不再理会这个页面的打开请求。 */
  var MAX_DECLINES = 2;

  /** iframe → { src, loads, blocked, declines, lastPrompt } */
  var states = new WeakMap();

  function isPageFrame(node) {
    return node instanceof HTMLIFrameElement && node.hasAttribute(FRAME_ATTR);
  }

  function stateOf(frame) {
    var state = states.get(frame);
    if (!state) {
      state = { src: frame.getAttribute('src'), loads: 0, blocked: false, declines: 0, lastPrompt: 0 };
      states.set(frame, state);
    }
    return state;
  }

  function rootOf(frame) {
    return frame.closest('[data-nm-page-frame-root]');
  }

  function showBlocked(frame, visible) {
    var root = rootOf(frame);
    var notice = root && root.querySelector('[data-nm-page-frame-notice]');
    if (notice) notice.hidden = !visible;
  }

  // load 不冒泡，但捕获阶段会经过 document：在这里统一计数
  document.addEventListener(
    'load',
    function (event) {
      var frame = event.target;
      if (!isPageFrame(frame)) return;
      var state = stateOf(frame);
      if (state.blocked) return; // 重置为空白页后的那次 load
      state.loads += 1;
      if (state.loads === 1) return;
      // 第一次加载之后再次 load：页面自我导航（contracts 5.2）
      state.blocked = true;
      frame.setAttribute('src', BLANK);
      showBlocked(frame, true);
    },
    true,
  );

  /** 每个 PageFrame 的展示模式状态；iframe 本身在进入 / 退出时不移动、不重建。 */
  var stageStates = new WeakMap();

  function stageState(root) {
    var state = stageStates.get(root);
    if (!state) {
      var pageId = root.getAttribute('data-nm-stage-page');
      state = { active: false, busy: false, originalPageId: pageId, currentPageId: pageId };
      stageStates.set(root, state);
    }
    return state;
  }

  function focusStage(root) {
    var close = root.querySelector('[data-nm-stage-close]');
    if (close) close.focus({ preventScroll: true });
  }

  function setStageScale(root) {
    if (!root.classList.contains('page-frame--stage')) return;
    var bar = root.querySelector('[data-nm-stage-bar]');
    var badge = root.querySelector('.page-frame__ai');
    var availableWidth = Math.max(1, root.clientWidth - 32);
    var availableHeight = Math.max(1, root.clientHeight - (bar ? bar.offsetHeight : 0) - (badge ? badge.offsetHeight : 0) - 56);
    var scale = Math.min(availableWidth / 375, availableHeight / 667);
    root.style.setProperty('--nm-stage-scale', String(scale));
  }

  function enterStage(root) {
    var state = stageState(root);
    if (state.active) return;
    state.active = true;
    state.originalPageId = root.getAttribute('data-nm-stage-page');
    state.currentPageId = state.originalPageId;
    root.classList.add('page-frame--stage');
    document.documentElement.classList.add('nm-stage-open');
    setStageScale(root);
    focusStage(root);
    if (typeof root.requestFullscreen === 'function') {
      try {
        var request = root.requestFullscreen();
        if (request && typeof request.catch === 'function') request.catch(function () {});
      } catch (error) {
        // iPhone Safari 等不支持全屏的环境仍使用铺满窗口的固定舞台。
      }
    }
  }

  function exitStage(root) {
    var state = stageState(root);
    if (!state.active) return;
    state.active = false;
    root.classList.remove('page-frame--stage');
    document.documentElement.classList.remove('nm-stage-open');
    if (document.fullscreenElement === root && typeof document.exitFullscreen === 'function') {
      try {
        var request = document.exitFullscreen();
        if (request && typeof request.catch === 'function') request.catch(function () {});
      } catch (error) {}
    }
    var open = root.querySelector('[data-nm-stage-open]');
    if (open) open.focus({ preventScroll: true });
    if (state.currentPageId && state.currentPageId !== state.originalPageId) {
      var wallId = root.getAttribute('data-nm-stage-wall');
      location.replace('/w/' + encodeURIComponent(wallId) + '/p/' + encodeURIComponent(state.currentPageId));
    }
  }

  function updateStageNavigation(root, data) {
    root.setAttribute('data-nm-stage-page', data.pageId);
    if (data.prevId) root.setAttribute('data-nm-stage-prev', data.prevId);
    else root.removeAttribute('data-nm-stage-prev');
    if (data.nextId) root.setAttribute('data-nm-stage-next', data.nextId);
    else root.removeAttribute('data-nm-stage-next');
    root.querySelector('[data-nm-stage-name]').textContent = data.displayName;
    root.querySelector('[data-nm-stage-tagline]').textContent = data.tagline;
    root.querySelector('[data-nm-stage-position]').textContent = data.position + ' / ' + data.total;
  }

  function switchStage(root, pageId) {
    var state = stageState(root);
    if (!state.active || state.busy || !pageId) return;
    var wallId = root.getAttribute('data-nm-stage-wall');
    var fromPageId = state.currentPageId;
    var status = root.querySelector('[data-nm-stage-status]');
    state.busy = true;
    status.textContent = '';
    root.querySelectorAll('[data-nm-stage-prev-button], [data-nm-stage-next-button]').forEach(function (button) {
      button.disabled = true;
    });
    fetch('/w/' + encodeURIComponent(wallId) + '/p/' + encodeURIComponent(pageId) + '/stage', {
      headers: { Accept: 'application/json' },
    })
      .then(function (response) {
        if (!response.ok) throw new Error('stage unavailable');
        return response.json();
      })
      .then(function (data) {
        if (!state.active || state.currentPageId !== fromPageId) return;
        if (
          !data ||
          data.pageId !== pageId ||
          typeof data.displayName !== 'string' ||
          typeof data.tagline !== 'string' ||
          typeof data.src !== 'string' ||
          typeof data.position !== 'number' ||
          typeof data.total !== 'number'
        ) {
          throw new Error('invalid stage response');
        }
        var frame = root.querySelector('iframe[' + FRAME_ATTR + ']');
        if (!frame) throw new Error('frame unavailable');
        // cloneNode 保留原 iframe 的 sandbox、referrerpolicy 与标记属性；新节点从 0 计算 load。
        var nextFrame = frame.cloneNode(false);
        nextFrame.setAttribute('src', data.src);
        nextFrame.setAttribute('title', data.displayName + '的页面');
        frame.replaceWith(nextFrame);
        state.currentPageId = data.pageId;
        updateStageNavigation(root, data);
        focusStage(root);
      })
      .catch(function () {
        if (state.active) status.textContent = '这一页看不了了';
      })
      .finally(function () {
        state.busy = false;
        root.querySelectorAll('[data-nm-stage-prev-button], [data-nm-stage-next-button]').forEach(function (button) {
          button.disabled = false;
        });
      });
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var button = target.closest('[data-nm-page-frame-reload]');
    if (button) {
      var reloadRoot = button.closest('[data-nm-page-frame-root]');
      var frame = reloadRoot && reloadRoot.querySelector('iframe[' + FRAME_ATTR + ']');
      if (!frame) return;
      var state = stateOf(frame);
      state.loads = 0;
      state.blocked = false;
      showBlocked(frame, false);
      frame.setAttribute('src', state.src);
      return;
    }
    var open = target.closest('[data-nm-stage-open]');
    if (open) {
      enterStage(open.closest('[data-nm-page-frame-root]'));
      return;
    }
    var close = target.closest('[data-nm-stage-close]');
    if (close) {
      exitStage(close.closest('[data-nm-page-frame-root]'));
      return;
    }
    var previous = target.closest('[data-nm-stage-prev-button]');
    var next = target.closest('[data-nm-stage-next-button]');
    if (previous || next) {
      var root = (previous || next).closest('[data-nm-page-frame-root]');
      switchStage(root, root.getAttribute(previous ? 'data-nm-stage-prev' : 'data-nm-stage-next'));
    }
  });

  document.addEventListener('keydown', function (event) {
    var root = document.querySelector('.page-frame--stage[data-nm-page-frame-root]');
    if (!root) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      exitStage(root);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    var target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    switchStage(root, root.getAttribute(event.key === 'ArrowLeft' ? 'data-nm-stage-prev' : 'data-nm-stage-next'));
  });

  window.addEventListener('resize', function () {
    document.querySelectorAll('.page-frame--stage[data-nm-page-frame-root]').forEach(setStageScale);
  });

  document.addEventListener('fullscreenchange', function () {
    var root = document.querySelector('.page-frame--stage[data-nm-page-frame-root]');
    if (!root) return;
    if (document.fullscreenElement === root) setStageScale(root);
    else exitStage(root);
  });

  function frameForSource(source) {
    if (!source) return null;
    var frames = document.querySelectorAll('iframe[' + FRAME_ATTR + ']');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === source) return frames[i];
    }
    return null;
  }

  window.addEventListener('message', function (event) {
    var frame = frameForSource(event.source);
    if (!frame) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.type !== OPEN_LINK_TYPE || typeof data.url !== 'string') return;
    var url;
    try {
      url = new URL(data.url);
    } catch (error) {
      return;
    }
    if (url.protocol !== 'https:') return;
    var state = stateOf(frame);
    var now = Date.now();
    if (state.declines >= MAX_DECLINES || now - state.lastPrompt < PROMPT_INTERVAL_MS) return;
    state.lastPrompt = now;
    if (window.confirm('这个页面想打开外部链接：\n' + url.hostname + '\n\n要在新标签页打开吗？')) {
      state.declines = 0;
      window.open(url.href, '_blank', 'noopener,noreferrer');
    } else {
      state.declines += 1;
    }
    state.lastPrompt = Date.now();
  });
})();
