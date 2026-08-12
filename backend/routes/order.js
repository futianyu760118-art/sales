const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { resolveDataScope, isInScope } = require('../data-scope');
const { resolveDataScopeV2, buildScopeFilter, combineFilter, logDataPermission } = require('../data-scope-v2');

// 状态变更锁定：人工改单后设置 user_status_locked=1，外部 API 同步不会覆盖这些状态
const STATUS_VALID = ['open','confirmed','procurement_ready','material_ready','packaging_done','shipped','completed','closed','cancelled'];
const STATUS_LOCK_FIELDS = (status, operator) => ({
  status,
  updated_at: now(),
  user_status_locked: 1,
  user_status_modified_at: now(),
  user_status_modified_by: operator || null
});

router.get('/', requirePerm('order:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, status, customer, product, sort_by, sort_order } = req.query;
  const table = getTable('orders');
  const scope = resolveDataScopeV2(req);
  const scopeLegacy = resolveDataScope(req);
  const scopeFilter = buildScopeFilter(scope, 'orders');

  // 客户名 -> 该客户的所有“可见”销售员集合（v1 兼容）
  let allowedCustomersBySp = null;
  if (scopeLegacy.enabled) {
    const inqTable = getTable('inquiries');
    allowedCustomersBySp = new Set();
    inqTable.all().forEach(iq => {
      const cn = String(iq.customer_name || '').trim();
      const sp = String(iq.sales_person || '').trim();
      if (cn && sp && scopeLegacy.ownerNames.has(sp)) allowedCustomersBySp.add(cn);
    });
  }

  const filter = combineFilter((r) => {
    if (status && r.status !== status) return false;
    if (customer && !(r.customer_name || '').includes(customer)) return false;
    if (product && !((r.product_code||'')+(r.product_name||'')).toLowerCase().includes(product.toLowerCase())) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.order_no, r.customer_name, r.product_name, r.product_code].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  }, (r) => {
    if (scope.enabled) {
      if (scopeFilter(r)) return true;
      const cn = String(r.customer_name || '').trim();
      if (cn && allowedCustomersBySp && allowedCustomersBySp.has(cn)) return true;
      return false;
    }
    if (scopeLegacy.enabled) {
      const cn = String(r.customer_name || '').trim();
      if (!cn || !allowedCustomersBySp || !allowedCustomersBySp.has(cn)) return false;
    }
    return true;
  });
  const orderBy = ['order_no','customer_name','product_name','quantity','order_amount','status','promised_date'].includes(sort_by) ? sort_by : 'order_no';
  const orderDir = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  logDataPermission(req, 'order.list', { table: 'orders', count: total, scope_mode: scope.mode || 'none' });
  res.json({
    data: records,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    scope: scope.enabled
      ? { mode: scope.mode, label: labelScopeOrder(scope.mode) }
      : { mode: 'none', label: '全部数据' }
  });
});

function labelScopeOrder(mode) {
  return {
    all: '全部数据',
    self: '我的订单',
    dept: '本部门订单',
    dept_and_child: '本部门及下级部门订单',
    custom: '自定义范围订单',
    none: '全部数据'
  }[mode] || '全部数据';
}

router.get('/stats', requirePerm('order:view'), (req, res) => {
  const table = getTable('orders');
  const all = table.all();
  const byStatus = {}; const totalAmount = all.reduce((s, o) => s + (Number(o.order_amount) || 0), 0);
  all.forEach(o => { byStatus[o.status||'open'] = (byStatus[o.status||'open']||0) + 1; });
  res.json({ total: all.length, by_status: byStatus, total_amount: totalAmount });
});

