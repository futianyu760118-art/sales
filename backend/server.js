const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { now: dbNow } = require('./db');

// ===== 进程级异常兜底（必须最先注册） =====
// Node 15+ 默认把「未处理的 Promise rejection」升级为异常并终止进程。
// 本项目大量 async 路由未包裹 try/catch，任何一次请求异常（如外部接口超时、
// 数据库异常、WebSocket 报错）都可能让整个服务进程直接消失。
// 这里统一兜底：记录日志并保持进程存活，避免"单个请求搞挂整个服务"。
function logProcessError(tag, err) {
  try {
    const e = err || {};
    console.error('[' + tag + '] ' + new Date().toISOString() + ' ' + (e.stack || e.message || String(e)));
  } catch (_) {}
}
process.on('unhandledRejection', (reason) => logProcessError('unhandledRejection', reason));
process.on('uncaughtException', (err) => logProcessError('uncaughtException', err));
process.on('exit', (code) => console.log('[process-exit] code=' + code + ' at ' + new Date().toISOString()));

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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 关键表快照备份（必须在 initData 之前）：防止系统更新导致 users 等表清空后
// 被 initData 用默认账号覆盖，造成"更新后登录不了"。提供多代时间戳恢复点。
try {
  const backup = require('./lib/user-backup');
  const r = backup.snapshot();
  const snap = (r && r.snapshoted) || [];
  const skip = (r && r.skipped) || [];
  console.log('[backup] 关键表快照: ' + (snap.length ? snap.join(', ') : '无') + (skip.length ? ' | 跳过: ' + skip.join(', ') : ''));
} catch (e) {
  console.warn('[backup] 快照失败(非致命):', e.message);
}

// 初始化数据
require('./initData');

// S&OP 产销协调会系统种子数据（幂等：仅空表时灌入）
try {
  const sopSeed = require('./sop-seed');
  const seeded = sopSeed.run();
  if (seeded.length) console.log('[sop-seed] 已灌入种子数据: ' + seeded.join(', '));
  else console.log('[sop-seed] 各表已有数据，跳过');
} catch (e) {
  console.error('[sop-seed] 种子数据初始化失败(非致命):', e.message);
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
  if (synced > 0) console.log(`已同步 ${synced} 个询价客户到客户管理`);
} catch(e) { console.error('客户同步失败:', e.message); }

const routes = require('./routes');
app.use('/api', routes);

// ===== Express 统一错误处理 =====
// 捕获同步异常与 next(err)（如 express.json 解析失败、multer 体积超限），
// 返回结构化错误而非默认 HTML 堆栈，避免请求悬挂与信息泄露。
app.use((err, req, res, next) => {
  logProcessError('express-error', err);
  if (res.headersSent) return next(err);
  const status = (err && (err.status || err.statusCode)) || 500;
  res.status(status).json({
    error: status === 400 ? '请求参数错误' : '服务器内部错误',
    message: err && err.message ? String(err.message) : ''
  });
});

