const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

// 根据采购周期和上次采购日，计算下次应采购日期
function computeNextPurchaseDate(record) {
  const cycle = Number(record.procurement_cycle) || 0;
  const enabled = Number(record.procurement_enabled) === 1;
  if (!enabled || cycle <= 0) return '';
  let base = record.last_purchase_date;
  if (!base) base = now().substring(0, 10);
  const d = new Date(base + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + cycle);
  return d.toISOString().substring(0, 10);
}

function todayStr() { return now().substring(0, 10); }

// 活跃状态（尚未完成/取消）的采购需求，视为该物料本周期已存在需求，避免重复生成
const ACTIVE_STATUS = ['pending', 'in_order', 'ordered'];

function genNo(prefix, table) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const ymd = d.toISOString().substring(0, 10).replace(/-/g, '');
  const seq = String((table.all().length || 0) + 1).padStart(3, '0');
  const rnd = Math.floor(Math.random() * 900 + 100);
  return `${prefix}${ymd}${seq}${rnd}`;
}

/**
 * 扫描物料库：对启用了周期采购且到期的物料，自动生成采购需求
 * 同一物料若已有活跃需求（未完成/未取消），则跳过，避免重复
 */
router.post('/scan', requirePerm('material:edit'), (req, res) => {
  const matTable = getTable('materials');
  const reqTable = getTable('purchase_requests');
  matTable._invalidate();
  reqTable._invalidate();

  const today = todayStr();
  const materials = matTable.all();
  const activeByMaterial = {};
  reqTable.all().forEach(r => {
    if (ACTIVE_STATUS.includes(r.status)) activeByMaterial[r.material_id] = (activeByMaterial[r.material_id] || 0) + 1;
  });

  const generated = [];
  const skipped = [];
  materials.forEach(m => {
    if (Number(m.procurement_enabled) !== 1) return;
    const cycle = Number(m.procurement_cycle) || 0;
    if (cycle <= 0) return;
    const next = m.next_purchase_date || computeNextPurchaseDate(m);
    if (!next || next > today) return;
    if (activeByMaterial[m.id]) { skipped.push({ id: m.id, code: m.material_code, reason: '已有活跃需求' }); return; }
    const qty = Number(m.procurement_qty) || 0;
    if (qty <= 0) { skipped.push({ id: m.id, code: m.material_code, reason: '采购数量未设置' }); return; }
    const cost = Number(m.standard_cost) || 0;
    const rec = {
      request_no: genNo('PR', reqTable),
      material_id: m.id,
      material_code: m.material_code || '',
      material_name: m.material_name || '',
      supplier: m.supplier || '',
      category: m.classification || m.category || '',
      unit: m.unit || '个',
      standard_cost: cost,
      qty,
      amount: Math.round(qty * cost * 100) / 100,
      due_date: next,
      status: 'pending',
      po_id: null,
      source: 'auto',
      remarks: '',
      created_at: now(),
      updated_at: now()
    };
    const result = reqTable.insert(rec);
    generated.push(reqTable.findById(result.lastID));
  });

  res.json({
    message: `扫描完成，生成 ${generated.length} 条采购需求，跳过 ${skipped.length} 条`,
    generated: generated.length,
    skipped: skipped.length,
    generated_items: generated,
    skipped_items: skipped
  });
});

/**
 * 采购需求列表
 */
router.get('/requests', requirePerm('material:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, status, supplier, sort_by, sort_order } = req.query;
  const table = getTable('purchase_requests');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (supplier && !(r.supplier || '').includes(supplier)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.request_no, r.material_code, r.material_name, r.supplier].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  };
  const allowedSort = ['id', 'request_no', 'material_code', 'material_name', 'supplier', 'qty', 'amount', 'due_date', 'status', 'created_at'];
  const orderBy = allowedSort.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/requests/:id', requirePerm('material:view'), (req, res) => {
  const row = getTable('purchase_requests').findById(req.params.id);
  if (!row) return res.status(404).json({ error: '采购需求不存在' });
  res.json(row);
});

// 手动新增采购需求
router.post('/requests', requirePerm('material:edit'), (req, res) => {
  const table = getTable('purchase_requests');
  const b = req.body;
  const qty = Number(b.qty) || 0;
  const cost = Number(b.standard_cost) || 0;
  const result = table.insert({
    request_no: b.request_no || genNo('PR', table),
    material_id: b.material_id || null,
    material_code: b.material_code || '',
    material_name: b.material_name || '',
    supplier: b.supplier || '',
    category: b.category || '',
    unit: b.unit || '个',
    standard_cost: cost,
    qty,
    amount: Math.round(qty * cost * 100) / 100,
    due_date: b.due_date || todayStr(),
    status: b.status || 'pending',
    po_id: null,
    source: 'manual',
    remarks: b.remarks || '',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '采购需求已创建', data: table.findById(result.lastID) });
});

