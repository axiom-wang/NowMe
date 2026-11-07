/* 主站聊天：纯文本 DOM、单次请求去重、可恢复的增量轮询。 */
(function () {
  'use strict';
  var root = document.querySelector('[data-chat]');
  var inbox = document.querySelector('[data-inbox="live"]');
  var badge = document.querySelector('[data-message-unread]');
  if (!root && !inbox && !badge) return;
  var form = root && root.querySelector('[data-chat-form]');
  var history = root && root.querySelector('[data-chat-history]');
  var list = root && root.querySelector('[data-message-list]');
  var status = root && root.querySelector('[data-chat-status]');
  var older = root && root.querySelector('[data-older]');
  var jump = root && root.querySelector('[data-new-messages]');
  var input = form && form.elements.text;
  var button = form && form.querySelector('button[type="submit"]');
  var base = root && '/messages/' + root.getAttribute('data-chat');
  var stopped = false;
  var polling = false;
  var sending = false;
  var loadingOlder = false;
  var readSequence = 0;
  var readPending = false;
  var pending = null;
  var seen = new Set();
  var latest = 0;
  var oldest = 0;
  if (list) list.querySelectorAll('[data-sequence]').forEach(function (item) {
    var seq = Number(item.getAttribute('data-sequence'));
    seen.add(seq); latest = Math.max(latest, seq); oldest = oldest ? Math.min(oldest, seq) : seq;
  });

  async function request(url, data) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch(url, {
        method: data ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json' }, body: data ? new URLSearchParams(data) : undefined
      });
      if (!response.ok) {
        var error = new Error('网络暂时不可用，请稍后重试');
        error.status = response.status;
        if (response.status === 401) error.message = '登录已过期，请重新登录。草稿仍保留在输入框中。';
        else if (response.status === 403) error.message = '页面已过期，请刷新后重试。请先复制输入框里的草稿。';
        else if (response.status === 404) error.message = '已失去该会话的访问权限，请返回消息列表。';
        else {
          try { error.message = (await response.json()).error || error.message; } catch (_) { /* 非 JSON 错误使用默认提示 */ }
        }
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.status) throw error;
      throw new Error('网络暂时不可用，将自动重试。');
    } finally { clearTimeout(timer); }
  }

  function showError(error) {
    if (!status) return;
    status.textContent = error.message || '网络暂时不可用，将自动重试。';
    if ([401, 403, 404].includes(error.status)) {
      stopped = true; button.disabled = true; input.disabled = false;
      root.querySelector(error.status === 401 ? '[data-chat-login]' : '[data-chat-back]').hidden = false;
      if (error.status === 404) {
        // 权限失效后清掉已经显示的聊天内容，保留用户自己的未发送草稿。
        list.replaceChildren(); older.hidden = true; jump.hidden = true;
        var members = root.querySelector('.chat-members');
        if (members) members.remove();
      }
    }
  }

  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function messageNode(message) {
    var item = node('li', 'message' + (message.senderId === root.getAttribute('data-user-id') ? ' message--mine' : ''));
    item.setAttribute('data-sequence', String(message.sequence));
    var meta = node('p', 'message-meta');
    meta.append(node('strong', '', message.senderName));
    var time = node('time', '', new Date(message.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }));
    time.dateTime = message.createdAt; meta.append(time);
    item.append(meta, node('p', 'message-text', message.text));
    return item;
  }

  function atBottom() { return history.scrollHeight - history.scrollTop - history.clientHeight < 40; }
  async function markRead() {
    if (stopped || readPending || document.hidden || !document.hasFocus() || !atBottom() || latest <= readSequence) return;
    readPending = true;
    var sequence = latest;
    try {
      await request(base + '/read', { _csrf: form.elements._csrf.value, sequence: String(sequence) });
      readSequence = sequence;
    } catch (error) { showError(error); }
    finally { readPending = false; }
  }

  async function syncMessages() {
    var more = true;
    while (more && !document.hidden && !stopped) {
      var page = await request(base + '/items?after=' + latest);
      if (document.hidden || stopped) return;
      var bottom = atBottom();
      var added = false;
      page.messages.forEach(function (message) {
        latest = Math.max(latest, message.sequence);
        oldest = oldest ? Math.min(oldest, message.sequence) : message.sequence;
        if (seen.has(message.sequence)) return;
        seen.add(message.sequence); list.append(messageNode(message)); added = true;
      });
      if (seen.size) root.querySelector('[data-chat-empty]').hidden = true;
      if (added && bottom) history.scrollTop = history.scrollHeight;
      else if (added) jump.hidden = false;
      more = page.hasMore && page.messages.length > 0;
    }
    await markRead();
  }

  function renderInbox(data) {
    var ul = inbox.querySelector('[data-conversation-list]');
    if (ul.contains(document.activeElement)) return;
    var fragment = document.createDocumentFragment();
    data.conversations.forEach(function (item) {
      var li = node('li', 'conversation-item');
      var link = node('a', 'conversation-link'); link.href = '/messages/' + item.id;
      var icon = node('span', 'conversation-icon', item.kind === 'group' ? '群' : Array.from(item.title)[0]); icon.setAttribute('aria-hidden', 'true');
      var copy = node('span', 'conversation-copy');
      copy.append(node('strong', '', item.title), node('span', 'muted', item.wallName), node('span', 'conversation-preview', item.lastText || '还没有消息，来打个招呼吧'));
      link.append(icon, copy);
      if (item.unread) { var count = node('span', 'message-badge', item.unread); count.setAttribute('aria-label', item.unread + ' 条未读'); link.append(count); }
      li.append(link); fragment.append(li);
    });
    ul.replaceChildren(fragment);
    inbox.querySelector('[data-inbox-empty]').hidden = data.conversations.length > 0;
    var next = inbox.querySelector('[data-conversation-next]'); next.hidden = !data.hasMore;
    if (data.hasMore) { var last = data.conversations[data.conversations.length - 1]; next.href = '/messages?before=' + last.lastSequence + ':' + last.id; }
  }

  async function poll() {
    if (polling || document.hidden || stopped || sending || loadingOlder) return;
    polling = true;
    try {
      if (root) await syncMessages();
      if (inbox) renderInbox(await request('/messages/list'));
      if (badge) {
        var data = await request('/messages/unread');
        badge.textContent = String(data.unread); badge.hidden = data.unread === 0;
        badge.setAttribute('aria-label', data.unread + ' 条未读消息');
      }
    } catch (error) { showError(error); }
    finally { polling = false; }
  }

  if (root) {
    history.scrollTop = history.scrollHeight;
    history.addEventListener('scroll', function () { if (atBottom()) jump.hidden = true; void markRead(); });
    jump.addEventListener('click', function () { history.scrollTop = history.scrollHeight; jump.hidden = true; void markRead(); });
    older.addEventListener('click', async function () {
      if (loadingOlder || stopped || !oldest) return;
      loadingOlder = true; older.disabled = true;
      var oldHeight = history.scrollHeight;
      var oldTop = history.scrollTop;
      try {
        var page = await request(base + '/items?before=' + oldest);
        if (stopped) return;
        var fragment = document.createDocumentFragment();
        page.messages.forEach(function (message) {
          oldest = Math.min(oldest, message.sequence);
          if (!seen.has(message.sequence)) { seen.add(message.sequence); fragment.append(messageNode(message)); }
        });
        list.prepend(fragment); older.hidden = !page.hasMore;
        history.scrollTop = oldTop + history.scrollHeight - oldHeight;
      } catch (error) { showError(error); }
      finally { loadingOlder = false; older.disabled = false; }
    });
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (sending || stopped) return;
      var text = input.value;
      if (!text.trim()) { status.textContent = '请输入消息内容'; return; }
      if (Array.from(text.trim()).length > Number(input.getAttribute('data-max-length'))) { status.textContent = '每条消息最多 2000 个字'; return; }
      if (!pending || pending.text !== text) pending = { text: text, clientId: form.elements.clientId.value };
      sending = true; button.disabled = true; input.disabled = true; button.textContent = '发送中…'; status.textContent = '正在发送…';
      try {
        await request(base + '/send', { _csrf: form.elements._csrf.value, clientId: pending.clientId, text: pending.text });
        input.value = ''; pending = null; form.elements.clientId.value = crypto.randomUUID();
        status.textContent = '已发送';
      } catch (error) {
        status.textContent = '发送失败，内容已保留，点击“重试发送”重试。';
        if (error.status) showError(error);
      } finally {
        sending = false; input.disabled = false; button.disabled = stopped; button.textContent = pending ? '重试发送' : '发送';
      }
      if (!pending) void poll();
    });
    input.addEventListener('input', function () {
      if (pending && input.value !== pending.text) { pending = null; form.elements.clientId.value = crypto.randomUUID(); button.textContent = '发送'; }
    });
    window.addEventListener('focus', function () { void markRead(); void poll(); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) void poll(); });
  window.addEventListener('online', function () { void poll(); });
  setInterval(function () { void poll(); }, 2500);
  void poll();
})();
