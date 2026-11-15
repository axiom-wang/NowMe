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
  var none = board.querySelector('[data-wall-none]');

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
    if (none) none.hidden = shown > 0;
    if (clear) clear.hidden = questions.length === 0;
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
