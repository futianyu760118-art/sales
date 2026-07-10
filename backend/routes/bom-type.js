const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

router.get('/types', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_types');
  table._invalidate();
  const types = table.all().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (types.length === 0) {
    const defaults = [
      { code: 'product_base', name: '产品基础BOM', description: '存储标准产品结构信息', sort_order: 1 },
      { code: 'order', name: '订单BOM', description: '根据客户订单需求生成的定制化BOM', sort_order: 2 },
      { code: 'production', name: '生产BOM', description: '实际生产过程中使用的BOM', sort_order: 3 }
    ];
    defaults.forEach(d => {
      table.insert({ ...d, enabled: 1, created_at: now(), updated_at: now() });
    });
    return res.json({ data: table.all().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)) });
  }
  res.json({ data: types });
});

router.post('/types', requirePerm('bom:edit'), (req, res) => {
  const { code, name, description, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: '类型编码和名称为必填项' });
  const table = getTable('bom_types');
  const existing = table.all().find(t => t.code === code);
  if (existing) return res.status(400).json({ error: '类型编码已存在' });
  const result = table.insert({
    code, name, description: description || '',
    sort_order: sort_order || 999, enabled: 1,
    created_at: now(), updated_at: now()
  });
  res.json({ message: '类型创建成功', data: table.findById(result.lastID) });
});

router.put('/types/:id', requirePerm('bom:edit'), (req, res) => {
  const table = getTable('bom_types');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '类型不存在' });
  const fields = { updated_at: now() };
  ['name', 'description', 'sort_order', 'enabled'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '类型更新成功', data: table.findById(req.params.id) });
});

router.delete('/types/:id', requirePerm('bom:delete'), (req, res) => {
  const table = getTable('bom_types');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '类型不存在' });
  table.delete(req.params.id);
  res.json({ message: '类型删除成功' });
});

router.get('/typed-bom', requirePerm('bom:view'), (req, res) => {
  const { product_id, bom_type, keyword } = req.query;
  const bomTable = getTable('product_bom');
  const typedBomTable = getTable('bom_typed_items');
  bomTable._invalidate();
  typedBomTable._invalidate();

  let items = [];
  if (bom_type === 'product_base' || !bom_type) {
    items = bomTable.all();
    if (product_id) items = items.filter(r => r.product_id === Number(product_id));
    items = items.map(i => ({ ...i, bom_type: 'product_base' }));
  } else {
    items = typedBomTable.all();
    if (product_id) items = items.filter(r => r.product_id === Number(product_id));
    if (bom_type) items = items.filter(r => r.bom_type === bom_type);
  }

  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(r => [r.code, r.name, r.spec].join(' ').toLowerCase().includes(kw));
  }

  const prodTable = getTable('products');
  prodTable._invalidate();
  const prodMap = {};
  prodTable.all().forEach(p => { prodMap[p.id] = p; });

  const result = items.map(item => ({
    ...item,
    product_model: prodMap[item.product_id] ? prodMap[item.product_id].external_model : ''
  }));

  res.json({ data: result, total: result.length });
});

router.post('/typed-bom/generate', requirePerm('bom:edit'), (req, res) => {
  const { product_id, bom_type, order_id, modifications } = req.body;
  if (!product_id || !bom_type) return res.status(400).json({ error: '产品ID和BOM类型为必填项' });

  const bomTable = getTable('product_bom');
  const typedBomTable = getTable('bom_typed_items');
  bomTable._invalidate();

  const baseItems = bomTable.all().filter(b => b.product_id === Number(product_id));
  if (baseItems.length === 0) return res.status(400).json({ error: '该产品没有基础BOM数据' });

  const existing = typedBomTable.all().filter(b => b.product_id === Number(product_id) && b.bom_type === bom_type);
  existing.forEach(e => typedBomTable.delete(e.id));

  let count = 0;
  baseItems.forEach(item => {
    let modItem = { ...item };
    if (modifications && Array.isArray(modifications)) {
      const mod = modifications.find(m => m.base_bom_id === item.id || m.code === item.code);
      if (mod) {
        if (mod.quantity !== undefined) modItem.quantity = Number(mod.quantity);
        if (mod.spec !== undefined) modItem.spec = mod.spec;
        if (mod.unit_price !== undefined) modItem.unit_price = Number(mod.unit_price);
        if (mod.name !== undefined) modItem.name = mod.name;
        if (mod.remarks !== undefined) modItem.remarks = mod.remarks;
        modItem.modified = 1;
      }
    }
    modItem.amount = (Number(modItem.quantity) || 0) * (Number(modItem.unit_price) || 0);
    typedBomTable.insert({
      product_id: Number(product_id),
      bom_type,
      order_id: order_id || null,
      parent_id: modItem.parent_id,
      level: modItem.level,
      code: modItem.code,
      name: modItem.name,
      spec: modItem.spec,
      unit: modItem.unit,
      quantity: modItem.quantity,
      material_type: modItem.material_type,
      material_category: modItem.material_category || '',
      unit_price: modItem.unit_price,
      amount: modItem.amount,
      base_bom_id: modItem.id,
      modified: modItem.modified || 0,
      sort: modItem.sort || count + 1,
      created_at: now(), updated_at: now()
    });
    count++;
  });

  res.json({ message: `${bom_type === 'order' ? '订单' : '生产'}BOM生成成功`, count });
});

