/*
 * 生成 / 修改的实时进度（contracts 18.2）：页面上的 [data-job-progress]。
 * 先用 SSE（EventSource，同源、带会话 cookie）接收阶段；浏览器不支持、被拒绝（404 / 429）或连续断线时，
 * 改为每隔 data-poll-ms 毫秒轮询一次 data-status（JSON）。任务结束：做好了就跳到预览，否则重新载入这一页看结果。
 * 只处理阶段名与数字，不插入任何 HTML。
 */
(function () {
  'use strict';
  var root = document.querySelector('[data-job-progress]');
  if (!root) return;
  var streamUrl = root.getAttribute('data-stream');
  var statusUrl = root.getAttribute('data-status');
  var pollMs = Number(root.getAttribute('data-poll-ms')) || 3000;
  var label = root.querySelector('[data-progress-label]');
  var turn = root.querySelector('[data-progress-turn]');
  var steps = Array.prototype.slice.call(root.querySelectorAll('[data-step]'));
  var order = steps.map(function (el) { return el.getAttribute('data-step'); });
  var finished = false;
  var source = null;
  var timer = null;
  var failures = 0;

  function render(view) {
    if (!view || typeof view.label !== 'string') return;
    if (label) label.textContent = view.label;
    if (turn) turn.textContent = view.step === 'generating' && view.turn ? '第 ' + view.turn + ' 轮' : '';
    var current = order.indexOf(view.step);
    steps.forEach(function (el, index) {
      var state = index < current || (view.done && index <= current) ? 'done' : index === current ? 'current' : 'todo';
      el.classList.remove('progress__step--done', 'progress__step--current', 'progress__step--todo');
      el.classList.add('progress__step--' + state);
      if (state === 'current') el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
  }

  function finish(result) {
    if (finished) return;
    finished = true;
    if (source) source.close();
    if (timer) clearTimeout(timer);
    root.classList.add('job-progress--done');
    // 只跳到本站的相对路径
    var next = result && typeof result.next === 'string' && result.next.charAt(0) === '/' && result.next.charAt(1) !== '/' ? result.next : null;
    setTimeout(function () {
      if (next) window.location.assign(next);
      else window.location.reload();
    }, 600);
  }

  function unavailable(status) {
    finished = true;
    if (source) source.close();
    if (timer) clearTimeout(timer);
    root.classList.add('job-progress--done');
    if (label) label.textContent = status === 401 ? '登录已经过期，请重新登录后查看进度。' : '这个任务已无法访问，请返回我的墙。';
    if (turn) turn.textContent = '';
    steps.forEach(function (el) { el.classList.remove('progress__step--current'); el.removeAttribute('aria-current'); });
    var hint = root.querySelector('.job-progress__hint');
    var link = document.createElement('a');
    link.href = status === 401 ? '/login?next=' + encodeURIComponent(location.pathname) : '/';
    link.textContent = status === 401 ? '重新登录' : '返回我的墙';
    if (hint) hint.replaceChildren(link);
  }

  function poll() {
    if (finished) return;
    fetch(statusUrl, { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (response) {
        if ([401, 403, 404].includes(response.status)) { unavailable(response.status); return null; }
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (data) {
        if (finished) return;
        failures = 0;
        render(data);
        if (data.done) finish(data);
        else timer = setTimeout(poll, pollMs);
      })
      .catch(function () {
        if (finished) return;
        failures += 1;
        // 断网或服务暂时不可用：慢一点再试，不刷新整页
        timer = setTimeout(poll, Math.min(pollMs * (failures + 1), 30000));
      });
  }

  function fallback() {
    if (source) {
      source.close();
      source = null;
    }
    if (!timer && !finished) poll();
  }

  if (typeof window.EventSource !== 'function') {
    poll();
    return;
  }
  var errors = 0;
  source = new EventSource(streamUrl);
  source.addEventListener('stage', function (event) {
    errors = 0;
    try { render(JSON.parse(event.data)); } catch (e) { /* 忽略坏数据 */ }
  });
  source.addEventListener('done', function (event) {
    var data = null;
    try { data = JSON.parse(event.data); } catch (e) { data = null; }
    render(data);
    finish(data);
  });
  source.addEventListener('gone', function () {
    unavailable(404);
  });
  source.onerror = function () {
    errors += 1;
    // 连接被拒绝（CLOSED）或反复断线：改为轮询；偶尔断一次让浏览器自己重连（会带上 Last-Event-ID）
    if (source && (source.readyState === EventSource.CLOSED || errors >= 3)) fallback();
  };
})();