// favicon：返回 204，避免浏览器请求 /favicon.ico 时 404 刷控制台
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    // HTML remains revalidated so deployments take effect immediately. Static
    // JS/CSS can be reused briefly in production, avoiding a full asset RTT on
    // every page navigation while still limiting staleness to five minutes.
    const isAsset = req.path.endsWith('.js') || req.path.endsWith('.css');
    if (process.env.NODE_ENV === 'production' && isAsset) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=30');
    } else {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend')));

// 物料库自检调度器 —— 默认禁用（手动触发）
// 启用：环境变量 ENABLE_PERIODIC_TASKS=1 启动服务
// 手动触发：访问 /api/material-check/run 或在物料库自检待办页点「▶ 运行自检」
if (process.env.ENABLE_PERIODIC_TASKS === '1') {
  try { require('./lib/material-check-scheduler').startScheduler(); console.log('[material-check] 周期自检已启用（环境变量 ENABLE_PERIODIC_TASKS=1）'); }
  catch (e) { console.error('[material-check] 调度器启动失败:', e.message); }
} else {
  console.log('[material-check] 周期自检已禁用（默认）。如需启用：set ENABLE_PERIODIC_TASKS=1 启动服务。或访问 /api/material-check/run 手动触发。');
}

// ===== 物料数据完整性自愈 =====
// 检测到 materials.json < 50KB → 自动从外部 API 拉回
// 触发时机：1) 服务启动 5s 后 2) 路由惰性触发（见 routes/material.js）
// 不再使用 setInterval 周期检查，避免在卡顿的 13MB 写盘期间反复触发出问题
const recovery = require('./lib/materials-recovery');

function ensureMaterialsHealth(){
  const h = recovery.check();
  const desc = h.desc || ('size=' + h.size);
  if(!h.ok || h.tooSmall){
    console.log('[startup] materials 数据异常（' + desc + '），启动自动恢复...');
    recovery.recover('startup', { log: (m) => console.log('[recovery] ' + m) });
  } else {
    console.log('[startup] materials 数据正常 (' + desc + ')');
  }
}
// 暴露给路由的惰性触发
global._recoverMaterialsNow = (reason) => recovery.recover(reason, { log: (m) => console.log('[recovery] ' + m) });
setTimeout(ensureMaterialsHealth, 5000);

// 关闭物料自动恢复周期任务 —— 周期任务在 13MB 写盘期间阻塞事件循环，
// 而且 material_check_issues.json 累积会撑到 80MB+
// 改为按需手动触发 + 路由惰性触发，需要时由用户在 UI 点「恢复」按钮或后端运维时手动跑
console.log('[startup] 材料自动恢复：仅启动时 + 按需触发，已禁用周期任务（避免长时间写盘阻塞）');

let httpsServer = null;
const certPfxPath = path.join(__dirname, 'cert', 'server.pfx');
const certCrtPath = path.join(__dirname, 'cert', 'server.crt');
const certKeyPath = path.join(__dirname, 'cert', 'server.key');

if (fs.existsSync(certPfxPath)) {
  try {
    const pfxData = fs.readFileSync(certPfxPath);
    const pfxPassphrase = process.env.HTTPS_PFX_PASSPHRASE || '';
    if (!pfxPassphrase) {
      console.warn('⚠️ HTTPS_PFX_PASSPHRASE 环境变量未设置, HTTPS 将无法启动');
    }
    httpsServer = https.createServer({ pfx: pfxData, passphrase: pfxPassphrase }, app);
  } catch(e) {
    console.log('HTTPS证书加载失败，仅使用HTTP:', e.message);
  }
} else if (fs.existsSync(certCrtPath) && fs.existsSync(certKeyPath)) {
  try {
    httpsServer = https.createServer({
      cert: fs.readFileSync(certCrtPath),
      key: fs.readFileSync(certKeyPath)
    }, app);
  } catch(e) {
    console.log('HTTPS证书加载失败，仅使用HTTP:', e.message);
  }
}
const server = http.createServer(app);

// HTTP 服务级错误兜底：端口占用等 listen 错误若无监听会直接抛出并终止进程
server.on('error', (err) => {
  logProcessError('server-error', err);
  if (err && err.code === 'EADDRINUSE') process.exit(1); // 交给 Docker/PM2 重启，避免僵死
});
server.on('clientError', (err, socket) => {
  try { if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

const WebSocket = require('ws');
const wss = new WebSocket.Server({ server, path: '/ws' });

// WebSocket 服务级错误：EventEmitter 的 'error' 无监听时会抛出导致进程退出
wss.on('error', (err) => logProcessError('wss-error', err));

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
  ws.on('error', (err) => logProcessError('ws-error', err));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth') {
        user = msg.user;
        wsClients.set(user, ws);
      }
      if (msg.type === 'chat' && msg.channel_id) {
        const broadcast = JSON.stringify({
          type: 'chat',
          channel_id: msg.channel_id,
          sender: msg.sender || user,
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
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`局域网访问: http://${LOCAL_IP}:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);

  // 内存监控：每 30 分钟打印一次 RSS/heap，便于定位 OOM/内存泄漏
  // （此前数据库缓存膨胀 + WSL 内存上限叠加，容器可能被 OOM 杀掉）
  setInterval(() => {
    const m = process.memoryUsage();
    console.log('[mem] rss=' + Math.round(m.rss / 1048576) + 'MB heapUsed=' + Math.round(m.heapUsed / 1048576) + 'MB external=' + Math.round(m.external / 1048576) + 'MB');
  }, 30 * 60 * 1000).unref();

  // 后台预热订单分析库大表与索引（order_bom_details 240MB 等），
  // 避免首次打开页面时由用户请求承担冷加载（不阻塞端口监听）
  try { require('./routes/order-analysis').warmupCaches(); } catch (e) {
    console.warn('[warmup] 订单分析预热失败:', e.message);
  }

  // 启动兜底：订单核价库成品型号 → 工价库自动补同步（已存在跳过，不重复；延迟30秒避开启动高峰）
  setTimeout(() => {
    try {
      require('./routes/product-labor-rate').syncFromPricingLib()
        .then(r => { if (r && r.added > 0) console.log('[startup] 核价库→工价库补同步：新增 ' + r.added + ' 个型号'); })
        .catch(e => console.warn('[startup] 核价库→工价库补同步失败:', e.message));
    } catch (e) {}
  }, 30000);

  if (httpsServer) {
    const HTTPS_PORT = PORT + 1;
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS Server running on https://localhost:${HTTPS_PORT}`);
      console.log(`局域网HTTPS访问: https://${LOCAL_IP}:${HTTPS_PORT}`);
      console.log(`截图/拍照功能请使用HTTPS地址访问`);
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
        console.log(`[定时同步] ${result.summary}`);
      }
    } catch(e) {
      console.error('[定时同步] 核价→报价同步失败:', e.message);
    }
  }

  // 启动后延迟30秒执行首次同步（等待系统初始化完成）
  setTimeout(() => {
    runSync();
    setInterval(runSync, SYNC_INTERVAL);
  }, 30000);

  console.log(`定时同步: 核价库→报价库 每5分钟自动同步`);

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
              console.log(`[AI自动引擎] 扫描${scanCount}个问题, 学习${learnCount}条, 计划${planCount}个, 新增行动${actionCount}条`);
            } else {
              console.log(`[AI自动引擎] 运行完成，暂无新问题`);
            }
          } catch(e) {
            console.error('[AI自动引擎] 解析结果失败:', e.message);
          }
        });
      });
      req.on('error', e => console.error('[AI自动引擎] 请求失败:', e.message));
      req.write(postData);
      req.end();
    } catch(e) {
      console.error('[AI自动引擎] 执行失败:', e.message);
    }
  }

  setTimeout(() => {
    runAiAutoEngine();
    setInterval(runAiAutoEngine, AI_AUTO_INTERVAL);
  }, 60000);

  console.log(`AI自动引擎: 每30分钟自动扫描→学习→总结→计划→行动`);

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
            console.log(`[外部同步] ${enabledMods.map(([n])=>n).join(',')} 完成, 导入${total}条`);
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
  console.log('外部同步调度器: 按配置频率自动同步');
  } else {
    console.log('[startup] 周期任务已禁用（物料自检/核价同步/AI引擎/外部API），设置 ENABLE_PERIODIC_TASKS=1 启用');
  }
});

// test write at 16:19:06
