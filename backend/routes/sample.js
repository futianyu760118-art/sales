const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { resolveDataScope, isInScope } = require('../data-scope');
const { resolveDataScopeV2, buildScopeFilter, combineFilter, logDataPermission } = require('../data-scope-v2');

router.get('/', requirePerm('sample:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, status, inquiry_no } = req.query;
  const table = getTable('samples');
  const scope = resolveDataScopeV2(req);
  const scopeLegacy = resolveDataScope(req);
  const scopeFilter = buildScopeFilter(scope, 'samples');

  // 询价单 -> 销售员 映射（用于样品单的归属推断，旧模式）
  let inquirySalesByNo = null;
  if (scopeLegacy.enabled) {
    const inqTable = getTable('inquiries');
    inquirySalesByNo = new Map();
    inqTable.all().forEach(iq => {
      const no = String(iq.serial_number || '').trim();
      const sp = String(iq.sales_person || '').trim();
      if (no && sp && scopeLegacy.ownerNames.has(sp)) inquirySalesByNo.set(no, sp);
    });
  }

  const filter = combineFilter((r) => {
    if (status && r.status !== status) return false;
    if (inquiry_no && !(r.inquiry_no || '').includes(inquiry_no)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.sample_no, r.customer_name, r.product_name, r.inquiry_no].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  }, (r) => {
    if (scope.enabled) {
      if (scopeFilter(r)) return true;
      // 旧模式：样品 → inquiry_no → inquiry.sales_person 匹配
      const no = String(r.inquiry_no || '').trim();
      if (no && inquirySalesByNo && inquirySalesByNo.has(no)) return true;
      return false;
    }
    if (scopeLegacy.enabled) {
      const no = String(r.inquiry_no || '').trim();
      if (!no || !inquirySalesByNo || !inquirySalesByNo.has(no)) return false;
    }
    return true;
  });
  const { records, total } = table.findWhere(filter, 'id', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  logDataPermission(req, 'sample.list', { table: 'samples', count: total, scope_mode: scope.mode || 'none' });
  res.json({
    data: records,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    scope: scope.enabled
      ? { mode: scope.mode, label: labelScopeSample(scope.mode) }
      : { mode: 'none', label: '全部数据' }
  });
});

function labelScopeSample(mode) {
  return {
    all: '全部数据',
    self: '我的样品单',
    dept: '本部门样品单',
    dept_and_child: '本部门及下级部门样品单',
    custom: '自定义范围样品单',
    none: '全部数据'
  }[mode] || '全部数据';
}

router.get('/stats', requirePerm('sample:view'), (req, res) => {
  const table = getTable('samples');
  const all = table.all();
  const byStatus = {}; all.forEach(s => { byStatus[s.status||'pending'] = (byStatus[s.status||'pending']||0) + 1; });
  res.json({ total: all.length, by_status: byStatus });
});

router.get('/:id', requirePerm('sample:view'), (req, res) => {
  const row = getTable('samples').findById(req.params.id);
  if (!row) return res.status(404).json({ error: '样品单不存在' });
  const scope = resolveDataScopeV2(req);
  let ok = true;
  if (scope.enabled) {
    ok = buildScopeFilter(scope, 'samples')(row);
    if (!ok) {
      const no = String(row.inquiry_no || '').trim();
      const inqTable = getTable('inquiries');
      const iq = no ? inqTable.all().find(i => String(i.serial_number || '').trim() === no) : null;
      const sp = iq ? String(iq.sales_person || '').trim() : '';
      const scopeLegacy = resolveDataScope(req);
      if (scopeLegacy.enabled && sp && scopeLegacy.ownerNames.has(sp)) ok = true;
    }
  }
  if (!ok) return res.status(403).json({ error: '无访问该样品单的权限', code: 'DATA_SCOPE_DENIED' });
  // 关联询价信息
  if (row.inquiry_no) {
    const inqTable = getTable('inquiries');
    row.inquiry = inqTable.all().find(i => i.serial_number === row.inquiry_no) || null;
  }
  logDataPermission(req, 'sample.detail', { table: 'samples', record_id: row.id, scope_mode: scope.mode || 'none' });
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
