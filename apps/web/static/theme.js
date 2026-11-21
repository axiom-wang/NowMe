/* Loaded synchronously before CSS so a saved appearance is applied before paint.
 * Only this display preference is stored; no account or page data is involved. */
(function () {
  'use strict';
  var root = document.documentElement;
  var key = 'nowme-theme';
  var preference = 'system';
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var picker;
  var trigger;
  var options;
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
    if (!picker) return;
    options.forEach(function (option) {
      var selected = option.dataset.themeOption === preference;
      option.setAttribute('aria-pressed', String(selected));
      if (selected) {
        var label = '外观：' + option.textContent.trim();
        trigger.setAttribute('aria-label', label);
        trigger.title = label;
      }
    });
  }
  apply(preference);
  media.addEventListener('change', function () { apply(preference); });
  window.addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) apply(valid(event.newValue) ? event.newValue : 'system');
  });
  document.addEventListener('DOMContentLoaded', function () {
    picker = document.querySelector('[data-theme-picker]');
    if (!picker) return;
    trigger = picker.querySelector('summary');
    options = picker.querySelectorAll('[data-theme-option]');
    apply(preference);
    picker.hidden = false;
    options.forEach(function (option) {
      option.addEventListener('click', function () {
        apply(option.dataset.themeOption);
        try { localStorage.setItem(key, preference); } catch (_) { /* Optional persistence. */ }
        picker.open = false;
        trigger.focus();
      });
    });
  });
})();
