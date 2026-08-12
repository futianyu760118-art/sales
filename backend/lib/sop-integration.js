/**
 * SOP业务与IM系统集成模块
 * 实现: 预警→IM推送, Action→IM提醒, 会议→IM聊天室
 */
const { getTable, ensureTable, now } = require('../db');
const { pushMessage, pushAlert } = require('./im-push');

// ========== 预警→IM推送集成 ==========

/**
 * 预警触发时自动推送IM消息
 */
async function handleAlertTriggered({ alertId, ruleCode, ruleName, level, message, entityType, entityId }) {
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  const msgTable = getTable('im_messages');
  convTable._invalidate();
  msgTable._invalidate();
  
  // 1. 创建系统通知会话（如果不存在）
  let systemConv = convTable.all().find(c => c.conv_type === 'SYSTEM' && c.related_type === 'ALERT');
  if (!systemConv) {
    const ts = now();
    const newConv = convTable.insert({
      conv_type: 'SYSTEM',
      conv_name: '系统预警通知',
      owner_id: 0,
      related_type: 'ALERT',
      related_id: null,
      is_active: 1,
      last_msg_at: ts,
      last_msg_preview: '',
      created_at: ts
    });
    systemConv = convTable.findById(newConv.lastID);
    
    // 添加所有用户为成员
    const userTable = getTable('users');
    userTable._invalidate();
    userTable.all().forEach(user => {
      memberTable.insert({
        conv_id: systemConv.id,
        user_id: user.id,
        role: 'MEMBER',
        is_muted: 0,
        is_pinned: 0,
        unread_count: 0,
        last_read_msg_id: 0,
        joined_at: ts
      });
    });
  }
  
  // 2. 发送预警消息
  const msgContent = `⚠️【${level}】${ruleName}\n\n${message}\n\n请立即处理，超时将自动升级。`;
  const ts = now();
  const msg = msgTable.insert({
    conv_id: systemConv.id,
    sender_id: 0,
    msg_type: 'ALERT',
    content: msgContent,
    rich_content_json: JSON.stringify({
      type: 'alert_card',
      alert_id: alertId,
      level,
      buttons: [
        { label: '查看详情', action: `navigate:/sop/alerts/${alertId}` },
        { label: '确认收到', action: `api:PUT /alerts/${alertId}/acknowledge` }
      ]
    }),
    created_at: ts
  });
  
  // 3. 更新会话最后消息
  convTable.update(systemConv.id, {
    last_msg_at: ts,
    last_msg_preview: msgContent.substring(0, 200)
  });
  
  // 4. 更新所有成员的未读数
  memberTable.all()
    .filter(m => m.conv_id === systemConv.id && !m.left_at)
    .forEach(m => {
      memberTable.update(m.id, { unread_count: (m.unread_count || 0) + 1 });
    });
  
  // 5. 通过推送模块发送外部通知
  const userTable = getTable('users');
  userTable._invalidate();
  const userIds = userTable.all().map(u => u.id);
  
  for (const userId of userIds) {
    await pushMessage({
      userId,
      content: msgContent,
      title: `【${level}】${ruleName}`,
      msgType: 'ALERT',
      channels: level === 'R' || level === 'BLOCK' 
        ? ['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']
        : ['WEBSOCKET', 'WECHAT_WORK']
    });
  }
  
  return { success: true, msgId: msg.lastID, convId: systemConv.id };
}

// ========== Action待办→IM提醒集成 ==========

/**
 * Action创建/指派时推送IM通知
 */
