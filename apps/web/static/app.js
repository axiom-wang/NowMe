/*
 * 主站的少量客户端脚本（主站 CSP 不允许内联脚本，所以都放在这里）：
 * - [data-copy="<元素 id>"]：复制该元素的文字（Agent 指令）；
 * - form[data-confirm="<提示>"]：提交前确认（断开、删除等危险操作）；
 * - form[data-busy-label="<说明>"]：提交后显示等待状态（“和 TA 聊什么”）；
 * - form[data-only-changed]：提交时只带改过的输入框（直接改文字，避免整页文字超过表单上限）；
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
    if (form.hasAttribute('data-only-changed')) {
      form.querySelectorAll('input[type="text"], textarea').forEach(function (field) {
        if (field.value === field.defaultValue) field.disabled = true;
      });
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
 * 必答题编辑（contracts 19.1）。没有脚本时编辑器照样能用（选项是每行一个的文本框）；有脚本时：
 * - 选项文本框换成一行一个的选项列表：回车加下一个、空行退格删除、粘贴多行自动拆开、可单独删除，
 *   列表内容实时写回文本框，所以提交的字段不变；
 * - 只显示有内容的题和一道空题，“再加一道题”展开下一道；每道题可以一键清空（不在表单里的旧题保存时删除）；
 * - “用例子填”把模板填进第一道还空着的题。
 */