router.put('/typed-bom/:id', requirePerm('bom:edit'), (req, res) => {
  const table = getTable('bom_typed_items');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'BOM项不存在' });
  const fields = { updated_at: now(), modified: 1 };
  ['code', 'name', 'spec', 'unit', 'material_type', 'material_category', 'remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['quantity', 'unit_price', 'level'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f] !== null ? Number(req.body[f]) : 0;
  });
  if (req.body.quantity !== undefined || req.body.unit_price !== undefined) {
    const qty = req.body.quantity !== undefined ? Number(req.body.quantity) : existing.quantity;
    const price = req.body.unit_price !== undefined ? Number(req.body.unit_price) : Number(existing.unit_price);
    fields.amount = qty * price;
  }
  table.update(req.params.id, fields);
  res.json({ message: '更新成功', data: table.findById(req.params.id) });
});

router.post('/compare', requirePerm('bom:view'), (req, res) => {
  const { product_id, types } = req.body;
  if (!product_id) return res.status(400).json({ error: '产品ID为必填项' });

  const bomTable = getTable('product_bom');
  const typedBomTable = getTable('bom_typed_items');
  bomTable._invalidate();
  typedBomTable._invalidate();

  const compareTypes = types || ['product_base', 'order', 'production'];
  const allData = {};

  const baseItems = bomTable.all().filter(b => b.product_id === Number(product_id));
  allData['product_base'] = baseItems;

  compareTypes.forEach(type => {
    if (type === 'product_base') return;
    allData[type] = typedBomTable.all().filter(b => b.product_id === Number(product_id) && b.bom_type === type);
  });

  const codeMap = {};
  Object.entries(allData).forEach(([type, items]) => {
    items.forEach(item => {
      const code = item.code || '';
      if (!codeMap[code]) codeMap[code] = { code, name: item.name || '', spec: item.spec || '' };
      codeMap[code][type] = {
        quantity: Number(item.quantity) || 0,
        unit_price: Number(item.unit_price) || 0,
        amount: Number(item.amount) || 0,
        spec: item.spec || '',
        name: item.name || '',
        material_type: item.material_type || '',
        material_category: item.material_category || '',
        modified: item.modified || 0,
        id: item.id
      };
    });
  });

  const differences = [];
  Object.values(codeMap).forEach(entry => {
    const hasDiff = compareTypes.some((t, i) => {
      if (i === 0) return false;
      const prev = entry[compareTypes[i - 1]];
      const curr = entry[t];
      if (!prev && curr) return true;
      if (prev && !curr) return true;
      if (!prev && !curr) return false;
      return prev.quantity !== curr.quantity ||
             prev.unit_price !== curr.unit_price ||
             prev.spec !== curr.spec ||
             prev.name !== curr.name;
    });
    if (hasDiff) {
      differences.push({
        ...entry,
        diff_fields: []
      });
    }
  });

  differences.forEach(diff => {
    const fields = [];
    compareTypes.forEach((t, i) => {
      if (i === 0) return;
      const prev = diff[compareTypes[i - 1]];
      const curr = diff[t];
      if (!prev && curr) { fields.push('新增'); return; }
      if (prev && !curr) { fields.push('删除'); return; }
      if (!prev && !curr) return;
      if (prev.quantity !== curr.quantity) fields.push('数量');
      if (prev.unit_price !== curr.unit_price) fields.push('单价');
      if (prev.spec !== curr.spec) fields.push('规格');
      if (prev.name !== curr.name) fields.push('名称');
    });
    diff.diff_fields = [...new Set(fields)];
  });

  res.json({
    data: Object.values(codeMap),
    differences,
    diff_count: differences.length,
    types: compareTypes,
    total: Object.keys(codeMap).length
  });
});

module.exports = router;
