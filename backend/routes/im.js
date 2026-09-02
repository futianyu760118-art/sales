/**
 * IM即时通讯 API路由
 * 基于SOP_System_AI_Code_Package/11_IM_MESSAGING.json规范实现
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm, extractUserId } = require('../auth-middleware');

// 确保表存在
['im_conversations', 'im_conversation_members', 'im_messages', 
 'im_message_receipts', 'im_notification_rules', 'im_push_logs'].forEach(t => ensureTable(t));

function genId(prefix) {
  return prefix + Date.now() + Math.floor(Math.random() * 1000);
}

// ========== 会话管理 ==========

// 获取会话列表（含未读数、置顶、免打扰）
router.get('/conversations', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { tab, keyword } = req.query;
  
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  convTable._invalidate();
  memberTable._invalidate();
  
  // 获取当前用户参与的会话
  const myMembers = memberTable.all().filter(m => m.user_id === userId);
  const myConvIds = new Set(myMembers.map(m => m.conv_id));
  
  let conversations = convTable.all()
    .filter(c => myConvIds.has(c.id))
    .map(c => {
      const member = myMembers.find(m => m.conv_id === c.id);
      return {
        ...c,
        unread_count: member?.unread_count || 0,
        is_muted: member?.is_muted || 0,
        is_pinned: member?.is_pinned || 0,
        members_count: memberTable.all().filter(m => m.conv_id === c.id && !m.left_at).length
      };
    });
  
  // 按置顶+最后消息时间排序
  conversations.sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
    return (b.last_msg_at || '').localeCompare(a.last_msg_at || '');
  });
  
  // 筛选
  if (tab === '未读') {
    conversations = conversations.filter(c => c.unread_count > 0);
  } else if (tab === '@我') {
    conversations = conversations.filter(c => c.last_msg_preview?.includes('@'));
  } else if (tab === '系统') {
    conversations = conversations.filter(c => c.conv_type === 'SYSTEM');
  }
  
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    conversations = conversations.filter(c => 
      (c.conv_name || '').toLowerCase().includes(kw) ||
      (c.last_msg_preview || '').toLowerCase().includes(kw)
    );
  }
  
  res.json({ code: 200, data: conversations });
});

// 创建会话（单聊/群聊/系统通知）
router.post('/conversations', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { conv_type, conv_name, member_ids, related_type, related_id } = req.body || {};
  
  if (!conv_type || !['SINGLE', 'GROUP', 'SYSTEM', 'MEETING_ROOM'].includes(conv_type)) {
    return res.status(400).json({ error: '无效的会话类型' });
  }
  
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  
  // 单聊：检查是否已存在
  if (conv_type === 'SINGLE' && member_ids?.length === 1) {
    const existing = findSingleConversation(userId, member_ids[0]);
    if (existing) {
      return res.json({ code: 200, data: existing });
    }
  }
  
  const ts = now();
  const conv = convTable.insert({
    conv_type,
    conv_name: conv_name || '',
    owner_id: userId,
    related_type: related_type || 'GENERAL',
    related_id: related_id || null,
    is_active: 1,
    last_msg_at: null,
    last_msg_preview: null,
    created_at: ts
  });
  
  const convId = conv.lastID || conv.id;
  
  // 添加成员
  const allMembers = [userId, ...(member_ids || [])];
  allMembers.forEach(uid => {
    memberTable.insert({
      conv_id: convId,
      user_id: uid,
      role: uid === userId ? 'OWNER' : 'MEMBER',
      is_muted: 0,
      is_pinned: 0,
      unread_count: 0,
      last_read_msg_id: 0,
      joined_at: ts
    });
  });
  
  // 发送欢迎消息
  const msgTable = getTable('im_messages');
  msgTable.insert({
    conv_id: convId,
    sender_id: 0,
    msg_type: 'SYSTEM',
    content: `【系统】会话已创建`,
    created_at: ts
  });
  
  res.json({ code: 200, data: { id: convId, conv_type, conv_name } });
});

function findSingleConversation(userId1, userId2) {
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  convTable._invalidate();
  memberTable._invalidate();
  
  const myConvs = memberTable.all()
    .filter(m => m.user_id === userId1 && !m.left_at)
    .map(m => m.conv_id);
  
  for (const convId of myConvs) {
    const conv = convTable.findById(convId);
    if (conv && conv.conv_type === 'SINGLE') {
      const otherMember = memberTable.all().find(m => 
        m.conv_id === convId && m.user_id === userId2 && !m.left_at
      );
      if (otherMember) return conv;
    }
  }
  return null;
}

// ========== 消息管理 ==========

// 获取消息历史（分页/游标/支持搜索）
router.get('/conversations/:convId/messages', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { convId } = req.params;
  const { cursor, limit = 30, search } = req.query;
  
  const msgTable = getTable('im_messages');
  msgTable._invalidate();
  
  let messages = msgTable.all()
    .filter(m => m.conv_id === Number(convId) && !m.is_recalled)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  
  // 搜索
  if (search) {
    const kw = String(search).toLowerCase();
    messages = messages.filter(m => 
      (m.content || '').toLowerCase().includes(kw)
    );
  }
  
  // 分页
  const limitNum = parseInt(limit);
  const start = cursor ? messages.findIndex(m => m.id === Number(cursor)) : 0;
  const paged = messages.slice(start, start + limitNum).reverse();
  
  // 获取发送者信息
  const userTable = getTable('users');
  userTable._invalidate();
  
  paged.forEach(m => {
    if (m.sender_id === 0) {
      m.sender_name = '系统';
      m.sender_avatar = '';
    } else {
      const sender = userTable.findById(m.sender_id);
      m.sender_name = sender?.name || sender?.username || '用户' + m.sender_id;
      m.sender_avatar = '';
    }
  });
  
  res.json({ code: 200, data: paged, next_cursor: paged.length > 0 ? paged[paged.length - 1].id : null });
});

// 发送消息
router.post('/conversations/:convId/messages', async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { convId } = req.params;
  const { msg_type, content, rich_content, reply_to_msg_id, mention_user_ids } = req.body || {};
  
  if (!content && !rich_content) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  
  const msgTable = getTable('im_messages');
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  
  const conv = convTable.findById(Number(convId));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  
  const ts = now();
  const msg = msgTable.insert({
    conv_id: Number(convId),
    sender_id: userId,
    msg_type: msg_type || 'TEXT',
    content: content || '',
    rich_content_json: rich_content ? JSON.stringify(rich_content) : null,
    reply_to_msg_id: reply_to_msg_id || null,
    is_recalled: 0,
    created_at: ts
  });
  
  const msgId = msg.lastID || msg.id;
  
  // 更新会话最后消息信息
  convTable.update(Number(convId), {
    last_msg_at: ts,
    last_msg_preview: (content || '').substring(0, 200)
  });
  
  // 更新未读数
  memberTable.all()
    .filter(m => m.conv_id === Number(convId) && m.user_id !== userId && !m.left_at)
    .forEach(m => {
      const newCount = (m.unread_count || 0) + 1;
      memberTable.update(m.id, { unread_count: newCount });
      broadcastUnreadCount(req, convId, m.user_id, newCount);
    });
  
  // 创建已读回执
  const members = memberTable.all()
    .filter(m => m.conv_id === Number(convId) && !m.left_at);
  members.forEach(m => {
    getTable('im_message_receipts').insert({
      msg_id: msgId,
      user_id: m.user_id,
      status: 'SENT',
      delivered_at: ts,
      read_at: null
    });
  });
  
  // 获取发送者信息
  const userTable = getTable('users');
  userTable._invalidate();
  const sender = userTable.findById(userId);
  
  const newMsg = {
    id: msgId,
    conv_id: Number(convId),
    sender_id: userId,
    sender_name: sender?.name || sender?.username || '用户',
    msg_type: msg_type || 'TEXT',
    content: content || '',
    rich_content: rich_content || null,
    reply_to_msg_id: reply_to_msg_id || null,
    created_at: ts
  };
  
  // 广播新消息事件
  broadcastToConversation(req, convId, {
    type: 'message:new',
    payload: newMsg
  });
  
  // 通知@提及用户
  if (mention_user_ids && mention_user_ids.length > 0) {
    mention_user_ids.forEach(uid => {
      broadcastToConversation(req, convId, {
        type: 'message:new',
        payload: { ...newMsg, is_mention: true }
      });
    });
  }
  
  res.json({ code: 200, data: newMsg });
});

// 撤回消息
router.put('/messages/:msgId/recall', (req, res) => {
  if (!req.app) req.app = req;
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { msgId } = req.params;
  
  const msgTable = getTable('im_messages');
  msgTable._invalidate();
  
  const msg = msgTable.findById(Number(msgId));
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.sender_id !== userId) return res.status(403).json({ error: '只能撤回自己的消息' });
  if (msg.msg_type === 'SYSTEM') return res.status(400).json({ error: '系统消息不可撤回' });
  
  const createdTime = new Date(msg.created_at);
  const nowTime = new Date();
  if ((nowTime - createdTime) > 120000) {
    return res.status(400).json({ error: '消息超过2分钟不可撤回' });
  }
  
  msgTable.update(Number(msgId), {
    is_recalled: 1,
    recalled_at: now()
  });
  
  broadcastToConversation(req, msg.conv_id, {
    type: 'message:recall',
    payload: { msg_id: Number(msgId), conv_id: msg.conv_id }
  });
  
  res.json({ code: 200, message: '撤回成功' });
});

// 标记消息已读
router.put('/messages/:msgId/read', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { msgId } = req.params;
  
  const receiptTable = getTable('im_message_receipts');
  receiptTable._invalidate();
  
  const receipts = receiptTable.all().filter(r => r.msg_id === Number(msgId) && r.user_id === userId);
  receipts.forEach(r => {
    if (r.status !== 'READ') {
      receiptTable.update(r.id, {
        status: 'READ',
        read_at: now()
      });
    }
  });
  
  res.json({ code: 200, message: '已标记为已读' });
});

// 标记会话全部已读
router.put('/conversations/:convId/read-all', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { convId } = req.params;
  
  const memberTable = getTable('im_conversation_members');
  const msgTable = getTable('im_messages');
  memberTable._invalidate();
  msgTable._invalidate();
  
  const member = memberTable.all().find(m => m.conv_id === Number(convId) && m.user_id === userId);
  if (!member) return res.status(404).json({ error: '会话不存在' });
  
  // 清零未读数
  memberTable.update(member.id, {
    unread_count: 0,
    last_read_msg_id: msgTable.all()
      .filter(m => m.conv_id === Number(convId))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0]?.id || 0
  });
  
  // 更新已读回执
  const receiptTable = getTable('im_message_receipts');
  receiptTable._invalidate();
  receiptTable.all()
    .filter(r => r.msg_id && r.user_id === userId && r.status !== 'READ')
    .forEach(r => {
      receiptTable.update(r.id, { status: 'READ', read_at: now() });
    });
  
  res.json({ code: 200, message: '已标记全部已读' });
});

// ========== 成员管理 ==========

// 获取成员列表
router.get('/conversations/:convId/members', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { convId } = req.params;
  const memberTable = getTable('im_conversation_members');
  const userTable = getTable('users');
  memberTable._invalidate();
  userTable._invalidate();
  
  const imWs = getIMWebSocket(req);
  const onlineUsers = imWs ? new Set(imWs.getOnlineUsers()) : new Set();
  
  const members = memberTable.all()
    .filter(m => m.conv_id === Number(convId) && !m.left_at)
    .map(m => {
      const user = userTable.findById(m.user_id);
      return {
        ...m,
        user_name: user?.name || user?.username || '用户' + m.user_id,
        online: onlineUsers.has(m.user_id)
      };
    });
  
  res.json({ code: 200, data: members });
});

// 添加成员
router.post('/conversations/:convId/members', (req, res) => {
  const { convId } = req.params;
  const { user_ids } = req.body || {};
  
  const memberTable = getTable('im_conversation_members');
  const convTable = getTable('im_conversations');
  
  const conv = convTable.findById(Number(convId));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (conv.conv_type === 'SINGLE') return res.status(400).json({ error: '单聊不可添加成员' });
  
  const ts = now();
  (user_ids || []).forEach(uid => {
    const exists = memberTable.all().find(m => m.conv_id === Number(convId) && m.user_id === uid);
    if (!exists) {
      memberTable.insert({
        conv_id: Number(convId),
        user_id: uid,
        role: 'MEMBER',
        is_muted: 0,
        is_pinned: 0,
        unread_count: 0,
        last_read_msg_id: 0,
        joined_at: ts
      });
    }
  });
  
  res.json({ code: 200, message: '添加成功' });
});

// 移除成员/退出群聊
router.delete('/conversations/:convId/members/:userId', (req, res) => {
  const { convId, userId } = req.params;
  const memberTable = getTable('im_conversation_members');
  
  const member = memberTable.all()
    .find(m => m.conv_id === Number(convId) && m.user_id === Number(userId));
  if (!member) return res.status(404).json({ error: '成员不存在' });
  
  memberTable.update(member.id, { left_at: now() });
  
  res.json({ code: 200, message: '移除成功' });
});

// ========== 设置管理 ==========

// 设置免打扰
router.put('/conversations/:convId/mute', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { convId } = req.params;
  const { is_muted, quiet_start, quiet_end } = req.body || {};
  
  const memberTable = getTable('im_conversation_members');
  const member = memberTable.all()
    .find(m => m.conv_id === Number(convId) && m.user_id === userId);
  if (!member) return res.status(404).json({ error: '会话不存在' });
  
  memberTable.update(member.id, { 
    is_muted: is_muted ? 1 : 0,
    quiet_start: quiet_start || null,
    quiet_end: quiet_end || null
  });
  
  res.json({ code: 200, message: '设置成功' });
});

// 置顶/取消置顶会话
router.put('/conversations/:convId/pin', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { convId } = req.params;
  
  const memberTable = getTable('im_conversation_members');
  const member = memberTable.all()
    .find(m => m.conv_id === Number(convId) && m.user_id === userId);
  if (!member) return res.status(404).json({ error: '会话不存在' });
  
  memberTable.update(member.id, { 
    is_pinned: member.is_pinned ? 0 : 1 
  });
  
  res.json({ code: 200, message: '设置成功' });
});

// ========== 全局搜索 ==========

// 全局消息搜索
router.get('/search', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { q, scope, msg_type } = req.query;
  
  if (!q) return res.status(400).json({ error: '搜索关键词必填' });
  
  const msgTable = getTable('im_messages');
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  msgTable._invalidate();
  
  // 获取用户可访问的会话
  const myConvIds = new Set(
    memberTable.all()
      .filter(m => m.user_id === userId && !m.left_at)
      .map(m => m.conv_id)
  );
  
  let messages = msgTable.all()
    .filter(m => myConvIds.has(m.conv_id) && (m.content || '').toLowerCase().includes(String(q).toLowerCase()));
  
  if (msg_type) {
    messages = messages.filter(m => m.msg_type === msg_type);
  }
  
  // 获取会话信息
  const results = messages.map(m => {
    const conv = convTable.findById(m.conv_id);
    return {
      ...m,
      conv_name: conv?.conv_name || '会话' + m.conv_id
    };
  });
  
  res.json({ code: 200, data: results });
});

// ========== 通知偏好 ==========

// 获取我的通知偏好
router.get('/notifications/settings', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const ruleTable = getTable('im_notification_rules');
  
  let rule = ruleTable.all().find(r => r.user_id === userId);
  if (!rule) {
    // 创建默认设置
    rule = ruleTable.insert({
      user_id: userId,
      alert_realtime_push: 1,
      action_reminder_push: 1,
      meeting_invite_push: 1,
      psi_update_push: 0,
      kpi_report_push: 1,
      self_check_push: 1,
      quiet_hours_start: '22:00',
      quiet_hours_end: '08:00',
      allow_at_mention_bypass: 1,
      channel_priority: JSON.stringify(['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']),
      created_at: now()
    });
    rule = ruleTable.findById(rule.lastID);
  }
  
  res.json({ code: 200, data: rule });
});

// 更新通知偏好
router.put('/notifications/settings', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const ruleTable = getTable('im_notification_rules');
  const b = req.body || {};
  
  let rule = ruleTable.all().find(r => r.user_id === userId);
  if (!rule) {
    rule = ruleTable.insert({
      user_id: userId,
      alert_realtime_push: b.alert_realtime_push ?? 1,
      action_reminder_push: b.action_reminder_push ?? 1,
      meeting_invite_push: b.meeting_invite_push ?? 1,
      psi_update_push: b.psi_update_push ?? 0,
      kpi_report_push: b.kpi_report_push ?? 1,
      self_check_push: b.self_check_push ?? 1,
      quiet_hours_start: b.quiet_hours_start || '22:00',
      quiet_hours_end: b.quiet_hours_end || '08:00',
      allow_at_mention_bypass: b.allow_at_mention_bypass ?? 1,
      channel_priority: b.channel_priority ? JSON.stringify(b.channel_priority) : JSON.stringify(['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']),
      created_at: now()
    });
    rule = ruleTable.findById(rule.lastID);
  } else {
    const updateFields = { updated_at: now() };
    Object.keys(b).forEach(k => {
      if (rule.hasOwnProperty(k)) {
        updateFields[k] = typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k];
      }
    });
    ruleTable.update(rule.id, updateFields);
    rule = ruleTable.findById(rule.id);
  }
  
  res.json({ code: 200, data: rule });
});

// ========== 外部推送 ==========

// 手动触发外部推送（测试用）
router.post('/push/external', async (req, res) => {
  const { channel, target_user_id, content } = req.body || {};
  
  if (!channel || !target_user_id || !content) {
    return res.status(400).json({ error: '参数不完整' });
  }
  
  const pushTable = getTable('im_push_logs');
  const log = pushTable.insert({
    channel,
    target_user_id,
    target_address: '',
    status: 'SENT',
    response_code: 'OK',
    response_msg: content,
    sent_at: now(),
    retry_count: 0
  });
  
  // 广播到用户
  broadcastToSystemNotification(req, {
    type: 'system:notification',
    payload: { channel, content }
  }, [target_user_id]);
  
  res.json({ code: 200, data: { id: log.lastID } });
});

// 查询推送日志
router.get('/push/logs', (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { channel, status } = req.query;
  const pushTable = getTable('im_push_logs');
  pushTable._invalidate();
  
  let logs = pushTable.all();
  if (channel) logs = logs.filter(l => l.channel === channel);
  if (status) logs = logs.filter(l => l.status === status);
  
  res.json({ code: 200, data: logs.slice(0, 100) });
});

// ========== 辅助方法 ==========

// 获取IM WebSocket实例（从app.set获取）
function getIMWebSocket(req) {
  try {
    const app = req.app;
    if (app && app.get('imWebSocket')) {
      return app.get('imWebSocket');
    }
  } catch (e) {}
  return null;
}

function broadcastToConversation(req, convId, message, excludeUserId) {
  const imWs = getIMWebSocket(req);
  if (imWs) {
    imWs.broadcastToConversation(convId, message, excludeUserId);
  }
}

function broadcastToSystemNotification(req, notification, userIds) {
  const imWs = getIMWebSocket(req);
  if (imWs) {
    imWs.broadcastSystemNotification(notification, userIds);
  }
}

function broadcastUnreadCount(req, convId, userId, unreadCount) {
  const imWs = getIMWebSocket(req);
  if (imWs) {
    imWs.broadcastUnreadCount(convId, userId, unreadCount);
  }
}

// 在线用户
const onlineUsers = new Set();

router.setOnline = (userId) => {
  onlineUsers.add(userId);
};

router.setOffline = (userId) => {
  onlineUsers.delete(userId);
};

router.getOnlineUsers = () => onlineUsers;

module.exports = router;