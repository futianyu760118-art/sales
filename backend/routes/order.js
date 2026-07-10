const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

router.get('/', requirePerm('order:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, status, customer, product, sort_by, sort_order } = req.query;
  const table = getTable('orders');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (customer && !(r.customer_name || '').includes(customer)) return false;
    if (product && !((r.product_code||'')+(r.product_name||'')).toLowerCase().includes(product.toLowerCase())) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.order_no, r.customer_name, r.product_name, r.product_code].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  };
  const orderBy = ['order_no','customer_name','product_name','quantity','order_amount','status','promised_date'].includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

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
  const bomTable = getTable('bom_items');
  row.bom_items = bomTable.all().filter(b => b.product_code === row.product_code);
  res.json(row);
});

router.post('/', requirePerm('order:create'), (req, res) => {
  const table = getTable('orders');
  const b = req.body;
  if (!b.order_no && !b.customer_name) return res.status(400).json({ error: '订单号或客户必填' });
  const result = table.insert({
    order_no: b.order_no || '', line_no: b.line_no || '', customer_name: b.customer_name || '',
    customer_code: b.customer_code || '', product_code: b.product_code || '',
    product_name: b.product_name || '', project_no: b.project_no || '',
    quantity: Number(b.quantity) || 0,
    completed_qty: Number(b.completed_qty) || 0,
    order_amount: Number(b.order_amount) || 0, status: b.status || 'open',
    risk_level: b.risk_level || 'blue', promised_date: b.promised_date || '',
    plan_date: b.plan_date || '', online_date: b.online_date || '',
    remarks: b.remarks || '', created_at: now(), updated_at: now()
  });
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
  const valid = ['open','confirmed','procurement_ready','material_ready','packaging_done','shipped','completed','closed','cancelled'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: '无效状态' });
  table.update(req.params.id, { status: req.body.status, updated_at: now() });
  res.json({ message: '状态更新' });
});

router.delete('/:id', requirePerm('order:delete'), (req, res) => {
  const table = getTable('orders');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

module.exports = router;
