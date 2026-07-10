const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

router.get('/', requirePerm('sample:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, status, inquiry_no } = req.query;
  const table = getTable('samples');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (inquiry_no && !(r.inquiry_no || '').includes(inquiry_no)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.sample_no, r.customer_name, r.product_name, r.inquiry_no].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = table.findWhere(filter, 'id', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/stats', requirePerm('sample:view'), (req, res) => {
  const table = getTable('samples');
  const all = table.all();
  const byStatus = {}; all.forEach(s => { byStatus[s.status||'pending'] = (byStatus[s.status||'pending']||0) + 1; });
  res.json({ total: all.length, by_status: byStatus });
});

router.get('/:id', requirePerm('sample:view'), (req, res) => {
  const row = getTable('samples').findById(req.params.id);
  if (!row) return res.status(404).json({ error: '样品单不存在' });
  // 关联询价信息
  if (row.inquiry_no) {
    const inqTable = getTable('inquiries');
    row.inquiry = inqTable.all().find(i => i.serial_number === row.inquiry_no) || null;
  }
  res.json(row);
});

router.post('/', requirePerm('sample:create'), (req, res) => {
  const table = getTable('samples');
  const b = req.body;
  if (!b.customer_name) return res.status(400).json({ error: '客户名称为必填项'});
  const result = table.insert({
    sample_no: b.sample_no || ('SMP' + Date.now() % 1000000), customer_name: b.customer_name || '',
    inquiry_no: b.inquiry_no || '', product_name: b.product_name || '', product_code: b.product_code || '',
    quantity: Number(b.quantity) || 0, sample_type: b.sample_type || '常规',
    status: b.status || 'pending', remarks: b.remarks || '',
    send_date: b.send_date || '', confirm_date: b.confirm_date || '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('sample:edit'), (req, res) => {
  const table = getTable('samples');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '样品单不存在' });
  const fields = { updated_at: now() };
  ['sample_no','customer_name','inquiry_no','product_name','product_code','sample_type','status','remarks','send_date','confirm_date'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['quantity'].forEach(f => { if (req.body[f] !== undefined) fields[f] = Number(req.body[f]) || 0; });
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

router.put('/:id/status', requirePerm('sample:edit'), (req, res) => {
  const table = getTable('samples');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  const valid = ['pending','confirmed','producing','sent','customer_confirmed','completed'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: '无效状态' });
  table.update(req.params.id, { status: req.body.status, updated_at: now() });
  res.json({ message: '状态更新' });
});

router.delete('/:id', requirePerm('sample:delete'), (req, res) => {
  const table = getTable('samples');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

module.exports = router;
