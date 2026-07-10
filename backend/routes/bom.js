const express = require('express');
const router = express.Router();
const { getTable, now: dbNow } = require('../db');
const { requirePerm } = require('../auth-middleware');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ dest: require('path').join(__dirname, '../uploads/') });

// ==================== BOM管理 ====================

// 构建物料库索引（material_code -> 物料库记录）
function buildMaterialIndex() {
  const matTable = getTable('materials');
  matTable._invalidate();
  const map = {};
  matTable.all().forEach(m => { if (m.material_code) map[m.material_code] = m; });
  return map;
}

// 获取BOM列表（支持按产品型号/物料类型/物料库分类/状态/物料库匹配筛选，并关联物料库信息）
router.get('/', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_items');
  const matMap = buildMaterialIndex();
  let items = table.all();
  const { page = 1, limit = 50 } = req.query;

  // 关联物料库标准信息
  items = items.map(i => {
    const mat = matMap[i.material_code];
    if (!mat) {
      return { ...i, mat_matched: false, mat_classification: '', mat_status: '', mat_material_type: '', mat_category: '', mat_standard_cost: 0, mat_supplier: '', mat_inventory_qty: 0, mat_min_inventory: 0, mat_bom_usage_count: 0, mat_used_in_products: '' };
    }
    return {
      ...i,
      mat_matched: true,
      mat_classification: mat.classification || '',
      mat_status: mat.status || '',
      mat_material_type: mat.material_type || mat.category || '',
      mat_category: mat.category || '',
      mat_standard_cost: Number(mat.standard_cost) || 0,
      mat_supplier: mat.supplier || '',
      mat_inventory_qty: Number(mat.inventory_qty) || 0,
      mat_min_inventory: Number(mat.min_inventory) || 0,
      mat_bom_usage_count: Number(mat.bom_usage_count) || 0,
      mat_used_in_products: mat.used_in_products || ''
    };
  });

  const { product_code, keyword, material_type, classification, status, key_part, matched, level, data_source, enabled } = req.query;

  if (product_code) items = items.filter(i => (i.product_code || '').includes(product_code) || (i.product_name || '').toLowerCase().includes(product_code.toLowerCase()));
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(i =>
      (i.material_code || '').toLowerCase().includes(kw) ||
      (i.material_name || '').toLowerCase().includes(kw) ||
      (i.product_code || '').toLowerCase().includes(kw)
    );
  }
  // 数据来源筛选
  if (data_source) {
    if (data_source === 'external_sync') {
      items = items.filter(i => (i.source || '') === 'external_sync');
    } else if (data_source === 'manual') {
      items = items.filter(i => (i.source || '') !== 'external_sync');
    }
  }
  // 启用/禁用筛选
  if (enabled === '1' || enabled === 'true') {
    items = items.filter(i => String(i.is_disabled || '') !== '1' && i.is_disabled !== true && i.is_disabled !== 'true');
  } else if (enabled === '0' || enabled === 'false') {
    items = items.filter(i => String(i.is_disabled) === '1' || i.is_disabled === true || i.is_disabled === 'true');
  }
  // 物料类型筛选（优先物料库标准，回退BOM自身属性）
  if (material_type) {
    items = items.filter(i => (i.mat_material_type || i.material_attr || '') === material_type);
  }
  // 物料库分类筛选（通用/专用/定制/常用物料）
  if (classification) items = items.filter(i => i.mat_classification === classification);
  // 物料库状态筛选
  if (status) items = items.filter(i => i.mat_status === status);
  // 关键件筛选
  if (key_part) {
    items = items.filter(i => String(i.key_part || '').trim() === key_part);
  }
  // 层次筛选（支持精确层次如 .1 / .1.1，或层级深度如 1/2/3）
  if (level) {
    if (/^\d+$/.test(level)) {
      const depth = parseInt(level);
      items = items.filter(i => (i.level || '').split('.').filter(Boolean).length === depth);
    } else {
      items = items.filter(i => (i.level || '') === level);
    }
  }
  // 物料库匹配状态筛选
  if (matched === 'true') items = items.filter(i => i.mat_matched);
  if (matched === 'false') items = items.filter(i => !i.mat_matched);

  const total = items.length;
  const pageNum = parseInt(page) || 1;
  const limitNum = parseInt(limit) || 50;
  const start = (pageNum - 1) * limitNum;
  const data = items.slice(start, start + limitNum);
  res.json({ data, total, page: pageNum, limit: limitNum });
});

// 穿透：根据产品型号查看关联的产品信息、订单、BOM统计
router.get('/drillthrough/:product_code', requirePerm('bom:view'), (req, res) => {
  const code = req.params.product_code;
  const prodTable = getTable('products');
  const orderTable = getTable('orders');
  const bomTable = getTable('bom_items');
  const summaryTable = getTable('order_summaries');
  prodTable._invalidate();
  orderTable._invalidate();
  bomTable._invalidate();

  const product = prodTable.all().find(p => p.external_model === code || p.internal_model === code || p.base_model === code) || null;
  // 订单匹配：兼容多种字段命名
  const orders = orderTable.all().filter(o =>
    o.product_code === code || o.product_model === code || o.external_model === code ||
    o.model === code || (o.product_code && String(o.product_code).includes(code))
  );
  const bomItems = bomTable.all().filter(b => b.product_code === code);
  const summary = summaryTable.all().find(s => s.product_code === code) || null;
  const materialCodes = new Set(bomItems.map(b => b.material_code).filter(Boolean));
  // 成本只按顶层汇总，避免父子重复计算
  const bomDepth = b => (String(b.level || '').match(/\./g) || []).length || 1;
  const topItems = bomItems.filter(b => bomDepth(b) === 1);

  res.json({
    product_code: code,
    product,
    orders,
    order_count: orders.length,
    bom_stats: {
      item_count: bomItems.length,
      top_count: topItems.length,
      material_count: materialCodes.size,
      total_cost: Math.round(topItems.reduce((s, b) => s + (Number(b.total) || Number(b.amount) || 0), 0) * 100) / 100,
      self_made: bomItems.filter(b => (b.material_attr || '').includes('自制')).length,
      outsourcing: bomItems.filter(b => (b.material_attr || '').includes('委外')).length
    },
    summary
  });
});

