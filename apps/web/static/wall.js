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
