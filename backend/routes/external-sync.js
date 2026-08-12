const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const https = require('https');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const outbox = require('../lib/material-outbox');
const bearerAuth = require('../lib/external-bearer-auth');

// 外部同步连接配置（默认值；可通过 /api/external-sync/config 在系统设置中覆盖）
const DEFAULT_CONFIG = {
  baseUrl: 'https://192.168.0.127:18084',
  appKey: 'ak_745e44c96d4f4790',
  appSecret: 'c93b118d21c9403ead9819d3336f7afafcbda6deab9b4738b5c57278396d6336',
  timeout: 30000
};

// ===== 多环境预设：可保存多套 API 配置并选择激活的那一套 =====
function _readSettingsRow() {
  const t = getTable('system_settings');
  const row = t.all().find(r => r.key === 'external_sync_config');
  if (row && row.value) { try { return JSON.parse(row.value); } catch (e) { return null; } }
  return null;
}
function _writeSettingsRow(obj) {
  const t = getTable('system_settings');
  const val = JSON.stringify(obj);
  const existing = t.all().find(r => r.key === 'external_sync_config');
  if (existing) t.update(existing.id, { value: val, updated_at: now() });
  else t.insert({ key: 'external_sync_config', value: val, created_at: now(), updated_at: now() });
  t._invalidate();
}
function newId() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 读取预设集（不存在时初始化；兼容旧扁平结构）
function getPresets() {
  let raw = _readSettingsRow();
  if (!raw) {
    raw = { presets: [Object.assign({ id: newId(), name: '默认环境' }, DEFAULT_CONFIG)], activeId: null };
    raw.activeId = raw.presets[0].id;
    _writeSettingsRow(raw);
    return raw;
  }
  if (!raw.presets) {
    // 迁移旧扁平结构 → 单个预设
    const id = newId();
    raw = { presets: [Object.assign({ id, name: '默认环境' }, raw)], activeId: id };
    _writeSettingsRow(raw);
  }
  return raw;
}
// 同步代码统一入口：返回当前激活预设（与 DEFAULT_CONFIG 合并）
function loadConfig() {
  const raw = getPresets();
  const active = raw.presets.find(p => p.id === raw.activeId) || raw.presets[0];
  return Object.assign({}, DEFAULT_CONFIG, active || {});
}
// 保存配置 = 更新当前激活预设
function saveConfig(patch) {
  const raw = getPresets();
  const idx = raw.presets.findIndex(p => p.id === raw.activeId);
  if (idx >= 0) {
    raw.presets[idx] = Object.assign({}, raw.presets[idx], patch);
    _writeSettingsRow(raw);
  }
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function sign(CONFIG, timestamp, dataType, queryString) {
  const s = `${timestamp}${CONFIG.appKey}${dataType}${queryString}`;
  return crypto.createHmac('sha256', CONFIG.appSecret).update(s).digest('hex');
}

// endpoint_code（签名用，下划线）→ URL 路径（多词接口用连字符）映射
const ENDPOINT_PATH = {
  'bom_details.list': 'bom-details/list',
  'purchase_orders.list': 'purchase-orders/list',
  'schedule_plans.list': 'schedule-plans/list',
  'order_details.list': 'order-details/list',
};

function fetchExternal(endpointCode, params = {}) {
  const CONFIG = loadConfig();
  return new Promise((resolve, reject) => {
    const parts = [];
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(v)}`);
    });
    const qs = parts.join('&');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(CONFIG, timestamp, endpointCode, qs);
    const path = ENDPOINT_PATH[endpointCode] || endpointCode.replace('.', '/');
    const url = `${CONFIG.baseUrl}/api/v1/external/${path}${qs ? '?' + qs : ''}`;

    const req = https.get(url, {
      agent: httpsAgent,
      timeout: CONFIG.timeout,
      headers: { 'X-App-Key': CONFIG.appKey, 'X-Timestamp': timestamp, 'X-Signature': signature }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (e) { json = null; }
        if (json && json.code === 0) {
          resolve(json.data || { items: [], total: 0 });
        } else if (json) {
          reject(new Error(`外部接口 ${endpointCode} 返回 HTTP ${res.statusCode}：${json.message || json.detail || `API错误(code=${json.code})`}`));
        } else {
          // 非 JSON 响应（如 500 Internal Server Error 纯文本）
          reject(new Error(`外部接口 ${endpointCode} 服务端错误 (HTTP ${res.statusCode})：${data.substring(0, 120)}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error('网络错误: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

async function fetchAllPages(endpointCode, pageSize = 200, maxPages = 200, extraParams = {}) {
  let all = [];
  let page = 1;
  while (page <= maxPages) {
    const r = await fetchExternal(endpointCode, Object.assign({ page, page_size: pageSize }, extraParams));
    all = all.concat(r.items || []);
    if (all.length >= (r.total || 0) || (r.items || []).length < pageSize) break;
    page++;
  }
  return all;
}

// ==================== 连接配置管理 ====================

// 获取外部同步连接配置（appSecret 脱敏返回）
router.get('/config', requirePerm('system:config'), (req, res) => {
  const cfg = loadConfig();
  res.json({
    baseUrl: cfg.baseUrl,
    appKey: cfg.appKey,
    appSecret: cfg.appSecret ? '••••••' + String(cfg.appSecret).slice(-4) : '',
    appSecretSet: !!cfg.appSecret,
    timeout: cfg.timeout
  });
});

// 保存外部同步连接配置
router.post('/config', requirePerm('system:config'), (req, res) => {
  const { baseUrl, appKey, appSecret, timeout } = req.body;
  const patch = {};
  if (baseUrl !== undefined) patch.baseUrl = String(baseUrl).trim();
  if (appKey !== undefined) patch.appKey = String(appKey).trim();
  // 脱敏占位符（••••••）不覆盖真实密钥
  if (appSecret !== undefined && appSecret !== '' && !String(appSecret).startsWith('•••')) {
    patch.appSecret = String(appSecret).trim();
  }
  if (timeout !== undefined) patch.timeout = Number(timeout) || DEFAULT_CONFIG.timeout;
  saveConfig(patch);
  res.json({ message: '外部同步设置已保存' });
});

// ===== 多环境预设管理：可保存多套 API 配置并选择激活 =====
// 预设列表（appSecret 脱敏）+ 激活ID
router.get('/config/presets', requirePerm('system:config'), (req, res) => {
  const raw = getPresets();
  const presets = raw.presets.map(p => ({
    id: p.id, name: p.name || '未命名',
    baseUrl: p.baseUrl || '', appKey: p.appKey || '',
    appSecret: p.appSecret ? '••••••' + String(p.appSecret).slice(-4) : '',
    appSecretSet: !!p.appSecret,
    timeout: p.timeout || DEFAULT_CONFIG.timeout
  }));
  res.json({ presets, activeId: raw.activeId });
});

// 新增预设
router.post('/config/presets', requirePerm('system:config'), (req, res) => {
  const { name, baseUrl, appKey, appSecret, timeout, activate } = req.body;
  const raw = getPresets();
  const id = newId();
  const preset = {
    id, name: String(name || '新环境').trim(),
    baseUrl: String(baseUrl || '').trim(),
    appKey: String(appKey || '').trim(),
    timeout: Number(timeout) || DEFAULT_CONFIG.timeout
  };
  if (appSecret && !String(appSecret).startsWith('•••')) preset.appSecret = String(appSecret).trim();
  raw.presets.push(preset);
  if (activate) raw.activeId = id;
  _writeSettingsRow(raw);
  res.json({ message: '环境已创建', id, activeId: raw.activeId });
});

// 更新预设
router.put('/config/presets/:id', requirePerm('system:config'), (req, res) => {
  const raw = getPresets();
  const p = raw.presets.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '环境不存在' });
  ['name', 'baseUrl', 'appKey'].forEach(f => { if (req.body[f] !== undefined) p[f] = String(req.body[f]).trim(); });
  if (req.body.appSecret !== undefined && req.body.appSecret !== '' && !String(req.body.appSecret).startsWith('•••')) {
    p.appSecret = String(req.body.appSecret).trim();
  }
  if (req.body.timeout !== undefined) p.timeout = Number(req.body.timeout) || DEFAULT_CONFIG.timeout;
  _writeSettingsRow(raw);
  res.json({ message: '环境已更新' });
});

// 删除预设（不允许删除激活项或最后一项）
router.delete('/config/presets/:id', requirePerm('system:config'), (req, res) => {
  const raw = getPresets();
  if (raw.presets.length <= 1) return res.status(400).json({ error: '至少保留一个环境' });
  if (raw.activeId === req.params.id) return res.status(400).json({ error: '不能删除当前激活环境，请先切换' });
  raw.presets = raw.presets.filter(x => x.id !== req.params.id);
  _writeSettingsRow(raw);
  res.json({ message: '环境已删除' });
});

// 选择激活预设
router.post('/config/active', requirePerm('system:config'), (req, res) => {
  const raw = getPresets();
  const id = req.body.id;
  if (!raw.presets.some(x => x.id === id)) return res.status(404).json({ error: '环境不存在' });
  raw.activeId = id;
  _writeSettingsRow(raw);
  res.json({ message: '已切换激活环境', activeId: id });
});

// 拉取外部库存明细并按物料代码汇总在手/可用/期末余额（Bearer 调用内部端点）
// 同时返回明细行（每条：物料×仓库×库位×批次）供持久化到 material_locations.json
async function fetchInventoryAggregate() {
  const items = await fetchAllPagesBearer('/api/v1/basicdata/inventory', 100);
  const agg = {};
  const detail = [];
  for (const it of items) {
    const code = (it.material_code || '').trim();
    if (!code) continue;
    const onHand = Number(it.qty_on_hand || 0);
    const avail = Number(it.balance_qty != null ? it.balance_qty : it.qty_on_hand || 0);
    const endBal = Number(it.ending_balance || it.balance_qty || 0);  // 期末余额（财务口径）
    if (!agg[code]) agg[code] = { on_hand: 0, available: 0, ending_balance: 0 };
    agg[code].on_hand += onHand;
    agg[code].available += avail;
    agg[code].ending_balance += endBal;
    detail.push({
      material_code: code,
      wh_code: it.wh_code || '',
      wh_name: it.wh_name || '',
      location_id: Number(it.location_id || 0),
      location_name: it.location_name || '',
      qty_on_hand: onHand,
      qty_available: avail,
      batch_no: it.batch_no || '',
      updated_at: it.updated_at || ''
    });
  }
  return { agg, detail, rows: items.length };
}

// Bearer 鉴权分页拉取（适用于 18085 内部业务端点；page_size 上限 100）
async function fetchAllPagesBearer(path, pageSize = 100, maxPages = 300, extraParams = {}) {
  let all = [];
  let page = 1;
  while (page <= maxPages) {
    const r = await bearerAuth.fetchWithBearer(path, Object.assign({ page, page_size: pageSize }, extraParams));
    const data = (r && r.data) || {};
    const items = data.items || [];
    all = all.concat(items);
    const total = data.total || 0;
    if (items.length < pageSize || all.length >= total) break;
    page++;
  }
  return all;
}

// 持久化物料-库位明细到 database/material_locations.json（原子写入 + 自动备份）
function saveMaterialLocations(detail) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '..', 'database', 'material_locations.json');
  const payload = { updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19), records: detail };
  const content = JSON.stringify(payload, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch (e) {
    // 备份原文件再回退写入
    try { fs.copyFileSync(file, file + '.bak'); } catch (_) {}
    fs.writeFileSync(file, content, 'utf8');
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ==================== 物料同步 ====================
// 内部端点路径（Bearer 鉴权）：materials 来自 /api/v1/basicdata/materials，包含 order_unit_price
// 注：旧的 /api/v1/external/{code} 端点已下线，改用内部业务端点 + OAuth2 登录
const MAT_PATH = '/api/v1/basicdata/materials';

router.post('/sync-materials', requirePerm('material:create'), async (req, res) => {
  try {
    let items;
    try {
      items = await fetchAllPagesBearer(MAT_PATH, 100);
    } catch (e) {
      return res.status(200).json({ message: '外部物料API暂不可用: ' + e.message, created: 0, updated: 0 });
    }

    // 物料主数据(materials)不含库存，需同时拉取库存明细按物料代码汇总在手/期末余额
    let inv = { agg: {}, rows: 0 };
    let invError = '';
    try {
      inv = await fetchInventoryAggregate();
    } catch (e) {
      invError = e.message;
    }

    const table = getTable('materials');
    table._invalidate();
    const codeMap = {};
    table.all().forEach(m => { if (m.material_code) codeMap[m.material_code] = m; });
    let created = 0, updated = 0, invUpdated = 0;
    for (const item of items) {
      const code = item.material_code || item.code || '';
      if (!code) continue;
      const existing = codeMap[code];
      const mapped = {
        material_code: code,
        material_name: item.material_name || item.name || '',
        category: item.material_category || item.material_type || item.category || '',
        specs: item.spec_model || item.specification || item.specs || '',
        material_type: item.material_type || item.category || '',
        unit: item.unit_of_measure || item.unit || item.uom || '',
        unit_price: Number(item.order_unit_price || item.unit_price || item.price || 0),
        standard_cost: Number(item.standard_cost || item.cost || item.order_unit_price || 0),
        supplier: item.brand || item.supplier_name || item.supplier || '',
        status: item.status === 1 ? 'active' : (item.status === 0 ? 'inactive' : (item.status || 'active')),
        classification: item.classification || '',
        classification2: (/自制|委外/.test(item.material_type || item.type || '')) ? '专用物料' : '通用物料',
        last_outbound_date: item.last_outbound_date || '',
        updated_at: now()
      };
      // 库存：优先取库存明细汇总（现有库存量+财务余额），其次物料接口自带字段
      const invRec = inv.agg[code];
      if (invRec) {
        mapped.inventory_qty = Math.round(invRec.on_hand * 1000) / 1000;
        mapped.available_qty = Math.round(invRec.available * 1000) / 1000;
        mapped.inv_ending_balance = Math.round(invRec.ending_balance * 100) / 100;
        invUpdated++;
      } else if (item.stock_qty !== undefined || item.inventory_qty !== undefined) {
        mapped.inventory_qty = Number(item.stock_qty || item.inventory_qty || 0);
      }
      if (item.stock_qty !== undefined || item.quantity !== undefined) mapped.quantity = Number(item.stock_qty || item.quantity || 0);
      if (item.safety_stock !== undefined || item.min_inventory !== undefined) mapped.min_inventory = Number(item.safety_stock || item.min_inventory || 0);
      if (existing) {
        // 已存在的物料：外部API没有返回的字段（category/classification/classification2）不要覆盖手动修改值
        // 只更新外部API确实有值的字段
        // 成品(category='成品')的标准成本/工价成本由订单审核台内部回传，外部不再覆盖
        const isFinishedProduct = (existing.category || '') === '成品';
        const updateFields = { updated_at: now() };
        if (item.material_name) updateFields.material_name = mapped.material_name;
        if (item.spec_model || item.specification) updateFields.specs = mapped.specs;
        if (item.unit_of_measure || item.unit) updateFields.unit = mapped.unit;
        if (item.material_type) updateFields.material_type = mapped.material_type;
        if (item.brand) updateFields.supplier = mapped.supplier;
        updateFields.status = mapped.status;
        if (mapped.unit_price) updateFields.unit_price = mapped.unit_price;
        if (mapped.standard_cost && !isFinishedProduct) updateFields.standard_cost = mapped.standard_cost;
        // category / classification / classification2 仅在外部API有明确值时才覆盖
        if (item.material_category || item.category) updateFields.category = mapped.category;
        if (item.classification) updateFields.classification = mapped.classification;
        if (item.classification2) updateFields.classification2 = mapped.classification2;
        // 库存
        if (mapped.inventory_qty !== undefined) updateFields.inventory_qty = mapped.inventory_qty;
        if (mapped.available_qty !== undefined) updateFields.available_qty = mapped.available_qty;
        if (mapped.quantity !== undefined) updateFields.quantity = mapped.quantity;
        if (mapped.last_outbound_date !== undefined) updateFields.last_outbound_date = mapped.last_outbound_date;
        if (mapped.inv_ending_balance !== undefined) updateFields.inv_ending_balance = mapped.inv_ending_balance;
        Object.assign(existing, updateFields);
        updated++;
      }
      else {
        // 新建时补齐默认值（未匹配库存则默认0）
        if (mapped.inventory_qty === undefined) mapped.inventory_qty = 0;
        if (mapped.quantity === undefined) mapped.quantity = 0;
        if (mapped.min_inventory === undefined) mapped.min_inventory = 0;
        mapped.created_at = now(); table.insertNoSave(mapped); codeMap[code] = mapped; created++;
      }
    }
    await table.saveNow();
    table._invalidate();
    let msg = `同步完成：新增${created}，更新${updated}；库存匹配更新${invUpdated}个（库存明细${inv.rows}条）`;
    if (invError) msg += `；库存拉取失败(${invError})`;
    res.json({ message: msg, created, updated, inventory_updated: invUpdated, inventory_rows: inv.rows, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 库存同步（取现有库存量 qty_on_hand + 库位明细）====================
// inventory.list 为 物料×仓库×库位×批次 明细，汇总在手数量后写回物料 inventory_qty，
// 同时把整份明细写入 material_locations.json 供物料列表「库位」列使用
router.post('/sync-inventory', requirePerm('material:edit'), async (req, res) => {
  try {
    let agg, detail, rows;
    try {
      const r = await fetchInventoryAggregate();
      agg = r.agg; detail = r.detail; rows = r.rows;
    } catch (e) {
      return res.status(200).json({ message: '外部库存API暂不可用: ' + e.message, updated: 0 });
    }

    const table = getTable('materials');
    table._invalidate();
    const materials = table.all();
    const ts = now();
    let updated = 0, unmatched = 0;
    const matchedCodes = new Set();

    for (const m of materials) {
      const code = (m.material_code || '').trim();
      if (!code || !agg[code]) continue;
      matchedCodes.add(code);
      const qty = Math.round(agg[code].on_hand * 1000) / 1000;
      if (Number(m.inventory_qty || 0) !== qty) {
        Object.assign(m, { inventory_qty: qty, available_qty: Math.round(agg[code].available * 1000) / 1000, updated_at: ts });
        updated++;
      }
      const endBal = Math.round(agg[code].ending_balance * 100) / 100;
      if (Number(m.inv_ending_balance || 0) !== endBal) {
        Object.assign(m, { inv_ending_balance: endBal, updated_at: ts });
      }
    }
    // 外部库存中存在但本地物料库无匹配的物料数
    unmatched = Object.keys(agg).filter(c => !matchedCodes.has(c)).length;

    table.saveNow();
    table._invalidate();
    // 库位明细写到独立文件
    saveMaterialLocations(detail || []);
    res.json({
      message: `库存同步完成：更新${updated}个物料（外部库存明细${rows}条，汇总${Object.keys(agg).length}个物料代码，未匹配${unmatched}个）`,
      updated, inventory_rows: rows, aggregated_codes: Object.keys(agg).length, unmatched,
      locations: (detail || []).length
    });
  } catch (e) { res.status(500).json({ error: '库存同步失败: ' + e.message }); }
});

// ==================== 客户同步 ====================
router.post('/sync-customers', requirePerm('customer:create'), async (req, res) => {
  try {
    const items = await fetchAllPages('customers.list', 200);
    const table = getTable('customers');
    let created = 0, updated = 0;
    for (const item of items) {
      const name = item.customer_name || item.name || '';
      if (!name) continue;
      const existing = table.all().find(c => c.name === name);
      const mapped = {
        name,
        customer_code: item.customer_code || '',
        customer_level: item.customer_level || '',
        customer_status: item.status === 1 ? 'active' : 'inactive',
        industry: item.industry_type || '',
        contact: item.contact_person || '',
        phone: item.contact_phone || '',
        updated_at: now()
      };
      if (existing) { table.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); table.insert(mapped); created++; }
    }
    table._invalidate();
    res.json({ message: `同步完成：新增${created}，更新${updated}`, created, updated, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 供应商同步 ====================
router.post('/sync-suppliers', requirePerm('supplier:create'), async (req, res) => {
  try {
    const items = await fetchAllPages('suppliers.list', 200);
    const table = getTable('suppliers');
    let created = 0, updated = 0;
    for (const item of items) {
      const name = item.supplier_name || item.name || '';
      if (!name) continue;
      const existing = table.all().find(s => s.name === name);
      const mapped = {
        name,
        code: item.supplier_code || '',
        category: item.supplier_type || '',
        contact: item.contact_person || '',
        phone: item.contact_phone || '',
        payment_terms: item.payment_terms || '',
        lifecycle_status: item.status === 1 ? 'cooperating' : 'exited',
        updated_at: now()
      };
      if (existing) { table.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); table.insert(mapped); created++; }
    }
    table._invalidate();
    res.json({ message: `同步完成：新增${created}，更新${updated}`, created, updated, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 订单同步 ====================
router.post('/sync-orders', requirePerm('order:create'), async (req, res) => {
  try {
    const items = await fetchAllPages('orders.list', 200);
    const table = getTable('orders');
    let created = 0, updated = 0;
    for (const item of items) {
      const orderNo = item.order_no || '';
      if (!orderNo) continue;
      const existing = table.all().find(o => o.order_no === orderNo);
      const mapped = {
        order_no: orderNo,
        line_no: item.line_no || '',
        customer_name: item.customer || '',
        customer_code: item.customer_code || '',
        product_code: item.product_code || '',
        product_name: item.product_name || '',
        bom_no: item.bom_no || '',
        bom_id: item.bom_id || null,
        quantity: Number(item.order_qty || 0),
        completed_qty: Number(item.completed_qty || 0),
        order_amount: Number(item.order_amount || 0),
        status: item.status || 'open',
        risk_level: item.risk_level || 'blue',
        promised_date: item.promised_date || '',
        updated_at: now()
      };
      if (existing) { table.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); table.insert(mapped); created++; }
    }
    table._invalidate();
    res.json({ message: `同步完成：新增${created}，更新${updated}`, created, updated, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 产品同步 ====================
router.post('/sync-products', requirePerm('product:create'), async (req, res) => {
  try {
    const items = await fetchAllPages('products.list', 200);
    const table = getTable('products');
    let created = 0, updated = 0;
    for (const item of items) {
      const model = item.product_code || item.external_model || '';
      if (!model) continue;
      const existing = table.all().find(p => p.external_model === model);
      const mapped = {
        external_model: model,
        name: item.product_name || item.name || '',
        internal_model: item.internal_model || '',
        category: item.product_category || item.category || '',
        status: 'active',
        updated_at: now()
      };
      if (existing) { table.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); table.insert(mapped); created++; }
    }
    table._invalidate();
    res.json({ message: `同步完成：新增${created}，更新${updated}`, created, updated, total: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 组织同步 ====================
router.post('/sync-organizations', requirePerm('system:config'), async (req, res) => {
  try {
    const items = await fetchAllPages('organizations.list', 200);
    const table = getTable('organizations');
    let created = 0, updated = 0;
    for (const item of items) {
      const code = item.oa_org_id || item.org_code || item.organization_code || item.code || '';
      if (!code) continue;
      const existing = table.all().find(o => o.org_code === code);
      const mapped = {
        org_code: code,
        org_name: item.org_name || item.organization_name || item.name || '',
        parent_org_code: item.parent_code || item.parent_org_code || item.parent_id || '',
        org_type: item.org_type || item.type || '',
        manager: item.leader_name || item.manager || item.leader || '',
        status: item.status === 1 || item.status === '1' ? 'active' : (item.status || 'active'),
        updated_at: now()
      };
      if (existing) { table.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); table.insert(mapped); created++; }
    }
    table._invalidate();
    res.json({ message: `组织同步完成：新增${created}，更新${updated}`, created, updated, total: items.length });
  } catch (e) { res.status(500).json({ error: '组织同步失败: ' + e.message }); }
});

// ==================== 人员同步 ====================
router.post('/sync-personnel', requirePerm('system:config'), async (req, res) => {
  try {
    const items = await fetchAllPages('employees.list', 200);
    const table = getTable('personnel');
    let created = 0, updated = 0;
    for (const item of items) {
      const code = item.oa_emp_id || item.oa_user_id || item.oa_employee_id || item.emp_code || item.employee_code || item.personnel_code || item.code || '';
      if (!code) continue;
      const existing = table.all().find(p => p.emp_code === code);
      const mapped = {
        emp_code: code,
        name: item.emp_name || item.employee_name || item.personnel_name || item.name || '',
        org_code: item.oa_org_id || item.org_code || item.department_code || item.dept_code || '',
        org_name: item.org_name || item.department_name || item.dept_name || '',
        position: item.position || item.title || item.post || '',
        phone: item.phone || item.mobile || '',
        email: item.email || '',
        gender: item.gender || '',
        status: item.status === 1 || item.status === '1' ? 'active' : (item.status || 'active'),
        updated_at: now()
      };
      if (existing) { table.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); table.insert(mapped); created++; }
    }
    table._invalidate();
    res.json({ message: `人员同步完成：新增${created}，更新${updated}`, created, updated, total: items.length });
  } catch (e) { res.status(500).json({ error: '人员同步失败: ' + e.message }); }
});

// ==================== 岗位同步 ====================
// 外部 positions.list 字段（常见）：id, position_code, position_name, org_code, status
// 与系统内 org_positions 表对接：code, name, department_id
// 关联部门来源：org_departments（按 code）→ organizations（按 org_code）→ 自动建占位部门
// 注：实际外部接口可能不返回 org_code（部分接口仅返回岗位主数据），关联失败时仍可创建岗位
router.post('/sync-positions', requirePerm('system:config'), async (req, res) => {
  try {
    const items = await fetchAllPages('positions.list', 200);
    const positionsTable = getTable('org_positions');
    const departmentsTable = getTable('org_departments');
    const organizationsTable = getTable('organizations');
    departmentsTable._invalidate();
    organizationsTable._invalidate();

    // 部门索引：code/org_code(org_departments) + org_code(organizations)
    const deptByCode = {};
    const deptByOrgCode = {};
    departmentsTable.all().forEach(d => {
      if (d.code) deptByCode[String(d.code)] = d;
      if (d.org_code) deptByOrgCode[String(d.org_code)] = d;
    });
    const orgsByCode = {};
    organizationsTable.all().forEach(o => { if (o.org_code) orgsByCode[String(o.org_code)] = o; });

    // 自动建占位 org_departments（用 org_code + org_name）
    const ensureDepartment = (orgCode, orgName) => {
      if (!orgCode) return null;
      if (deptByCode[orgCode] || deptByOrgCode[orgCode]) return deptByCode[orgCode] || deptByOrgCode[orgCode];
      const org = orgsByCode[orgCode];
      const name = orgName || (org ? org.org_name : '') || orgCode;
      const result = departmentsTable.insert({
        name, code: orgCode, org_code: orgCode, org_name: name,
        status: 'active', sort: 0, parent_id: null, level: 1,
        created_at: now(), updated_at: now()
      });
      const newDept = departmentsTable.findById(result.lastID);
      deptByCode[orgCode] = newDept;
      deptByOrgCode[orgCode] = newDept;
      return newDept;
    };

    let created = 0, updated = 0, skipped = 0, unmatched_dept = 0, auto_created_dept = 0;
    for (const item of items) {
      // 外部字段映射：code/name/org_code/level/sort/description/status
      const code = item.position_code || item.code || (item.id ? String(item.id) : '');
      const name = item.position_name || item.name || '';
      if (!code && !name) { skipped++; continue; }
      const orgCode = item.org_code || item.oa_org_id || item.department_code || item.dept_code || '';
      let dept = null;
      if (orgCode) {
        dept = deptByCode[orgCode] || deptByOrgCode[orgCode];
        if (!dept) {
          const org = orgsByCode[orgCode];
          if (org) {
            dept = ensureDepartment(orgCode, org.org_name);
            auto_created_dept++;
          } else {
            unmatched_dept++;
          }
        }
      }

      // 唯一性：先按 code 找（更新）；code 为空时按 name+dept 找
      let existing = null;
      if (code) existing = positionsTable.all().find(p => p.code === code);
      if (!existing && name) {
        existing = positionsTable.all().find(p => p.name === name && (dept ? p.department_id === dept.id : !p.department_id));
      }
      const mapped = {
        code: code || '',
        name: name,
        department_id: dept ? dept.id : null,
        level: item.level || item.grade || '',
        sort: Number(item.sort || item.sequence || 0),
        description: item.description || item.remark || '',
        status: item.status === 0 || item.status === '0' || item.status === 'inactive' || item.status === 'disabled' ? 'inactive' : 'active',
        updated_at: now()
      };
      if (existing) { positionsTable.update(existing.id, mapped); updated++; }
      else { mapped.created_at = now(); positionsTable.insert(mapped); created++; }
    }
    positionsTable._invalidate();
    departmentsTable._invalidate();
    let msg = `岗位同步完成：新增${created}，更新${updated}`;
    if (auto_created_dept) msg += `，自动建部门${auto_created_dept}`;
    if (unmatched_dept) msg += `，未匹配部门${unmatched_dept}`;
    if (skipped) msg += `，跳过${skipped}`;
    res.json({
      message: msg,
      created, updated, unmatched_dept, auto_created_dept, skipped, total: items.length
    });
  } catch (e) { res.status(500).json({ error: '岗位同步失败: ' + e.message }); }
});

// ==================== BOM同步（bom_details明细行 → bom_items）====================
// 说明：外部 boms.list 头的 material_code 为 null，故直接用明细行（自带 bom_no + 组件 material_code），
// 以 bom_no 作为产品分组键(product_code)，组件信息取自明细行本身。
router.post('/sync-boms', requirePerm('bom:create'), async (req, res) => {
  try {
    // 明细数据量大（外部约9.7万行），默认500页=100000行覆盖全量
    const maxPages = parseInt(req.body.max_pages) || 500;
    const details = await fetchAllPages('bom_details.list', 200, maxPages);

    const table = getTable('bom_items');
    const existing = {};
    table.all().forEach(b => {
      const k = [b.bom_no, b.material_code, b.line_no].join('||');
      if (b.bom_no && b.material_code) existing[k] = b;
    });

    let created = 0, updated = 0, skipped = 0;
    for (const d of details) {
      const bomNo = (d.bom_no || '').trim();
      const materialCode = (d.material_code || '').trim();
      if (!bomNo || !materialCode) { skipped++; continue; }
      const lineNo = (d.line_no || '').toString();
      const key = [bomNo, materialCode, lineNo].join('||');
      // 从物料代码前缀解析层级（如 "1.7.4.XXX" → "1.7.4"）
      const lvlMatch = String(d.material_code).match(/^(\d+(?:\.\d+)*)\./);
      const stdQty = Number(d.standard_qty) || 0;
      const mapped = {
        product_code: bomNo,
        product_name: '',
        bom_no: bomNo,
        line_no: lineNo,
        level: lvlMatch ? lvlMatch[1] : '1',
        material_code: materialCode,
        material_name: (d.material_name || '').trim(),
        spec: (d.material_size || '').trim(),
        unit: (d.unit_id || d.unit || '').trim(),
        quantity: stdQty,          // calcPlanCost 读取的用量字段（此前误写 qty 导致成本为 0）
        qty: stdQty,               // 兼容旧引用
        material_attr: (d.material_type || '').trim(),
        use_status: (d.use_status !== undefined ? d.use_status : ''),
        source: 'external_sync',
        updated_at: now()
      };
      const ex = existing[key];
      if (ex) { table.updateNoSave(ex.id, mapped); updated++; }
      else { mapped.created_at = now(); const nid = table.insertNoSave(mapped); existing[key] = { id: nid }; created++; }
    }
    await table.saveNow();
    table._invalidate();
    res.json({
      message: `BOM同步完成：拉取明细${details.length}条；新增${created}、更新${updated}、跳过${skipped}`,
      created, updated, skipped, details_fetched: details.length, max_pages: maxPages
    });
  } catch (e) { res.status(500).json({ error: 'BOM同步失败: ' + e.message }); }
});

// ==================== 采购订单同步（行→purchase_requests，按po_no→purchase_orders）====================
router.post('/sync-purchase-orders', requirePerm('material:create'), async (req, res) => {
  try {
    const maxPages = parseInt(req.body.max_pages) || 40;
    const lines = await fetchAllPages('purchase_orders.list', 200, maxPages);

    const reqTable = getTable('purchase_requests');
    const poTable = getTable('purchase_orders');
    const existingReq = {};
    reqTable.all().forEach(r => {
      const k = [r.po_no, r.material_code, r.external_detail_id].join('||');
      if (r.po_no) existingReq[k] = r;
    });
    const existingPO = {};
    poTable.all().forEach(p => { if (p.po_no) existingPO[p.po_no] = p; });

    const statusMap = (s) => {
      const v = String(s || '').toLowerCase();
      if (/close|finish|done|结案/.test(v)) return 'closed';
      if (/receiv|到货|收货/.test(v)) return 'received';
      if (/order|采购|下单/.test(v)) return 'ordered';
      if (/submit|sent|提交/.test(v)) return 'submitted';
      return 'draft';
    };

    const poGroups = {};
    let reqCreated = 0, reqUpdated = 0;
    for (const ln of lines) {
      const poNo = (ln.po_no || '').trim();
      if (!poNo) continue;
      const materialCode = (ln.material_code || '').trim();
      const detailId = (ln.detail_id || ln.id || '').toString();
      const key = [poNo, materialCode, detailId].join('||');
      const qty = Number(ln.po_qty) || 0;
      const price = Number(ln.po_price) || 0;
      const mapped = {
        po_no: poNo,
        material_code: materialCode,
        material_name: (ln.material_name || '').trim(),
        supplier: (ln.supplier_name || ln.supplier || '').trim(),
        category: (ln.material_type_name || '').trim(),
        unit: (ln.unit || '').trim(),
        standard_cost: price,
        qty,
        amount: Math.round(qty * price * 100) / 100,
        due_date: (ln.eta || ln.po_date || '').toString().substring(0, 10),
        status: 'in_order',
        source: 'external_sync',
        external_detail_id: detailId,
        updated_at: now()
      };
      const ex = existingReq[key];
      if (ex) { reqTable.update(ex.id, mapped); reqUpdated++; mapped.id = ex.id; }
      else { mapped.created_at = now(); const r = reqTable.insert(mapped); mapped.id = r.lastID; existingReq[key] = mapped; reqCreated++; }
      if (!poGroups[poNo]) poGroups[poNo] = { supplier: mapped.supplier, lines: [], status: statusMap(ln.po_status) };
      poGroups[poNo].lines.push(mapped);
    }

    let poCreated = 0, poUpdated = 0;
    for (const [poNo, g] of Object.entries(poGroups)) {
      const totalQty = g.lines.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      const totalAmount = g.lines.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const itemIds = g.lines.map(r => r.id).filter(Boolean);
      const fields = {
        supplier: g.supplier, total_items: g.lines.length, total_qty: totalQty,
        total_amount: Math.round(totalAmount * 100) / 100, status: g.status,
        item_ids: itemIds, updated_at: now()
      };
      const ex = existingPO[poNo];
      if (ex) { poTable.update(ex.id, fields); poUpdated++; }
      else { fields.po_no = poNo; fields.remarks = '从外部系统同步'; fields.created_at = now(); const r = poTable.insert(fields); existingPO[poNo] = { id: r.lastID }; poCreated++; }
    }
    reqTable._invalidate(); poTable._invalidate();
    res.json({
      message: `采购订单同步完成：明细行新增${reqCreated}、更新${reqUpdated}；采购单新增${poCreated}、更新${poUpdated}`,
      request_created: reqCreated, request_updated: reqUpdated,
      po_created: poCreated, po_updated: poUpdated, lines_fetched: lines.length
    });
  } catch (e) { res.status(500).json({ error: '采购订单同步失败: ' + e.message }); }
});

// ==================== 测试连接 ====================
router.post('/test-connection', requirePerm('system:config'), async (req, res) => {
  const results = {};
  const tests = ['customers.list', 'suppliers.list', 'orders.list', 'materials.list', 'products.list', 'boms.list', 'bom_details.list', 'purchase_orders.list', 'schedule_plans.list', 'organizations.list', 'employees.list'];
  for (const ep of tests) {
    try {
      const r = await fetchExternal(ep, { page: 1, page_size: 1 });
      results[ep] = { ok: true, total: r.total || 0 };
    } catch (e) {
      results[ep] = { ok: false, error: e.message };
    }
  }
  const ok = Object.values(results).some(r => r.ok);
  res.json({ message: ok ? '部分API可用' : '全部不可用', results });
});

// ==================== 一键同步 ====================
router.post('/sync-all', requirePerm('system:config'), async (req, res) => {
  const types = ['customers', 'suppliers', 'orders', 'products', 'materials', 'organizations', 'positions', 'personnel', 'boms', 'purchase-orders'];
  const results = {};
  for (const t of types) {
    try {
      const data = JSON.stringify({});
      const resp = await new Promise((resolve) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost', port: process.env.PORT || 3010,
          path: '/api/external-sync/sync-' + t, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, (res2) => {
          let d = ''; res2.on('data', c => d += c);
          res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ error: d }); } });
        });
        req.write(data); req.end();
      });
      results[t] = resp;
    } catch (e) { results[t] = { error: e.message }; }
  }
  res.json({ message: '同步完成', results });
});

// ==================== 物料变更回传 outbox ====================
// 列表（status: pending/sent/failed，keyword 匹配物料代码/载荷）
router.get('/outbox', requirePerm('material:view'), (req, res) => {
  res.json(outbox.list({
    status: req.query.status || '',
    keyword: req.query.keyword || '',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.page_size) || 100
  }));
});
// 待回传数量（前端徽标）
router.get('/outbox/stats', requirePerm('material:view'), (req, res) => {
  res.json({ pending: outbox.pendingCount() });
});
// 一键回传所有 pending
router.post('/outbox/flush', requirePerm('material:edit'), async (req, res) => {
  try { res.json(await outbox.flush()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// 重试单条
router.post('/outbox/:id/retry', requirePerm('material:edit'), async (req, res) => {
  try { res.json(await outbox.retryOne(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
// 忽略/删除单条
router.post('/outbox/:id/dismiss', requirePerm('material:edit'), (req, res) => {
  res.json({ message: outbox.dismiss(req.params.id) ? '已忽略' : '记录不存在' });
});
// 外部写入接口配置
router.get('/outbox/write-config', requirePerm('system:config'), (req, res) => {
  res.json(outbox.getWriteConfig());
});
router.post('/outbox/write-config', requirePerm('system:config'), (req, res) => {
  const { enabled, baseUrl, path, method, endpointCode } = req.body;
  const patch = {};
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (baseUrl !== undefined) patch.baseUrl = String(baseUrl).trim();
  if (path !== undefined) patch.path = String(path).trim();
  if (method !== undefined) patch.method = String(method).trim().toUpperCase() || 'PUT';
  if (endpointCode !== undefined) patch.endpointCode = String(endpointCode).trim() || 'materials.update';
  res.json({ message: '写入接口配置已保存', data: outbox.setWriteConfig(patch) });
});

// Bearer 鉴权凭证管理（用户名密码登录内部业务端点）
router.get('/bearer-auth', requirePerm('system:config'), (req, res) => {
  const c = bearerAuth.getBearerCredentials();
  // 脱敏密码
  res.json({ baseUrl: c.baseUrl, username: c.username, password: c.password ? '••••••' + String(c.password).slice(-2) : '', loginPath: c.loginPath });
});
router.post('/bearer-auth', requirePerm('system:config'), async (req, res) => {
  const { baseUrl, username, password, loginPath } = req.body;
  const patch = {};
  if (baseUrl !== undefined) patch.baseUrl = String(baseUrl).trim();
  if (username !== undefined) patch.username = String(username).trim();
  if (password !== undefined && password !== '' && !String(password).startsWith('••')) patch.password = String(password);
  if (loginPath !== undefined) patch.loginPath = String(loginPath).trim();
  const saved = bearerAuth.setBearerCredentials(patch);
  // 测一次登录验证
  try {
    await bearerAuth.getBearerToken(true);
    res.json({ message: 'Bearer 凭证已保存且登录验证通过', data: { baseUrl: saved.baseUrl, username: saved.username, loginPath: saved.loginPath } });
  } catch (e) {
    res.status(200).json({ message: 'Bearer 凭证已保存，但登录验证失败: ' + e.message, data: { baseUrl: saved.baseUrl, username: saved.username }, warning: true });
  }
});

module.exports = router;
module.exports.fetchExternal = fetchExternal;
module.exports.fetchAllPages = fetchAllPages;
module.exports.fetchInventoryAggregate = fetchInventoryAggregate;
module.exports.saveMaterialLocations = saveMaterialLocations;
