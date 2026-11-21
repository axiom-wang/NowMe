/* Loaded synchronously before CSS so a saved appearance is applied before paint.
 * Only this display preference is stored; no account or page data is involved. */
(function () {
  'use strict';
  var root = document.documentElement;
  var key = 'nowme-theme';
  var preference = 'system';
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  function valid(value) { return value === 'light' || value === 'dark' || value === 'system'; }
  try {
    var saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch (_) { /* Private browsing can deny storage; the switch still works. */ }
  function apply(value) {
    preference = valid(value) ? value : 'system';
    root.dataset.theme = preference;
    var dark = preference === 'dark' || (preference === 'system' && media.matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.removeAttribute('media');
      meta.content = dark ? '#171612' : '#f3f0e8';
    });
    document.querySelectorAll('[data-theme-picker]').forEach(function (select) { select.value = preference; });
  }
  apply(preference);
  media.addEventListener('change', function () { apply(preference); });
  window.addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) apply(valid(event.newValue) ? event.newValue : 'system');
  });
  document.addEventListener('DOMContentLoaded', function () {
    apply(preference);
    document.querySelectorAll('[data-theme-picker]').forEach(function (select) {
      select.addEventListener('change', function () {
        apply(select.value);
        try { localStorage.setItem(key, preference); } catch (_) { /* Optional persistence. */ }
      });
    });
  });
})();
