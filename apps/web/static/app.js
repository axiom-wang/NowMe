/*
 * 主站的少量客户端脚本（主站 CSP 不允许内联脚本，所以都放在这里）：
 * - [data-copy="<元素 id>"]：复制该元素的文字（Agent 指令）；
 * - form[data-confirm="<提示>"]：提交前确认（断开、删除等危险操作）。
 */
(function () {
  'use strict';

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'visually-hidden';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (error) {
        reject(error);
      } finally {
        area.remove();
      }
    });
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target instanceof Element ? target.closest('[data-copy]') : null;
    if (!button) return;
    var source = document.getElementById(button.getAttribute('data-copy') || '');
    if (!source) return;
    var label = button.textContent;
    copyText(source.textContent || '').then(
      function () {
        button.textContent = '已复制';
        setTimeout(function () {
          button.textContent = label;
        }, 1500);
      },
      function () {
        var range = document.createRange();
        range.selectNodeContents(source);
        var selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        button.textContent = '请手动复制';
      },
    );
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  });
  // AI 设置只处理表单预设，不存储或发出 Key。
  document.querySelectorAll('form[data-ai-settings]').forEach(function (form) {
    var shared = form.querySelector('[name="shared"]');
    function syncShared() {
      form.querySelectorAll('[name^="generate_"]').forEach(function (field) {
        if (field.name !== 'generate_model') field.disabled = shared.checked;
      });
    }
    shared.addEventListener('change', syncShared);
    syncShared();
    form.querySelectorAll('[data-model-provider]').forEach(function (select) {
      select.addEventListener('change', function () {
        var role = select.getAttribute('data-model-provider');
        var option = select.selectedOptions[0];
        form.elements[role + '_baseUrl'].value = option.getAttribute('data-base-url') || '';
        form.elements[role + '_model'].value = option.getAttribute('data-model') || '';
        form.elements[role + '_vision'].checked = option.getAttribute('data-vision') === '1';
        form.elements[role + '_apiKey'].value = '';
        if (role === 'interview' && shared.checked) {
          var generate = form.querySelector('[name="generate_provider"] option[value="' + select.value + '"]');
          form.elements.generate_model.value = generate.getAttribute('data-model') || '';
        }
      });
    });
  });
})();
