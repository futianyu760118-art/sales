const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { now: dbNow } = require('./db');

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

// 初始化数据
require('./initData');

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

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend')));

// 启动物料库自检调度器
try { require('./lib/material-check-scheduler').startScheduler(); } catch (e) { console.error('[material-check] 调度器启动失败:', e.message); }

// 物料数据完整性自愈：若 materials.json < 1MB（疑似损坏或曾被覆盖为空），自动从外部 API 拉回
function ensureMaterialsHealth() {
  try {
    const matFile = path.join(__dirname, '..', 'database', 'materials.json');
    const stat = fs.statSync(matFile);
    if (stat.size < 1024 * 1024) {
      console.log('[startup] materials.json 仅 ' + stat.size + ' 字节，启动自动恢复 → 调外部 API 同步...');
      const expSync = require('./routes/external-sync');
      const originalApp = app._router;
      // 通过 http 内部调用
      const opts = { hostname: 'localhost', port: 3010, path: '/api/external-sync/sync-materials', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } };
      const req = http.request(opts, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>console.log('[startup] 恢复完成:', d.substring(0,150))); });
      req.on('error',()=>{});
      req.write('{}');req.end();
    } else {
      console.log('[startup] materials.json 大小正常 ('+ (stat.size/1024/1024).toFixed(1) +' MB)');
    }
  } catch(e) { console.error('[startup] 检查物料数据失败:', e.message); }
}
setTimeout(ensureMaterialsHealth, 10000); // 启动 10 秒后做健康检查

const server = http.createServer(app);

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
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server, path: '/ws' });

const wsClients = new Map();

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

  if (httpsServer) {
    const HTTPS_PORT = PORT + 1;
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS Server running on https://localhost:${HTTPS_PORT}`);
      console.log(`局域网HTTPS访问: https://${LOCAL_IP}:${HTTPS_PORT}`);
      console.log(`截图/拍照功能请使用HTTPS地址访问`);
    });
  }

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
});