async function handleActionCreated({ actionId, actionCode, description, ownerId, collaboratorIds, dueDate, priority, sourceSystem }) {
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  const msgTable = getTable('im_messages');
  convTable._invalidate();
  msgTable._invalidate();
  
  // 1. 获取或创建责任人的对话
  const allUserIds = [ownerId, ...(collaboratorIds || [])];
  
  for (const userId of allUserIds) {
    // 查找与系统的对话
    let userConv = convTable.all().find(c => {
      if (c.conv_type !== 'SINGLE') return false;
      const members = memberTable.all().filter(m => m.conv_id === c.id && !m.left_at);
      return members.length === 2 && members.some(m => m.user_id === userId) && members.some(m => m.user_id === 0);
    });
    
    if (!userConv) {
      const ts = now();
      const newConv = convTable.insert({
        conv_type: 'SINGLE',
        conv_name: '系统通知',
        owner_id: userId,
        related_type: 'ACTION',
        related_id: actionId,
        is_active: 1,
        last_msg_at: ts,
        last_msg_preview: '',
        created_at: ts
      });
      userConv = convTable.findById(newConv.lastID);
      
      // 添加用户和系统为成员
      memberTable.insert({
        conv_id: userConv.id,
        user_id: userId,
        role: 'MEMBER',
        is_muted: 0,
        is_pinned: 0,
        unread_count: 0,
        last_read_msg_id: 0,
        joined_at: ts
      });
      memberTable.insert({
        conv_id: userConv.id,
        user_id: 0,
        role: 'OWNER',
        is_muted: 0,
        is_pinned: 0,
        unread_count: 0,
        last_read_msg_id: 0,
        joined_at: ts
      });
    }
    
    // 2. 发送Action提醒消息
    const msgContent = `📌【${priority}级待办】\n编号：${actionCode}\n描述：${description}\n截止：${dueDate}\n来源：${sourceSystem || 'SOP系统'}`;
    const ts = now();
    
    msgTable.insert({
      conv_id: userConv.id,
      sender_id: 0,
      msg_type: 'ACTION_REMINDER',
      content: msgContent,
      rich_content_json: JSON.stringify({
        type: 'action_card',
        action_id: actionId,
        action_code: actionCode,
        priority,
        buttons: [
          { label: '立即处理', action: `navigate:/sop/actions/${actionId}` },
          { label: '标记进行中', action: `api:PUT /sop/actions/${actionId}/status`, payload: { status: 'IN_PROGRESS' } }
        ]
      }),
      created_at: ts
    });
    
    convTable.update(userConv.id, {
      last_msg_at: ts,
      last_msg_preview: msgContent.substring(0, 200)
    });
    
    memberTable.all()
      .filter(m => m.conv_id === userConv.id && m.user_id === userId)
      .forEach(m => {
        memberTable.update(m.id, { unread_count: (m.unread_count || 0) + 1 });
      });
    
    // 3. 推送外部通知
    await pushMessage({
      userId,
      content: msgContent,
      title: `📌 新待办指派 (${priority})`,
      msgType: 'ACTION_REMINDER',
      channels: priority === 'P0' 
        ? ['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']
        : ['WEBSOCKET', 'WECHAT_WORK']
    });
  }
  
  return { success: true, actionId, notifiedUsers: allUserIds };
}

/**
 * Action逾期升级推送
 */
async function handleActionOverdue({ actionId, actionCode, description, ownerId, overdueDays, escalationLevel }) {
  const msgContent = `🚨【待办逾期】\n编号：${actionCode}\n描述：${description}\n逾期：${overdueDays}天\n升级层级：${escalationLevel}`;
  
  await pushMessage({
    userId: ownerId,
    content: msgContent,
    title: `🚨 待办逾期 (${escalationLevel}级)`,
    msgType: 'ACTION_REMINDER',
    channels: ['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']
  });
  
  return { success: true, actionId };
}

// ========== 会议→IM聊天室集成 ==========

/**
 * 会议创建时自动创建IM聊天室
 */
