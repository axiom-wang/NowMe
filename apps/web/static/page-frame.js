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

  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target instanceof Element ? target.closest('[data-nm-page-frame-reload]') : null;
    if (!button) return;
    var root = button.closest('[data-nm-page-frame-root]');
    var frame = root && root.querySelector('iframe[' + FRAME_ATTR + ']');
    if (!frame) return;
    var state = stateOf(frame);
    state.loads = 0;
    state.blocked = false;
    showBlocked(frame, false);
    frame.setAttribute('src', state.src);
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
