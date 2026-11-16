/*
 * 主站的少量客户端脚本（主站 CSP 不允许内联脚本，所以都放在这里）：
 * - [data-copy="<元素 id>"]：复制该元素的文字（Agent 指令）；
 * - form[data-confirm="<提示>"]：提交前确认（断开、删除等危险操作）；
 * - form[data-busy-label="<说明>"]：提交后显示等待状态（“和 TA 聊什么”）；
 * - [data-file-picker]：用统一的外观显示图片选择按钮和文件名；
 * - details[data-dismissable]：弹出菜单（账号菜单、发起聊天、画像管理）。Esc 关闭并把焦点还给标题，
 *   点到外面或键盘焦点移到外面时也关闭；没有脚本时它们就是普通的折叠。
 */
(function () {
  'use strict';

  document.querySelectorAll('[data-file-picker]').forEach(function (picker) {
    var input = picker.querySelector('input[type="file"]');
    var button = picker.querySelector('.file-picker__button');
    var status = picker.querySelector('.file-picker__name');
    var empty = status.textContent;
    function showFile() {
      status.textContent = input.files.length ? input.files[0].name : empty;
    }
    input.addEventListener('change', showFile);
    window.addEventListener('pageshow', showFile);
    showFile();
    input.classList.add('visually-hidden');
    button.hidden = false;
    status.hidden = false;
  });

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

  var copyStates = new WeakMap();
  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target instanceof Element ? target.closest('[data-copy]') : null;
    if (!button) return;
    var source = document.getElementById(button.getAttribute('data-copy') || '');
    if (!source) return;
    var state = copyStates.get(button);
    if (!state) { state = { label: button.textContent, timer: null, sequence: 0 }; copyStates.set(button, state); }
    clearTimeout(state.timer);
    var sequence = ++state.sequence;
    function feedback(text) {
      if (sequence !== state.sequence) return;
      button.textContent = text;
      state.timer = setTimeout(function () { button.textContent = state.label; }, 1500);
    }
    copyText(source.textContent || '').then(
      function () {
        feedback('已复制');
      },
      function () {
        if (sequence !== state.sequence) return;
        var range = document.createRange();
        range.selectNodeContents(source);
        var selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        feedback('请手动复制');
      },
    );
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var open = document.querySelectorAll('details[data-dismissable][open]');
    for (var i = 0; i < open.length; i += 1) {
      var details = open[i];
      var inside = details.contains(document.activeElement);
      details.open = false;
      var summary = details.querySelector('summary');
      if (inside && summary) summary.focus();
    }
  });
  function closeOutside(target) {
    document.querySelectorAll('details[data-dismissable][open]').forEach(function (details) {
      if (!(target instanceof Node) || !details.contains(target)) details.open = false;
    });
  }
  document.addEventListener('click', function (event) {
    closeOutside(event.target);
  });
  document.addEventListener('focusin', function (event) {
    closeOutside(event.target);
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
      return;
    }
    // form[data-busy-label]：提交后要等一会儿的操作（请 AI 找话题）。所在的 [data-busy-scope] 进入等待状态，
    // 写明正在做什么，并禁用里面的按钮防止重复提交。页面随后整页跳转，不需要恢复。
    var busy = form.getAttribute('data-busy-label');
    var scope = busy ? form.closest('[data-busy-scope]') : null;
    if (!scope || scope.classList.contains('is-busy')) {
      if (scope) event.preventDefault();
      return;
    }
    scope.classList.add('is-busy');
    scope.setAttribute('aria-busy', 'true');
    var status = scope.querySelector('[data-busy-status]');
    if (status) {
      status.textContent = busy;
      status.hidden = false;
    }
    // 等这次提交发出去之后再禁用按钮（现在禁用不影响提交，但保持顺序更稳妥）
    setTimeout(function () {
      scope.querySelectorAll('button').forEach(function (button) {
        button.disabled = true;
      });
    }, 0);
  });
  // 从往返缓存回到页面时（后退），解除等待状态
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    document.querySelectorAll('[data-busy-scope].is-busy').forEach(function (scope) {
      scope.classList.remove('is-busy');
      scope.removeAttribute('aria-busy');
      var status = scope.querySelector('[data-busy-status]');
      if (status) status.hidden = true;
      scope.querySelectorAll('button').forEach(function (button) {
        button.disabled = false;
      });
    });
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

// 体验登录支持无脚本表单；增强时展示提交与网络失败状态，保持可重试。
document.querySelectorAll('form[data-demo-login]').forEach(function (form) {
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = form.querySelector('button');
    var error = form.querySelector('[data-demo-error]');
    var label = button.textContent;
    button.disabled = true;
    button.textContent = '正在进入…';
    form.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try {
      var response = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.redirected) throw new Error();
      window.location.assign(response.url);
    } catch (_) {
      error.textContent = '体验登录失败，请重试；若仍失败，请联系维护者。';
      error.hidden = false;
      button.disabled = false;
      button.textContent = label;
      form.removeAttribute('aria-busy');
    }
  });
});

/*
 * 必答题编辑（contracts 19.1）：“用例子填”按钮把模板填进第一道还空着的题。没有脚本时按钮不显示。
 */
(function () {
  'use strict';
  Array.prototype.slice.call(document.querySelectorAll('[data-question-editor]')).forEach(function (editor) {
    var templates = editor.querySelector('[data-question-templates]');
    if (!templates) return;
    templates.hidden = false;
    templates.addEventListener('click', function (event) {
      var target = event.target;
      var button = target instanceof Element ? target.closest('[data-question-template]') : null;
      if (!button) return;
      var template;
      try {
        template = JSON.parse(button.getAttribute('data-question-template') || '{}');
      } catch (error) {
        return;
      }
      var items = Array.prototype.slice.call(editor.querySelectorAll('[data-question-item]'));
      var item = items.filter(function (candidate) {
        var prompt = candidate.querySelector('input[name$="_prompt"]');
        var options = candidate.querySelector('textarea[name$="_options"]');
        return prompt && options && !prompt.value.trim() && !options.value.trim();
      })[0];
      if (!item) return;
      item.querySelector('input[name$="_prompt"]').value = template.prompt || '';
      item.querySelector('textarea[name$="_options"]').value = template.options || '';
      var kind = item.querySelector('input[name$="_kind"][value="' + (template.kind === 'multi' ? 'multi' : 'single') + '"]');
      if (kind) kind.checked = true;
      item.querySelector('input[name$="_prompt"]').focus();
    });
  });
})();