async function handleMeetingCreated({ meetingId, meetingCode, meetingType, meetingDate, attendeeIds, psiHeaderId }) {
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  const msgTable = getTable('im_messages');
  convTable._invalidate();
  
  // 1. 创建会议聊天室
  const ts = now();
  const conv = convTable.insert({
    conv_type: 'MEETING_ROOM',
    conv_name: `S&OP会议-${meetingCode}`,
    owner_id: 0,
    related_type: 'MEETING',
    related_id: meetingId,
    is_active: 1,
    last_msg_at: ts,
    last_msg_preview: '',
    created_at: ts
  });
  const convId = conv.lastID;
  
  // 2. 添加所有出席人员
  (attendeeIds || []).forEach(userId => {
    memberTable.insert({
      conv_id: convId,
      user_id: userId,
      role: 'MEMBER',
      is_muted: 0,
      is_pinned: 0,
      unread_count: 0,
      last_read_msg_id: 0,
      joined_at: ts
    });
  });
  
  // 3. 发送欢迎消息
  const welcomeMsg = `📅【会议邀请】\n会议编号：${meetingCode}\n类型：${meetingType}\n时间：${meetingDate}\n关联PSI：${psiHeaderId ? 'PSI#' + psiHeaderId : '无'}\n\n请准时参加，议程已自动生成。`;
  
  msgTable.insert({
    conv_id: convId,
    sender_id: 0,
    msg_type: 'MEETING_INVITE',
    content: welcomeMsg,
    rich_content_json: JSON.stringify({
      type: 'meeting_card',
      meeting_id: meetingId,
      meeting_code: meetingCode,
      buttons: [
        { label: '确认出席', action: `api:PUT /meetings/${meetingId}/rsvp`, payload: { status: 'ACCEPT' } },
        { label: '查看议程', action: `navigate:/sop/meetings/${meetingId}#agenda` }
      ]
    }),
    created_at: ts
  });
  
  convTable.update(convId, {
    last_msg_at: ts,
    last_msg_preview: welcomeMsg.substring(0, 200)
  });
  
  // 4. 通知所有出席人员
  for (const userId of (attendeeIds || [])) {
    memberTable.all()
      .filter(m => m.conv_id === convId && m.user_id === userId)
      .forEach(m => {
        memberTable.update(m.id, { unread_count: (m.unread_count || 0) + 1 });
      });
    
    await pushMessage({
      userId,
      content: welcomeMsg,
      title: '📅 会议邀请',
      msgType: 'MEETING_INVITE',
      channels: ['WEBSOCKET', 'WECHAT_WORK', 'EMAIL']
    });
  }
  
  return { success: true, convId, meetingCode };
}

/**
 * 会议决议推送
 */
async function handleMeetingDecisionMade({ meetingId, meetingCode, decisionSummary, actionsCount }) {
  const convTable = getTable('im_conversations');
  const msgTable = getTable('im_messages');
  const memberTable = getTable('im_conversation_members');
  convTable._invalidate();
  msgTable._invalidate();
  
  // 查找会议聊天室
  const conv = convTable.all().find(c => c.conv_type === 'MEETING_ROOM' && c.related_id === meetingId);
  if (!conv) return { success: false, reason: '会议聊天室不存在' };
  
  // 发送决议消息
  const msgContent = `📋【会议决议】${meetingCode}已关闭\n\n决议摘要：${decisionSummary}\n\n已自动生成${actionsCount}条Action待办，请各责任人查收。`;
  const ts = now();
  
  msgTable.insert({
    conv_id: conv.id,
    sender_id: 0,
    msg_type: 'SYSTEM',
    content: msgContent,
    rich_content_json: JSON.stringify({
      type: 'decision_card',
      meeting_id: meetingId,
      buttons: [
        { label: '查看全部Action', action: `navigate:/sop/actions?meeting_id=${meetingId}` }
      ]
    }),
    created_at: ts
  });
  
  convTable.update(conv.id, {
    last_msg_at: ts,
    last_msg_preview: msgContent.substring(0, 200)
  });
  
  // 通知所有成员
  const memberIds = memberTable.all()
    .filter(m => m.conv_id === conv.id && !m.left_at)
    .map(m => m.user_id);
  
  for (const userId of memberIds) {
    await pushMessage({
      userId,
      content: msgContent,
      title: '📋 会议决议通知',
      msgType: 'SYSTEM',
      channels: ['WEBSOCKET', 'WECHAT_WORK', 'EMAIL']
    });
  }
  
  return { success: true, meetingId };
}

/**
 * 硬拦截触发时创建紧急群聊
 */