router.put('/requests/:id', requirePerm('material:edit'), (req, res) => {
  const table = getTable('purchase_requests');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '采购需求不存在' });
  const fields = { updated_at: now() };
  ['material_code', 'material_name', 'supplier', 'category', 'unit', 'due_date', 'status', 'remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['qty', 'standard_cost'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = Number(req.body[f]) || 0;
  });
  if (fields.qty !== undefined || fields.standard_cost !== undefined) {
    const qty = fields.qty !== undefined ? fields.qty : existing.qty;
    const cost = fields.standard_cost !== undefined ? fields.standard_cost : existing.standard_cost;
    fields.amount = Math.round(qty * cost * 100) / 100;
  }
  // 已纳入采购单的需求，禁止改为 pending 之外的状态混乱
  if (existing.po_id && fields.status === 'pending') {
    return res.status(400).json({ error: '该需求已纳入采购单，无法重置为待处理' });
  }
  table.update(req.params.id, fields);
  res.json({ message: '更新成功', data: table.findById(req.params.id) });
});

router.delete('/requests/:id', requirePerm('material:edit'), (req, res) => {
  const table = getTable('purchase_requests');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '采购需求不存在' });
  if (existing.po_id) return res.status(400).json({ error: '该需求已纳入采购单，无法删除' });
  table.delete(req.params.id);
  res.json({ message: '已删除' });
});

/**
 * 生成采购单：将待处理(pending)的采购需求按供应商分组，每个供应商一张采购单
 * 可选 body.supplier 限定单个供应商；可选 body.request_ids 指定需求集合
 */
router.post('/generate-orders', requirePerm('material:edit'), (req, res) => {
  const reqTable = getTable('purchase_requests');
  const poTable = getTable('purchase_orders');
  reqTable._invalidate();
  poTable._invalidate();

  const filterSupplier = req.body.supplier;
  const idSet = Array.isArray(req.body.request_ids) ? new Set(req.body.request_ids.map(Number)) : null;

  let pending = reqTable.all().filter(r => r.status === 'pending');
  if (filterSupplier) pending = pending.filter(r => (r.supplier || '未指定供应商') === filterSupplier);
  if (idSet) pending = pending.filter(r => idSet.has(r.id));
  if (!pending.length) return res.json({ message: '没有待处理的采购需求', orders: [] });

  // 按供应商分组
  const groups = {};
  pending.forEach(r => {
    const key = r.supplier && String(r.supplier).trim() ? r.supplier : '未指定供应商';
    (groups[key] = groups[key] || []).push(r);
  });

  const orders = [];
  const ts = now();
  Object.keys(groups).forEach(supplier => {
    const items = groups[supplier];
    const totalQty = items.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const totalAmount = items.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const po = {
      po_no: genNo('PO', poTable),
      supplier,
      total_items: items.length,
      total_qty: totalQty,
      total_amount: Math.round(totalAmount * 100) / 100,
      status: 'draft',
      remarks: '',
      item_ids: items.map(r => r.id),
      created_at: ts,
      updated_at: ts
    };
    const result = poTable.insert(po);
    const poId = result.lastID;
    items.forEach(r => reqTable.update(r.id, { status: 'in_order', po_id: poId, updated_at: ts }));
    orders.push(poTable.findById(poId));
  });

  res.json({ message: `已生成 ${orders.length} 张采购单`, orders });
});

/**
 * 采购单列表
 */
router.get('/orders', requirePerm('material:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, status, supplier, sort_by, sort_order } = req.query;
  const table = getTable('purchase_orders');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (supplier && !(r.supplier || '').includes(supplier)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.po_no, r.supplier].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  };
  const allowedSort = ['id', 'po_no', 'supplier', 'total_items', 'total_qty', 'total_amount', 'status', 'created_at'];
  const orderBy = allowedSort.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/orders/:id', requirePerm('material:view'), (req, res) => {
  const poTable = getTable('purchase_orders');
  const reqTable = getTable('purchase_requests');
  const po = poTable.findById(req.params.id);
  if (!po) return res.status(404).json({ error: '采购单不存在' });
  const itemIds = po.item_ids || [];
  const items = reqTable.all().filter(r => itemIds.includes(r.id));
  res.json({ ...po, items });
});