router.get('/:id', requirePerm('order:view'), (req, res) => {
  const row = getTable('orders').findById(req.params.id);
  if (!row) return res.status(404).json({ error: '订单不存在' });
  const scope = resolveDataScopeV2(req);
  let ok = true;
  if (scope.enabled) {
    ok = buildScopeFilter(scope, 'orders')(row);
    if (!ok) {
      const cn = String(row.customer_name || '').trim();
      if (cn) {
        const inqTable = getTable('inquiries');
        ok = inqTable.all().some(iq =>
          String(iq.customer_name || '').trim() === cn &&
          scope.ownerNames.includes(
            Number(iq.sales_id || 0)
          )
        );
        if (!ok) {
          const scopeLegacy = resolveDataScope(req);
          if (scopeLegacy.enabled) {
            ok = inqTable.all().some(iq =>
              String(iq.customer_name || '').trim() === cn &&
              scopeLegacy.ownerNames.has(String(iq.sales_person || '').trim())
            );
          }
        }
      }
    }
  }
  if (!ok) return res.status(403).json({ error: '无访问该订单的权限', code: 'DATA_SCOPE_DENIED' });
  const bomTable = getTable('bom_items');
  row.bom_items = bomTable.all().filter(b => b.product_code === row.product_code);
  logDataPermission(req, 'order.detail', { table: 'orders', record_id: row.id, scope_mode: scope.mode || 'none' });
  res.json(row);
});

router.post('/', requirePerm('order:create'), (req, res) => {
  const table = getTable('orders');
  const b = req.body;
  if (!b.order_no && !b.customer_name) return res.status(400).json({ error: '订单号或客户必填' });
  // 数据权限字段
  const operatorId = Number(req.body.user_id || req.headers['x-user-id'] || req.headers['x-user']) || null;
  let salesId = b.sales_id ? Number(b.sales_id) : null;
  let deptId = b.department_id ? Number(b.department_id) : null;
  if (!salesId && operatorId) salesId = operatorId;
  if (salesId && !deptId) {
    const personnel = getTable('org_personnel').all().find(p => Number(p.linked_user_id) === Number(salesId));
    if (personnel && personnel.department_id) deptId = Number(personnel.department_id);
  }
  const result = table.insert({
    order_no: b.order_no || '', line_no: b.line_no || '', customer_name: b.customer_name || '',
    customer_code: b.customer_code || '', product_code: b.product_code || '',
    product_name: b.product_name || '', project_no: b.project_no || '',
    quantity: Number(b.quantity) || 0,
    completed_qty: Number(b.completed_qty) || 0,
    order_amount: Number(b.order_amount) || 0, status: b.status || 'open',
    risk_level: b.risk_level || 'blue', promised_date: b.promised_date || '',
    plan_date: b.plan_date || '', online_date: b.online_date || '',
    remarks: b.remarks || '',
    sales_id: salesId,
    department_id: deptId,
    create_by: operatorId,
    created_at: now(), updated_at: now()
  });
  logDataPermission(req, 'order.create', { table: 'orders', record_id: result.lastID, scope_mode: 'self' });
  res.json({ message: '创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('order:edit'), (req, res) => {
  const table = getTable('orders');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '订单不存在' });
  const fields = { updated_at: now() };
  ['order_no','line_no','customer_name','customer_code','product_code','product_name','project_no','status','risk_level','promised_date','plan_date','online_date','remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['quantity','completed_qty','order_amount'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = Number(req.body[f]) || 0;
  });
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

router.put('/:id/status', requirePerm('order:edit'), (req, res) => {
  const table = getTable('orders');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  if (!STATUS_VALID.includes(req.body.status)) return res.status(400).json({ error: '无效状态' });
  const operator = req.body.user_id || req.headers['x-user-id'] || null;
  table.update(req.params.id, STATUS_LOCK_FIELDS(req.body.status, operator));
  res.json({ message: '状态更新', locked: true });
});

router.delete('/:id', requirePerm('order:delete'), (req, res) => {
  const table = getTable('orders');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

router.post('/batch-delete', requirePerm('order:delete'), (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '请提供要删除的ID列表' });
  const table = getTable('orders');
  let ok = 0, fail = 0;
  ids.forEach(id => {
    if (table.findById(id)) { table.delete(id); ok++; }
    else { fail++; }
  });
  res.json({ message: `批量删除完成：成功 ${ok} 条，失败 ${fail} 条`, ok, fail });
});

// ===== 按 order_no + line_no 定位本地记录（用于外部 API 列表驱动本地操作） =====
// 注：销售中心订单管理页面读外部 API，但业务按钮仍作用于本地库。
// 通过 order_no + line_no 唯一定位本地记录。
function findByKey(orderNo, lineNo) {
  const table = getTable('orders');
  const o = String(orderNo || '').trim();
  const l = String(lineNo || '').trim();
  if (!o) return null;
  return table.all().find(r => String(r.order_no || '').trim() === o && String(r.line_no || '').trim() === l) || null;
}

router.get('/by-key/:order_no/:line_no', requirePerm('order:view'), (req, res) => {
  const o = findByKey(req.params.order_no, req.params.line_no);
  if (!o) return res.status(404).json({ error: '本地未同步该订单', order_no: req.params.order_no, line_no: req.params.line_no });
  res.json(o);
});

router.put('/by-key/:order_no/:line_no/status', requirePerm('order:edit'), (req, res) => {
  const o = findByKey(req.params.order_no, req.params.line_no);
  if (!o) return res.status(404).json({ error: '本地未同步该订单，请先点同步订单' });
  if (!STATUS_VALID.includes(req.body.status)) return res.status(400).json({ error: '无效状态' });
  const operator = req.body.user_id || req.headers['x-user-id'] || null;
  const table = getTable('orders');
  table.update(o.id, STATUS_LOCK_FIELDS(req.body.status, operator));
  res.json({ message: '状态更新', id: o.id, status: req.body.status, locked: true });
});

// 批量状态变更：body = { items: [{order_no, line_no}, ...], status, user_id }
// 命中即标记 user_status_locked=1，未命中的写入 missing
router.post('/by-key/batch-status', requirePerm('order:edit'), (req, res) => {
  const { items, status } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '请提供 items 数组（每项含 order_no, line_no）' });
  if (!STATUS_VALID.includes(status)) return res.status(400).json({ error: '无效状态' });
  const table = getTable('orders');
  const operator = req.body.user_id || req.headers['x-user-id'] || null;
  let ok = 0, fail = 0, missing = [], noChange = [];
  items.forEach(it => {
    const o = findByKey(it.order_no, it.line_no);
    if (!o) { fail++; missing.push({ order_no: it.order_no, line_no: it.line_no }); return; }
    if (o.status === status) { noChange.push({ order_no: it.order_no, line_no: it.line_no, id: o.id }); return; }
    table.update(o.id, STATUS_LOCK_FIELDS(status, operator));
    ok++;
  });
  res.json({ message: `批量状态完成：成功 ${ok} 条，失败 ${fail} 条，未变 ${noChange.length} 条`, ok, fail, missing, no_change: noChange });
});

