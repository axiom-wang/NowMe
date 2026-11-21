/*
 * 墙页在绘制前同步加载（主站 CSP 不允许内联脚本）：给 <html> 打上逛墙空间的标记，
 * 让页面一开始就按空间布局排版，不会先闪一下网格。真正的交互在 wall.js；墙上没人时 wall.js 会去掉这个标记。
 * 没有脚本时墙就是普通的网格。
 */
(function () {
  'use strict';
  if (typeof window.requestAnimationFrame !== 'function') return;
  document.documentElement.classList.add('nm-wall-space');
  // 以前可以切到“列表”并记在本机；列表视图已经去掉，顺手清掉旧的记录
  try { window.localStorage.removeItem('nowme:wall-view'); } catch (_) { /* 不能写存储时忽略 */ }
})();
