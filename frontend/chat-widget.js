(function(){
  const API = window.API_BASE || '';
  const currentUser = localStorage.getItem('username') || 'guest';

  let ws = null;
  let activeTab = 'ai';
  let activeChannel = null;
  let aiHistory = [];
  let channels = [];
  let isConnected = false;

  function initWS() {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onopen = () => {
        isConnected = true;
        ws.send(JSON.stringify({ type: 'auth', user: currentUser }));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'chat' && activeChannel && msg.channel_id === activeChannel) {
            appendChatMessage(msg.sender, msg.content, msg.created_at, false);
          } else if (msg.type === 'data_change') {
            handleDataChange(msg.entity, msg.action, msg.data);
          }
        } catch(err) {}
      };
      ws.onclose = () => { isConnected = false; setTimeout(initWS, 5000); };
      ws.onerror = () => {};
    } catch(e) {}
  }

  function createWidget() {
    const div = document.createElement('div');
    div.id = 'chatWidget';
    div.innerHTML = `
<style>
#chatWidget { position:fixed; bottom:20px; right:20px; z-index:99999; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
#chatFab { width:56px; height:56px; border-radius:50%; background:linear-gradient(135deg,#667eea,#764ba2); border:none; color:white; font-size:24px; cursor:pointer; box-shadow:0 4px 15px rgba(102,126,234,0.4); display:flex; align-items:center; justify-content:center; transition:transform 0.2s; position:relative; }
#chatFab:hover { transform:scale(1.1); }
#chatFab .badge { position:absolute; top:-2px; right:-2px; background:#e74c3c; color:white; font-size:10px; min-width:18px; height:18px; border-radius:9px; display:none; align-items:center; justify-content:center; padding:0 4px; }
#chatPanel { display:none; position:absolute; bottom:70px; right:0; width:420px; height:560px; background:white; border-radius:16px; box-shadow:0 10px 40px rgba(0,0,0,0.15); flex-direction:column; overflow:hidden; }
#chatPanel.open { display:flex; }
.chat-header { background:linear-gradient(135deg,#667eea,#764ba2); color:white; padding:12px 16px; display:flex; align-items:center; justify-content:space-between; }
.chat-header h3 { font-size:15px; font-weight:600; margin:0; }
.chat-tabs { display:flex; background:#f8f9fa; border-bottom:1px solid #eee; }
.chat-tab { flex:1; padding:10px 8px; text-align:center; font-size:12px; color:#666; cursor:pointer; border-bottom:2px solid transparent; transition:all 0.2s; }
.chat-tab.active { color:#667eea; border-bottom-color:#667eea; font-weight:600; }
.chat-tab:hover { background:#f0f0f0; }
.chat-body { flex:1; overflow-y:auto; padding:12px; background:#fafafa; }
.chat-input-area { padding:10px 12px; border-top:1px solid #eee; background:white; display:flex; gap:8px; align-items:flex-end; }
.chat-input-area textarea { flex:1; border:1px solid #ddd; border-radius:8px; padding:8px 10px; font-size:13px; resize:none; max-height:80px; outline:none; font-family:inherit; }
.chat-input-area textarea:focus { border-color:#667eea; }
.chat-send-btn { width:36px; height:36px; border-radius:50%; background:#667eea; color:white; border:none; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.chat-send-btn:hover { background:#5a6fd6; }
.chat-send-btn:disabled { background:#ccc; cursor:not-allowed; }
.msg-bubble { margin-bottom:10px; max-width:85%; }
.msg-bubble.self { margin-left:auto; }
.msg-bubble .msg-sender { font-size:11px; color:#999; margin-bottom:2px; }
.msg-bubble .msg-content { padding:8px 12px; border-radius:12px; font-size:13px; line-height:1.5; word-break:break-word; white-space:pre-wrap; }
.msg-bubble.self .msg-content { background:#667eea; color:white; border-bottom-right-radius:4px; }
.msg-bubble.other .msg-content { background:white; color:#333; border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
.msg-bubble.ai .msg-content { background:linear-gradient(135deg,#f0f4ff,#e8eeff); color:#333; border-left:3px solid #667eea; border-bottom-left-radius:4px; }
.msg-bubble .msg-time { font-size:10px; color:#bbb; margin-top:2px; }
.action-item { background:#fff3cd; border:1px solid #ffc107; border-radius:6px; padding:6px 10px; margin-top:6px; font-size:12px; }
.action-item .action-assignee { color:#e67e22; font-weight:600; }
.action-item .action-priority-high { color:#e74c3c; }
.action-item .action-priority-medium { color:#f39c12; }
.action-item .action-priority-low { color:#27ae60; }
.channel-list { padding:8px; }
.channel-item { padding:10px 12px; border-radius:8px; cursor:pointer; margin-bottom:4px; transition:background 0.2s; display:flex; align-items:center; gap:8px; }
.channel-item:hover { background:#f0f0f0; }
.channel-item.active { background:#e8eeff; }
.channel-item .ch-icon { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:14px; color:white; flex-shrink:0; }
.channel-item .ch-info { flex:1; min-width:0; }
.channel-item .ch-name { font-size:13px; font-weight:500; color:#333; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.channel-item .ch-last { font-size:11px; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.channel-item .ch-time { font-size:10px; color:#bbb; flex-shrink:0; }
.chat-close { background:none; border:none; color:white; font-size:20px; cursor:pointer; padding:0 4px; }
.chat-close:hover { opacity:0.8; }
.chat-toolbar { display:flex; gap:4px; padding:4px 12px; background:#f8f9fa; border-top:1px solid #eee; }
.chat-toolbar button { background:none; border:1px solid #ddd; border-radius:4px; padding:3px 8px; font-size:11px; cursor:pointer; color:#666; }
.chat-toolbar button:hover { background:#e8eeff; color:#667eea; border-color:#667eea; }
.typing-indicator { font-size:11px; color:#999; padding:4px 12px; display:none; }
.typing-indicator.show { display:block; }
.channel-header { padding:8px 12px; background:#f8f9fa; border-bottom:1px solid #eee; display:flex; align-items:center; gap:8px; }
.channel-header .back-btn { background:none; border:none; cursor:pointer; font-size:16px; color:#667eea; padding:2px 6px; }
.channel-header .ch-title { font-size:13px; font-weight:600; color:#333; }
.new-channel-btn { width:100%; padding:8px; background:none; border:1px dashed #667eea; border-radius:8px; color:#667eea; font-size:12px; cursor:pointer; margin-top:4px; }
.new-channel-btn:hover { background:#f0f4ff; }
.todo-panel { padding:8px; }
.todo-item { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:6px; margin-bottom:4px; background:white; border:1px solid #eee; font-size:12px; }
.todo-item .todo-check { width:16px; height:16px; border-radius:50%; border:2px solid #ccc; cursor:pointer; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
.todo-item .todo-check.done { background:#27ae60; border-color:#27ae60; color:white; }
.todo-item .todo-text { flex:1; }
.todo-item .todo-text.done { text-decoration:line-through; color:#999; }
.todo-item .todo-priority { font-size:10px; padding:1px 6px; border-radius:3px; }
</style>
<button id="chatFab" onclick="ChatWidget.toggle()">
  <span>💬</span>
  <span class="badge" id="chatBadge"></span>
</button>
<div id="chatPanel">
  <div class="chat-header">
    <h3>智能助手 & 团队沟通</h3>
    <button class="chat-close" onclick="ChatWidget.close()">✕</button>
  </div>
  <div class="chat-tabs">
    <div class="chat-tab active" data-tab="ai" onclick="ChatWidget.switchTab('ai')">🤖 AI助手</div>
    <div class="chat-tab" data-tab="team" onclick="ChatWidget.switchTab('team')">👥 团队</div>
    <div class="chat-tab" data-tab="todo" onclick="ChatWidget.switchTab('todo')">📋 待办</div>
  </div>
  <div class="chat-body" id="chatBody"></div>
  <div class="typing-indicator" id="typingIndicator">AI正在思考...</div>
  <div class="chat-input-area" id="chatInputArea">
    <textarea id="chatInput" rows="1" placeholder="输入消息，Enter发送，Shift+Enter换行..." onkeydown="ChatWidget.handleKeydown(event)" oninput="ChatWidget.autoResize(this)"></textarea>
    <button class="chat-send-btn" id="chatSendBtn" onclick="ChatWidget.send()">➤</button>
  </div>
</div>`;
    document.body.appendChild(div);
    initWS();
    renderAiWelcome();
  }

  function renderAiWelcome() {
    const body = document.getElementById('chatBody');
    if (!body) return;
    body.innerHTML = `
<div class="msg-bubble ai">
  <div class="msg-content">
👋 你好！我是企业经营管理平台（EBMS）-HJ AI助手

我可以帮你：
📊 <b>数据分析</b> - 查询询价、核价、客户等业务数据
💡 <b>策略建议</b> - 提供报价策略、客户跟进建议
⚠️ <b>风险预警</b> - 识别逾期、滞留等问题
📝 <b>待办生成</b> - 自动提取行动项

试试问我：
• "当前询价状态如何？"
• "有哪些待核价的项目？"
• "帮我分析客户情况"
  </div>
</div>`;
  }

  function toggle() {
    const panel = document.getElementById('chatPanel');
    if (panel.classList.contains('open')) { close(); } else { open(); }
  }

  function open() {
    const panel = document.getElementById('chatPanel');
    panel.classList.add('open');
    const input = document.getElementById('chatInput');
    if (input) input.focus();
  }

  function close() {
    const panel = document.getElementById('chatPanel');
    panel.classList.remove('open');
  }

  function switchTab(tab) {
    activeTab = tab;
    activeChannel = null;
    document.querySelectorAll('.chat-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const body = document.getElementById('chatBody');
    const inputArea = document.getElementById('chatInputArea');
    const typing = document.getElementById('typingIndicator');

    if (tab === 'ai') {
      inputArea.style.display = 'flex';
      typing.style.display = 'none';
      if (aiHistory.length === 0) {
        renderAiWelcome();
      } else {
        renderAiHistory();
      }
    } else if (tab === 'team') {
      inputArea.style.display = 'none';
      typing.style.display = 'none';
      renderChannelList();
    } else if (tab === 'todo') {
      inputArea.style.display = 'none';
      typing.style.display = 'none';
      renderTodoList();
    }
  }

  function renderAiHistory() {
    const body = document.getElementById('chatBody');
    body.innerHTML = '';
    aiHistory.forEach(h => {
      appendChatMessage(currentUser, h.content, '', true);
      appendAiMessage(h.reply, h.action_items || []);
    });
    body.scrollTop = body.scrollHeight;
  }

  function appendChatMessage(sender, content, time, isSelf) {
    const body = document.getElementById('chatBody');
    const div = document.createElement('div');
    div.className = `msg-bubble ${isSelf ? 'self' : 'other'}`;
    const t = time || new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
    div.innerHTML = `
${!isSelf ? `<div class="msg-sender">${sender}</div>` : ''}
<div class="msg-content">${escapeHtml(content)}</div>
<div class="msg-time">${t}</div>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function appendAiMessage(content, actionItems) {
    const body = document.getElementById('chatBody');
    const div = document.createElement('div');
    div.className = 'msg-bubble ai';
    let html = `<div class="msg-content">${formatAiContent(content)}</div>`;
    if (actionItems && actionItems.length > 0) {
      actionItems.forEach(item => {
        const pClass = item.priority === '高' ? 'action-priority-high' : item.priority === '低' ? 'action-priority-low' : 'action-priority-medium';
        html += `<div class="action-item"><span class="${pClass}">[${item.priority}]</span> ${item.assignee ? `<span class="action-assignee">@${item.assignee}</span> ` : ''}${escapeHtml(item.content)}</div>`;
      });
    }
    div.innerHTML = html;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function formatAiContent(text) {
    return escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
      .replace(/【行动】/g, '<span style="color:#e67e22;font-weight:600;">【行动】</span>')
      .replace(/⚠️/g, '<span style="color:#e74c3c;">⚠️</span>')
      .replace(/📊/g, '<span>📊</span>')
      .replace(/🏆/g, '<span>🏆</span>')
      .replace(/📝/g, '<span>📝</span>')
      .replace(/💡/g, '<span>💡</span>')
      .replace(/\n/g, '<br>');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function send() {
    const input = document.getElementById('chatInput');
    const content = input.value.trim();
    if (!content) return;

    if (activeTab === 'ai') {
      input.value = '';
      autoResize(input);
      appendChatMessage(currentUser, content, '', true);

      const typing = document.getElementById('typingIndicator');
      typing.classList.add('show');
      const sendBtn = document.getElementById('chatSendBtn');
      sendBtn.disabled = true;

      try {
        const res = await fetch(`${API}/api/chat/ai-chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            user: currentUser,
            context_type: window.chatContextType || '',
            context_id: window.chatContextId || null,
            history: aiHistory.slice(-20)
          })
        });
        const data = await res.json();
        typing.classList.remove('show');
        sendBtn.disabled = false;
        appendAiMessage(data.reply, data.action_items || []);
        aiHistory.push({ role: 'user', content });
        aiHistory.push({ role: 'assistant', content: data.reply, action_items: data.action_items || [] });
      } catch(err) {
        typing.classList.remove('show');
        sendBtn.disabled = false;
        appendAiMessage('网络错误，请稍后重试。', []);
      }
    } else if (activeTab === 'team' && activeChannel) {
      input.value = '';
      autoResize(input);
      appendChatMessage(currentUser, content, '', true);

      try {
        await fetch(`${API}/api/chat/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel_id: activeChannel,
            sender: currentUser,
            content,
            msg_type: 'text'
          })
        });
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'chat', channel_id: activeChannel, sender: currentUser, content }));
        }
      } catch(err) {}
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 80) + 'px';
  }

  async function renderChannelList() {
    const body = document.getElementById('chatBody');
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#999;font-size:13px;">加载中...</div>';
    try {
      const res = await fetch(`${API}/api/chat/channels?user=${encodeURIComponent(currentUser)}`);
      channels = await res.json();
      let html = '<div class="channel-list">';
      html += `<div class="channel-item" onclick="ChatWidget.createDirectChannel()" style="justify-content:center;border:1px dashed #667eea;color:#667eea;font-size:12px;">+ 新建私聊</div>`;
      channels.forEach(ch => {
        const icon = ch.type === 'direct' ? '💬' : ch.type === 'business' ? '📋' : '📢';
        const bgColor = ch.type === 'direct' ? '#3498db' : ch.type === 'business' ? '#e67e22' : '#27ae60';
        const name = ch.type === 'direct' ? ch.members.split(',').filter(m => m !== currentUser).join(', ') || ch.name : ch.name || (ch.type === 'business' ? ch.business_title : '频道');
        const lastTime = ch.updated_at ? ch.updated_at.substring(11, 16) : '';
        html += `<div class="channel-item" onclick="ChatWidget.openChannel(${ch.id})">
          <div class="ch-icon" style="background:${bgColor}">${icon}</div>
          <div class="ch-info"><div class="ch-name">${escapeHtml(name)}</div></div>
          <div class="ch-time">${lastTime}</div>
        </div>`;
      });
      html += '</div>';
      body.innerHTML = html;
    } catch(err) {
      body.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;font-size:13px;">加载失败</div>';
    }
  }

  async function openChannel(channelId) {
    activeChannel = channelId;
    const ch = channels.find(c => c.id === channelId);
    const body = document.getElementById('chatBody');
    const inputArea = document.getElementById('chatInputArea');
    inputArea.style.display = 'flex';

    const name = ch?.type === 'direct' ? ch.members.split(',').filter(m => m !== currentUser).join(', ') : ch?.name || '频道';

    body.innerHTML = `<div class="channel-header">
      <button class="back-btn" onclick="ChatWidget.switchTab('team')">←</button>
      <span class="ch-title">${escapeHtml(name)}</span>
    </div>`;

    try {
      const res = await fetch(`${API}/api/chat/messages?channel_id=${channelId}&limit=50`);
      const messages = await res.json();
      const msgContainer = document.createElement('div');
      msgContainer.style.padding = '8px';
      messages.forEach(msg => {
        const isSelf = msg.sender === currentUser;
        const bubble = document.createElement('div');
        bubble.className = `msg-bubble ${isSelf ? 'self' : 'other'}`;
        bubble.innerHTML = `
${!isSelf ? `<div class="msg-sender">${escapeHtml(msg.sender)}</div>` : ''}
<div class="msg-content">${escapeHtml(msg.content)}</div>
<div class="msg-time">${msg.created_at ? msg.created_at.substring(11, 16) : ''}</div>`;
        msgContainer.appendChild(bubble);
      });
      body.appendChild(msgContainer);
      body.scrollTop = body.scrollHeight;
    } catch(err) {}
  }

  async function createDirectChannel() {
    try {
      const res = await fetch(`${API}/api/chat/online-users`);
      const users = await res.json();
      const otherUsers = users.filter(u => u.username !== currentUser);
      if (otherUsers.length === 0) { alert('暂无其他在线用户'); return; }

      const name = prompt(`选择聊天对象（输入用户名）：\n${otherUsers.map(u => u.display_name || u.username).join(', ')}`);
      if (!name) return;

      const target = otherUsers.find(u => u.display_name === name || u.username === name);
      if (!target) { alert('未找到该用户'); return; }

      const members = [currentUser, target.username].sort().join(',');
      const chRes = await fetch(`${API}/api/chat/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '', type: 'direct', members, created_by: currentUser })
      });
      const ch = await chRes.json();
      renderChannelList();
      setTimeout(() => openChannel(ch.id), 300);
    } catch(err) { alert('创建失败'); }
  }

  async function renderTodoList() {
    const body = document.getElementById('chatBody');
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#999;font-size:13px;">加载中...</div>';
    try {
      const res = await fetch(`${API}/api/chat/action-items?assignee=${encodeURIComponent(currentUser)}&created_by=${encodeURIComponent(currentUser)}`);
      const items = await res.json();
      if (items.length === 0) {
        body.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#999;font-size:13px;">📋 暂无待办事项\n\n通过AI助手对话自动生成待办</div>';
        return;
      }
      let html = '<div class="todo-panel">';
      items.forEach(item => {
        const isDone = item.status === 'done';
        const pColor = item.priority === '高' ? '#e74c3c' : item.priority === '低' ? '#27ae60' : '#f39c12';
        html += `<div class="todo-item">
          <div class="todo-check ${isDone ? 'done' : ''}" onclick="ChatWidget.toggleTodo(${item.id}, this)">${isDone ? '✓' : ''}</div>
          <div class="todo-text ${isDone ? 'done' : ''}">${escapeHtml(item.content)}</div>
          <span class="todo-priority" style="background:${pColor}20;color:${pColor}">${item.priority || '中'}</span>
        </div>`;
      });
      html += '</div>';
      body.innerHTML = html;
    } catch(err) {
      body.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;font-size:13px;">加载失败</div>';
    }
  }

  async function toggleTodo(id, el) {
    const isDone = el.classList.contains('done');
    const newStatus = isDone ? 'pending' : 'done';
    try {
      await fetch(`${API}/api/chat/action-items/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      el.classList.toggle('done');
      el.textContent = isDone ? '' : '✓';
      const textEl = el.nextElementSibling;
      if (textEl) textEl.classList.toggle('done');
    } catch(err) {}
  }

  function handleDataChange(entity, action, data) {
    // 根据当前页面和数据实体，触发对应的刷新函数
    const page = window.location.pathname;
    if (entity === 'customers' && page.includes('customer')) {
      if (typeof loadCustomers === 'function') loadCustomers();
    } else if (entity === 'inquiries' && page.includes('inquir')) {
      if (typeof loadInquiries === 'function') loadInquiries();
    } else if (entity === 'products' && page.includes('product')) {
      if (typeof loadProducts === 'function') loadProducts();
    } else if (entity === 'quotes' && page.includes('quot')) {
      if (typeof loadLibrary === 'function') loadLibrary();
    }
  }

  function setContext(type, id) {
    window.chatContextType = type;
    window.chatContextId = id;
  }

  window.ChatWidget = { toggle, open, close, switchTab, send, handleKeydown, autoResize, openChannel, createDirectChannel, toggleTodo, setContext };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createWidget);
  } else {
    createWidget();
  }
})();
