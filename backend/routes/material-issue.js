/**
 * 领料单 / 出库单（订单分析库 - 实际物料成本权威数据源）
 * ------------------------------------------------------------------
 * 每条记录 = 一次物料领用/出库，关联到具体订单（order_no）
 * 订单分析库核算"实际物料成本"时，按 order_no 汇总本表 amount
 * 设计对标「费用库 / 人工库」模式：JSON 存储 + 权限校验 + 导入 + 质检
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('material_issues');

// ===== 常量 =====
const NUM_FIELDS = ['quantity', 'unit_price', 'amount', 'order_id'];
const STR_FIELDS = [
  'issue_code', 'order_no', 'product_code', 'product_name',
  'material_code', 'material_name', 'spec', 'unit', 'issue_type',
  'issue_date', 'work_month', 'department', 'warehouse',
  'issued_by', 'received_by', 'source', 'remarks'
];
const ALLOWED_SORT = [
  'id', 'issue_code', 'order_no', 'product_code', 'material_code',
  'material_name', 'issue_type', 'issue_date', 'work_month',
  'department', 'warehouse', 'quantity', 'unit_price', 'amount', 'source', 'created_at'
];

const ISSUE_TYPES = ['生产领料', '补料', '退料', '报废', '调拨', '售后领料'];
const SOURCES = ['手工录入', 'Excel导入', '外部API'];

// ===== 工具函数 =====
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}

function deriveMonth(d) {
  if (!d) return '';
  const s = String(d).replace('/', '-').substring(0, 10);
  return s.length >= 7 ? s.substring(0, 7) : '';
}

// 金额 = 数量 × 单价；退料类取负
function computeAmount(r) {
  const qty = toNum(r.quantity);
  const price = toNum(r.unit_price);
  let amt = Math.round(qty * price * 100) / 100;
  if ((r.issue_type || '') === '退料') amt = -Math.abs(amt);
  return amt;
}

function normalizeRecord(r) {
  const rec = Object.assign({}, r);
  rec.quantity = toNum(rec.quantity);
  rec.unit_price = toNum(rec.unit_price);
  rec.order_id = rec.order_id ? Number(rec.order_id) : null;
  // 若未显式给 amount 则自动计算
  if (rec.amount === undefined || rec.amount === '' || rec._auto_amount !== false) {
    rec.amount = computeAmount(rec);
  } else {
    rec.amount = toNum(rec.amount);
  }
  rec.issue_date = rec.issue_date || '';
  rec.work_month = rec.work_month || deriveMonth(rec.issue_date);
  rec.issue_type = rec.issue_type || '生产领料';
  rec.source = rec.source || '手工录入';
  rec.unit = rec.unit || 'pcs';
  rec.remarks = rec.remarks || '';
  return rec;
}

// 编码：LL + YYYYMM + -NNNN，如 LL202607-0001
function genIssueCode(table, month) {
  const ym = (month || now().substring(0, 7)).replace('-', '');
  const prefix = 'LL' + ym;
  let maxSeq = 0;
  table.all().forEach(r => {
    const code = (r.issue_code || '').trim();
    if (code.startsWith(prefix + '-')) {
      const seq = parseInt(code.substring(prefix.length + 1), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return prefix + '-' + String(maxSeq + 1).padStart(4, '0');
}

// ===== 列表（分页/筛选/排序）=====
router.get('/', requirePerm('material-issue:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, order_no, product_code,
          material_code, issue_type, department, warehouse, source,
          work_month, issue_from, issue_to, amount_min, amount_max,
          sort_by, sort_order } = req.query;
  const table = getTable('material_issues');
  const filter = (r) => {
    if (order_no && (r.order_no || '') !== order_no) return false;
    if (product_code && (r.product_code || '') !== product_code) return false;
    if (material_code && !(r.material_code || '').includes(material_code)) return false;
    if (issue_type && r.issue_type !== issue_type) return false;
    if (department && r.department !== department) return false;
    if (warehouse && r.warehouse !== warehouse) return false;
    if (source && r.source !== source) return false;
    if (work_month && r.work_month !== work_month) return false;
    if (issue_from && (r.issue_date || '') < issue_from) return false;
    if (issue_to && (r.issue_date || '') > issue_to) return false;
    if (amount_min !== undefined && amount_min !== '' && toNum(r.amount) < toNum(amount_min)) return false;
    if (amount_max !== undefined && amount_max !== '' && toNum(r.amount) > toNum(amount_max)) return false;
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      const hay = [r.issue_code, r.order_no, r.product_name, r.material_code,
        r.material_name, r.spec, r.department, r.warehouse, r.issued_by, r.remarks].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  };
  const orderBy = ALLOWED_SORT.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && String(sort_order).toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// 筛选项 / 下拉数据
router.get('/meta/filter-options', requirePerm('material-issue:view'), (req, res) => {
  const table = getTable('material_issues');
  table._invalidate();
  const all = table.all();
  const uniq = key => [...new Set(all.map(r => r[key]).filter(v => v !== undefined && v !== null && String(v).trim() !== ''))];
  res.json({
    issue_types: uniq('issue_type'),
    departments: uniq('department'),
    warehouses: uniq('warehouse'),
    sources: uniq('source'),
    work_months: uniq('work_month').sort().reverse(),
    order_nos: uniq('order_no'),
    standard_issue_types: ISSUE_TYPES,
    standard_sources: SOURCES
  });
});

// 订单下拉（供前端选择关联订单）
router.get('/meta/orders', requirePerm('material-issue:view'), (req, res) => {
  const orders = getTable('orders');
  orders._invalidate();
  const kw = String(req.query.keyword || '').trim().toLowerCase();
  let list = orders.all().map(o => ({
    id: o.id, order_no: o.order_no, customer_name: o.customer_name,
    product_code: o.product_code, product_name: o.product_name, quantity: o.quantity
  }));
  if (kw) {
    list = list.filter(o => [o.order_no, o.customer_name, o.product_code, o.product_name].join(' ').toLowerCase().includes(kw));
  }
  res.json({ data: list.slice(0, 200), total: list.length });
});

// 物料下拉（按关键字查物料库，回填单价）
router.get('/meta/materials', requirePerm('material-issue:view'), (req, res) => {
  const mat = getTable('materials');
  mat._invalidate();
  const kw = String(req.query.keyword || '').trim().toLowerCase();
  let list = mat.all().filter(m => m.status !== 'inactive').map(m => ({
    material_code: m.material_code, material_name: m.material_name,
    unit_price: m.unit_price, unit: m.unit || 'pcs'
  }));
  if (kw) {
    list = list.filter(m => [m.material_code, m.material_name].join(' ').toLowerCase().includes(kw));
  }
  res.json({ data: list.slice(0, 50), total: list.length });
});

// ===== 仪表盘统计 =====
router.get('/dashboard/stats', requirePerm('material-issue:view'), (req, res) => {
  const table = getTable('material_issues');
  table._invalidate();
  const all = table.all();
  let totalAmount = 0, totalQty = 0;
  const byType = {}, byDept = {}, byMonth = {}, byOrder = {}, byWarehouse = {}, bySource = {};
  all.forEach(r => {
    const amt = toNum(r.amount);
    totalAmount += amt;
    totalQty += Math.abs(toNum(r.quantity));
    const inc = (obj, k) => { const kk = k || '未分类'; obj[kk] = (obj[kk] || 0) + amt; };
    inc(byType, r.issue_type);
    inc(byDept, r.department);
    inc(byMonth, r.work_month);
    inc(byOrder, r.order_no);
    bySource[r.source || '未知'] = (bySource[r.source || '未知'] || 0) + 1;
    inc(byWarehouse, r.warehouse);
  });
  const sortPairs = (obj) => Object.entries(obj).map(([k, v]) => ({ name: k, value: Math.round(v * 100) / 100 })).sort((a, b) => b.value - a.value);
  res.json({
    total: all.length,
    total_amount: Math.round(totalAmount * 100) / 100,
    total_qty: Math.round(totalQty * 100) / 100,
    by_type: sortPairs(byType),
    by_department: sortPairs(byDept),
    by_month: sortPairs(byMonth),
    by_order: sortPairs(byOrder).slice(0, 20),
    by_warehouse: sortPairs(byWarehouse),
    by_source: Object.entries(bySource).map(([k, v]) => ({ name: k, value: v }))
  });
});

// 按订单归集（订单分析库实际物料成本核算调用）
router.get('/by-order/:orderNo', requirePerm('material-issue:view'), (req, res) => {
  const table = getTable('material_issues');
  table._invalidate();
  const orderNo = req.params.orderNo;
  const items = table.all().filter(r => r.order_no === orderNo);
  let total = 0;
  const byMaterial = {};
  items.forEach(r => {
    const amt = toNum(r.amount);
    total += amt;
    const key = r.material_code || r.material_name || '未编码';
    if (!byMaterial[key]) byMaterial[key] = { material_code: r.material_code, material_name: r.material_name, unit: r.unit, qty: 0, amount: 0 };
    byMaterial[key].qty += toNum(r.quantity);
    byMaterial[key].amount = Math.round((byMaterial[key].amount + amt) * 100) / 100;
  });
  res.json({
    order_no: orderNo,
    count: items.length,
    total_amount: Math.round(total * 100) / 100,
    items,
    by_material: Object.values(byMaterial).map(m => { m.qty = Math.round(m.qty * 100) / 100; return m; })
  });
});

// ===== 数据质检 =====
const SEV_ORDER = { severe: 0, warning: 1, info: 2 };
router.get('/quality-check', requirePerm('material-issue:view'), (req, res) => {
  const table = getTable('material_issues');
  table._invalidate();
  const all = table.all();
  const codeCount = {};
  all.forEach(r => { if (r.issue_code) codeCount[r.issue_code] = (codeCount[r.issue_code] || 0) + 1; });
  const issues = [];
  all.forEach(r => {
    const push = (type, severity, message) => issues.push({ id: r.id, issue_code: r.issue_code || '', order_no: r.order_no || '', type, severity, message });
    if (!r.order_no) push('no_order', 'severe', '未关联订单号（无法归集到订单实际成本）');
    if (!r.material_code && !r.material_name) push('empty_material', 'severe', '物料编码与名称均为空');
    if (toNum(r.quantity) === 0) push('zero_qty', 'warning', '领料数量为0');
    if (toNum(r.unit_price) === 0) push('zero_price', 'warning', '单价为0');
    if (!r.issue_date) push('no_date', 'warning', '领料日期为空');
    if (r.issue_code && codeCount[r.issue_code] > 1) push('dup_code', 'severe', `领料单号重复(共${codeCount[r.issue_code]}条)`);
    if (!r.work_month) push('no_month', 'info', '未归属月份');
  });
  const bySeverity = { severe: 0, warning: 0, info: 0 };
  const affectedIds = new Set();
  issues.forEach(i => { bySeverity[i.severity]++; affectedIds.add(i.id); });
  res.json({
    total: all.length,
    affected: affectedIds.size,
    issue_count: issues.length,
    by_severity: bySeverity,
    pass_rate: all.length ? Math.round((1 - affectedIds.size / all.length) * 1000) / 10 : 100,
    issues: issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
  });
});

// ===== 导出 CSV =====
router.get('/export/csv', requirePerm('material-issue:view'), (req, res) => {
  const table = getTable('material_issues');
  table._invalidate();
  const { order_no, issue_type, department, work_month, issue_from, issue_to } = req.query;
  const rows = table.all().filter(r => {
    if (order_no && r.order_no !== order_no) return false;
    if (issue_type && r.issue_type !== issue_type) return false;
    if (department && r.department !== department) return false;
    if (work_month && r.work_month !== work_month) return false;
    if (issue_from && (r.issue_date || '') < issue_from) return false;
    if (issue_to && (r.issue_date || '') > issue_to) return false;
    return true;
  }).sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || ''));
  const headers = ['领料单号', '订单号', '产品编码', '产品名称', '物料编码', '物料名称', '规格', '单位',
    '领料类型', '数量', '单价', '金额', '领料日期', '归属月份', '部门', '仓库', '发料人', '收料人', '来源', '备注'];
  const data = rows.map(r => [
    r.issue_code, r.order_no, r.product_code, r.product_name, r.material_code, r.material_name, r.spec, r.unit,
    r.issue_type, toNum(r.quantity), toNum(r.unit_price), toNum(r.amount), r.issue_date, r.work_month,
    r.department, r.warehouse, r.issued_by, r.received_by, r.source, r.remarks
  ].map(v => String(v == null ? '' : v).replace(/,/g, '，')));
  let csv = headers.join(',') + '\n';
  data.forEach(r => csv += r.join(',') + '\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=material_issues.csv');
  res.send('\uFEFF' + csv);
});

// ===== 单条详情 =====
router.get('/:id', requirePerm('material-issue:view'), (req, res) => {
  const table = getTable('material_issues');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '领料单不存在' });
  res.json(row);
});

// ===== CRUD =====
router.post('/', requirePerm('material-issue:create'), async (req, res) => {
  const body = req.body || {};
  if (!body.order_no && !body.material_name) return res.status(400).json({ error: '订单号或物料名称必填' });
  const rec = normalizeRecord(body);
  const table = getTable('material_issues');
  if (rec.issue_code) {
    const dup = table.all().find(r => r.issue_code === rec.issue_code);
    if (dup) return res.status(400).json({ error: '领料单号已存在', data: dup });
  } else {
    rec.issue_code = genIssueCode(table, rec.work_month);
  }
  const ts = now();
  const result = await table.insert(Object.assign({}, rec, { created_at: ts, updated_at: ts }));
  res.json({ message: '领料单创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('material-issue:edit'), async (req, res) => {
  const table = getTable('material_issues');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '领料单不存在' });
  const rec = normalizeRecord(Object.assign({}, existing, req.body));
  if (rec.issue_code && rec.issue_code !== existing.issue_code) {
    const dup = table.all().find(r => r.issue_code === rec.issue_code && r.id !== existing.id);
    if (dup) return res.status(400).json({ error: '领料单号已存在' });
  }
  const fields = { updated_at: now() };
  STR_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = rec[f]; });
  NUM_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = rec[f]; });
  if (NUM_FIELDS.some(f => f !== 'amount' && req.body[f] !== undefined) || req.body.issue_type !== undefined) {
    fields.amount = computeAmount(rec);
  }
  if (req.body.issue_date !== undefined && req.body.work_month === undefined) {
    fields.work_month = deriveMonth(rec.issue_date);
  }
  await table.update(req.params.id, fields);
  res.json({ message: '领料单更新成功', data: table.findById(req.params.id) });
});

router.post('/batch-update', requirePerm('material-issue:edit'), async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items必须为数组' });
  const table = getTable('material_issues');
  const ts = now();
  let updated = 0, skipped = 0;
  for (const item of items) {
    const ex = table.findById(item.id);
    if (!ex) { skipped++; continue; }
    const rec = normalizeRecord(Object.assign({}, ex, item));
    const fields = { updated_at: ts };
    STR_FIELDS.forEach(f => { if (item[f] !== undefined) fields[f] = rec[f]; });
    NUM_FIELDS.forEach(f => { if (item[f] !== undefined) fields[f] = rec[f]; });
    if (NUM_FIELDS.some(f => f !== 'amount' && item[f] !== undefined) || item.issue_type !== undefined) {
      fields.amount = computeAmount(rec);
    }
    if (item.issue_date !== undefined && item.work_month === undefined) {
      fields.work_month = deriveMonth(rec.issue_date);
    }
    await table.update(item.id, fields);
    updated++;
  }
  res.json({ message: '批量更新成功', updated, skipped });
});

router.post('/batch-delete', requirePerm('material-issue:delete'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids必须为非空数组' });
  const table = getTable('material_issues');
  let deleted = 0; const notFound = [];
  for (const id of ids) {
    if (!table.findById(id)) { notFound.push(id); continue; }
    await table.delete(id); deleted++;
  }
  res.json({ message: '批量删除完成', deleted, not_found: notFound });
});

router.delete('/:id', requirePerm('material-issue:delete'), async (req, res) => {
  const table = getTable('material_issues');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '领料单不存在' });
  await table.delete(req.params.id);
  res.json({ message: '领料单删除成功' });
});

// ===== 外部 API 对接（与人工库/费用库相同模式）=====
function loadExternalConfig() {
  try {
    const file = path.join(__dirname, '..', '..', 'database', 'material_external_config.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return { enabled: false, base_url: '', app_key: '', app_secret: '', endpoint_code: 'material_issues.list' };
}

router.get('/external/config', requirePerm('material-issue:view'), (req, res) => res.json(loadExternalConfig()));

router.put('/external/config', requirePerm('material-issue:edit'), (req, res) => {
  const cur = loadExternalConfig();
  const next = Object.assign({}, cur, req.body || {});
  try {
    const file = path.join(__dirname, '..', '..', 'database', 'material_external_config.json');
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    res.json({ message: '外部对接配置已保存', data: next });
  } catch (e) { res.status(500).json({ error: '保存失败: ' + e.message }); }
});

router.post('/sync-from-external', requirePerm('material-issue:create'), async (req, res) => {
  const cfg = loadExternalConfig();
  if (!cfg.enabled || !cfg.base_url) {
    return res.status(400).json({ error: '外部对接未启用，请先在「外部对接」配置 base_url 并启用' });
  }
  let remote;
  try { remote = await callExternalMaterialIssue(cfg); }
  catch (e) { return res.status(502).json({ error: '外部API调用失败: ' + e.message }); }
  const list = Array.isArray(remote) ? remote : (remote.records || remote.data || remote.list || []);
  const table = getTable('material_issues');
  table._invalidate();
  const ts = now();
  let added = 0, updated = 0, skipped = 0;
  for (const item of list) {
    const rec = normalizeRecord({
      issue_code: item.issue_code || item.code || '',
      order_no: item.order_no || '',
      product_code: item.product_code || '',
      product_name: item.product_name || '',
      material_code: item.material_code || '',
      material_name: item.material_name || '',
      spec: item.spec || item.specification || '',
      unit: item.unit || item.uom || 'pcs',
      issue_type: item.issue_type || item.type || '生产领料',
      quantity: item.qty || item.quantity || 0,
      unit_price: item.unit_price || item.price || 0,
      amount: item.amount || 0,
      issue_date: item.issue_date || item.date || '',
      department: item.department || '',
      warehouse: item.warehouse || '',
      issued_by: item.issued_by || item.operator || '',
      received_by: item.received_by || item.receiver || '',
      source: '外部API',
      remarks: item.remarks || '',
    });
    if (!rec.issue_code && !rec.material_code) { skipped++; continue; }
    const code = rec.issue_code;
    const exist = code ? table.all().find(r => r.issue_code === code) : null;
    if (exist) {
      await table.update(exist.id, Object.assign({}, rec, { updated_at: ts }));
      updated++;
    } else {
      await table.insert(Object.assign({}, rec, { created_at: ts, updated_at: ts }));
      added++;
    }
  }
  res.json({ message: '外部API同步完成', added, updated, skipped, total: list.length });
});

function callExternalMaterialIssue(cfg) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const https = require('https');
    const http = require('http');
    const url = new URL(cfg.base_url);
    const isHttps = url.protocol === 'https:';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = timestamp + (cfg.app_key || '') + (cfg.endpoint_code || 'material_issues.list');
    const signature = cfg.app_secret ? crypto.createHmac('sha256', cfg.app_secret).update(stringToSign, 'utf8').digest('hex') : '';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: Object.assign({ 'X-Timestamp': timestamp }, cfg.app_key ? { 'X-App-Key': cfg.app_key } : {}, signature ? { 'X-Signature': signature } : {}),
      timeout: 30000
    };
    const lib = isHttps ? https : http;
    const r = lib.request(options, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try { const j = JSON.parse(body); resolve(j.data || j.records || j.list || j); }
        catch (e) { reject(new Error('解析响应失败: ' + body.substring(0, 200))); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时')); });
    r.end();
  });
}

module.exports = router;