// 获取筛选器可选值（物料类型/物料库分类/物料库状态），供前端下拉
router.get('/filter-options', requirePerm('bom:view'), (req, res) => {
  const matTable = getTable('materials');
  const bomTable = getTable('bom_items');
  matTable._invalidate();
  bomTable._invalidate();

  const matCodes = new Set(bomTable.all().map(b => b.material_code).filter(Boolean));
  const materials = matTable.all().filter(m => matCodes.has(m.material_code));

  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const bomAll = bomTable.all();
  const levelSet = {};
  bomAll.forEach(b => { if (b.level) levelSet[b.level] = true; });
  const levels = Object.keys(levelSet).sort((a, b) => a.split('.').filter(Boolean).length - b.split('.').filter(Boolean).length || a.localeCompare(b));
  res.json({
    material_types: uniq(materials.map(m => m.material_type || m.category)),
    classifications: uniq(materials.map(m => m.classification)),
    statuses: uniq(materials.map(m => m.status)),
    bom_material_attrs: uniq(bomAll.map(b => b.material_attr)),
    key_parts: uniq(bomAll.map(b => b.key_part)),
    levels
  });
});

// 按物料库同步BOM标准信息（标准按物料库：物料类型/名称/规格/单位）
router.post('/sync-from-materials', requirePerm('bom:create'), (req, res) => {
  const bomTable = getTable('bom_items');
  const matMap = buildMaterialIndex();
  const items = bomTable.all();
  const ts = dbNow();
  let updated = 0, skipped = 0, unmatched = 0;
  const details = [];

  items.forEach(item => {
    const mat = matMap[item.material_code];
    if (!mat) { unmatched++; return; }
    const fields = { updated_at: ts };
    let changed = false;
    if (mat.material_type && mat.material_type !== (item.material_attr || '')) { fields.material_attr = mat.material_type; changed = true; }
    if (mat.material_name && mat.material_name !== (item.material_name || '')) { fields.material_name = mat.material_name; changed = true; }
    if (mat.specs && mat.specs !== (item.spec || '')) { fields.spec = mat.specs; changed = true; }
    if (mat.unit && mat.unit !== (item.unit || '')) { fields.unit = mat.unit; changed = true; }
    if (changed) {
      bomTable.update(item.id, fields);
      updated++;
      if (details.length < 50) details.push({ id: item.id, material_code: item.material_code, fields: Object.keys(fields).filter(f => f !== 'updated_at') });
    } else {
      skipped++;
    }
  });

  res.json({ message: 'BOM标准已按物料库同步', updated, skipped, unmatched, total: items.length, details });
});

