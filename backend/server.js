const express = require('express');
const logger = require('./lib/logger');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { now: dbNow } = require('./db');
const { verifyToken } = require('./lib/auth-token');

// ===== 密钥自检：外部对接密钥必须通过环境变量注入，代码中不硬编码 =====
require('./lib/secrets').warnMissing();

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();

const app = express();
const PORT = parseInt(process.env.PORT) || 3010;

// CORS 白名单：仅允许前端部署域名与本地开发来源，拒绝任意来源跨域。
// 生产前端域名通过环境变量 CORS_ALLOWED_ORIGINS 配置（逗号分隔，如 https://sales.example.com）。
// 本地开发默认放行 localhost / 127.0.0.1 / 本机局域网 IP。
const EXTRA_ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => { try { return new URL(s).origin; } catch (e) { return s; } })
);

function isLocalOrigin(hostname) {
  // Node 对 IPv6 的 hostname 带方括号（如 "[::1]"），先去掉再比较
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === LOCAL_IP;
}

app.use(cors({
  origin(origin, callback) {
    // 无 Origin 头：同源页面请求 / 服务端内部调用（如 /api/ai-assistant/auto-run）→ 放行
    if (!origin) return callback(null, true);
    try {
      const url = new URL(origin);
      if (isLocalOrigin(url.hostname)) return callback(null, true);
      if (EXTRA_ALLOWED_ORIGINS.has(url.origin)) return callback(null, true);
    } catch (e) { /* 非法 origin（如 "null"）→ 落入拒绝 */ }
    // 非白名单来源：不下发 CORS 头，浏览器将拦截跨域响应
    callback(null, false);
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 关键表快照备份（必须在 initData 之前）：防止系统更新导致 users 等表清空后
// 被 initData 用默认账号覆盖，造成"更新后登录不了"。提供多代时间戳恢复点。
try {
  const backup = require('./lib/user-backup');
  const r = backup.snapshot();
  logger.info('[backup] 关键表快照: ' + (r.snapshoted.length ? r.snapshoted.join(', ') : '无') + (r.skipped.length ? ' | 跳过: ' + r.skipped.join(', ') : ''));
} catch (e) {
  logger.warn('[backup] 快照失败(非致命):', e.message);
}

// 初始化数据
require('./initData');

// S&OP 产销协调会系统种子数据（幂等：仅空表时灌入）
try {
  const sopSeed = require('./sop-seed');
  const seeded = sopSeed.run();
  if (seeded.length) logger.info('[sop-seed] 已灌入种子数据: ' + seeded.join(', '));
  else logger.info('[sop-seed] 各表已有数据，跳过');
} catch (e) {
  logger.error('[sop-seed] 种子数据初始化失败(非致命):', e.message);
}

// 注意：权限设置由用户在权限管理页面配置并持久化保存，服务器启动时不再覆盖用户设置
const { getTable } = require('./db');

// 修复：同步询价管理中的客户到客户管理
try {
  const inqTable = getTable('inquiries');
  const custTable = getTable('customers');
  let synced = 0;
  inqTable.all().forEach(inq => {
    if (!inq.customer_name) return;
    const exists = custTable.all().find(c => c.name === inq.customer_name);
    if (!exists) {
      custTable.insert({
        name: inq.customer_name,
        source: inq.customer_source || '询价同步',
        contact: '', phone: '', email: '',
        created_at: inq.created_at || dbNow(),
        updated_at: dbNow()
      });
      synced++;
    }
  });
  if (synced > 0) logger.info(`已同步 ${synced} 个询价客户到客户管理`);
} catch(e) { logger.error('客户同步失败:', e.message); }

const routes = require('./routes');
app.use('/api', routes);

// favicon：返回 204，避免浏览器请求 /favicon.ico 时 404 刷控制台
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend')));

// 物料库自检调度器 —— 默认禁用（手动触发）
// 启用：环境变量 ENABLE_PERIODIC_TASKS=1 启动服务
// 手动触发：访问 /api/material-check/run 或在物料库自检待办页点「▶ 运行自检」
if (process.env.ENABLE_PERIODIC_TASKS === '1') {
  try { require('./lib/material-check-scheduler').startScheduler(); logger.info('[material-check] 周期自检已启用（环境变量 ENABLE_PERIODIC_TASKS=1）'); }
  catch (e) { logger.error('[material-check] 调度器启动失败:', e.message); }
} else {
  logger.info('[material-check] 周期自检已禁用（默认）。如需启用：set ENABLE_PERIODIC_TASKS=1 启动服务。或访问 /api/material-check/run 手动触发。');
}

// ===== 物料数据完整性自愈 =====
// 检测到 materials.json < 50KB → 自动从外部 API 拉回
// 触发时机：1) 服务启动 5s 后 2) 路由惰性触发（见 routes/material.js）
// 不再使用 setInterval 周期检查，避免在卡顿的 13MB 写盘期间反复触发出问题
const recovery = require('./lib/materials-recovery');

function ensureMaterialsHealth(){
  const h = recovery.check();
  if(!h.ok || h.tooSmall){
    logger.info('[startup] materials.json 异常（size=' + h.size + '），启动自动恢复...');
    recovery.recover('startup', { log: (m) => logger.info('[recovery] ' + m) });
  } else {
    logger.info('[startup] materials.json 大小正常 (' + (h.size/1024/1024).toFixed(1) + ' MB)');
  }
}
// 暴露给路由的惰性触发
global._recoverMaterialsNow = (reason) => recovery.recover(reason, { log: (m) => logger.info('[recovery] ' + m) });
setTimeout(ensureMaterialsHealth, 5000);

// 关闭物料自动恢复周期任务 —— 周期任务在 13MB 写盘期间阻塞事件循环，
// 而且 material_check_issues.json 累积会撑到 80MB+
// 改为按需手动触发 + 路由惰性触发，需要时由用户在 UI 点「恢复」按钮或后端运维时手动跑
logger.info('[startup] 材料自动恢复：仅启动时 + 按需触发，已禁用周期任务（避免长时间写盘阻塞）');

let httpsServer = null;
const certPfxPath = path.join(__dirname, 'cert', 'server.pfx');
const certCrtPath = path.join(__dirname, 'cert', 'server.crt');
const certKeyPath = path.join(__dirname, 'cert', 'server.key');

if (fs.existsSync(certPfxPath)) {
  try {
    const pfxData = fs.readFileSync(certPfxPath);
    const pfxPassphrase = process.env.HTTPS_PFX_PASSPHRASE || '';
    if (!pfxPassphrase) {
      logger.warn('⚠️ HTTPS_PFX_PASSPHRASE 环境变量未设置, HTTPS 将无法启动');
    }
    httpsServer = https.createServer({ pfx: pfxData, passphrase: pfxPassphrase }, app);
  } catch(e) {
    logger.info('HTTPS证书加载失败，仅使用HTTP:', e.message);
  }
} else if (fs.existsSync(certCrtPath) && fs.existsSync(certKeyPath)) {
  try {
    httpsServer = https.createServer({
      cert: fs.readFileSync(certCrtPath),
      key: fs.readFileSync(certKeyPath)
    }, app);
  } catch(e) {
    logger.info('HTTPS证书加载失败，仅使用HTTP:', e.message);
  }
}
const server = http.createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server, path: '/ws' });

const wsClients = new Map();

// 增强IM WebSocket服务
const { setupIMWebSocket } = require('./lib/im-websocket');
setupIMWebSocket(wss, app);

// 广播数据变更通知给所有连接的客户端
function broadcastDataChange(entity, action, data) {
  const msg = JSON.stringify({ type: 'data_change', entity, action, data, timestamp: Date.now() });
  wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// 暴露给路由使用
app.set('broadcastDataChange', broadcastDataChange);

wss.on('connection', (ws) => {
  let user = '';
  let authed = false;

  function reject(reason) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        // 先发送失败原因，待其刷出后再关闭，保证客户端能收到 auth_failed 与正常关闭码
        ws.send(JSON.stringify({ type: 'auth_failed', reason }), () => {
          ws.close(4401, reason || '未认证');
        });
        return;
      }
    } catch (e) {}
    ws.close(4401, reason || '未认证');
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth') {
        // 鉴权：必须携带登录签发的 token，身份以 token 为准，不再信任客户端自报 user。
        const payload = verifyToken(msg.token);
        if (!payload || !payload.username) {
          reject('未认证或 token 无效');
          return;
        }
        user = payload.username;
        authed = true;
        wsClients.set(user, ws);
        return;
      }
      if (msg.type === 'chat' && msg.channel_id) {
        if (!authed) {
          reject('未认证');
          return;
        }
        const broadcast = JSON.stringify({
          type: 'chat',
          channel_id: msg.channel_id,
          sender: user, // 以鉴权身份为准，忽略客户端 sender
          content: msg.content,
          msg_type: msg.msg_type || 'text',
          created_at: dbNow()
        });
        wsClients.forEach((client, u) => {
          if (client.readyState === WebSocket.OPEN && u !== user) {
            client.send(broadcast);
          }
        });
      }
    } catch(e) {}
  });
  ws.on('close', () => {
    if (user) wsClients.delete(user);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info(`局域网访问: http://${LOCAL_IP}:${PORT}`);
  logger.info(`WebSocket: ws://localhost:${PORT}/ws`);

  if (httpsServer) {
    const HTTPS_PORT = PORT + 1;
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      logger.info(`HTTPS Server running on https://localhost:${HTTPS_PORT}`);
      logger.info(`局域网HTTPS访问: https://${LOCAL_IP}:${HTTPS_PORT}`);
      logger.info(`截图/拍照功能请使用HTTPS地址访问`);
    });
  }

  // ===== 周期任务默认禁用 =====
  // 之前的 4 个周期任务（物料自检 / 核价同步 / AI 引擎 / 外部 API 同步）会持续写大文件
  // 同步 13MB materials.json / 80MB issues.json 时阻塞事件循环，导致前端页面卡顿
  // 在 13MB 异步写盘机制未彻底解决前，默认禁用；启用方法：环境变量 ENABLE_PERIODIC_TASKS=1
  if (process.env.ENABLE_PERIODIC_TASKS === '1') {
  // 定时同步：核价库→报价库，每5分钟执行一次
  const { syncPricingToQuote } = require('./routes/quote');
  const SYNC_INTERVAL = 5 * 60 * 1000;

  function runSync() {
    try {
      const result = syncPricingToQuote();
      if (result.created > 0 || result.updated > 0) {
        logger.info(`[定时同步] ${result.summary}`);
      }
    } catch(e) {
      logger.error('[定时同步] 核价→报价同步失败:', e.message);
    }
  }

  // 启动后延迟30秒执行首次同步（等待系统初始化完成）
  setTimeout(() => {
    runSync();
    setInterval(runSync, SYNC_INTERVAL);
  }, 30000);

  logger.info(`定时同步: 核价库→报价库 每5分钟自动同步`);

  // 定时自动化引擎：每30分钟自动扫描问题、自我学习、总结归纳、生成计划、输出行动
  const AI_AUTO_INTERVAL = 30 * 60 * 1000;

  function runAiAutoEngine() {
    try {
      const http = require('http');
      const postData = JSON.stringify({ user: 'system' });
      const req = http.request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/ai-assistant/auto-run',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            const scanCount = (result.scan || []).length;
            const learnCount = (result.learned || []).length;
            const planCount = (result.plans || []).length;
            const actionCount = (result.actions || []).filter(a => a.status === 'created').length;
            if (scanCount > 0 || actionCount > 0) {
              logger.info(`[AI自动引擎] 扫描${scanCount}个问题, 学习${learnCount}条, 计划${planCount}个, 新增行动${actionCount}条`);
            } else {
              logger.info(`[AI自动引擎] 运行完成，暂无新问题`);
            }
          } catch(e) {
            logger.error('[AI自动引擎] 解析结果失败:', e.message);
          }
        });
      });
      req.on('error', e => logger.error('[AI自动引擎] 请求失败:', e.message));
      req.write(postData);
      req.end();
    } catch(e) {
      logger.error('[AI自动引擎] 执行失败:', e.message);
    }
  }

  setTimeout(() => {
    runAiAutoEngine();
    setInterval(runAiAutoEngine, AI_AUTO_INTERVAL);
  }, 60000);

  logger.info(`AI自动引擎: 每30分钟自动扫描→学习→总结→计划→行动`);

  // 外部数据同步调度器：按配置频率自动同步供应商/客户
  const fs = require('fs');
  const path = require('path');
  const SYNC_CONFIG_PATH = path.join(__dirname, '..', 'database', 'sync-config.json');
  let syncSchedulerTimer = null;
  let lastSyncRun = 0;

  function runExternalSync() {
    try {
      if (!fs.existsSync(SYNC_CONFIG_PATH)) return;
      const cfg = JSON.parse(fs.readFileSync(SYNC_CONFIG_PATH, 'utf8'));
      if (!cfg.enabled || cfg.frequency === 'manual') return;
      const freqMap = cfg.frequency_map || { '5min': 300000, '30min': 1800000, 'hourly': 3600000, 'daily': 86400000 };
      const interval = freqMap[cfg.frequency] || 0;
      if (interval === 0) return;
      const now = Date.now();
      if (now - lastSyncRun < interval) return;
      lastSyncRun = now;

      const enabledMods = Object.entries(cfg.modules || {}).filter(([_, m]) => m.enabled);
      if (enabledMods.length === 0) return;

      const postData = JSON.stringify({ apply: true });
      const req = http.request({
        hostname: '127.0.0.1', port: PORT,
        path: '/api/external-api/sync-all', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(body);
            const counts = Object.values(r.results || {}).map(v => v.imported || 0);
            const total = counts.reduce((a, b) => a + b, 0);
            logger.info(`[外部同步] ${enabledMods.map(([n])=>n).join(',')} 完成, 导入${total}条`);
          } catch (e) {}
        });
      });
      req.on('error', () => {});
      req.write(postData);
      req.end();
    } catch (e) {}
  }

  // 每30秒检查一次是否需要同步
  setInterval(runExternalSync, 30000);
  logger.info('外部同步调度器: 按配置频率自动同步');
  } else {
    logger.info('[startup] 周期任务已禁用（物料自检/核价同步/AI引擎/外部API），设置 ENABLE_PERIODIC_TASKS=1 启用');
  }
});