router.put('/orders/:id', requirePerm('material:edit'), (req, res) => {
  const poTable = getTable('purchase_orders');
  const reqTable = getTable('purchase_requests');
  const matTable = getTable('materials');
  const existing = poTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '采购单不存在' });
  const fields = { updated_at: now() };
  ['supplier', 'remarks'].forEach(f => { if (req.body[f] !== undefined) fields[f] = req.body[f]; });
  if (req.body.status !== undefined) {
    const valid = ['draft', 'submitted', 'ordered', 'received', 'closed', 'cancelled'];
    if (!valid.includes(req.body.status)) return res.status(400).json({ error: '无效状态' });
    fields.status = req.body.status;
  }
  poTable.update(req.params.id, fields);

  // 采购单收货(received)时：关联需求置为 received，并推进物料上次采购日/下次采购日，回写库存
  if (fields.status === 'received') {
    const ts = now();
    const td = todayStr();
    const itemIds = existing.item_ids || [];
    reqTable.all().filter(r => itemIds.includes(r.id)).forEach(r => {
      reqTable.update(r.id, { status: 'received', updated_at: ts });
      if (r.material_id) {
        const mat = matTable.findById(r.material_id);
        if (mat) {
          const matFields = { last_purchase_date: td, updated_at: ts };
          const newInv = (Number(mat.inventory_qty) || 0) + (Number(r.qty) || 0);
          matFields.inventory_qty = newInv;
          matFields.next_purchase_date = computeNextPurchaseDate({
            procurement_enabled: mat.procurement_enabled,
            procurement_cycle: mat.procurement_cycle,
            last_purchase_date: td
          });
          matTable.update(r.material_id, matFields);
        }
      }
    });
  }
  // 取消采购单时：释放关联需求回到 pending
  if (fields.status === 'cancelled') {
    const ts = now();
    (existing.item_ids || []).forEach(rid => {
      const r = reqTable.findById(rid);
      if (r && r.status === 'in_order') reqTable.update(rid, { status: 'pending', po_id: null, updated_at: ts });
    });
  }

  res.json({ message: '采购单已更新', data: poTable.findById(req.params.id) });
});

router.delete('/orders/:id', requirePerm('material:edit'), (req, res) => {
  const poTable = getTable('purchase_orders');
  const reqTable = getTable('purchase_requests');
  const existing = poTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '采购单不存在' });
  if (existing.status && existing.status !== 'draft' && existing.status !== 'cancelled') {
    return res.status(400).json({ error: '该采购单状态不允许删除' });
  }
  // 释放关联需求
  const ts = now();
  (existing.item_ids || []).forEach(rid => {
    const r = reqTable.findById(rid);
    if (r && r.status === 'in_order') reqTable.update(rid, { status: 'pending', po_id: null, updated_at: ts });
  });
  poTable.delete(req.params.id);
  res.json({ message: '采购单已删除' });
});

/**
 * 采购仪表盘（即时信息）
 */
router.get('/dashboard', requirePerm('material:view'), (req, res) => {
  const matTable = getTable('materials');
  const reqTable = getTable('purchase_requests');
  const poTable = getTable('purchase_orders');
  matTable._invalidate(); reqTable._invalidate(); poTable._invalidate();

  const today = todayStr();
  const materials = matTable.all();
  const requests = reqTable.all();
  const orders = poTable.all();

  // 即将到期/已到期（按周期）
  const dueItems = [];
  let enabledCount = 0;
  materials.forEach(m => {
    if (Number(m.procurement_enabled) !== 1) return;
    enabledCount++;
    const next = m.next_purchase_date || computeNextPurchaseDate(m);
    if (next && next <= today) {
      dueItems.push({
        id: m.id, material_code: m.material_code, material_name: m.material_name,
        supplier: m.supplier || '', next_purchase_date: next,
        procurement_qty: Number(m.procurement_qty) || 0, unit: m.unit || '个',
        overdue_days: Math.floor((new Date(today) - new Date(next)) / 86400000)
      });
    }
  });

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const inOrderRequests = requests.filter(r => r.status === 'in_order');
  const orderedRequests = requests.filter(r => r.status === 'ordered');
  const receivedRequests = requests.filter(r => r.status === 'received');

  const pendingAmount = pendingRequests.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const draftOrders = orders.filter(o => o.status === 'draft');
  const openOrders = orders.filter(o => ['draft', 'submitted', 'ordered'].includes(o.status));
  const openOrdersAmount = openOrders.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

  // 按供应商汇总待处理需求（便于生成采购单）
  const bySupplier = {};
  pendingRequests.forEach(r => {
    const k = r.supplier && String(r.supplier).trim() ? r.supplier : '未指定供应商';
    if (!bySupplier[k]) bySupplier[k] = { supplier: k, items: 0, qty: 0, amount: 0 };
    bySupplier[k].items++;
    bySupplier[k].qty += Number(r.qty) || 0;
    bySupplier[k].amount += Number(r.amount) || 0;
  });
  const supplierGroups = Object.values(bySupplier).map(g => ({
    ...g, amount: Math.round(g.amount * 100) / 100
  })).sort((a, b) => b.amount - a.amount);

  res.json({
    today,
    procurement_enabled: enabledCount,
    due_count: dueItems.length,
    due_items: dueItems.sort((a, b) => b.overdue_days - a.overdue_days),
    pending_requests: pendingRequests.length,
    pending_amount: Math.round(pendingAmount * 100) / 100,
    in_order_requests: inOrderRequests.length,
    ordered_requests: orderedRequests.length,
    received_requests: receivedRequests.length,
    draft_orders: draftOrders.length,
    open_orders: openOrders.length,
    open_orders_amount: Math.round(openOrdersAmount * 100) / 100,
    total_orders: orders.length,
    supplier_groups: supplierGroups
  });
});

module.exports = router;
