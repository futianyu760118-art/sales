/**
 * IM多通道推送模块
 * 支持: 企微/钉钉/飞书Webhook、短信(SMS)、邮件(Email)、WebSocket
 */
const { getTable, now } = require('../db');

// 推送通道配置（实际部署时应从环境变量或配置文件读取）
const CHANNEL_CONFIG = {
  WECHAT_WORK: {
    enabled: true,
    webhook_url: process.env.WECHAT_WORK_WEBHOOK || '',
    corp_id: process.env.WECHAT_WORK_CORP_ID || '',
    app_secret: process.env.WECHAT_WORK_APP_SECRET || ''
  },
  DINGTALK: {
    enabled: false,
    webhook_url: process.env.DINGTALK_WEBHOOK || '',
    secret: process.env.DINGTALK_SECRET || ''
  },
  FEISHU: {
    enabled: false,
    webhook_url: process.env.FEISHU_WEBHOOK || ''
  },
  SMS: {
    enabled: true,
    provider: process.env.SMS_PROVIDER || 'aliyun',
    access_key: process.env.SMS_ACCESS_KEY || '',
    template_codes: {
      action_overdue: process.env.SMS_TEMPLATE_ACTION_OVERDUE || 'SMS_001',
      block_triggered: process.env.SMS_TEMPLATE_BLOCK || 'SMS_002',
      meeting_reminder: process.env.SMS_TEMPLATE_MEETING || 'SMS_003'
    }
  },
  EMAIL: {
    enabled: true,
    provider: process.env.EMAIL_PROVIDER || 'smtp',
    smtp_host: process.env.SMTP_HOST || 'smtp.example.com',
    smtp_port: process.env.SMTP_PORT || 465,
    sender: process.env.EMAIL_SENDER || 'noreply@example.com'
  }
};

/**
 * 发送Webhook请求
 */
async function sendWebhook(url, data) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return { success: response.ok, status_code: response.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 企业微信推送
 */
async function pushWeChatWork(content, target) {
  if (!CHANNEL_CONFIG.WECHAT_WORK.enabled || !CHANNEL_CONFIG.WECHAT_WORK.webhook_url) {
    return { success: false, reason: '企业微信未配置' };
  }
  
  const data = {
    msgtype: 'text',
    text: { content }
  };
  
  return sendWebhook(CHANNEL_CONFIG.WECHAT_WORK.webhook_url, data);
}

/**
 * 钉钉推送
 */
async function pushDingTalk(content, target) {
  if (!CHANNEL_CONFIG.DINGTALK.enabled || !CHANNEL_CONFIG.DINGTALK.webhook_url) {
    return { success: false, reason: '钉钉未配置' };
  }
  
  const data = {
    msgtype: 'text',
    text: { content },
    at: { atMobiles: [target] }
  };
  
  return sendWebhook(CHANNEL_CONFIG.DINGTALK.webhook_url, data);
}

/**
 * 飞书推送
 */
async function pushFeishu(content, target) {
  if (!CHANNEL_CONFIG.FEISHU.enabled || !CHANNEL_CONFIG.FEISHU.webhook_url) {
    return { success: false, reason: '飞书未配置' };
  }
  
  const data = {
    msg_type: 'text',
    content: { text: content }
  };
  
  return sendWebhook(CHANNEL_CONFIG.FEISHU.webhook_url, data);
}

/**
 * 短信推送（模拟实现，实际需对接云服务商API）
 */
async function pushSMS(content, phone, templateCode) {
  if (!CHANNEL_CONFIG.SMS.enabled) {
    return { success: false, reason: '短信服务未启用' };
  }
  
  // 实际对接阿里云/腾讯云短信API
  // 此处为示例实现
  console.log(`[SMS] 发送短信到 ${phone}: ${content}`);
  return { success: true, provider: CHANNEL_CONFIG.SMS.provider };
}

/**
 * 邮件推送（模拟实现）
 */
async function pushEmail(content, email, subject) {
  if (!CHANNEL_CONFIG.EMAIL.enabled) {
    return { success: false, reason: '邮件服务未启用' };
  }
  
  // 实际需使用nodemailer等库对接SMTP
  // 此处为示例实现
  console.log(`[EMAIL] 发送邮件到 ${email}: ${subject} - ${content}`);
  return { success: true };
}

/**
 * 按通道优先级推送消息
 * @param {Object} params
 * @param {number} params.userId - 目标用户ID
 * @param {string} params.content - 消息内容
 * @param {string} params.title - 消息标题
 * @param {string} params.msgType - 消息类型
 * @param {Array} params.channels - 通道优先级列表
 * @param {number} params.msgId - 关联消息ID
 */
async function pushMessage({ userId, content, title, msgType = 'TEXT', channels, msgId }) {
  const pushLogTable = getTable('im_push_logs');
  
  // 获取用户通知偏好
  const ruleTable = getTable('im_notification_rules');
  ruleTable._invalidate();
  let rule = ruleTable.all().find(r => r.user_id === userId);
  
  // 如果没有偏好设置，使用默认通道
  if (!rule) {
    rule = { channel_priority: JSON.stringify(['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']) };
  }
  
  const defaultChannels = JSON.parse(rule.channel_priority || '["WEBSOCKET"]');
  const channelList = channels || defaultChannels;
  
  // 检查免打扰时段
  const now = new Date();
  const quietStart = rule.quiet_hours_start || '22:00';
  const quietEnd = rule.quiet_hours_end || '08:00';
  const isQuietTime = checkQuietHours(now, quietStart, quietEnd);
  const shouldBypassQuiet = rule.allow_at_mention_bypass && ['ALERT', 'BLOCK', 'P0'].includes(msgType);
  
  if (isQuietTime && !shouldBypassQuiet) {
    return { skipped: true, reason: '免打扰时段' };
  }
  
  // 按优先级尝试推送
  const results = [];
  let websocketSent = false;
  
  for (const channel of channelList) {
    if (channel === 'WEBSOCKET') {
      // WebSocket由IM模块直接处理，此处仅记录
      results.push({ channel, status: 'WEBSOCKET_HANDLED' });
      websocketSent = true;
      continue;
    }
    
    // 获取用户联系方式
    const userTable = getTable('users');
    userTable._invalidate();
    const user = userTable.findById(userId);
    if (!user) continue;
    
    let result = { success: false, channel };
    
    switch (channel) {
      case 'WECHAT_WORK':
        result = await pushWeChatWork(`${title}\n${content}`, user.username);
        break;
      case 'DINGTALK':
        result = await pushDingTalk(`${title}\n${content}`, user.username);
        break;
      case 'FEISHU':
        result = await pushFeishu(`${title}\n${content}`, user.username);
        break;
      case 'SMS':
        if (user.phone) {
          const templateCode = CHANNEL_CONFIG.SMS.template_codes[msgType] || 'SMS_001';
          result = await pushSMS(content, user.phone, templateCode);
        }
        break;
      case 'EMAIL':
        if (user.email) {
          result = await pushEmail(content, user.email, title || '系统通知');
        }
        break;
    }
    
    results.push({ channel, ...result });
    
    // 记录推送日志
    pushLogTable.insert({
      msg_id: msgId || null,
      channel,
      target_user_id: userId,
      target_address: user?.email || user?.phone || '',
      status: result.success ? 'SENT' : 'FAILED',
      response_code: result.status_code || '',
      response_msg: result.error || '',
      sent_at: now(),
      retry_count: 0
    });
    
    // 推送成功则停止尝试其他通道
    if (result.success) break;
  }
  
  return { 
    success: results.some(r => r.success || r.status === 'WEBSOCKET_HANDLED'),
    channels_used: results.map(r => r.channel)
  };
}

/**
 * 检查是否在免打扰时段
 */
function checkQuietHours(now, startStr, endStr) {
  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);
  
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  
  // 跨天免打扰（如22:00到08:00）
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  } else {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
}