// 把BOM管理(bom_items)的物料同步到物料库，按 material_code 去重，新物料按自动分类标准分类
router.post('/sync-to-materials', requirePerm('bom:create'), (req, res) => {
  const bomTable = getTable('bom_items');
  const matTable = getTable('materials');
  const ruleTable = getTable('classification_rules');
  bomTable._invalidate();
  matTable._invalidate();
  ruleTable._invalidate();

  const bomItems = bomTable.all();
  const codeMap = {};
  const allMats = matTable.all();
  allMats.forEach(m => { if (m.material_code) codeMap[m.material_code] = m; });
  // 物料全字段指纹：完全一致的物料不重复创建
  const matFp = m => [m.material_name, m.specs, m.material_type, m.unit, Number(m.standard_cost) || 0, m.classification].join('∮');
  const existingMatFps = new Set(allMats.map(matFp));

  // 统计每个物料编码被哪些产品使用（去重的核心）
  const usageMap = {};
  const sampleMap = {};
  bomItems.forEach(b => {
    if (!b.material_code) return;
    if (!usageMap[b.material_code]) { usageMap[b.material_code] = new Set(); sampleMap[b.material_code] = b; }
    if (b.product_code) usageMap[b.material_code].add(b.product_code);
  });

  const ts = dbNow();
  let added = 0, updated = 0, skipped = 0, identicalSkipped = 0;
  const addedCodes = [];

  Object.keys(usageMap).forEach(code => {
    const sample = sampleMap[code];
    const products = [...usageMap[code]];
    const usageCount = products.length;
    const usedIn = products.join(',');
    if (codeMap[code]) {
      const mat = codeMap[code];
      if ((Number(mat.bom_usage_count) || 0) !== usageCount || (mat.used_in_products || '') !== usedIn) {
        matTable.update(mat.id, { bom_usage_count: usageCount, used_in_products: usedIn, updated_at: ts });
        updated++;
      } else { skipped++; }
    } else {
      // 待建物料指纹
      const candidate = {
        material_name: sample.material_name || '', specs: sample.spec || '',
        material_type: sample.material_attr || '', unit: sample.unit || '',
        standard_cost: Number(sample.unit_price) || 0, classification: '专用物料'
      };
      // 完全一致的已有物料则跳过（不同编码但内容完全相同）
      if (existingMatFps.has(matFp(candidate))) { identicalSkipped++; return; }
      const result = matTable.insert({
        product_id: null, material_name: candidate.material_name, material_code: code,
        category: candidate.material_type, specs: candidate.specs,
        material_type: candidate.material_type, unit: candidate.unit,
        standard_cost: candidate.standard_cost, processing_cost: 0, processing_loss: 0,
        supplier: '', status: 'normal', unit_price: candidate.standard_cost,
        quantity: Number(sample.quantity) || 0, classification: '专用物料',
        inventory_qty: 0, min_inventory: 0, monthly_usage: 0,
        bom_usage_count: usageCount, used_in_products: usedIn,
        certificate_required: '', remarks: '', created_at: ts, updated_at: ts
      });
      codeMap[code] = matTable.findById(result.lastID);
      existingMatFps.add(matFp(candidate));
      added++; addedCodes.push(code);
    }
  });

  // 新增物料按自动分类标准执行分类
  let classified = 0;
  if (addedCodes.length > 0) {
    const rules = ruleTable.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));
    const defaultCat = '专用物料';
    addedCodes.forEach(code => {
      const mat = codeMap[code];
      let target = '';
      for (const rule of rules) {
        const raw = mat[rule.field];
        const val = String(raw === undefined || raw === null ? '' : raw);
        let match = false;
        if (rule.operator === 'equals') match = val === rule.value;
        else if (rule.operator === 'contains') match = val.includes(rule.value);
        else if (rule.operator === 'startsWith') match = val.startsWith(rule.value);
        else if (rule.operator === 'gte') match = raw !== undefined && raw !== null && raw !== '' && Number(val) >= Number(rule.value);
        else if (rule.operator === 'lte') match = raw !== undefined && raw !== null && raw !== '' && Number(val) <= Number(rule.value);
        if (match) { target = rule.result_category; break; }
      }
      if (!target) target = defaultCat;
      if (target !== (mat.classification || '')) {
        matTable.update(mat.id, { classification: target, updated_at: ts });
        classified++;
      }
    });
  }

  res.json({
    message: 'BOM物料已同步到物料库', added, updated, skipped, classified, identical_skipped: identicalSkipped,
    total_bom_codes: Object.keys(usageMap).length, added_codes: addedCodes
  });
});

// 根据BOM明细同步建立订单汇总产品信息（缺失的补建，产品名/BOM成本从BOM明细推导）
function syncBomToSummary() {
  const bomTable = getTable('bom_items');
  const summaryTable = getTable('order_summaries');
  bomTable._invalidate();
  summaryTable._invalidate();

  const bomItems = bomTable.all();
  const summaries = summaryTable.all();
  const existingMap = {};
  summaries.forEach(s => { existingMap[s.product_code] = s; });

  // 按 product_code 分组，推导产品信息（成本只按顶层汇总，避免父子重复计算）
  const bomLevelDepth = b => (String(b.level || '').match(/\./g) || []).length || 1;
  const grouped = {};
  bomItems.forEach(b => {
    const code = b.product_code;
    if (!code) return;
    if (!grouped[code]) grouped[code] = { product_code: code, product_name: '', cost_total: 0, item_count: 0, top_count: 0 };
    // 仅顶层(level_depth=1)计入成本：父件成本已含子件，重复累加会虚高
    if (bomLevelDepth(b) === 1) {
      grouped[code].cost_total += Number(b.total) || Number(b.amount) || 0;
      grouped[code].top_count++;
    }
    grouped[code].item_count++;
    if (!grouped[code].product_name && b.product_name) grouped[code].product_name = b.product_name;
  });

  const ts = dbNow();
  let added = 0, updated = 0, skipped = 0;
  Object.values(grouped).forEach(g => {
    const cost = Math.round(g.cost_total * 100) / 100;
    if (!existingMap[g.product_code]) {
      summaryTable.insert({
        product_code: g.product_code,
        product_name: g.product_name,
        quantity: 1,
        cost_no_tax: cost, cost_total: cost,
        purchase_cost: 0, purchase_total: 0,
        sale_price_no_tax: 0, sale_total: 0,
        gross_profit: 0, gross_margin: 0,
        purchase_gross_profit: 0, purchase_gross_margin: 0,
        final_gross_margin: 0,
        created_at: ts, updated_at: ts
      });
      added++;
    } else {
      const ex = existingMap[g.product_code];
      // 补全产品名或空成本，不覆盖已有总表数据
      const fields = { updated_at: ts };
      let changed = false;
      if (!ex.product_name && g.product_name) { fields.product_name = g.product_name; changed = true; }
      if ((!ex.cost_total || Number(ex.cost_total) === 0) && cost > 0) { fields.cost_total = cost; fields.cost_no_tax = cost; changed = true; }
      if (changed) { summaryTable.update(ex.id, fields); updated++; } else { skipped++; }
    }
  });

  return { added, updated, skipped, total_products: Object.keys(grouped).length };
}

router.post('/sync-to-summary', requirePerm('bom:create'), (req, res) => {
  const r = syncBomToSummary();
  res.json({ message: 'BOM明细已同步到订单汇总', ...r });
});

// ==================== 订单汇总 ====================

