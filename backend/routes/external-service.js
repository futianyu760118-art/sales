/**
 * 外部 API 服务（供其他系统调用 · 如金蝶/WMS/MES 对接 EBMS 数据）
 * --------------------------------------------------
 * 所有接口前缀 /api/external，请求头需携带 X-API-Key
 * 提供：连通性自检 / 模块清单 / 表清单 / 表数据推送（OUT）/ 回传接收（BACK）/ 同步清单
 *
 * 与阿米巴模块的关联：
 *   - 暴露阿米巴全部业务表（amiba_org / amiba_cost_target / amiba_trade_price /
 *     amiba_trade_detail / amiba_account_detail / amiba_cost_improve / amiba_pioneer /
 *     amiba_dispute / amiba_train / amiba_month_report）供外部拉取
 *   - 接收外部回传（BACK）并加锁，防止后续推送覆盖
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getTable, now } = require('../db');
const { EXTERNAL_API_KEY: API_KEY } = require('../lib/secrets');

// ===== API Key 校验中间件（密钥来自环境变量 EBMS_EXTERNAL_API_KEY，不再硬编码） =====
function apiKeyAuth(req, res, next) {
  if (!API_KEY) {
    // 服务端未配置密钥：拒绝所有入站外部请求（fail-closed），避免误开接口
    return res.status(503).json({ code: 503, message: '服务端未配置 EBMS_EXTERNAL_API_KEY 环境变量，外部接口已停用' });
  }
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ code: 401, message: '缺少 X-API-Key 请求头' });
  const a = Buffer.from(String(key));
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ code: 401, message: 'X-API-Key 无效' });
  }
  next();
}
router.use(apiKeyAuth);

// ===== 同步登记表 =====
getTable('external_registry'); // ensure table exists
function regTable() { return getTable('external_registry'); }

// ===== 暴露的表清单：模块、表名、显示名、业务键字段、描述 =====
const EXPOSED_TABLES = [
  // ---- 销售管理 ----
  { module: '销售管理', table: 'inquiries', name: '询价单', key: 'serial_number', desc: '客户询价单据' },
  { module: '销售管理', table: 'orders', name: '订单', key: 'order_no', desc: '客户订单' },
  { module: '销售管理', table: 'customers', name: '客户', key: 'name', desc: '客户档案' },
  { module: '销售管理', table: 'samples', name: '样品单', key: 'sample_no', desc: '样品申请单' },
  { module: '销售管理', table: 'feedback', name: '问题反馈', key: 'title', desc: '问题反馈单' },
  // ---- 采购/供应链 ----
  { module: '供应链中心', table: 'materials', name: '物料库', key: 'material_code', desc: '物料主数据' },
  { module: '供应链中心', table: 'suppliers', name: '供应商', key: 'supplier_code', desc: '供应商档案' },
  { module: '供应链中心', table: 'purchase_orders', name: '采购单', key: 'order_no', desc: '采购订单' },
  // ---- 产品/研发 ----
  { module: '研发中心', table: 'products', name: '产品', key: 'external_model', desc: '产品主数据' },
  { module: '研发中心', table: 'projects', name: '研发项目', key: 'project_no', desc: '研发项目档案' },
  { module: '研发中心', table: 'bom_pricing', name: 'BOM核价', key: 'model', desc: 'BOM核价记录' },
  // ---- 阿米巴经营（降本攻坚） ----
  { module: '阿米巴经营', table: 'amiba_org', name: '巴组织架构', key: 'amiba_name', desc: '阿米巴单元树' },
  { module: '阿米巴经营', table: 'amiba_cost_target_company', name: '公司降本总目标', key: 'year', desc: '按年度的公司目标' },
  { module: '阿米巴经营', table: 'amiba_cost_target', name: '巴降本目标', key: 'amiba_name', desc: '巴级年度/月度目标' },
  { module: '阿米巴经营', table: 'amiba_trade_price', name: '内部交易定价', key: 'product_name', desc: '内部交易价格表' },
  { module: '阿米巴经营', table: 'amiba_trade_detail', name: '内部交易明细', key: 'trade_no', desc: '内部交易核算明细' },
  { module: '阿米巴经营', table: 'amiba_account_detail', name: '经营核算明细', key: 'amiba_name', desc: '月度经营核算结果' },
  { module: '阿米巴经营', table: 'amiba_cost_improve', name: '降本改善项目', key: 'project_name', desc: '改善立项与结项' },
  { module: '阿米巴经营', table: 'amiba_pioneer', name: '先锋试点巴', key: 'amiba_name', desc: '先锋巴专项管理' },
  { module: '阿米巴经营', table: 'amiba_dispute', name: '争议仲裁', key: 'dispute_desc', desc: '内部争议仲裁' },
  { module: '阿米巴经营', table: 'amiba_train', name: '培训记录', key: 'train_name', desc: '阿米巴培训' },
  { module: '阿米巴经营', table: 'amiba_month_report', name: '月度月报', key: 'month', desc: '月度经营月报' },
  // ---- 阿米巴应收/应付（对接财务/金蝶） ----
  { module: '阿米巴经营', table: 'amiba_ar', name: '应收(AR)', key: 'document_no', desc: '应收单据·按巴归集·按应收确认收入' },
  { module: '阿米巴经营', table: 'amiba_ap', name: '应付(AP)', key: 'document_no', desc: '应付单据·按巴归集·按应付确认成本' },
  // ---- 组织架构 ----
  { module: '组织架构', table: 'org_departments', name: '部门', key: 'name', desc: '组织部门树' },
  { module: '组织架构', table: 'org_personnel', name: '人员', key: 'name', desc: '组织人员档案' },
  { module: '组织架构', table: 'org_positions', name: '岗位', key: 'name', desc: '组织岗位' },
  // ---- 系统 ----
  { module: '系统', table: 'users', name: '用户', key: 'username', desc: '系统用户' },
  { module: '系统', table: 'roles', name: '角色', key: 'code', desc: '系统角色' },
];

function findTableMeta(name) {
  return EXPOSED_TABLES.find(t => t.table === name);
}

// ===== 工具：从 records 中按业务键查找 =====
function findByKey(records, keyField, keyValue) {
  if (keyValue === undefined || keyValue === null) return null;
  const k = String(keyValue);
  return records.find(r => String(r[keyField] || '') === k) || null;
}

// ===== 登记一条同步记录 =====
async function logRegistry({ direction, source_table, source_key, status, payload, summary, remark, caller }) {
  try {
    const t = regTable();
    t._invalidate();
    const r = await t.insert({
      direction, source_table, source_key,
      status: status || 'success',
      request_payload: payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : '',
      response_summary: s(summary || ''),
      locked: 0,
      remark: s(remark || ''),
      caller: s(caller || 'external'),
      created_at: now(), updated_at: now()
    });
    return r.lastID;
  } catch (e) { return null; }
}
function s(v, def) { if (v === undefined || v === null) return def || ''; return String(v); }

// ===== 检查是否被回传锁定（BACK 锁定后 OUT 不再覆盖） =====
function isLocked(table, key) {
  try {
    const t = regTable();
    t._invalidate();
    return t.all().some(r =>
      r.direction === 'BACK' && r.locked && r.source_table === table &&
      String(r.source_key) === String(key));
  } catch (e) { return false; }
}

// ============================================================
// 1. 连通性自检
// ============================================================
router.get('/status', (req, res) => {
  res.json({
    code: 0,
    message: 'OK',
    service: 'EBMS External API',
    version: '1.0.0',
    server_time: now(),
    amiba_module: true
  });
});

// ============================================================
// 2. 业务模块清单
// ============================================================
router.get('/modules', (req, res) => {
  const moduleMap = {};
  EXPOSED_TABLES.forEach(t => {
    if (!moduleMap[t.module]) moduleMap[t.module] = { module: t.module, table_count: 0, tables: [] };
    moduleMap[t.module].table_count++;
    moduleMap[t.module].tables.push({ table: t.table, name: t.name, desc: t.desc });
  });
  res.json({ code: 0, data: Object.values(moduleMap) });
});

// ============================================================
// 3. 表清单
// ============================================================
router.get('/tables', (req, res) => {
  const module = s(req.query.module).trim();
  const search = s(req.query.search).trim().toLowerCase();
  let list = EXPOSED_TABLES;
  if (module) list = list.filter(t => t.module === module);
  if (search) list = list.filter(t =>
    [t.table, t.name, t.desc, t.module].join(' ').toLowerCase().includes(search));
  res.json({ code: 0, total: list.length, data: list });
});

// ============================================================
// 4. 取表数据（OUT 方向，自动登记）
// ============================================================
router.get('/data/:table', async (req, res) => {
  const meta = findTableMeta(req.params.table);
  if (!meta) return res.status(404).json({ code: 404, message: `表 ${req.params.table} 不在暴露清单中` });
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let records = [];
  try { records = getTable(meta.table).all(); } catch (e) {
    return res.status(500).json({ code: 500, message: `读取表 ${meta.table} 失败: ${e.message}` });
  }
  const total = records.length;
  // 过滤已锁定（BACK 锁定的记录不推送，外部不应覆盖）
  const lockedKeys = new Set();
  try {
    const t = regTable(); t._invalidate();
    t.all().filter(r => r.direction === 'BACK' && r.locked && r.source_table === meta.table)
      .forEach(r => lockedKeys.add(String(r.source_key)));
  } catch (e) {}
  let filtered = records;
  if (lockedKeys.size) filtered = records.filter(r => !lockedKeys.has(String(r[meta.key])));
  const page = filtered.slice(offset, offset + limit);
  // 登记 OUT
  await logRegistry({
    direction: 'OUT', source_table: meta.table, source_key: `LIST:${offset}-${offset + page.length}`,
    status: 'success', summary: `推送 ${page.length} 条（总 ${filtered.length}，跳过锁定 ${records.length - filtered.length}）`,
    caller: 'external:API_KEY', remark: req.query.remark || `limit=${limit}`
  });
  res.json({
    code: 0,
    table: meta.table, key_field: meta.key,
    total: filtered.length, locked_skipped: records.length - filtered.length,
    offset, limit, count: page.length,
    data: page
  });
});

// 按业务键取单条
router.get('/data/:table/:key', async (req, res) => {
  const meta = findTableMeta(req.params.table);
  if (!meta) return res.status(404).json({ code: 404, message: `表 ${req.params.table} 不在暴露清单中` });
  let records = [];
  try { records = getTable(meta.table).all(); } catch (e) {
    return res.status(500).json({ code: 500, message: `读取表 ${meta.table} 失败: ${e.message}` });
  }
  const row = findByKey(records, meta.key, req.params.key);
  if (!row) return res.status(404).json({ code: 404, message: `${meta.table} 中不存在 ${meta.key}=${req.params.key}` });
  if (isLocked(meta.table, String(row[meta.key]))) {
    return res.status(423).json({ code: 423, message: '该记录已被外部回传锁定，不再推送', locked: true, data: row });
  }
  await logRegistry({
    direction: 'OUT', source_table: meta.table, source_key: String(row[meta.key]),
    status: 'success', summary: '单条推送', caller: 'external:API_KEY'
  });
  res.json({ code: 0, table: meta.table, key_field: meta.key, data: row });
});

// ============================================================
// 5. 回传信息（BACK 方向 · 自动加锁 · 外部不再覆盖）
// ============================================================
router.post('/receive', async (req, res) => {
  try {
    const source_table = s(req.body.source_table);
    const source_key = s(req.body.source_key);
    const data = req.body.data || {};
    const remark = s(req.body.remark, '外部系统回传');
    if (!source_table || !source_key) return res.status(400).json({ code: 400, message: 'source_table 与 source_key 必填' });
    const meta = findTableMeta(source_table);
    if (!meta) return res.status(400).json({ code: 400, message: `表 ${source_table} 不在暴露清单中` });

    // 查找本地记录：若存在则更新；若不存在则新建（确保业务键 source_key 写入）
    let localRow = null;
    let action = 'no_change';
    try { localRow = findByKey(getTable(meta.table).all(), meta.key, source_key); } catch (e) {}
    let updatedFields = null;
    if (localRow) {
      const updated = Object.assign({}, localRow, data, {
        _back_locked: true, _back_at: now(), _back_remark: remark, updated_at: now()
      });
      try {
        await getTable(meta.table).update(localRow.id, updated);
        updatedFields = Object.keys(data);
        action = 'updated';
      } catch (e) {
        action = 'update_failed: ' + e.message;
      }
    } else {
      // 新建记录：业务键置入，来源/状态默认
      const newRecord = Object.assign({}, data, {
        [meta.key]: source_key,
        _back_locked: true, _back_at: now(), _back_remark: remark,
        source: data.source || 'external_api',
        created_at: now(), updated_at: now()
      });
      // 对必填的常用字段给默认值
      if (meta.table === 'amiba_ar' && !newRecord.status) newRecord.status = 'open';
      if (meta.table === 'amiba_ap' && !newRecord.status) newRecord.status = 'open';
      if (meta.table === 'amiba_ar' && !newRecord.paid_amount) newRecord.paid_amount = 0;
      if (meta.table === 'amiba_ap' && !newRecord.paid_amount) newRecord.paid_amount = 0;
      try {
        const result = await getTable(meta.table).insert(newRecord);
        localRow = Object.assign({ id: result.lastID }, newRecord);
        updatedFields = Object.keys(data);
        action = 'created';
      } catch (e) {
        action = 'create_failed: ' + e.message;
      }
    }
    // 登记 BACK + 加锁
    const t = regTable();
    t._invalidate();
    const regId = await t.insert({
      direction: 'BACK', source_table, source_key,
      status: action.startsWith('create_failed') || action.startsWith('update_failed') ? 'failed' : 'success',
      request_payload: JSON.stringify({ data, remark }),
      response_summary: action,
      locked: 1,
      remark, caller: 'external:API_KEY',
      created_at: now(), updated_at: now()
    });
    res.json({
      code: 0,
      message: '回传成功，已加锁',
      registry_id: regId,
      source_table, source_key,
      locked: true,
      action,
      local_id: localRow ? localRow.id : null,
      updated_fields: updatedFields
    });
  } catch (e) {
    await logRegistry({ direction: 'BACK', source_table: s(req.body.source_table), source_key: s(req.body.source_key), status: 'failed', payload: req.body, summary: e.message, remark: '回传失败' });
    res.status(500).json({ code: 500, message: '回传失败: ' + e.message });
  }
});

// ============================================================
// 6. 同步/回传清单
// ============================================================
router.get('/registry', (req, res) => {
  const status = s(req.query.status);
  const direction = s(req.query.direction);
  const table = s(req.query.table);
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 200));
  let list = [];
  try { list = regTable().all(); } catch (e) { list = []; }
  list = list.filter(r =>
    (!status || r.status === status) &&
    (!direction || r.direction === direction) &&
    (!table || r.source_table === table));
  list = list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, limit);
  const summary = {
    total: list.length,
    out: list.filter(r => r.direction === 'OUT').length,
    back: list.filter(r => r.direction === 'BACK').length,
    locked: list.filter(r => r.locked).length
  };
  res.json({ code: 0, summary, data: list });
});

// ============================================================
// 7. 已锁定（已回传）记录
// ============================================================
router.get('/locked', (req, res) => {
  let list = [];
  try { list = regTable().all(); } catch (e) { list = []; }
  list = list.filter(r => r.locked && r.direction === 'BACK');
  // 去重：同一 (source_table, source_key) 取最新一条
  const map = {};
  list.forEach(r => {
    const k = r.source_table + '::' + r.source_key;
    if (!map[k] || (r.created_at || '') > (map[k].created_at || '')) map[k] = r;
  });
  const dedup = Object.values(map).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ code: 0, total: dedup.length, data: dedup });
});

module.exports = router;