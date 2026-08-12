// 物料变更回传 outbox：本地物料被增删改时写入待回传队列；
// 外部写入接口配置后由 sendOne/flush 真正回传，未配置则优雅暂存。
// 注意：仅在本地 CRUD 路由(material.js)入队，外部拉取同步(external-sync)不入队，避免回环。
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { getTable, now } = require('../db');

const TABLE = 'external_outbox';
const WRITE_CFG_KEY = 'material_write_config';

// 本地物料 → 外部API字段（按 materials.list 暴露字段对齐）
function toExternalPayload(m) {
  if (!m) return {};
  const st = m.status;
  return {
    material_code: m.material_code || '',
    material_name: m.material_name || '',
    spec_model: m.specs || m.spec_model || '',
    material_type: m.material_type || m.category || '',
    unit_of_measure: m.unit || '',
    brand: m.supplier || m.brand || '',
    status: (st === 'inactive') ? 0 : 1,
    order_unit_price: Number(m.unit_price || m.standard_cost || 0),
    standard_cost: Number(m.standard_cost || 0),
    inventory_qty: Number(m.inventory_qty || 0),
    min_inventory: Number(m.min_inventory || 0),
    classification: m.classification || '',
    last_outbound_date: m.last_outbound_date || ''
  };
}

// ===== 外部写入接口配置（独立存于 system_settings）=====
function _readWriteCfgRow() {
  const t = getTable('system_settings');
  const row = t.all().find(r => r.key === WRITE_CFG_KEY);
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}
function getWriteConfig() {
  const def = { enabled: false, baseUrl: '', path: '', method: 'PUT', endpointCode: 'materials.update' };
  return Object.assign(def, _readWriteCfgRow() || {});
}
function setWriteConfig(patch) {
  const next = Object.assign(getWriteConfig(), patch || {});
  if (next.enabled !== undefined) next.enabled = !!next.enabled;
  const t = getTable('system_settings');
  const val = JSON.stringify(next);
  const existing = t.all().find(r => r.key === WRITE_CFG_KEY);
  if (existing) t.update(existing.id, { value: val, updated_at: now() });
  else t.insert({ key: WRITE_CFG_KEY, value: val, created_at: now(), updated_at: now() });
  t._invalidate();
  return next;
}

// 复用 external-sync 的连接配置（baseUrl/appKey/appSecret）
function _loadConnCfg() {
  const t = getTable('system_settings');
  const row = t.all().find(r => r.key === 'external_sync_config');
  let presets = null;
  if (row) { try { presets = JSON.parse(row.value); } catch (e) {} }
  if (presets && Array.isArray(presets.presets)) {
    return presets.presets.find(p => p.id === presets.activeId) || presets.presets[0] || {};
  }
  return {};
}

// ===== 入队（带 coalesce：同 material_code 的 pending 增/改合并，避免堆积）=====
function queue(op, materialCode, recordId, payload) {
  try {
    if (!materialCode) return;
    const t = getTable(TABLE);
    t._invalidate();
    const all = t.all();
    if (op === 'update' || op === 'create') {
      const dup = all.find(e => e.material_code === materialCode && e.status === 'pending' && (e.op === 'create' || e.op === 'update'));
      if (dup) {
        const merged = Object.assign({}, JSON.parse(dup.payload || '{}'), payload || {});
        t.update(dup.id, { payload: JSON.stringify(merged), op: dup.op === 'create' ? 'create' : op, updated_at: now() });
        return;
      }
    }
    if (op === 'delete') {
      // 本地已删除：清除该代码下尚未发送的增/改记录，避免无意义回传
      all.filter(e => e.material_code === materialCode && e.status === 'pending' && (e.op === 'create' || e.op === 'update'))
        .forEach(e => t.delete(e.id));
    }
    t.insert({
      table_name: 'materials', record_id: recordId || null, material_code: materialCode,
      op, payload: JSON.stringify(payload || {}), status: 'pending',
      attempts: 0, last_error: '', created_at: now(), updated_at: now(), sent_at: ''
    });
  } catch (e) { console.error('[outbox] queue error:', e.message); }
}