// 获取订单汇总列表（关联BOM明细和订单信息）
router.get('/order-summary', requirePerm('bom:view'), (req, res) => {
  const summaryTable = getTable('order_summaries');
  const bomTable = getTable('bom_items');
  const orderTable = getTable('orders');
  bomTable._invalidate();
  orderTable._invalidate();
  let items = summaryTable.all();

  // 按产品代码分组BOM统计
  const bomByProduct = {};
  bomTable.all().forEach(b => {
    const code = b.product_code;
    if (!code) return;
    if (!bomByProduct[code]) {
      bomByProduct[code] = { item_count: 0, total_cost: 0, key_parts: 0 };
    }
    bomByProduct[code].item_count++;
    bomByProduct[code].total_cost += Number(b.amount) || 0;
    if (b.key_part === '1') bomByProduct[code].key_parts++;
  });

  // 按产品代码查找关联订单
  items = items.map(item => {
    const bomStats = bomByProduct[item.product_code] || {};
    const productOrders = orderTable.all().filter(o =>
      o.product_code === item.product_code || o.product_model === item.product_code
    );
    const primaryOrder = productOrders.length > 0 ? productOrders[0] : null;
    return {
      ...item,
      bom_count: bomStats.item_count || 0,
      bom_total: Math.round((bomStats.total_cost || 0) * 100) / 100,
      key_part_count: bomStats.key_parts || 0,
      order_no: primaryOrder ? (primaryOrder.order_no || primaryOrder.id || '') : '',
      order_qty: primaryOrder ? (Number(primaryOrder.quantity) || 0) : 0,
      order_amount: primaryOrder ? (Number(primaryOrder.total_amount) || 0) : 0
    };
  });

  // keyword 筛选
  const { keyword } = req.query;
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(i =>
      (i.product_code || '').toLowerCase().includes(kw) ||
      (i.product_name || '').toLowerCase().includes(kw)
    );
  }

  // 统计
  const totalBomItems = Object.values(bomByProduct).reduce((s, v) => s + v.item_count, 0);
  const totalAmount = items.reduce((s, i) => s + (Number(i.order_amount) || 0), 0);

  res.json({
    data: items,
    total: items.length,
    products: items.length,
    bom_items: totalBomItems,
    total_amount: totalAmount
  });
});

// 获取单个订单汇总
router.get('/order-summary/:id', requirePerm('bom:view'), (req, res) => {
  const table = getTable('order_summaries');
  const item = table.findById(req.params.id);
  if (!item) return res.status(404).json({ error: '订单汇总不存在' });
  res.json(item);
});

// 新增订单汇总
router.post('/order-summary', requirePerm('bom:create'), (req, res) => {
  const table = getTable('order_summaries');
  const data = req.body;
  data.created_at = dbNow();
  data.updated_at = dbNow();
  const result = table.insert(data);
  res.json({ message: '添加成功', id: result.lastID });
});

// 更新订单汇总
router.put('/order-summary/:id', requirePerm('bom:edit'), (req, res) => {
  const table = getTable('order_summaries');
  const item = table.findById(req.params.id);
  if (!item) return res.status(404).json({ error: '订单汇总不存在' });
  req.body.updated_at = dbNow();
  table.update(req.params.id, req.body);
  res.json({ message: '更新成功' });
});