/**
 * 系统广播消息
 */
async function systemBroadcast(content, channels = ['WEBSOCKET']) {
  const userTable = getTable('users');
  userTable._invalidate();
  const users = userTable.all();
  
  const results = [];
  for (const user of users) {
    if (user.id) {
      const r = await pushMessage({
        userId: user.id,
        content,
        title: '系统广播',
        msgType: 'SYSTEM',
        channels
      });
      results.push({ userId: user.id, ...r });
    }
  }
  
  return { total: users.length, results };
}

/**
 * 预警推送
 */
async function pushAlert({ alertId, level, ruleName, message, entityType, entityId }) {
  const msgType = level === 'R' || level === 'BLOCK' ? 'ALERT' : 'ALERT';
  const title = `【${level}】${ruleName}`;
  const content = `${message}\n触发时间：${now()}`;
  
  // 获取需要通知的用户（从预警规则获取）
  const ruleTable = getTable('alert_rules');
  ruleTable._invalidate();
  const rule = ruleTable.findById(alertId);
  
  if (!rule) return { success: false, reason: '预警规则不存在' };
  
  // 简化处理：通知所有活跃用户
  const userTable = getTable('users');
  userTable._invalidate();
  const recipients = userTable.all().filter(u => u.id);
  
  const results = [];
  for (const user of recipients) {
    const channels = level === 'R' || level === 'BLOCK' 
      ? ['WEBSOCKET', 'WECHAT_WORK', 'SMS', 'EMAIL']
      : ['WEBSOCKET', 'WECHAT_WORK'];
    
    const r = await pushMessage({
      userId: user.id,
      content,
      title,
      msgType,
      channels
    });
    results.push({ userId: user.id, ...r });
  }
  
  return { alertId, totalRecipients: recipients.length, results };
}

module.exports = {
  pushMessage,
  pushAlert,
  systemBroadcast,
  pushWeChatWork,
  pushDingTalk,
  pushFeishu,
  pushSMS,
  pushEmail,
  CHANNEL_CONFIG
};