function list({ status, keyword, page = 1, pageSize = 100 } = {}) {
  const t = getTable(TABLE);
  t._invalidate();
  let rows = t.all().slice().sort((a, b) => (b.id - a.id));
  if (status) rows = rows.filter(r => r.status === status);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    rows = rows.filter(r => (r.material_code || '').toLowerCase().includes(kw) || String(r.payload || '').toLowerCase().includes(kw));
  }
  const total = rows.length;
  if (page && pageSize) {
    const start = (page - 1) * pageSize;
    rows = rows.slice(start, start + pageSize);
  }
  return { rows, total };
}

function pendingCount() {
  const t = getTable(TABLE);
  t._invalidate();
  return t.all().filter(r => r.status === 'pending').length;
}

function _findById(id) {
  const t = getTable(TABLE);
  t._invalidate();
  return t.all().find(r => r.id === Number(id));
}

function dismiss(id) {
  const t = getTable(TABLE);
  const e = _findById(id);
  if (!e) return false;
  t.delete(Number(id));
  return true;
}

// ===== 发送器：写入接口未配置时优雅失败；配置后按 HMAC 签名回传 =====
function _sign(appKey, appSecret, endpointCode, timestamp, body) {
  const s = `${timestamp}${appKey}${endpointCode}${body}`;
  return crypto.createHmac('sha256', appSecret).update(s).digest('hex');
}

function sendOne(entry) {
  return new Promise((resolve) => {
    const wcfg = getWriteConfig();
    if (!wcfg.enabled || !wcfg.path) {
      return resolve({ ok: false, error: '外部写入接口尚未配置（变更已暂存，配置后可一键回传）' });
    }
    const conn = _loadConnCfg();
    const baseUrl = (wcfg.baseUrl || conn.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl || !conn.appKey || !conn.appSecret) {
      return resolve({ ok: false, error: '连接配置缺失（baseUrl/appKey/appSecret），请在系统设置-外部同步中配置' });
    }
    let urlObj;
    try { urlObj = new URL(baseUrl + wcfg.path); } catch (e) { return resolve({ ok: false, error: '写入接口地址无效: ' + baseUrl + wcfg.path }); }
    const body = entry.payload || '{}';
    const data = Buffer.from(body, 'utf8');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = _sign(conn.appKey, conn.appSecret, wcfg.endpointCode, timestamp, body);
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      method: (wcfg.method || 'PUT').toUpperCase(),
      hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      headers: {
        'Content-Type': 'application/json', 'Content-Length': data.length,
        'X-App-Key': conn.appKey, 'X-Timestamp': timestamp, 'X-Signature': signature
      },
      agent: isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined,
      timeout: 30000
    }, (res) => {
      let chunk = ''; res.on('data', c => chunk += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, body: chunk.substring(0, 500) });
        else resolve({ ok: false, error: `HTTP ${res.statusCode}: ${chunk.substring(0, 200)}` });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: '网络错误: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    req.write(data); req.end();
  });
}

function _mark(id, patch) { const t = getTable(TABLE); t.update(Number(id), patch); }

async function flush() {
  const t = getTable(TABLE);
  t._invalidate();
  const pending = t.all().filter(r => r.status === 'pending');
  let sent = 0, failed = 0; const errors = [];
  for (const entry of pending) {
    const r = await sendOne(entry);
    if (r.ok) { _mark(entry.id, { status: 'sent', attempts: (entry.attempts || 0) + 1, sent_at: now(), updated_at: now(), last_error: '' }); sent++; }
    else { _mark(entry.id, { status: 'failed', attempts: (entry.attempts || 0) + 1, last_error: r.error, updated_at: now() }); failed++; errors.push({ id: entry.id, material_code: entry.material_code, error: r.error }); }
  }
  return { sent, failed, errors };
}

async function retryOne(id) {
  const entry = _findById(id);
  if (!entry) return { ok: false, error: '记录不存在' };
  const r = await sendOne(entry);
  if (r.ok) _mark(id, { status: 'sent', attempts: (entry.attempts || 0) + 1, sent_at: now(), last_error: '' });
  else _mark(id, { status: 'failed', attempts: (entry.attempts || 0) + 1, last_error: r.error });
  return r;
}

module.exports = {
  toExternalPayload, queue, list, pendingCount, dismiss, flush, retryOne,
  getWriteConfig, setWriteConfig
};