// 删除订单汇总
router.delete('/order-summary/:id', requirePerm('bom:delete'), (req, res) => {
  const table = getTable('order_summaries');
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// ==================== BOM 仪表盘 ====================
// 一次性聚合多维度统计：总览 / 来源 / 启用 / 物料类型 / 层级 / 关键件 / Top产品 / 最近同步
// 支持时间范围筛选（按 created_at 过滤）+ 同期对比（自动计算同等长度的上一时段）
//   query: start=YYYY-MM-DD, end=YYYY-MM-DD, compare=1
router.get('/dashboard', requirePerm('bom:view'), (req, res) => {
  const bomTable = getTable('bom_items');
  const summaryTable = getTable('order_summaries');
  const orderTable = getTable('orders');
  bomTable._invalidate();
  summaryTable._invalidate();
  orderTable._invalidate();

  const { start, end, compare } = req.query;

  // 时间字段解析：created_at 形如 "2026-07-09 14:23:16" 或 ISO
  const parseTime = s => {
    if (!s) return null;
    const t = new Date(s.replace(' ', 'T'));
    return isNaN(t.getTime()) ? null : t;
  };
  const startTime = parseTime(start);
  const endTime = parseTime(end);
  const enableCompare = compare === '1' || compare === 'true';

  // 计算上一时段（与当前时段等长）
  let compareStartTime = null, compareEndTime = null;
  if (enableCompare && startTime && endTime) {
    const duration = endTime.getTime() - startTime.getTime();
    compareEndTime = new Date(startTime.getTime() - 1);
    compareStartTime = new Date(compareEndTime.getTime() - duration);
  } else if (enableCompare && startTime && !endTime) {
    // 仅起始日 → 对比上一日
    compareStartTime = new Date(startTime.getTime() - 86400000);
    compareEndTime = new Date(startTime.getTime() - 1);
  } else if (enableCompare && !startTime && endTime) {
    compareStartTime = new Date(endTime.getTime() - 86400000 * 7);
    compareEndTime = new Date(endTime.getTime() - 1);
  }

  const inRange = (item) => {
    const t = parseTime(item.created_at);
    if (!t) return !startTime && !endTime; // 无时间字段的数据：当无筛选时纳入；有时段筛选时排除
    if (startTime && t < startTime) return false;
    if (endTime && t > endTime) return false;
    return true;
  };
  const inCompareRange = (item) => {
    if (!compareStartTime && !compareEndTime) return false;
    const t = parseTime(item.created_at);
    if (!t) return false;
    if (compareStartTime && t < compareStartTime) return false;
    if (compareEndTime && t > compareEndTime) return false;
    return true;
  };

  const all = bomTable.all();
  const filtered = all.filter(inRange);
  const prevFiltered = enableCompare ? all.filter(inCompareRange) : [];

  const compute = (items) => {
    const sourceMap = { external_sync: 0, manual: 0, other: 0 };
    const isDisabled = i => String(i.is_disabled) === '1' || i.is_disabled === true || i.is_disabled === 'true';
    const matTypeMap = {};
    const levelMap = {};
    const productMap = {};
    let enabledCount = 0, disabledCount = 0, keyPartCount = 0, totalAmount = 0;

    items.forEach(i => {
      const s = i.source || '';
      if (s === 'external_sync') sourceMap.external_sync++;
      else if (s) sourceMap.other++;
      else sourceMap.manual++;
      if (isDisabled(i)) disabledCount++; else enabledCount++;
      if (String(i.key_part || '').trim() === '1') keyPartCount++;
      const t = i.material_attr || i.mat_material_type || '未分类';
      matTypeMap[t] = (matTypeMap[t] || 0) + 1;
      const lv = String(i.level || '').split('.').filter(Boolean).length || 1;
      levelMap[lv] = (levelMap[lv] || 0) + 1;
      const code = i.product_code || '';
      if (code) {
        if (!productMap[code]) productMap[code] = { product_code: code, product_name: i.product_name || '', count: 0, total: 0, has_external: false, has_disabled: false };
        productMap[code].count++;
        productMap[code].total += Number(i.amount) || 0;
        if (i.source === 'external_sync') productMap[code].has_external = true;
        if (isDisabled(i)) productMap[code].has_disabled = true;
      }
      totalAmount += Number(i.amount) || 0;
    });

    const materialTypes = Object.entries(matTypeMap)
      .map(([k, v]) => ({ name: k, count: v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const levels = Object.entries(levelMap)
      .map(([k, v]) => ({ level: Number(k), count: v }))
      .sort((a, b) => a.level - b.level);
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(p => ({ ...p, total: Math.round(p.total * 100) / 100 }));

    return {
      total: items.length,
      enabled: enabledCount,
      disabled: disabledCount,
      key_part_count: keyPartCount,
      total_amount: Math.round(totalAmount * 100) / 100,
      source_distribution: [
        { name: '外部同步', key: 'external_sync', count: sourceMap.external_sync },
        { name: '手工/导入', key: 'manual', count: sourceMap.manual },
        { name: '其他来源', key: 'other', count: sourceMap.other }
      ],
      material_types: materialTypes,
      levels,
      top_products: topProducts
    };
  };

  const cur = compute(filtered);
  const prev = enableCompare ? compute(prevFiltered) : null;

  // 整个数据集中的"最近外部同步时间"（不受时间筛选影响，作为全局参考）
  const lastExternal = all
    .filter(i => i.source === 'external_sync' && i.updated_at)
    .map(i => i.updated_at)
    .sort()
    .pop() || '';

  res.json({
    ...cur,
    period: {
      start: startTime ? startTime.toISOString() : null,
      end: endTime ? endTime.toISOString() : null,
      has_filter: !!(startTime || endTime)
    },
    compare: prev ? {
      ...prev,
      period: {
        start: compareStartTime ? compareStartTime.toISOString() : null,
        end: compareEndTime ? compareEndTime.toISOString() : null
      },
      // 增量值 = 当前 - 上期（百分比变动）
      delta: {
        total: cur.total - prev.total,
        total_pct: prev.total ? ((cur.total - prev.total) / prev.total * 100) : null,
        enabled: cur.enabled - prev.enabled,
        disabled: cur.disabled - prev.disabled,
        key_part_count: cur.key_part_count - prev.key_part_count,
        total_amount: Math.round((cur.total_amount - prev.total_amount) * 100) / 100,
        total_amount_pct: prev.total_amount ? Math.round((cur.total_amount - prev.total_amount) / prev.total_amount * 10000) / 100 : null,
        external_sync: cur.source_distribution[0].count - prev.source_distribution[0].count,
        manual: cur.source_distribution[1].count - prev.source_distribution[1].count
      }
    } : null,
    last_external_sync_at: lastExternal,
    order_count: orderTable.all().length,
    summary_count: summaryTable.all().length
  });
});

// 获取单个BOM物料
router.get('/:id', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_items');
  const item = table.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'BOM物料不存在' });
  res.json(item);
});

// 新增BOM物料
router.post('/', requirePerm('bom:create'), (req, res) => {
  const table = getTable('bom_items');
  const data = req.body;
  data.created_at = dbNow();
  data.updated_at = dbNow();
  const result = table.insert(data);
  res.json({ message: '添加成功', id: result.lastID });
});

// 更新BOM物料
router.put('/:id', requirePerm('bom:edit'), (req, res) => {
  const table = getTable('bom_items');
  const item = table.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'BOM物料不存在' });
  req.body.updated_at = dbNow();
  table.update(req.params.id, req.body);
  res.json({ message: '更新成功' });
});

// 切换启用/禁用状态
router.put('/:id/toggle-disabled', requirePerm('bom:edit'), (req, res) => {
  const table = getTable('bom_items');
  const item = table.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'BOM物料不存在' });
  const isDisabled = String(item.is_disabled) === '1' || item.is_disabled === true || item.is_disabled === 'true';
  const next = isDisabled ? '0' : '1';
  table.update(req.params.id, { is_disabled: next, updated_at: dbNow() });
  res.json({ message: isDisabled ? '已启用' : '已禁用', is_disabled: next });
});

