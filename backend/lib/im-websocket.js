/**
 * IM WebSocket服务增强
 * 扩展现有WebSocket以支持IM消息的实时推送
 */

const logger = require('./logger');

/**
 * 创建IM WebSocket服务
 * @param {WebSocket.Server} wss - 现有WebSocket服务器
 * @param {express.Application} app - Express应用
 */
function setupIMWebSocket(wss, app) {
  // 存储用户连接信息
  const imClients = new Map(); // userId -> Set<ws>
  const convSubscribers = new Map(); // convId -> Set<userId>
  
  // 广播IM消息到指定会话的所有成员
  function broadcastToConversation(convId, message, excludeUserId = null) {
    const subscribers = convSubscribers.get(convId) || new Set();
    const payload = JSON.stringify({
      type: 'im_message',
      conv_id: convId,
      data: message,
      timestamp: Date.now()
    });
    
    subscribers.forEach(userId => {
      if (userId === excludeUserId) return;
      const userSockets = imClients.get(userId) || [];
      userSockets.forEach(ws => {
        if (ws.readyState === 1) {
          ws.send(payload);
        }
      });
    });
  }
  
  // 广播系统通知给所有在线用户
  function broadcastSystemNotification(notification, userIds = null) {
    const payload = JSON.stringify({
      type: 'im_notification',
      data: notification,
      timestamp: Date.now()
    });
    
    const targets = userIds || Array.from(imClients.keys());
    targets.forEach(userId => {
      const userSockets = imClients.get(userId) || [];
      userSockets.forEach(ws => {
        if (ws.readyState === 1) {
          ws.send(payload);
        }
      });
    });
  }
  
  // 更新会话未读数
  function broadcastUnreadCount(convId, userId, unreadCount) {
    const payload = JSON.stringify({
      type: 'im_unread_update',
      conv_id: convId,
      user_id: userId,
      unread_count: unreadCount,
      timestamp: Date.now()
    });
    
    const userSockets = imClients.get(userId) || [];
    userSockets.forEach(ws => {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    });
  }
  
  // 用户上线
  wss.on('connection', (ws, req) => {
    ws._imUserId = null;
    ws._convSubscriptions = new Set();
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        
        // 用户认证
        if (msg.type === 'im_auth') {
          const userId = msg.user_id || msg.user;
          ws._imUserId = userId;
          
          if (!imClients.has(userId)) {
            imClients.set(userId, new Set());
          }
          imClients.get(userId).add(ws);
          
          ws.send(JSON.stringify({
            type: 'im_auth_success',
            user_id: userId,
            online_users: Array.from(imClients.keys()),
            timestamp: Date.now()
          }));
        }
        
        // 订阅会话
        if (msg.type === 'im_subscribe' && msg.conv_id) {
          const convId = Number(msg.conv_id);
          ws._convSubscriptions.add(convId);
          
          if (!convSubscribers.has(convId)) {
            convSubscribers.set(convId, new Set());
          }
          convSubscribers.get(convId).add(ws._imUserId);
        }
        
        // 取消订阅会话
        if (msg.type === 'im_unsubscribe' && msg.conv_id) {
          const convId = Number(msg.conv_id);
          ws._convSubscriptions.delete(convId);
          
          const subscribers = convSubscribers.get(convId);
          if (subscribers) {
            subscribers.delete(ws._imUserId);
            if (subscribers.size === 0) {
              convSubscribers.delete(convId);
            }
          }
        }
        
        // 正在输入指示
        if (msg.type === 'im_typing' && msg.conv_id) {
          const convId = Number(msg.conv_id);
          const broadcast = JSON.stringify({
            type: 'im_typing',
            conv_id: convId,
            user_id: ws._imUserId,
            user_name: msg.user_name,
            is_typing: msg.is_typing,
            timestamp: Date.now()
          });
          
          const subscribers = convSubscribers.get(convId) || new Set();
          subscribers.forEach(userId => {
            if (userId !== ws._imUserId) {
              const userSockets = imClients.get(userId) || [];
              userSockets.forEach(s => {
                if (s.readyState === 1) {
                  s.send(broadcast);
                }
              });
            }
          });
        }
        
        // 消息已读回执
        if (msg.type === 'im_read_receipt' && msg.msg_ids && msg.conv_id) {
          const broadcast = JSON.stringify({
            type: 'im_read_receipt',
            conv_id: msg.conv_id,
            user_id: ws._imUserId,
            msg_ids: msg.msg_ids,
            read_at: msg.read_at || Date.now(),
            timestamp: Date.now()
          });
          
          const subscribers = convSubscribers.get(Number(msg.conv_id)) || new Set();
          subscribers.forEach(userId => {
            if (userId !== ws._imUserId) {
              const userSockets = imClients.get(userId) || [];
              userSockets.forEach(s => {
                if (s.readyState === 1) {
                  s.send(broadcast);
                }
              });
            }
          });
        }
        
        // 通用聊天消息（兼容旧版）
        if (msg.type === 'chat' && msg.channel_id) {
          const broadcast = JSON.stringify({
            type: 'chat',
            channel_id: msg.channel_id,
            sender: msg.sender || ws._imUserId,
            content: msg.content,
            msg_type: msg.msg_type || 'text',
            created_at: Date.now()
          });
          imClients.forEach((clientSet, u) => {
            if (u !== ws._imUserId) {
              clientSet.forEach(c => {
                if (c.readyState === 1) c.send(broadcast);
              });
            }
          });
        }
      } catch (e) {
        logger.error('IM WebSocket消息解析错误:', e.message);
      }
    });
    
    ws.on('close', () => {
      const userId = ws._imUserId;
      if (userId) {
        // 移除用户连接
        const userSet = imClients.get(userId);
        if (userSet) {
          userSet.delete(ws);
          if (userSet.size === 0) {
            imClients.delete(userId);
          }
        }
        
        // 移除会话订阅
        ws._convSubscriptions.forEach(convId => {
          const subscribers = convSubscribers.get(convId);
          if (subscribers) {
            subscribers.delete(userId);
            if (subscribers.size === 0) {
              convSubscribers.delete(convId);
            }
          }
        });
        
        // 通知其他用户下线
        const offlineNotify = JSON.stringify({
          type: 'im_user_offline',
          user_id: userId,
          timestamp: Date.now()
        });
        imClients.forEach(clientSet => {
          clientSet.forEach(s => {
            if (s.readyState === 1) s.send(offlineNotify);
          });
        });
      }
    });
    
    // 心跳机制
    ws._lastPing = Date.now();
    ws._pingInterval = setInterval(() => {
      if (ws.readyState !== 1) {
        clearInterval(ws._pingInterval);
        return;
      }
      if (Date.now() - ws._lastPing > 60000) {
        ws.terminate();
      } else {
        ws.ping();
      }
    }, 30000);
  });
  
  // 暴露IM WebSocket方法供路由和业务逻辑调用
  app.set('imWebSocket', {
    broadcastToConversation,
    broadcastSystemNotification,
    broadcastUnreadCount,
    getOnlineUsers: () => Array.from(imClients.keys()),
    getConversationSubscribers: (convId) => Array.from(convSubscribers.get(convId) || [])
  });
  
  logger.info('[IM WebSocket] IM实时消息服务已增强');
}

module.exports = { setupIMWebSocket };