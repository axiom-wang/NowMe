/*
 * 墙上的搜索（主站 CSP 不允许内联脚本）：按名字、一行介绍、接话点在浏览器里筛选已经加载的卡片，不发请求。
 * 多个词用空格隔开，全部命中才显示。没有脚本时搜索框不起作用，墙照常浏览。
 */
(function () {
  'use strict';
  var board = document.querySelector('[data-wall-board]');
  var input = board && board.querySelector('[data-wall-search]');
  if (!board || !input) return;
  var cards = Array.prototype.slice.call(board.querySelectorAll('[data-wall-card]'));
  var count = board.querySelector('[data-wall-count]');
  var none = board.querySelector('[data-wall-none]');

  function apply() {
    var terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    cards.forEach(function (card) {
      var text = card.getAttribute('data-search') || '';
      var match = terms.every(function (term) {
        return text.indexOf(term) >= 0;
      });
      card.hidden = !match;
      if (match) shown += 1;
    });
    board.classList.add('is-settled');
    board.classList.toggle('is-filtering', terms.length > 0);
    if (count) count.textContent = String(shown);
    if (none) none.hidden = shown > 0;
  }

  input.addEventListener('input', apply);
  // 浏览器后退时会恢复输入框里的字：按恢复后的内容再筛一次
  window.addEventListener('pageshow', function () {
    if (input.value) apply();
  });
})();
