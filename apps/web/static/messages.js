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
  var stopped = false; // 登录失效等整页性错误：所有轮询停止
  var chatStopped = false; // 只是这个聊天打不开了：聊天窗口停止，左栏与顶栏照常更新
  var polling = false;
  var lastUnreadAt = 0;
  var unreadInterval = 30000;
  var pollTimer = null;
  var sending = false;
  var loadingOlder = false;
  var readSequence = 0;
  var readPending = false;
  var pending = null;
  var userId = root && root.getAttribute('data-user-id');
  var draftKey = root && 'nowme:draft:' + userId + ':' + root.getAttribute('data-chat');
  var enterSends = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var scrollKey = 'nowme:inbox-scroll';
  var PAGE = 50;
  var loadingMore = false;
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

  /** chat：错误来自聊天窗口自己的请求。401 让整页停；聊天 403/404 只停聊天窗口（左栏会话列表继续更新）。 */
  function showError(error, chat) {
    var fatal = [401, 403, 404].includes(error.status);
    if (error.status === 401 || (fatal && !chat)) { stopped = true; clearInterval(pollTimer); }
    if (fatal) chatStopped = true;
    if (!status) return;
    status.textContent = error.message || '网络好像断了，恢复后会自动重试。';
    if (fatal) {
      button.disabled = true; input.disabled = false;
      root.querySelector(error.status === 401 ? '[data-chat-login]' : '[data-chat-back]').hidden = false;
      if (error.status === 404) {
        // 权限失效后清掉已经显示的聊天内容，保留用户自己的未发送草稿。
        list.replaceChildren(); older.hidden = true; jump.hidden = true;
        var members = root.querySelector('.chat-members');
        if (members) members.remove();
      }
    }
  }
  function chatDead() { return stopped || chatStopped; }

  function node(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // 时间按浏览器所在时区显示（服务端渲染的首屏按东京时区，加载后会被改成本地时间）
  function localDay(time) { return new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime(); }
  function conversationTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    var now = new Date();
    var days = Math.round((localDay(now) - localDay(date)) / 86400000);
    if (days === 0) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (days === 1) return '昨天';
    if (days > 1 && days < 7) return date.toLocaleDateString('zh-CN', { weekday: 'short' });
    var options = { month: 'numeric', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString('zh-CN', options);
  }
  function messageTime(value) {
    return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function localizeTimes() {
    document.querySelectorAll('.conversation-time[datetime]').forEach(function (el) { el.textContent = conversationTime(el.getAttribute('datetime')); });
    document.querySelectorAll('.message-meta time[datetime]').forEach(function (el) { el.textContent = messageTime(el.getAttribute('datetime')); });
  }

  function filterInbox() {
    if (!inboxPanel || !inboxFilters) return;
    var filter = location.hash === '#unread' ? 'unread' : location.hash === '#group' ? 'group' : 'all';
    var visible = 0;
    var unread = 0;
    inboxPanel.querySelectorAll('.conversation-item').forEach(function (item) {
      var count = Number(item.getAttribute('data-unread'));
      unread += count;
      // 当前打开的会话始终可见：不会因为筛选把正在聊的窗口从左栏里藏掉
      var current = item.getAttribute('data-active') === 'true';
      item.hidden = !current && (filter === 'unread' ? count === 0 : filter === 'group' && item.getAttribute('data-kind') !== 'group');
      if (!item.hidden) visible++;
      // 点开别的会话时带上当前筛选，会话页的左栏保持同一个筛选
      var link = item.querySelector('.conversation-link');
      if (link) link.hash = filter === 'all' ? '' : filter;
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
    var time = node('time', '', messageTime(message.createdAt));
    time.dateTime = message.createdAt; meta.append(time);
    item.append(meta, node('p', 'message-text', message.text));
    return item;
  }

  function atBottom() { return history.scrollHeight - history.scrollTop - history.clientHeight < 40; }
  function clearActiveUnread() {
    // 已经读到最新：当前会话的角标立刻消失，顶栏也马上重新取一次未读数
    var item = inboxPanel && inboxPanel.querySelector('[data-active="true"]');
    if (item) {
      item.setAttribute('data-unread', '0');
      var count = item.querySelector('.message-badge');
      if (count) count.remove();
      filterInbox();
    }
    lastUnreadAt = 0;
  }
  async function markRead() {
    if (chatDead() || readPending || document.hidden || !document.hasFocus() || !atBottom() || latest <= readSequence) return;
    readPending = true;
    var sequence = latest;
    try {
      await request(base + '/read', { _csrf: form.elements._csrf.value, sequence: String(sequence) });
      readSequence = sequence;
      clearActiveUnread();
    } catch (error) { showError(error, true); }
    finally { readPending = false; }
  }

  async function syncMessages() {
    var more = true;
    while (more && !document.hidden && !chatDead()) {
      var page = await request(base + '/items?after=' + latest);
      if (document.hidden || chatDead()) return;
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

  function conversationNode(item) {
    var active = !!root && item.id === root.getAttribute('data-chat');
    var li = node('li', 'conversation-item');
    li.setAttribute('data-kind', item.kind); li.setAttribute('data-unread', String(item.unread)); li.setAttribute('data-id', item.id);
    if (active) li.setAttribute('data-active', 'true');
    var link = node('a', 'conversation-link'); link.href = '/messages/' + item.id;
    if (active) link.setAttribute('aria-current', 'page');
    var icon = node('span', 'conversation-icon' + (item.kind === 'group' ? ' conversation-icon--group' : ''), item.kind === 'group' ? '群' : Array.from(item.title)[0]); icon.setAttribute('aria-hidden', 'true');
    if (item.avatarUrl) { var avatar = node('img'); avatar.src = item.avatarUrl; avatar.alt = ''; icon.replaceChildren(avatar); }
    var copy = node('span', 'conversation-copy');
    var head = node('span', 'conversation-head');
    head.append(node('strong', '', item.title));
    if (item.lastAt) { var time = node('time', 'conversation-time', conversationTime(item.lastAt)); time.dateTime = item.lastAt; head.append(time); }
    copy.append(head);
    if (item.kind === 'direct') copy.append(node('span', 'muted', item.wallName));
    var foot = node('span', 'conversation-foot');
    foot.append(node('span', 'conversation-preview', item.lastText || '还没有消息，来打个招呼吧'));
    if (item.unread) { var count = node('span', 'message-badge', item.unread); count.setAttribute('aria-label', item.unread + ' 条未读'); foot.append(count); }
    copy.append(foot);
    link.append(icon, copy); li.append(link);
    return li;
  }

  function updateNext(data) {
    var next = inbox.querySelector('[data-conversation-next]');
    var last = data.conversations[data.conversations.length - 1];
    next.hidden = !data.hasMore || !last;
    if (data.hasMore && last) next.href = '/messages?before=' + last.lastSequence + ':' + last.id;
  }

  function renderInbox(data) {
    var ul = inbox.querySelector('[data-conversation-list]');
    if (ul.contains(document.activeElement)) return;
    var fragment = document.createDocumentFragment();
    data.conversations.forEach(function (item) { fragment.append(conversationNode(item)); });
    ul.replaceChildren(fragment);
    updateNext(data);
    filterInbox();
  }

  // 左栏“更早的会话”：原地加载下一页，不再整页跳转（当前聊天不会丢）
  async function loadMoreConversations() {
    if (loadingMore || stopped) return;
    var next = inbox.querySelector('[data-conversation-next]');
    var before = new URL(next.href, location.href).searchParams.get('before');
    if (!before) return;
    loadingMore = true; next.setAttribute('aria-busy', 'true');
    try {
      var data = await request('/messages/list?before=' + encodeURIComponent(before));
      var ul = inbox.querySelector('[data-conversation-list]');
      var have = new Set(Array.prototype.map.call(ul.querySelectorAll('.conversation-item'), function (li) { return li.getAttribute('data-id'); }));
      data.conversations.forEach(function (item) { if (!have.has(item.id)) ul.append(conversationNode(item)); });
      updateNext(data);
      filterInbox();
    } catch (error) { showError(error, false); }
    finally { loadingMore = false; next.removeAttribute('aria-busy'); }
  }

  // 已展开的会话数：轮询要覆盖已经加载出来的部分，否则一刷新就缩回第一页
  function listUrl() {
    var count = inbox.querySelectorAll('.conversation-item').length;
    return count > PAGE ? '/messages/list?limit=' + Math.min(count, 500) : '/messages/list';
  }

  async function poll() {
    if (polling || document.hidden || stopped || sending || loadingOlder) return;
    polling = true;
    try {
      // 聊天窗口与左栏 / 顶栏各自处理错误：聊天 404 不影响会话列表继续更新
      if (root && !chatStopped) { try { await syncMessages(); } catch (error) { showError(error, true); } }
      if (stopped) return;
      try {
        if (inbox && !loadingMore) renderInbox(await request(listUrl()));
        if (badge && !stopped && Date.now() - lastUnreadAt >= unreadInterval) {
          lastUnreadAt = Date.now();
          var data = await request('/messages/unread');
          badge.textContent = String(data.unread); badge.hidden = data.unread === 0;
          badge.setAttribute('aria-label', data.unread + ' 条未读消息');
        }
      } catch (error) { showError(error, false); }
    } finally { polling = false; }
  }

  localizeTimes();
  if (inboxFilters) {
    inboxFilters.removeAttribute('data-pending');
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
  if (inbox) {
    // 在左栏点开另一个会话是整页跳转：记住这次点击时的左栏滚动位置，下一页只恢复一次（从顶栏等别处进来不恢复）；
    // 首次进入时把当前会话滚进视野
    var scroller = inbox;
    try {
      var saved = JSON.parse(sessionStorage.getItem(scrollKey) || 'null');
      sessionStorage.removeItem(scrollKey);
      if (saved && saved.top > 0 && Date.now() - saved.at < 15000) scroller.scrollTop = saved.top;
    } catch (_) { /* 存储不可用时不恢复 */ }
    var current = scroller.querySelector('[data-active="true"]');
    if (current) current.scrollIntoView({ block: 'nearest' });
    var more = scroller.querySelector('[data-conversation-next]');
    if (more) more.addEventListener('click', function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void loadMoreConversations();
    });
    scroller.addEventListener('click', function (event) {
      var link = event.target.closest('.conversation-link');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      try { sessionStorage.setItem(scrollKey, JSON.stringify({ top: scroller.scrollTop, at: Date.now() })); } catch (_) { /* 忽略 */ }
      // 宽屏下在聊天之间切换用“替换”而不是“新增”历史记录：浏览器后退不会把看过的每个聊天退一遍
      if (root && window.matchMedia('(min-width: 760px)').matches && link.getAttribute('aria-current') !== 'page') {
        event.preventDefault();
        location.replace(link.href);
      }
    });
  }
  if (root) {
    // 草稿按会话记在本标签页里：在左栏切到别的聊天再回来，没发完的话还在（发送成功后清除；服务端给的开场白优先）
    var saveDraft = function () {
      try {
        if (input.value) sessionStorage.setItem(draftKey, input.value);
        else sessionStorage.removeItem(draftKey);
      } catch (_) { /* 存储不可用时不保存草稿 */ }
    };
    if (!input.value) { try { input.value = sessionStorage.getItem(draftKey) || ''; } catch (_) { /* 忽略 */ } }
    history.scrollTop = history.scrollHeight;
    history.addEventListener('scroll', function () { if (atBottom()) jump.hidden = true; void markRead(); });
    jump.addEventListener('click', function () { history.scrollTop = history.scrollHeight; jump.hidden = true; void markRead(); });
    older.addEventListener('click', async function () {
      if (loadingOlder || chatDead() || !oldest) return;
      loadingOlder = true; older.disabled = true;
      var oldHeight = history.scrollHeight;
      var oldTop = history.scrollTop;
      try {
        var page = await request(base + '/items?before=' + oldest);
        if (chatDead()) return;
        var fragment = document.createDocumentFragment();
        page.messages.forEach(function (message) {
          oldest = Math.min(oldest, message.sequence);
          if (!seen.has(message.sequence)) { seen.add(message.sequence); fragment.append(messageNode(message)); }
        });
        list.prepend(fragment); older.hidden = !page.hasMore;
        history.scrollTop = oldTop + history.scrollHeight - oldHeight;
      } catch (error) { showError(error, true); }
      finally { loadingOlder = false; older.disabled = false; }
    });
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (sending || chatDead()) return;
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
        saveDraft();
        pending = null; form.elements.clientId.value = crypto.randomUUID();
        status.textContent = '已发送';
      } catch (error) {
        status.textContent = '没发出去，内容还在输入框里，点“重试发送”再试一次。';
        if (error.status) showError(error, true);
      } finally {
        if (pending && input.value !== pending.text) { pending = null; form.elements.clientId.value = crypto.randomUUID(); }
        sending = false; button.disabled = chatDead(); button.textContent = pending ? '重试发送' : '发送';
      }
      if (!pending) void poll();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      // Ctrl / ⌘ + Enter 任何设备都发送；鼠标键盘设备上 Enter 直接发送、Shift + Enter 换行；触屏手机上 Enter 仍是换行
      var send = event.ctrlKey || event.metaKey || (enterSends && !event.shiftKey && !event.altKey);
      if (!send) return;
      event.preventDefault();
      if (!input.value.trim() && !(event.ctrlKey || event.metaKey)) return;
      form.requestSubmit();
    });
    input.addEventListener('input', function () {
      saveDraft();
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
