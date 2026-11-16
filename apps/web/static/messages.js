/* 主站聊天：纯文本 DOM、单次请求去重、可恢复的增量轮询。 */
(function () {
  'use strict';
  var root = document.querySelector('[data-chat]');
  var inbox = document.querySelector('[data-inbox="live"]');
  var inboxPanel = document.querySelector('[data-inbox]');
  var inboxFilters = document.querySelector('[data-inbox-filters]');
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
  var lastUnreadAt = 0;
  var unreadInterval = 30000;
  var pollTimer = null;
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
        var error = new Error('网络好像不太稳，稍后再试一次。');
        error.status = response.status;
        if (response.status === 401) error.message = '登录已经过期，请重新登录。输入框里的草稿还在。';
        else if (response.status === 403) {
          // 私聊已关闭（拉黑 / 停用）时服务端给出 JSON 说明；CSRF / 来源校验失败是 HTML 错误页
          error.message = '页面打开太久了，刷新后再试。刷新前先复制一下输入框里的草稿。';
          try { error.message = (await response.json()).error || error.message; } catch (_) { /* 非 JSON */ }
        }
        else if (response.status === 404) error.message = '这段对话打不开了，回到消息列表看看。';
        else {
          try { error.message = (await response.json()).error || error.message; } catch (_) { /* 非 JSON 错误使用默认提示 */ }
        }
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.status) throw error;
      throw new Error('网络好像断了，恢复后会自动重试。');
    } finally { clearTimeout(timer); }
  }

  function showError(error) {
    if ([401, 403, 404].includes(error.status)) {
      stopped = true;
      clearInterval(pollTimer);
    }
    if (!status) return;
    status.textContent = error.message || '网络好像断了，恢复后会自动重试。';
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

  function conversationTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    var now = new Date();
    var day = function (time) { return Math.floor((time.getTime() + 9 * 60 * 60 * 1000) / 86400000); };
    var days = day(now) - day(date);
    if (days === 0) return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
    if (days === 1) return '昨天';
    if (days > 1 && days < 7) return date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Tokyo', weekday: 'short' });
    var year = function (time) { return new Date(time.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear(); };
    var options = { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' };
    if (year(date) !== year(now)) options.year = 'numeric';
    return date.toLocaleDateString('zh-CN', options);
  }

  function filterInbox() {
    if (!inboxPanel || !inboxFilters) return;
    var filter = location.hash === '#unread' ? 'unread' : location.hash === '#group' ? 'group' : 'all';
    var visible = 0;
    var unread = 0;
    inboxPanel.querySelectorAll('.conversation-item').forEach(function (item) {
      var count = Number(item.getAttribute('data-unread'));
      unread += count;
      item.hidden = filter === 'unread' ? count === 0 : filter === 'group' && item.getAttribute('data-kind') !== 'group';
      if (!item.hidden) visible++;
    });
    inboxFilters.querySelectorAll('[data-inbox-filter]').forEach(function (button) {
      var active = button.getAttribute('data-inbox-filter') === filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    var count = inboxFilters.querySelector('[data-inbox-unread]');
    count.textContent = String(unread); count.hidden = unread === 0;
    inboxPanel.querySelector('[data-inbox-empty]').hidden = visible > 0;
    var more = !inboxPanel.querySelector('[data-conversation-next]').hidden || inboxPanel.getAttribute('data-inbox') === 'paged';
    inboxPanel.querySelector('[data-inbox-page-note]').hidden = !more;
    var empty = inboxPanel.querySelector('[data-inbox-empty]');
    var title = filter === 'unread' ? (more ? '这一页没有未读消息' : '消息都看过了') : filter === 'group' ? '这里还没有群聊' : empty.getAttribute('data-empty-title');
    var copy = filter === 'unread' ? (more ? '更早的聊天里可能还有，点下面的“更早的会话”看看。' : '有新消息时会出现在这里。') : filter === 'group' ? '每面墙都有一个全员群，进去和大家打个招呼。' : empty.getAttribute('data-empty-copy');
    inboxPanel.querySelector('[data-inbox-empty-title]').textContent = title;
    inboxPanel.querySelector('[data-inbox-empty-copy]').textContent = copy;
    var emptyAction = inboxPanel.querySelector('[data-inbox-empty-action]');
    if (emptyAction) emptyAction.hidden = filter === 'unread';
    var next = inboxPanel.querySelector('[data-conversation-next]');
    var nextUrl = new URL(next.href);
    nextUrl.hash = filter === 'all' ? '' : filter;
    next.href = nextUrl.pathname + nextUrl.search + nextUrl.hash;
    var newest = inboxPanel.querySelector('[data-conversation-latest]');
    if (newest) newest.href = '/messages' + nextUrl.hash;
  }

  function messageNode(message) {
    var item = node('li', 'message' + (message.senderId === root.getAttribute('data-user-id') ? ' message--mine' : ''));
    item.setAttribute('data-sequence', String(message.sequence));
    var meta = node('p', 'message-meta');
    if (message.senderAvatarUrl) { var avatar = node('img', 'chat-avatar'); avatar.src = message.senderAvatarUrl; avatar.alt = ''; meta.append(avatar); }
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
      li.setAttribute('data-kind', item.kind); li.setAttribute('data-unread', String(item.unread));
      var link = node('a', 'conversation-link'); link.href = '/messages/' + item.id;
      var icon = node('span', 'conversation-icon' + (item.kind === 'group' ? ' conversation-icon--group' : ''), item.kind === 'group' ? '群' : Array.from(item.title)[0]); icon.setAttribute('aria-hidden', 'true');
      if (item.avatarUrl) { var avatar = node('img'); avatar.src = item.avatarUrl; avatar.alt = ''; icon.replaceChildren(avatar); }
      var copy = node('span', 'conversation-copy');
      copy.append(node('strong', '', item.title), node('span', 'muted', item.wallName), node('span', 'conversation-preview', item.lastText || '还没有消息，来打个招呼吧'));
      link.append(icon, copy);
      if (item.lastAt) { var time = node('time', 'conversation-time', conversationTime(item.lastAt)); time.dateTime = item.lastAt; link.append(time); }
      if (item.unread) { var count = node('span', 'message-badge', item.unread); count.setAttribute('aria-label', item.unread + ' 条未读'); link.append(count); }
      li.append(link); fragment.append(li);
    });
    ul.replaceChildren(fragment);
    var next = inbox.querySelector('[data-conversation-next]'); next.hidden = !data.hasMore;
    if (data.hasMore) { var last = data.conversations[data.conversations.length - 1]; next.href = '/messages?before=' + last.lastSequence + ':' + last.id; }
    filterInbox();
  }

  async function poll() {
    if (polling || document.hidden || stopped || sending || loadingOlder) return;
    polling = true;
    try {
      if (root) await syncMessages();
      if (stopped) return;
      if (inbox) renderInbox(await request('/messages/list'));
      if (badge && !stopped && Date.now() - lastUnreadAt >= unreadInterval) {
        lastUnreadAt = Date.now();
        var data = await request('/messages/unread');
        badge.textContent = String(data.unread); badge.hidden = data.unread === 0;
        badge.setAttribute('aria-label', data.unread + ' 条未读消息');
      }
    } catch (error) { showError(error); }
    finally { polling = false; }
  }

  if (inboxFilters) {
    inboxFilters.hidden = false;
    inboxFilters.addEventListener('click', function (event) {
      var button = event.target.closest('[data-inbox-filter]');
      if (!button) return;
      var filter = button.getAttribute('data-inbox-filter');
      window.history.replaceState(null, '', location.pathname + location.search + (filter === 'all' ? '' : '#' + filter));
      filterInbox();
    });
    window.addEventListener('hashchange', filterInbox);
    filterInbox();
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
      if (!text.trim()) { status.textContent = '先写点什么再发送。'; return; }
      if (Array.from(text.trim()).length > Number(input.getAttribute('data-max-length'))) { status.textContent = '每条消息最多 ' + input.getAttribute('data-max-length') + ' 个字，删减一些再发。'; return; }
      if (!pending || pending.text !== text) pending = { text: text, clientId: form.elements.clientId.value };
      // 保持输入框可编辑和焦点，移动端不因禁用而收起键盘；响应只清空本次发出的文字。
      var submitted = pending;
      sending = true; button.disabled = true; input.focus({ preventScroll: true }); button.textContent = '发送中…'; status.textContent = '正在发送…';
      try {
        await request(base + '/send', { _csrf: form.elements._csrf.value, clientId: submitted.clientId, text: submitted.text });
        if (input.value === submitted.text) input.value = '';
        pending = null; form.elements.clientId.value = crypto.randomUUID();
        status.textContent = '已发送';
      } catch (error) {
        status.textContent = '没发出去，内容还在输入框里，点“重试发送”再试一次。';
        if (error.status) showError(error);
      } finally {
        if (pending && input.value !== pending.text) { pending = null; form.elements.clientId.value = crypto.randomUUID(); }
        sending = false; button.disabled = stopped; button.textContent = pending ? '重试发送' : '发送';
      }
      if (!pending) void poll();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    input.addEventListener('input', function () {
      if (sending) return;
      if (pending && input.value !== pending.text) { pending = null; form.elements.clientId.value = crypto.randomUUID(); button.textContent = '发送'; }
    });
    window.addEventListener('focus', function () { void markRead(); void poll(); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) void poll(); });
  window.addEventListener('online', function () { void poll(); });
  pollTimer = setInterval(function () { void poll(); }, root || inbox ? 2500 : unreadInterval);
  void poll();
})();