async function handleHardBlockTriggered({ blockType, entityCode, blockReason, notifyRoleIds }) {
  const convTable = getTable('im_conversations');
  const memberTable = getTable('im_conversation_members');
  const msgTable = getTable('im_messages');
  convTable._invalidate();
  
  // 创建紧急GROUP会话
  const ts = now();
  const conv = convTable.insert({
    conv_type: 'GROUP',
    conv_name: `⛔ 硬拦截-${entityCode}`,
    owner_id: 0,
    related_type: 'ALERT',
    related_id: null,
    is_active: 1,
    last_msg_at: ts,
    last_msg_preview: '',
    created_at: ts
  });
  const convId = conv.lastID;
  
  // 添加相关人员
  (notifyRoleIds || []).forEach(userId => {
    memberTable.insert({
      conv_id: convId,
      user_id: userId,
      role: 'ADMIN',
      is_muted: 0,
      is_pinned: 1,
      unread_count: 0,
      last_read_msg_id: 0,
      joined_at: ts
    });
  });
  
  // 发送硬拦截消息
  const msgContent = `⛔【硬拦截】\n类型：${blockType}\n对象：${entityCode}\n原因：${blockReason}\n\n⚠️ 该拦截不可绕过，请立即处理。`;
  
  msgTable.insert({
    conv_id: convId,
    sender_id: 0,
    msg_type: 'ALERT',
    content: msgContent,
    rich_content_json: JSON.stringify({
      type: 'block_card',
      style: 'critical',
      block_type: blockType,
      entity_code: entityCode,
      buttons: [
        { label: '联系工程部', action: 'navigate:/sop/im?user=ENGINEER_HEAD' },
        { label: '查看详情', action: 'navigate:/sop/supply#block-check' }
      ]
    }),
    created_at: ts
  });
  
  convTable.update(convId, {
    last_msg_at: ts,
    last_msg_preview: msgContent.substring(0, 200)
  });
  
  // 紧急推送
  for (const userId of (notifyRoleIds || [])) {
    await pushMessage({
      userId,
      content: msgContent,
      title: `⛔ 硬拦截告警`,
      msgType: 'ALERT',
      channels: ['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']
    });
  }
  
  return { success: true, convId };
}

// ========== KPI更新→IM通知 ==========

/**
 * KPI更新时推送通知
 */
async function handleKpiUpdated({ kpiCode, kpiName, actualValue, status, periodMonth }) {
  if (status !== 'R') return { success: false, reason: '非红灯状态不推送' };
  
  const convTable = getTable('im_conversations');
  const msgTable = getTable('im_messages');
  convTable._invalidate();
  
  // 查找KPI通知会话
  let kpiConv = convTable.all().find(c => c.conv_type === 'SYSTEM' && c.related_type === 'KPI');
  if (!kpiConv) {
    const ts = now();
    const newConv = convTable.insert({
      conv_type: 'SYSTEM',
      conv_name: 'KPI指标通知',
      owner_id: 0,
      related_type: 'KPI',
      related_id: null,
      is_active: 1,
      last_msg_at: ts,
      last_msg_preview: '',
      created_at: ts
    });
    kpiConv = convTable.findById(newConv.lastID);
  }
  
  const msgContent = `🔴【KPI红灯】${kpiName}\n实际值：${actualValue}\n月份：${periodMonth}\n\n请关注并采取行动。`;
  const ts = now();
  
  msgTable.insert({
    conv_id: kpiConv.id,
    sender_id: 0,
    msg_type: 'SYSTEM',
    content: msgContent,
    rich_content_json: JSON.stringify({
      type: 'kpi_card',
      kpi_code: kpiCode,
      buttons: [
        { label: '查看驾驶舱', action: 'navigate:/sop/dashboard' },
        { label: '查看红灯详情', action: `navigate:/sop/kpi?status=R` }
      ]
    }),
    created_at: ts
  });
  
  convTable.update(kpiConv.id, {
    last_msg_at: ts,
    last_msg_preview: msgContent.substring(0, 200)
  });
  
  // 推送通知
  const userTable = getTable('users');
  userTable._invalidate();
  const userIds = userTable.all().map(u => u.id);
  
  for (const userId of userIds) {
    await pushMessage({
      userId,
      content: msgContent,
      title: `🔴 KPI红灯告警`,
      msgType: 'ALERT',
      channels: ['WEBSOCKET', 'WECHAT_WORK']
    });
  }
  
  return { success: true, kpiCode };
}