// 删除BOM物料
router.delete('/:id', requirePerm('bom:delete'), (req, res) => {
  const table = getTable('bom_items');
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// 删除某产品型号下所有BOM
router.delete('/by-product/:product_code', requirePerm('bom:delete'), (req, res) => {
  const table = getTable('bom_items');
  const items = table.all().filter(i => i.product_code === req.params.product_code);
  items.forEach(i => table.delete(i.id));
  res.json({ message: '删除成功', count: items.length });
});

// ==================== Excel导入 ====================

// 查找"层次/层级"表头所在行（用于识别BOM表）
function findBomHeaderRow(rows) {
  return rows.findIndex(row => row && row.some(c => String(c || '').trim().match(/层次|层级/)));
}
// 按表头文本识别BOM列位置（不依赖固定列号）
function detectBomColumns(headerRow) {
  const m = {};
  (headerRow || []).forEach((cell, idx) => {
    const c = String(cell || '').trim();
    if ((c.includes('层次') || c.includes('层级')) && m.level === undefined) m.level = idx;
    else if ((c.includes('物料代码') || c.includes('物料编码')) && m.code === undefined) m.code = idx;
    else if ((c.includes('物料名称') || c === '名称') && m.name === undefined) m.name = idx;
    else if (c.includes('规格') && m.spec === undefined) m.spec = idx;
    else if (c.includes('辅助属性') && m.aux === undefined) m.aux = idx;
    else if (c === '单位' && m.unit === undefined) m.unit = idx;
    else if (c.includes('数量') && m.qty === undefined) m.qty = idx;
    else if (c.includes('物料属性') && m.mattr === undefined) m.mattr = idx;
    else if (c.includes('关键件') && m.key === undefined) m.key = idx;
    else if (c.includes('使用状态') && m.us === undefined) m.us = idx;
    else if (c.includes('是否禁用') && m.dis === undefined) m.dis = idx;
    else if (c.includes('直接材料') && !c.includes('采购') && m.dm === undefined) m.dm = idx;
    else if (c.includes('直接人工') && m.dl === undefined) m.dl = idx;
    else if (c.includes('变动制造费用') && m.vo === undefined) m.vo = idx;
    else if (c.includes('固定制造费用') && m.fo === undefined) m.fo = idx;
    else if (c.includes('委外材料费') && m.om === undefined) m.om = idx;
    else if (c.includes('委外加工费') && m.ol === undefined) m.ol = idx;
    else if (c === '单价' && m.up === undefined) m.up = idx;
    else if (c === '金额' && m.amt === undefined) m.amt = idx;
    else if (c.includes('含税材料') && m.tax === undefined) m.tax = idx;
    else if (c.includes('加工费') && !c.includes('委外') && m.pf === undefined) m.pf = idx;
    else if (c === '合计' && m.total === undefined) m.total = idx;
    else if (c.includes('采购确认价格') && !c.includes('不含税') && !c.includes('合计') && !c.includes('毛利') && m.pcp === undefined) m.pcp = idx;
  });
  return m;
}
// 判断是否订单汇总表（有成本/售价/毛利列，且无层次表头）
function isOrderSummarySheet(rows) {
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const text = (rows[r] || []).map(c => String(c || '')).join('|');
    if ((text.includes('不含税') || text.includes('销售单价') || text.includes('毛利率')) && !text.includes('层次')) return true;
  }
  return false;
}
// 从BOM表顶部行中识别产品型号(3.1.xxx)
function detectProductCode(rows, headerIdx, fallback) {
  for (let r = 0; r < Math.min(headerIdx + 1, rows.length); r++) {
    for (const cell of (rows[r] || [])) {
      const s = String(cell || '').trim();
      if (/^3\.1\./.test(s)) return s;
    }
  }
  return fallback;
}

// 按表头文本大致匹配总表(订单汇总)列位置（不依赖固定列号）
function detectSummaryColumns(headerRow) {
  const m = {};
  (headerRow || []).forEach((cell, idx) => {
    const c = String(cell || '').trim();
    if (!c) return;
    if ((c.includes('型号') || c.includes('物料代码') || c.includes('物料编码')) && m.code === undefined) m.code = idx;
    else if (c.includes('名称') && m.name === undefined) m.name = idx;
    else if (c === '数量' && m.qty === undefined) m.qty = idx;
    else if (c.includes('采购确认价格') && c.includes('不含税') && !c.includes('合计') && m.purchase_unit === undefined) m.purchase_unit = idx;
    else if (c.includes('采购确认价格') && c.includes('合计') && m.purchase_total === undefined) m.purchase_total = idx;
    else if (c.includes('不含税') && c.includes('成本') && !c.includes('采购') && m.unit_cost === undefined) m.unit_cost = idx;
    else if (c.includes('销售') && c.includes('不含税') && m.sale_unit === undefined) m.sale_unit = idx;
    else if (c.includes('销售') && c.includes('合计') && m.sale_total === undefined) m.sale_total = idx;
    else if (c.includes('采购确认价格') && c.includes('毛利率') && m.purchase_gm === undefined) m.purchase_gm = idx;
    else if (c.includes('采购确认价格') && c.includes('毛利') && m.purchase_gp === undefined) m.purchase_gp = idx;
    else if (c.includes('最终') && c.includes('毛利率') && m.final_gm === undefined) m.final_gm = idx;
    else if (c.includes('毛利率') && m.gross_margin === undefined) m.gross_margin = idx;
    else if (c.includes('毛利') && m.gross_profit === undefined) m.gross_profit = idx;
    else if (c.includes('合计')) { if (m.cost_total === undefined) m.cost_total = idx; else if (m.sale_total === undefined) m.sale_total = idx; }
  });
  return m;
}

// 解析总表（按表头匹配），返回订单汇总记录数组
function parseSummarySheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
  let headerIdx = rows.findIndex(r => r && r.some(c => /型号|物料代码|物料编码|毛利率|不含税/.test(String(c || ''))));
  if (headerIdx === -1) headerIdx = 0;
  const m = detectSummaryColumns(rows[headerIdx]);
  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const code = m.code !== undefined ? String(row[m.code] || '').trim() : '';
    if (!code) continue;
    records.push({
      product_code: code,
      product_name: m.name !== undefined ? String(row[m.name] || '').trim() : '',
      quantity: m.qty !== undefined ? (Number(row[m.qty]) || 0) : 0,
      cost_no_tax: m.unit_cost !== undefined ? (Number(row[m.unit_cost]) || 0) : 0,
      cost_total: m.cost_total !== undefined ? (Number(row[m.cost_total]) || 0) : 0,
      purchase_cost: m.purchase_unit !== undefined ? (Number(row[m.purchase_unit]) || 0) : 0,
      purchase_total: m.purchase_total !== undefined ? (Number(row[m.purchase_total]) || 0) : 0,
      sale_price_no_tax: m.sale_unit !== undefined ? (Number(row[m.sale_unit]) || 0) : 0,
      sale_total: m.sale_total !== undefined ? (Number(row[m.sale_total]) || 0) : 0,
      gross_profit: m.gross_profit !== undefined ? (Number(row[m.gross_profit]) || 0) : 0,
      gross_margin: m.gross_margin !== undefined ? (Number(row[m.gross_margin]) || 0) : 0,
      purchase_gross_profit: m.purchase_gp !== undefined ? (Number(row[m.purchase_gp]) || 0) : 0,
      purchase_gross_margin: m.purchase_gm !== undefined ? (Number(row[m.purchase_gm]) || 0) : 0,
      final_gross_margin: m.final_gm !== undefined ? (Number(row[m.final_gm]) || 0) : 0
    });
  }
  return records;
}