(function () {
  'use strict';
  var MAX_OPTIONS = 12;
  var MAX_OPTION_LENGTH = 12;
  var SPLIT = /[\n\r,，、;；]+/;

  function splitOptions(text) {
    return String(text || '')
      .split(SPLIT)
      .map(function (item) { return item.trim().replace(/\s+/g, ' '); })
      .filter(Boolean);
  }

  Array.prototype.slice.call(document.querySelectorAll('[data-question-editor]')).forEach(function (editor) {
    var items = Array.prototype.slice.call(editor.querySelectorAll('[data-question-item]'));
    var addQuestion = editor.querySelector('[data-question-add]');

    function promptOf(item) { return item.querySelector('input[name$="_prompt"]'); }
    function textareaOf(item) { return item.querySelector('[data-question-options]'); }
    function isEmpty(item) {
      return !promptOf(item).value.trim() && !textareaOf(item).value.trim();
    }

    function enhanceOptions(item) {
      var textarea = textareaOf(item);
      var label = textarea.closest('label');
      var list = document.createElement('ol');
      list.className = 'option-list';
      var foot = document.createElement('div');
      foot.className = 'option-list__foot';
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'option-list__add';
      add.textContent = '+ 添加选项';
      var count = document.createElement('span');
      count.className = 'option-list__count';
      count.setAttribute('aria-live', 'polite');
      foot.appendChild(add);
      foot.appendChild(count);
      // 文本框留在表单里（隐藏）负责提交；读屏用列表
      textarea.hidden = true;
      textarea.setAttribute('aria-hidden', 'true');
      textarea.tabIndex = -1;
      label.parentNode.insertBefore(list, label.nextSibling);
      list.parentNode.insertBefore(foot, list.nextSibling);
      var invalid = textarea.getAttribute('aria-invalid');
      var describedBy = textarea.getAttribute('aria-describedby');

      function rows() { return Array.prototype.slice.call(list.querySelectorAll('input')); }
      function sync() {
        var values = rows().map(function (input) { return input.value.trim(); }).filter(Boolean);
        textarea.value = values.join('\n');
        count.textContent = values.length + ' / ' + MAX_OPTIONS;
        add.disabled = rows().length >= MAX_OPTIONS;
        var many = rows().length > 2;
        Array.prototype.slice.call(list.querySelectorAll('.option-row__remove')).forEach(function (button) { button.disabled = !many; });
      }
      function renumber() {
        rows().forEach(function (input, index) { input.setAttribute('aria-label', '选项 ' + (index + 1)); });
      }
      function makeRow(value, after) {
        var row = document.createElement('li');
        row.className = 'option-row';
        var marker = document.createElement('span');
        marker.className = 'option-row__marker';
        marker.setAttribute('aria-hidden', 'true');
        var input = document.createElement('input');
        input.type = 'text';
        input.maxLength = MAX_OPTION_LENGTH;
        input.value = value || '';
        input.placeholder = '选项';
        input.autocomplete = 'off';
        if (invalid) input.setAttribute('aria-invalid', invalid);
        if (describedBy) input.setAttribute('aria-describedby', describedBy);
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'option-row__remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', '删除这个选项');
        row.appendChild(marker);
        row.appendChild(input);
        row.appendChild(remove);
        if (after && after.nextSibling) list.insertBefore(row, after.nextSibling);
        else if (after) list.appendChild(row);
        else list.appendChild(row);
        return input;
      }
      function setValues(values) {
        list.innerHTML = '';
        values.slice(0, MAX_OPTIONS).forEach(function (value) { makeRow(value); });
        while (rows().length < 2) makeRow('');
        renumber();
        sync();
      }

      list.addEventListener('input', sync);
      list.addEventListener('keydown', function (event) {
        var input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        var row = input.closest('.option-row');
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.isComposing) return;
          var next = row.nextElementSibling;
          if (next) { next.querySelector('input').focus(); return; }
          if (rows().length >= MAX_OPTIONS) return;
          makeRow('', row).focus();
          renumber();
          sync();
        } else if (event.key === 'Backspace' && !input.value && rows().length > 2) {
          event.preventDefault();
          var previous = row.previousElementSibling || row.nextElementSibling;
          row.remove();
          if (previous) previous.querySelector('input').focus();
          renumber();
          sync();
        }
      });
      list.addEventListener('paste', function (event) {
        var input = event.target;
        if (!(input instanceof HTMLInputElement) || !event.clipboardData) return;
        var parts = splitOptions(event.clipboardData.getData('text'));
        if (parts.length < 2) return;
        event.preventDefault();
        var row = input.closest('.option-row');
        var current = input.value.trim();
        input.value = current ? current : parts.shift();
        var last = row;
        parts.forEach(function (part) {
          if (rows().length >= MAX_OPTIONS) return;
          last = makeRow(part, last).closest('.option-row');
        });
        renumber();
        sync();
        last.querySelector('input').focus();
      });
      list.addEventListener('click', function (event) {
        var target = event.target;
        var button = target instanceof Element ? target.closest('.option-row__remove') : null;
        if (!button || button.disabled) return;
        var row = button.closest('.option-row');
        var focus = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        if (focus) focus.querySelector('input').focus();
        renumber();
        sync();
      });
      add.addEventListener('click', function () {
        if (rows().length >= MAX_OPTIONS) return;
        var empty = rows().filter(function (input) { return !input.value.trim(); })[0];
        (empty || makeRow('')).focus();
        renumber();
        sync();
      });

      setValues(splitOptions(textarea.value));
      item.nmSetOptions = setValues;
    }

    function refreshAdd() {
      if (!addQuestion) return;
      addQuestion.hidden = !items.some(function (item) { return item.hidden; });
    }

    function clearItem(item) {
      promptOf(item).value = '';
      item.nmSetOptions([]);
      var single = item.querySelector('input[name$="_kind"][value="single"]');
      if (single) single.checked = true;
    }

    items.forEach(function (item) {
      enhanceOptions(item);
      var remove = item.querySelector('[data-question-remove]');
      if (remove) {
        remove.hidden = false;
        remove.addEventListener('click', function () {
          clearItem(item);
          // 至少留一道题可填
          var visible = items.filter(function (candidate) { return !candidate.hidden; });
          if (visible.length > 1) {
            item.hidden = true;
            var focusTarget = visible.filter(function (candidate) { return candidate !== item; })[0];
            if (focusTarget) promptOf(focusTarget).focus();
          } else {
            promptOf(item).focus();
          }
          refreshAdd();
        });
      }
    });

    // 只显示有内容的题（含有错误提示的）和第一道空题
    var shownEmpty = false;
    items.forEach(function (item) {
      if (!isEmpty(item) || item.classList.contains('field--invalid')) return;
      if (shownEmpty) item.hidden = true;
      shownEmpty = true;
    });
    if (addQuestion) {
      addQuestion.addEventListener('click', function () {
        var next = items.filter(function (item) { return item.hidden; })[0];
        if (!next) return;
        next.hidden = false;
        promptOf(next).focus();
        refreshAdd();
      });
    }
    refreshAdd();

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
      var item = items.filter(isEmpty)[0];
      if (!item) return;
      item.hidden = false;
      promptOf(item).value = template.prompt || '';
      item.nmSetOptions(splitOptions(template.options || ''));
      var kindValue = template.kind === 'multi' || template.kind === 'text' ? template.kind : 'single';
      var kind = item.querySelector('input[name$="_kind"][value="' + kindValue + '"]');
      if (kind) kind.checked = true;
      promptOf(item).focus();
      refreshAdd();
    });
  });
})();

// Direct links to collapsed assistance also work after a form redirect.
(function () {
  function revealHash() {
    var id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    var target = id ? document.getElementById(id) : null;
    if (!target) return;
    var changed = false;
    for (var parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open) { parent.open = true; changed = true; }
    }
    if (changed) target.scrollIntoView({ block: 'start' });
  }
  revealHash();
  window.addEventListener('hashchange', revealHash);
})();