// ========== 自检报告→IM推送 ==========

/**
 * 每周自检报告推送
 */
async function handleSelfCheckCompleted({ weekNo, totalScore, grade, passedCount, failedCount }) {
  const convTable = getTable('im_conversations');
  const msgTable = getTable('im_messages');
  const memberTable = getTable('im_conversation_members');
  convTable._invalidate();
  
  // 查找自检通知会话
  let selfCheckConv = convTable.all().find(c => c.conv_type === 'SYSTEM' && c.related_type === 'SELF_CHECK');
  if (!selfCheckConv) {
    const ts = now();
    const newConv = convTable.insert({
      conv_type: 'SYSTEM',
      conv_name: '每周自检报告',
      owner_id: 0,
      related_type: 'SELF_CHECK',
      related_id: null,
      is_active: 1,
      last_msg_at: ts,
      last_msg_preview: '',
      created_at: ts
    });
    selfCheckConv = convTable.findById(newConv.lastID);
    
    // 添加所有用户
    const userTable = getTable('users');
    userTable._invalidate();
    userTable.all().forEach(user => {
      memberTable.insert({
        conv_id: selfCheckConv.id,
        user_id: user.id,
        role: 'MEMBER',
        is_muted: 0,
        is_pinned: 0,
        unread_count: 0,
        last_read_msg_id: 0,
        joined_at: ts
      });
    });
  }
  
  const msgContent = `📋【每周自检报告】\n周次：${weekNo}\n总评分：${totalScore}分 (等级：${grade})\n✅ 通过：${passedCount}项\n❌ 未通过：${failedCount}项\n\n未通过项已自动创建Action。`;
  const ts = now();
  
  msgTable.insert({
    conv_id: selfCheckConv.id,
    sender_id: 0,
    msg_type: 'SYSTEM',
    content: msgContent,
    rich_content_json: JSON.stringify({
      type: 'report_card',
      week_no: weekNo,
      grade,
      buttons: [
        { label: '查看报告', action: `navigate:/sop/self-check?week=${weekNo}` },
        { label: '查看Action', action: 'navigate:/sop/actions?source=self_check' }
      ]
    }),
    created_at: ts
  });
  
  convTable.update(selfCheckConv.id, {
    last_msg_at: ts,
    last_msg_preview: msgContent.substring(0, 200)
  });
  
  // 推送通知
  const userTable = getTable('users');
  userTable._invalidate();
  const userIds = userTable.all().map(u => u.id);
  
  for (const userId of userIds) {
    await pushMessage({
      userId,
      content: msgContent,
      title: `📋 每周自检报告 (${grade})`,
      msgType: 'SYSTEM',
      channels: ['WEBSOCKET', 'WECHAT_WORK', 'EMAIL']
    });
  }
  
  return { success: true, weekNo };
}

// ========== PSI更新→IM推送 ==========

/**
 * PSI更新时推送通知
 */
async function handlePsiUpdated({ headerId, psiCode, productCode, status, invEndM0, invEndM1, colorStatus }) {
  if (colorStatus !== 'R') return { success: false, reason: '非红灯状态不推送' };
  
  const msgContent = `📊【PSI更新】${psiCode}\n产品：${productCode}\n状态：${status}\nM月期末：${invEndM0}\nM+1期末：${invEndM1}\n\n⚠️ 库存预警，请关注。`;
  
  const userTable = getTable('users');
  userTable._invalidate();
  const userIds = userTable.all().map(u => u.id);
  
  for (const userId of userIds) {
    await pushMessage({
      userId,
      content: msgContent,
      title: '📊 PSI库存预警',
      msgType: 'SYSTEM',
      channels: ['WEBSOCKET']
    });
  }
  
  return { success: true, psiCode };
}

module.exports = {
  handleAlertTriggered,
  handleActionCreated,
  handleActionOverdue,
  handleMeetingCreated,
  handleMeetingDecisionMade,
  handleHardBlockTriggered,
  handleKpiUpdated,
  handleSelfCheckCompleted,
  handlePsiUpdated
};