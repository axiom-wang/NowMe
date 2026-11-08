/* 原生账号菜单：点击外部或按 Escape 关闭。筛选使用链接，无脚本也可用。 */
(function () {
  var menu = document.querySelector('.home-account');
  if (!menu) return;
  document.addEventListener('click', function (event) {
    if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
})();