router.post('/import-excel', upload.single('file'), requirePerm('bom:create'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });

  try {
    const wb = XLSX.readFile(req.file.path);
    const result = { order_summaries: [], bom_items: [], bom_sheets: [], skipped_sheets: [], errors: [] };

    // 按内容分类工作表：有"层次"表头→BOM表；否则为总表(可选)；总表有无均可导入BOM
    const summarySheetNames = [];
    const bomSheetNames = [];
    wb.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', blankrows: false });
      if (findBomHeaderRow(rows) !== -1) bomSheetNames.push(name);
      else if (name === '总表' || isOrderSummarySheet(rows)) summarySheetNames.push(name);
      else result.skipped_sheets.push(name);
    });

    const summaryTable = getTable('order_summaries');
    const bomTable = getTable('bom_items');

    // 1. 总表（可选，优先导入；按表头大致匹配列，不依赖固定列号）
    summarySheetNames.forEach(sheetName => {
      const records = parseSummarySheet(wb.Sheets[sheetName]);
      records.forEach(record => {
        const full = { ...record, created_at: dbNow(), updated_at: dbNow() };
        const existing = summaryTable.all().find(r => r.product_code === record.product_code);
        if (existing) summaryTable.update(existing.id, { ...full, updated_at: dbNow() });
        else summaryTable.insert(full);
        result.order_summaries.push(record.product_code);
      });
    });

    // 2. BOM明细（按表头识别列，支持任意工作表命名与无总表场景）
    // 全字段指纹：完全一致的BOM明细不重复导入
    const bomItemFp = b => [b.product_code, b.material_code, b.level, b.spec, b.aux_attr, b.unit, b.quantity, b.material_attr, b.key_part, b.unit_price, b.amount, b.total, b.purchase_confirm_price].join('∮');
    const existingFpSet = new Set(bomTable.all().map(bomItemFp));
    let identicalSkipped = 0;

    bomSheetNames.forEach(sheetName => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
      const headerIdx = findBomHeaderRow(rows);
      if (headerIdx === -1) return;
      const colMap = detectBomColumns(rows[headerIdx]);
      const productCode = detectProductCode(rows, headerIdx, sheetName);
      const productName = headerIdx >= 1 && rows[headerIdx - 1] ? String(rows[headerIdx - 1][1] || '').trim() : '';

      // 计算层次深度（按点号总数：.1=1层，.1.1=2层），用于成本去重（顶层=1）
      const levelDepth = lv => (String(lv).match(/\./g) || []).length;

      let imported = 0;
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || colMap.level === undefined) continue;
        const levelStr = String(row[colMap.level] || '').trim();
        if (!levelStr) continue; // 跳过空层次行
        const code = colMap.code !== undefined ? String(row[colMap.code] || '').trim() : '';
        const mattr = colMap.mattr !== undefined ? String(row[colMap.mattr] || '').trim() : '';
        if (!code && !mattr) continue; // 完全空行跳过
        if (code === '费用' || code.includes('加工费')) continue; // 费用行跳过

        const item = {
          product_code: productCode,
          product_name: productName,
          level: levelStr,
          level_depth: levelDepth(levelStr),
          material_code: code,
          material_name: colMap.name !== undefined ? String(row[colMap.name] || '').trim() : '',
          spec: colMap.spec !== undefined ? String(row[colMap.spec] || '').trim() : '',
          aux_attr: colMap.aux !== undefined ? String(row[colMap.aux] || '').trim() : '',
          unit: colMap.unit !== undefined ? String(row[colMap.unit] || '').trim() : '',
          quantity: colMap.qty !== undefined ? (Number(row[colMap.qty]) || 0) : 0,
          material_attr: mattr,
          key_part: colMap.key !== undefined ? String(row[colMap.key] || '').trim() : '',
          use_status: colMap.us !== undefined ? String(row[colMap.us] || '').trim() : '',
          is_disabled: colMap.dis !== undefined ? String(row[colMap.dis] || '').trim() : '',
          direct_material: colMap.dm !== undefined ? (Number(row[colMap.dm]) || 0) : 0,
          direct_labor: colMap.dl !== undefined ? (Number(row[colMap.dl]) || 0) : 0,
          variable_overhead: colMap.vo !== undefined ? (Number(row[colMap.vo]) || 0) : 0,
          fixed_overhead: colMap.fo !== undefined ? (Number(row[colMap.fo]) || 0) : 0,
          outsource_material: colMap.om !== undefined ? (Number(row[colMap.om]) || 0) : 0,
          outsource_labor: colMap.ol !== undefined ? (Number(row[colMap.ol]) || 0) : 0,
          unit_price: colMap.up !== undefined ? (Number(row[colMap.up]) || 0) : 0,
          amount: colMap.amt !== undefined ? (Number(row[colMap.amt]) || 0) : 0,
          tax_material: colMap.tax !== undefined ? (Number(row[colMap.tax]) || 0) : 0,
          processing_fee: colMap.pf !== undefined ? (Number(row[colMap.pf]) || 0) : 0,
          total: colMap.total !== undefined ? (Number(row[colMap.total]) || 0) : 0,
          purchase_confirm_price: colMap.pcp !== undefined ? (Number(row[colMap.pcp]) || 0) : 0,
          created_at: dbNow(), updated_at: dbNow()
        };
        // 完全一致则跳过（避免重复导入）
        const fp = bomItemFp(item);
        if (existingFpSet.has(fp)) { identicalSkipped++; continue; }
        bomTable.insert(item);
        existingFpSet.add(fp);
        result.bom_items.push(code);
        imported++;
      }
      result.bom_sheets.push({ sheet: sheetName, product_code: productCode, imported });
    });

    // 清理上传文件
    require('fs').unlinkSync(req.file.path);

    // 根据BOM明细同步建立订单汇总产品信息（无总表时自动补建）
    let summarySync = null;
    try { summarySync = syncBomToSummary(); } catch (e) { console.error('同步订单汇总失败:', e.message); }

    res.json({
      message: '导入成功',
      order_summaries_count: result.order_summaries.length,
      bom_items_count: result.bom_items.length,
      identical_skipped: identicalSkipped,
      bom_sheets: result.bom_sheets,
      skipped_sheets: result.skipped_sheets,
      summary_sync: summarySync,
      details: result
    });
  } catch (e) {
    if (req.file && require('fs').existsSync(req.file.path)) {
      require('fs').unlinkSync(req.file.path);
    }
    res.status(500).json({ error: '导入失败: ' + e.message });
  }
});