router.put('/by-key/:order_no/:line_no', requirePerm('order:edit'), (req, res) => {
  const o = findByKey(req.params.order_no, req.params.line_no);
  if (!o) return res.status(404).json({ error: '本地未同步该订单，请先点同步订单' });
  const table = getTable('orders');
  const fields = { updated_at: now() };
  ['order_no','line_no','customer_name','customer_code','product_code','product_name','project_no','status','risk_level','promised_date','plan_date','online_date','remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['quantity','completed_qty','order_amount'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = Number(req.body[f]) || 0;
  });
  table.update(o.id, fields);
  res.json({ message: '更新成功', id: o.id });
});

router.delete('/by-key/:order_no/:line_no', requirePerm('order:delete'), (req, res) => {
  const o = findByKey(req.params.order_no, req.params.line_no);
  if (!o) return res.status(404).json({ error: '本地未同步该订单，请先点同步订单' });
  const table = getTable('orders');
  table.delete(o.id);
  res.json({ message: '删除成功' });
});

router.post('/batch-delete-by-key', requirePerm('order:delete'), (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '请提供 items 数组（每项含 order_no, line_no）' });
  const table = getTable('orders');
  let ok = 0, fail = 0, missing = [];
  items.forEach(it => {
    const o = findByKey(it.order_no, it.line_no);
    if (o) { table.delete(o.id); ok++; }
    else { fail++; missing.push({ order_no: it.order_no, line_no: it.line_no }); }
  });
  res.json({ message: `批量删除完成：成功 ${ok} 条，失败 ${fail} 条`, ok, fail, missing });
});

module.exports = router;