// ==================== 统计分析 ====================

// BOM统计：按产品型号汇总
router.get('/stats/bom-by-product', requirePerm('bom:view'), (req, res) => {
  const bomTable = getTable('bom_items');
  const items = bomTable.all();

  const grouped = {};
  items.forEach(item => {
    const code = item.product_code || 'unknown';
    if (!grouped[code]) {
      grouped[code] = {
        product_code: code,
        product_name: item.product_name || '',
        item_count: 0,
        total_amount: 0,
        total_purchase_price: 0,
        materials: new Set()
      };
    }
    grouped[code].item_count++;
    grouped[code].total_amount += Number(item.amount) || 0;
    grouped[code].total_purchase_price += Number(item.purchase_confirm_price) || 0;
    grouped[code].materials.add(item.material_code);
  });

  const result = Object.values(grouped).map(g => ({
    ...g,
    unique_materials: g.materials.size,
    materials: undefined
  }));

  res.json(result);
});

// 订单汇总统计
router.get('/stats/order-overview', requirePerm('bom:view'), (req, res) => {
  const summaryTable = getTable('order_summaries');
  const items = summaryTable.all();

  const totalQuantity = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const totalCost = items.reduce((s, i) => s + (Number(i.cost_total) || 0), 0);
  const totalSale = items.reduce((s, i) => s + (Number(i.sale_total) || 0), 0);
  const totalGrossProfit = items.reduce((s, i) => s + (Number(i.gross_profit) || 0), 0);
  const avgGrossMargin = items.length > 0
    ? items.reduce((s, i) => s + (Number(i.gross_margin) || 0), 0) / items.length
    : 0;

  res.json({
    product_count: items.length,
    total_quantity: totalQuantity,
    total_cost: Math.round(totalCost * 100) / 100,
    total_sale: Math.round(totalSale * 100) / 100,
    total_gross_profit: Math.round(totalGrossProfit * 100) / 100,
    avg_gross_margin: avgGrossMargin,
    products: items
  });
});

module.exports = router;
