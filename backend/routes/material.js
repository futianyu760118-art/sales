const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

function migrateMaterialDataOnce() {
  const table = getTable('materials');
  table._invalidate();
  const materials = table.all();
  let certFixed = 0, statFixed = 0;
  materials.forEach(m => {
    const fields = {};
    if (m.certificate_required === undefined || m.certificate_required === null) {
      fields.certificate_required = 0;
      certFixed++;
    } else {
      const v = String(m.certificate_required).trim();
      const n = (v === '1' || v === 'true') ? 1 : 0;
      if (m.certificate_required !== n) { fields.certificate_required = n; certFixed++; }
    }
    if (m.status === 'normal' || m.status === 'custom') { fields.status = 'active'; statFixed++; }
    if (Object.keys(fields).length) { fields.updated_at = now(); table.update(m.id, fields); }
  });
  if (certFixed > 0 || statFixed > 0) {
    console.log(`[Material Migration] certificate_required: ${certFixed}, status: ${statFixed}`);
  }
}

let migrated = false;
function ensureMigration() {
  if (!migrated) { migrated = true; migrateMaterialDataOnce(); }
}

// 根据采购周期和上次采购日，计算下次应采购日期
function computeNextPurchaseDate(record) {
  const cycle = Number(record.procurement_cycle) || 0;
  const enabled = Number(record.procurement_enabled) === 1;
  if (!enabled || cycle <= 0) return '';
  let base = record.last_purchase_date;
  if (!base) {
    base = now().substring(0, 10);
  }
  const d = new Date(base + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + cycle);
  return d.toISOString().substring(0, 10);
}

router.get('/', requirePerm('material:view'), (req, res) => {
  const { page = 1, limit = 15, product_id, status, keyword, category, classification, sort_by, sort_order } = req.query;
  const table = getTable('materials');
  const filter = (r) => {
    if (product_id && r.product_id !== Number(product_id)) return false;
    if (status && r.status !== status) return false;
    if (category && !(r.category || '').includes(category)) return false;
    if (classification && (r.classification || '通用物料') !== classification) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.material_name, r.material_code, r.specs, r.material_type, r.supplier, r.category].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const allowedSortFields = ['id', 'material_code', 'material_name', 'category', 'standard_cost', 'processing_cost', 'processing_loss', 'inventory_qty', 'min_inventory', 'monthly_usage', 'unit_price', 'supplier', 'bom_usage_count', 'status', 'classification', 'procurement_enabled', 'procurement_cycle', 'procurement_qty', 'last_purchase_date', 'next_purchase_date', 'created_at'];
  const orderBy = allowedSortFields.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit), sort_by: orderBy, sort_order: orderDir });
});

router.get('/dashboard/stats', requirePerm('material:view'), (req, res) => {
  ensureMigration();
  const matTable = getTable('materials');
  const bomTable = getTable('product_bom');
  matTable._invalidate();
  bomTable._invalidate();

  const materials = matTable.all();
  const bomItems = bomTable.all();

  const totalMaterials = materials.length;
  const byClassification = {};
  const byCategory = {};
  const byStatus = {};
  let totalCost = 0;
  let lowInventoryCount = 0;
  const lowInventoryItems = [];

  materials.forEach(m => {
    const cls = m.classification || '通用物料';
    byClassification[cls] = (byClassification[cls] || 0) + 1;
    const cat = m.category || '未分类';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const st = m.status || 'normal';
    byStatus[st] = (byStatus[st] || 0) + 1;
    totalCost += Number(m.standard_cost) || 0;
    if (m.min_inventory > 0 && (m.inventory_qty || 0) <= m.min_inventory) {
      lowInventoryCount++;
      lowInventoryItems.push({
        id: m.id, material_code: m.material_code, material_name: m.material_name,
        inventory_qty: m.inventory_qty || 0, min_inventory: m.min_inventory,
        shortage: m.min_inventory - (m.inventory_qty || 0)
      });
    }
  });

  const topUsed = [...materials]
    .sort((a, b) => (b.bom_usage_count || 0) - (a.bom_usage_count || 0))
    .slice(0, 10)
    .map(m => ({ material_code: m.material_code, material_name: m.material_name, usage_count: m.bom_usage_count || 0, classification: m.classification || '通用物料' }));

  const topCost = [...materials]
    .sort((a, b) => (Number(b.standard_cost) || 0) - (Number(a.standard_cost) || 0))
    .slice(0, 10)
    .map(m => ({ material_code: m.material_code, material_name: m.material_name, standard_cost: Number(m.standard_cost) || 0, classification: m.classification || '通用物料' }));

  const monthlyPurchaseSuggestion = materials
    .filter(m => m.monthly_usage > 0)
    .map(m => {
      const deficit = m.monthly_usage - (m.inventory_qty || 0);
      return {
        id: m.id, material_code: m.material_code, material_name: m.material_name,
        classification: m.classification || '通用物料', monthly_usage: m.monthly_usage,
        inventory_qty: m.inventory_qty || 0, min_inventory: m.min_inventory || 0,
        suggested_qty: Math.max(0, deficit + (m.min_inventory || 0)),
        estimated_cost: Math.max(0, deficit + (m.min_inventory || 0)) * (Number(m.standard_cost) || 0)
      };
    })
    .filter(m => m.suggested_qty > 0)
    .sort((a, b) => b.estimated_cost - a.estimated_cost);

  // 采购周期统计（即时信息）
  const today = now().substring(0, 10);
  let procurementEnabledCount = 0;
  let procurementDueCount = 0;
  let procurementInventoryValue = 0;
  const procurementDueItems = [];
  materials.forEach(m => {
    const inv = Number(m.inventory_qty) || 0;
    procurementInventoryValue += inv * (Number(m.standard_cost) || 0);
    if (Number(m.procurement_enabled) === 1) {
      procurementEnabledCount++;
      const next = m.next_purchase_date || computeNextPurchaseDate(m);
      if (next && next <= today) {
        procurementDueCount++;
        procurementDueItems.push({
          id: m.id, material_code: m.material_code, material_name: m.material_name,
          supplier: m.supplier || '', next_purchase_date: next,
          procurement_qty: Number(m.procurement_qty) || 0,
          unit: m.unit || '个', standard_cost: Number(m.standard_cost) || 0,
          overdue_days: Math.floor((new Date(today) - new Date(next)) / 86400000)
        });
      }
    }
  });

  const timeline = materials
    .map(m => ({
      id: m.id,
      material_code: m.material_code,
      material_name: m.material_name,
      event_type: m.status === 'inactive' ? 'disabled' : 'created',
      event_text: m.status === 'inactive' ? '物料已禁用' : '物料已新增',
      event_time: m.status === 'inactive' ? (m.updated_at || m.created_at) : (m.created_at || m.updated_at),
      status: m.status
    }))
    .sort((a, b) => new Date(b.event_time) - new Date(a.event_time))
    .slice(0, 20);

  res.json({
    totalMaterials, byClassification, byCategory, byStatus, totalCost, lowInventoryCount, lowInventoryItems, topUsed, topCost, monthlyPurchaseSuggestion, bomTotalItems: bomItems.length,
    // 即时仪表盘便捷字段
    total: totalMaterials,
    active: (byStatus.active || 0) + (byStatus.normal || 0),
    inactive: byStatus.inactive || 0,
    low_stock: lowInventoryCount,
    categories: Object.keys(byCategory).length,
    inventory_value: Math.round(procurementInventoryValue * 100) / 100,
    procurement_enabled: procurementEnabledCount,
    procurement_due: procurementDueCount,
    procurement_due_items: procurementDueItems.sort((a, b) => b.overdue_days - a.overdue_days),
    timeline
  });
});

// ===== 时间段对比仪表盘 =====
const PERIOD_PRESETS = {
  today: { days: 1, label: '今日' },
  '7d': { days: 7, label: '近 7 天' },
  '30d': { days: 30, label: '近 30 天' },
  '90d': { days: 90, label: '近 90 天' },
  quarter: { days: 90, label: '近一季度' },
  year: { days: 365, label: '近一年' }
};

function parseDateStr(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('T') ? '' : 'Z'));
  return isNaN(d.getTime()) ? null : d;
}

function toDateKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 根据 from/to 计算对比期（同样长度，前移）
function resolvePeriod(query) {
  const range = String(query.range || '30d').toLowerCase();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let to, from, label, key;
  if (range === 'custom' && query.from && query.to) {
    const f = parseDateStr(query.from);
    const t = parseDateStr(query.to);
    if (!f || !t) return null;
    f.setUTCHours(0, 0, 0, 0);
    t.setUTCHours(0, 0, 0, 0);
    if (t < f) return null;
    from = f; to = t; label = `${toDateKey(f)} ~ ${toDateKey(t)}`; key = 'custom';
  } else {
    const preset = PERIOD_PRESETS[range] || PERIOD_PRESETS['30d'];
    to = new Date(today);
    from = new Date(today);
    from.setUTCDate(from.getUTCDate() - (preset.days - 1));
    label = preset.label; key = range;
  }
  // 对比期：长度 = to - from + 1 天，前移
  const days = Math.round((to - from) / 86400000) + 1;
  const prevTo = new Date(from);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
  return {
    key,
    label,
    current: { from, to },
    previous: { from: prevFrom, to: prevTo }
  };
}

// 在指定日期 D 上重构库存快照（基于 created_at/updated_at）
function snapshotAt(materials, asOf) {
  const asOfTs = asOf.getTime();
  let total = 0, active = 0, inactive = 0, byStatus = {}, byClassification = {}, byCategory = {};
  let inventoryValue = 0, lowStock = 0, procurementDue = 0, procurementEnabled = 0;
  materials.forEach(m => {
    const created = parseDateStr(m.created_at);
    if (!created || created.getTime() > asOfTs) return;
    total++;
    // 状态：若 updated_at 在截止日前且当前 inactive → 视为 inactive，否则 active
    const upd = parseDateStr(m.updated_at);
    const wasInactive = m.status === 'inactive' && upd && upd.getTime() <= asOfTs;
    const st = wasInactive ? 'inactive' : 'active';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (st === 'active') active++; else inactive++;
    const cls = m.classification || '通用物料';
    byClassification[cls] = (byClassification[cls] || 0) + 1;
    const cat = m.category || '未分类';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const inv = Number(m.inventory_qty) || 0;
    const cost = Number(m.standard_cost) || 0;
    inventoryValue += inv * cost;
    if ((Number(m.min_inventory) || 0) > 0 && inv <= Number(m.min_inventory)) lowStock++;
    if (Number(m.procurement_enabled) === 1) {
      procurementEnabled++;
      // next_purchase_date 计算后比较
      const next = m.next_purchase_date || '';
      if (next && new Date(next + 'T00:00:00Z').getTime() <= asOfTs) procurementDue++;
    }
  });
  return {
    total, active, inactive,
    low_stock: lowStock,
    inventory_value: Math.round(inventoryValue * 100) / 100,
    procurement_enabled: procurementEnabled,
    procurement_due: procurementDue,
    by_status: byStatus,
    by_classification: byClassification,
    by_category: byCategory
  };
}

// 期间内事件：新增/禁用
function eventsInPeriod(materials, from, to) {
  const fromTs = from.getTime(), toTs = to.getTime() + 86399999;
  const created = [], disabled = [];
  materials.forEach(m => {
    const c = parseDateStr(m.created_at);
    if (c && c.getTime() >= fromTs && c.getTime() <= toTs) {
      created.push({
        id: m.id, material_code: m.material_code, material_name: m.material_name,
        classification: m.classification || '通用物料', created_at: m.created_at
      });
    }
    if (m.status === 'inactive') {
      const u = parseDateStr(m.updated_at);
      if (u && u.getTime() >= fromTs && u.getTime() <= toTs) {
        disabled.push({
          id: m.id, material_code: m.material_code, material_name: m.material_name,
          classification: m.classification || '通用物料', updated_at: m.updated_at
        });
      }
    }
  });
  created.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  disabled.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return { created: created.slice(0, 20), disabled: disabled.slice(0, 20), created_count: created.length, disabled_count: disabled.length };
}

// 每日趋势：基于重构快照（最多 30 个点）
// 每天点表示「该日结束」的库存状态；最后一天与 current 一致
function buildTrend(materials, from, to){
  const days = Math.round((to - from) / 86400000) + 1;
  // 数据点过多时降采样：最多 30 个点
  const step = days > 30 ? Math.ceil(days / 30) : 1;
  const points = [];
  let cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    // 用「当日结束」(23:59:59.999) 作为快照时间点
    const endOfDay = new Date(cursor);
    endOfDay.setUTCHours(23, 59, 59, 999);
    const snap = snapshotAt(materials, endOfDay);
    // 当日新增数（按日界）
    const dayStart = cursor.getTime();
    const dayEnd = endOfDay.getTime();
    const newCount = materials.filter(m => {
      const c = parseDateStr(m.created_at);
      return c && c.getTime() >= dayStart && c.getTime() <= dayEnd;
    }).length;
    points.push({
      date: toDateKey(cursor),
      total: snap.total,
      active: snap.active,
      low_stock: snap.low_stock,
      inventory_value: snap.inventory_value,
      new_count: newCount
    });
    cursor.setUTCDate(cursor.getUTCDate() + step);
  }
  return { points, step, total_days: days };
}

router.get('/dashboard/period-stats', requirePerm('material:view'), (req, res) => {
  ensureMigration();
  const period = resolvePeriod(req.query);
  if (!period) return res.status(400).json({ error: '时间范围参数无效' });
  const matTable = getTable('materials');
  matTable._invalidate();
  const materials = matTable.all();
  const today = new Date(); today.setUTCHours(23, 59, 59, 999);
  const current = snapshotAt(materials, today);
  const prev = snapshotAt(materials, period.previous.to);
  const ev = eventsInPeriod(materials, period.current.from, period.current.to);
  const trend = buildTrend(materials, period.current.from, period.current.to);
  // 变更计算
  const change = (cur, p) => {
    const diff = (cur || 0) - (p || 0);
    const percent = (p || 0) > 0 ? Math.round((diff / p) * 1000) / 10 : (cur > 0 ? 100 : 0);
    return { current: cur || 0, previous: p || 0, diff, percent, trend: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat' };
  };
  const changes = {
    total: change(current.total, prev.total),
    active: change(current.active, prev.active),
    inactive: change(current.inactive, prev.inactive),
    low_stock: change(current.low_stock, prev.low_stock),
    inventory_value: change(current.inventory_value, prev.inventory_value),
    procurement_enabled: change(current.procurement_enabled, prev.procurement_enabled),
    procurement_due: change(current.procurement_due, prev.procurement_due)
  };
  res.json({
    period: {
      key: period.key,
      label: period.label,
      current: { from: toDateKey(period.current.from), to: toDateKey(period.current.to) },
      previous: { from: toDateKey(period.previous.from), to: toDateKey(period.previous.to) }
    },
    current, previous: prev, changes,
    events: ev,
    trend
  });
});

router.get('/inventory/alerts', requirePerm('material:view'), (req, res) => {
  const matTable = getTable('materials');
  matTable._invalidate();
  const materials = matTable.all().filter(m =>
    m.min_inventory > 0 && (m.inventory_qty || 0) <= m.min_inventory
  ).map(m => ({
    id: m.id, material_code: m.material_code, material_name: m.material_name,
    classification: m.classification || '通用物料', inventory_qty: m.inventory_qty || 0,
    min_inventory: m.min_inventory, monthly_usage: m.monthly_usage || 0,
    shortage: m.min_inventory - (m.inventory_qty || 0), unit: m.unit || '个',
    standard_cost: Number(m.standard_cost) || 0
  }));
  res.json({ data: materials, total: materials.length });
});

router.post('/sync-from-bom', requirePerm('material:create'), (req, res) => {
  const bomTable = getTable('product_bom');
  const matTable = getTable('materials');
  const prodTable = getTable('products');
  bomTable._invalidate();
  matTable._invalidate();

  const bomItems = bomTable.all();
  const products = prodTable.all();
  const existingMats = matTable.all();

  const codeMap = {};
  existingMats.forEach(m => { codeMap[m.material_code] = m; });

  let added = 0, updated = 0, skipped = 0;

  bomItems.forEach(bom => {
    const code = bom.code;
    if (!code || code === '费用') { skipped++; return; }
    const product = products.find(p => p.id === bom.product_id);
    const productModel = product ? product.external_model : '';

    if (codeMap[code]) {
      const mat = codeMap[code];
      const currentProducts = (mat.used_in_products || '').split(',').filter(Boolean);
      if (!currentProducts.includes(productModel) && productModel) {
        currentProducts.push(productModel);
        matTable.update(mat.id, { used_in_products: currentProducts.join(','), bom_usage_count: currentProducts.length, updated_at: now() });
        updated++;
      } else { skipped++; }
    } else {
      let classification = '通用物料';
      if (bom.material_type === '委外加工') classification = '定制物料';
      else if (bom.material_type === '外购') {
        const sameCodeCount = bomItems.filter(b => b.code === code).length;
        classification = sameCodeCount >= 3 ? '常用物料' : '专用物料';
      }
      const result = matTable.insert({
        product_id: bom.product_id, material_name: bom.name || '', material_code: code,
        category: bom.material_type || '', specs: bom.spec || '', material_type: bom.material_type || '',
        unit: bom.unit || '', standard_cost: Number(bom.unit_price) || 0, processing_cost: 0, processing_loss: 0,
        supplier: '', status: 'active', unit_price: Number(bom.unit_price) || 0, quantity: Number(bom.quantity) || 0,
        classification, inventory_qty: 0, min_inventory: 0, monthly_usage: 0,
        bom_usage_count: productModel ? 1 : 0, used_in_products: productModel || '',
        certificate_required: 0, remarks: '', created_at: now(), updated_at: now()
      });
      codeMap[code] = matTable.findById(result.lastID);
      added++;
    }
  });

  res.json({ message: 'BOM同步完成', added, updated, skipped, total: bomItems.length });
});

router.post('/sync-to-bom', requirePerm('material:create'), (req, res) => {
  const bomTable = getTable('product_bom');
  const matTable = getTable('materials');
  bomTable._invalidate();
  matTable._invalidate();

  const materials = matTable.all();
  const matMap = {};
  materials.forEach(m => {
    if (m.material_code) matMap[m.material_code] = m;
  });

  const bomItems = bomTable.all();
  let updated = 0, skipped = 0, unmatched = 0;
  const ts = now();

  bomItems.forEach(bom => {
    const mat = matMap[bom.code];
    if (!mat) { unmatched++; return; }
    const fields = { updated_at: ts };
    let changed = false;
    if (mat.classification && mat.classification !== (bom.material_category || '')) {
      fields.material_category = mat.classification;
      changed = true;
    }
    if (mat.material_type && mat.material_type !== (bom.material_type || '')) {
      fields.material_type = mat.material_type;
      changed = true;
    }
    if (changed) {
      bomTable.update(bom.id, fields);
      updated++;
    } else {
      skipped++;
    }
  });

  res.json({ message: '物料分类已同步到BOM', updated, skipped, unmatched, total: bomItems.length });
});

router.post('/inventory/batch-update', requirePerm('material:edit'), (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items必须为数组' });
  const matTable = getTable('materials');
  matTable._invalidate();
  const allowedFields = ['inventory_qty', 'min_inventory', 'monthly_usage', 'classification', 'status', 'category', 'supplier', 'unit', 'standard_cost', 'processing_cost', 'processing_loss', 'certificate_required', 'material_type', 'remarks'];
  let updated = 0;
  let skipped = 0;
  let bomSynced = 0;
  const bomTable = getTable('product_bom');
  bomTable._invalidate();
  const ts = now();
  items.forEach(item => {
    const mat = matTable.findById(item.id);
    if (!mat) { skipped++; return; }
    const fields = { updated_at: ts };
    const classChanged = item.classification !== undefined && item.classification !== mat.classification;
    const typeChanged = item.material_type !== undefined && item.material_type !== mat.material_type;
    allowedFields.forEach(f => {
      if (item[f] !== undefined) {
        if (['inventory_qty', 'min_inventory', 'monthly_usage', 'standard_cost', 'processing_cost', 'processing_loss'].includes(f)) {
          fields[f] = Number(item[f]) || 0;
        } else {
          fields[f] = item[f];
        }
      }
    });
    if (Object.keys(fields).length > 1) {
      matTable.update(item.id, fields);
      updated++;
      if ((classChanged || typeChanged) && mat.material_code) {
        const bomFields = { updated_at: ts };
        if (classChanged) bomFields.material_category = item.classification;
        if (typeChanged) bomFields.material_type = item.material_type;
        bomTable.all().filter(b => b.code === mat.material_code).forEach(b => {
          bomTable.update(b.id, bomFields);
          bomSynced++;
        });
      }
    }
  });
  res.json({ message: '批量更新成功', updated, skipped, bomSynced });
});

router.get('/export/purchase-report', requirePerm('material:view'), (req, res) => {
  const matTable = getTable('materials');
  matTable._invalidate();
  const materials = matTable.all();
  const headers = ['物料编码', '物料名称', '分类', '规格', '材质', '单位', '标准成本', '库存数量', '最低库存', '月用量', '需采购量', '预估成本', '物料分类', '供应商', '使用产品'];
  const rows = materials.map(m => {
    const deficit = Math.max(0, (m.monthly_usage || 0) - (m.inventory_qty || 0) + (m.min_inventory || 0));
    return [m.material_code || '', m.material_name || '', m.category || '', m.specs || '', m.material_type || '', m.unit || '',
      Number(m.standard_cost) || 0, m.inventory_qty || 0, m.min_inventory || 0, m.monthly_usage || 0, deficit,
      (deficit * (Number(m.standard_cost) || 0)).toFixed(2), m.classification || '通用物料', m.supplier || '', m.used_in_products || ''
    ].map(v => String(v).replace(/,/g, '，'));
  });
  let csv = headers.join(',') + '\n';
  rows.forEach(r => csv += r.join(',') + '\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=purchase_report.csv');
  res.send('\uFEFF' + csv);
});

router.get('/by-model/:model', requirePerm('material:view'), (req, res) => {
  const prodTable = getTable('products');
  const product = prodTable.all().find(p => p.external_model === req.params.model || p.internal_model === req.params.model);
  if (!product) return res.json({ data: [], product: null });
  const table = getTable('materials');
  const materials = table.all().filter(m => m.product_id === product.id);
  res.json({ data: materials, product: { id: product.id, external_model: product.external_model, internal_model: product.internal_model } });
});

// 筛选器可选值（动态，避免下拉选项与实际数据不符）
router.get('/meta/filter-options', requirePerm('material:view'), (req, res) => {
  const table = getTable('materials');
  table._invalidate();
  const all = table.all();
  const uniq = key => [...new Set(all.map(m => m[key]).filter(v => v !== undefined && v !== null && String(v).trim() !== ''))];
  res.json({
    categories: uniq('category'),
    material_types: uniq('material_type'),
    statuses: uniq('status'),
    classifications: uniq('classification')
  });
});

// 物料编码规则标准
router.get('/coding-rules', requirePerm('material:view'), (req, res) => {
  try {
    const fs = require('fs'); const path = require('path');
    const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'material_coding_rules.json'), 'utf8'));
    res.json(rules);
  } catch (e) { res.status(500).json({ error: '编码规则加载失败: ' + e.message }); }
});

// 物料单位标准
router.get('/unit-standards', requirePerm('material:view'), (req, res) => {
  try {
    const fs = require('fs'); const path = require('path');
    const std = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'material_unit_standards.json'), 'utf8'));
    res.json(std);
  } catch (e) { res.status(500).json({ error: '单位标准加载失败: ' + e.message }); }
});

// 单位标准化：按标准自动纠正物料单位（统一大小写+品类标准单位）
router.post('/standardize-units', requirePerm('material:edit'), (req, res) => {
  const fs = require('fs'); const path = require('path');
  let std;
  try { std = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'material_unit_standards.json'), 'utf8')); }
  catch (e) { return res.status(500).json({ error: '标准加载失败' }); }
  const table = getTable('materials'); table._invalidate();
  const all = table.all();
  const unify = std.unit_unify || {};
  const catRules = std.category_rules || [];
  const defaultUnit = std.default_unit || 'PCS';
  const ts = now();
  let unified = 0, catFixed = 0, skipped = 0;
  const details = [];

  function standardUnitFor(mat) {
    const text = ((mat.material_name || '') + ' ' + (mat.material_code || '') + ' ' + (mat.category || '')).toLowerCase();
    for (const rule of catRules) {
      if ((rule.keywords || []).some(kw => text.includes(kw.toLowerCase()))) return rule.standard_unit;
    }
    return null; // 无品类规则
  }

  all.forEach(m => {
    const orig = (m.unit || '').trim();
    let target = orig;
    let changed = false; let reason = '';
    // 1. 品类标准单位优先
    const catStd = standardUnitFor(m);
    if (catStd && orig && orig !== catStd) {
      // 当前单位不属于该品类的合法单位族（如电子件用了"个"应改PCS）
      target = catStd; changed = true; reason = '品类标准(' + catStd + ')';
    } else if (orig && unify[orig] && unify[orig] !== orig) {
      // 2. 单位统一（大小写/别名）
      target = unify[orig]; changed = true; reason = '统一写法(' + orig + '→' + target + ')';
    } else if (!orig) {
      // 3. 空单位：用品类标准或默认
      target = catStd || defaultUnit; changed = true; reason = '补默认(' + target + ')';
    }
    if (changed) {
      table.update(m.id, { unit: target, updated_at: ts });
      if (reason.includes('品类')) catFixed++; else if (reason.includes('统一')) unified++; else unified++;
      if (details.length < 50) details.push({ id: m.id, code: m.material_code, name: (m.material_name || '').substring(0, 20), from: orig || '(空)', to: target, reason });
    } else { skipped++; }
  });
  res.json({ message: '单位标准化完成', unified, category_fixed: catFixed, skipped, total: all.length, details });
});

// 物料库正确性与合理性检验
router.get('/quality-check', requirePerm('material:view'), (req, res) => {
  const table = getTable('materials');
  table._invalidate();
  const all = table.all();
  const issues = [];
  const sevOrder = { severe: 0, warning: 1, info: 2 };

  // 重复编码统计
  const codeCount = {};
  all.forEach(m => { const c = (m.material_code || '').trim(); if (c) codeCount[c] = (codeCount[c] || 0) + 1; });

  all.forEach(m => {
    const code = (m.material_code || '').trim();
    const name = (m.material_name || '').trim();
    const push = (type, severity, message) => issues.push({ id: m.id, material_code: code, material_name: name, type, severity, message });

    // 正确性（严重）
    if (!code) push('empty_code', 'severe', '物料编码为空');
    if (!name) push('empty_name', 'severe', '物料名称为空');
    if (code && codeCount[code] > 1) push('dup_code', 'severe', `物料编码重复(共${codeCount[code]}条)`);

    const cost = Number(m.standard_cost) || 0;
    const procCost = Number(m.processing_cost) || 0;
    const loss = Number(m.processing_loss) || 0;
    const inv = Number(m.inventory_qty) || 0;
    const minInv = Number(m.min_inventory) || 0;
    const monthly = Number(m.monthly_usage) || 0;
    const usage = Number(m.bom_usage_count) || 0;
    const usedIn = (m.used_in_products || '').trim();
    const cls = (m.classification || '').trim();
    const mtype = (m.material_type || '').trim();
    const cat = (m.category || '').trim();
    const unit = (m.unit || '').trim();

    // 合理性（严重/警告）
    if (cost < 0) push('neg_cost', 'severe', '标准成本为负数');
    if (procCost < 0) push('neg_proc', 'warning', '加工费为负数');
    if (loss < 0 || loss > 100) push('abnormal_loss', 'warning', `加工损耗率异常(${loss}%)`);
    if (!unit) push('empty_unit', 'warning', '单位为空');
    if (cost === 0 && mtype !== '自制') push('zero_cost', 'warning', '标准成本为0或未填');
    if (!cls) push('no_classification', 'warning', '未设置物料分类(建议运行自动分类)');
    if (minInv > 0 && inv <= minInv) push('low_inventory', 'warning', `库存不足(库存${inv}≤最低${minInv})`);
    if (monthly > 0 && inv <= 0) push('no_stock_with_usage', 'warning', '有月用量但库存为0');
    if (usage > 0 && !usedIn) push('usage_without_products', 'info', 'BOM使用次数>0但使用产品为空');
    if (mtype && cat && mtype !== cat) push('type_mismatch', 'info', `物料属性(${mtype})与分类(${cat})不一致`);
    if (code && /[^\w\-./]/.test(code)) push('code_format', 'info', '物料编码含特殊字符');
  });

  const bySeverity = { severe: 0, warning: 0, info: 0 };
  const byType = {};
  const affectedIds = new Set();
  issues.forEach(i => { bySeverity[i.severity]++; byType[i.type] = (byType[i.type] || 0) + 1; affectedIds.add(i.id); });

  res.json({
    total: all.length,
    affected: affectedIds.size,
    issue_count: issues.length,
    by_severity: bySeverity,
    by_type: byType,
    pass_rate: all.length ? Math.round((1 - affectedIds.size / all.length) * 1000) / 10 : 100,
    issues: issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])
  });
});

// 自动纠正可处理的质量问题
router.post('/quality-check/auto-fix', requirePerm('material:edit'), (req, res) => {
  const table = getTable('materials');
  const ruleTable = getTable('classification_rules');
  table._invalidate();
  ruleTable._invalidate();
  const all = table.all();
  const rules = ruleTable.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));
  const ts = now();
  const fixed = { no_classification: 0, type_mismatch: 0, zero_cost_from_bom: 0 };
  const details = [];

  function classifyByRules(mat) {
    for (const rule of rules) {
      const val = String(mat[rule.field] || '');
      let m = false;
      if (rule.operator === 'equals') m = val === rule.value;
      else if (rule.operator === 'contains') m = val.includes(rule.value);
      else if (rule.operator === 'startsWith') m = val.startsWith(rule.value);
      else if (rule.operator === 'gte') m = val !== '' && Number(val) >= Number(rule.value);
      if (m) return rule.result_category;
    }
    return '专用物料';
  }

  all.forEach(mat => {
    let changed = false;
    const fields = { updated_at: ts };
    // 未分类 → 按规则自动分类
    if (!mat.classification) {
      fields.classification = classifyByRules(mat);
      fixed.no_classification++;
      changed = true;
    }
    // 物料属性与分类不一致 → 以 material_type 为准同步 category
    const mtype = (mat.material_type || '').trim();
    const cat = (mat.category || '').trim();
    if (mtype && cat && mtype !== cat) {
      fields.category = mtype;
      fixed.type_mismatch++;
      changed = true;
    }
    if (changed) {
      table.update(mat.id, fields);
      details.push({ id: mat.id, material_code: mat.material_code, fixed: Object.keys(fields).filter(k => k !== 'updated_at') });
    }
  });

  res.json({
    message: '自动纠正完成',
    fixed_count: details.length,
    fixed,
    details: details.slice(0, 100)
  });
});

// ===== 智能最小库存推荐 =====
const fs = require('fs');
const path = require('path');
const POLICY_FILE = path.join(__dirname, '..', '..', 'database', 'inventory_policy.json');
const DEFAULT_POLICY = {
  value_tiers: [
    { name: '低货值', max_cost: 5 },
    { name: '中货值', max_cost: 100 },
    { name: '高货值', max_cost: null }
  ],
  strategy_months: {
    '通用物料': { '低货值': 1.0, '中货值': 0.5, '高货值': 0.25 },
    '常用物料': { '低货值': 1.0, '中货值': 0.5, '高货值': 0.25 },
    '专用物料': { '低货值': 0.5, '中货值': 0.3, '高货值': 0.1 },
    '定制物料': { '低货值': 0.3, '中货值': 0.2, '高货值': 0.1 }
  },
  default_classification: '专用物料',
  fallback_months: 0.3,
  volume_tiers: [
    { name: '小体积', max_volume: 0.002, factor: 1.0 },
    { name: '中体积', max_volume: 0.02, factor: 0.8 },
    { name: '大体积', max_volume: null, factor: 0.6 }
  ],
  volume_unit: 'm³',
  apply_volume_when_unknown: false,
  min_floor: 1,
  key_part_floor: 5,
  round_up: true
};

function loadInventoryPolicy() {
  try {
    if (fs.existsSync(POLICY_FILE)) {
      return Object.assign({}, DEFAULT_POLICY, JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')));
    }
  } catch (e) { console.error('读取库存策略失败: ', e.message); }
  return Object.assign({}, DEFAULT_POLICY);
}

function classifyValueTier(cost, policy) {
  const tiers = policy.value_tiers || DEFAULT_POLICY.value_tiers;
  for (const t of tiers) {
    if (t.max_cost === null || t.max_cost === undefined || Number(cost) <= Number(t.max_cost)) return t.name;
  }
  return tiers.length ? tiers[tiers.length - 1].name : '高货值';
}

function classifyVolumeFactor(volume, policy) {
  const v = Number(volume);
  if (!v || v <= 0 || !policy.apply_volume_when_unknown && !(volume > 0)) {
    return { factor: 1.0, tier: '未知' };
  }
  const tiers = policy.volume_tiers || DEFAULT_POLICY.volume_tiers;
  for (const t of tiers) {
    if (t.max_volume === null || t.max_volume === undefined || v <= Number(t.max_volume)) {
      return { factor: Number(t.factor), tier: t.name };
    }
  }
  return { factor: 1.0, tier: '未知' };
}

// 核心：根据 用量/分类/货值/体积 计算推荐最小库存
function computeRecommendedMin(mat, policy) {
  const cost = Number(mat.standard_cost) || 0;
  const mu = Number(mat.monthly_usage) || 0;
  const cls = (mat.classification && String(mat.classification).trim()) || policy.default_classification || '专用物料';
  const vTier = classifyValueTier(cost, policy);
  const strat = policy.strategy_months || DEFAULT_POLICY.strategy_months;
  let months = (strat[cls] && strat[cls][vTier] != null) ? Number(strat[cls][vTier])
    : (strat[policy.default_classification] && strat[policy.default_classification][vTier] != null ? Number(strat[policy.default_classification][vTier]) : Number(policy.fallback_months || 0.3));
  const vf = classifyVolumeFactor(mat.volume, policy);
  const floor = mat.key_part == 1 || (mat.certificate_required == '1' || mat.certificate_required === 1) ? Number(policy.key_part_floor || 5) : Number(policy.min_floor || 1);

  let recommended;
  let reason;
  if (mu > 0) {
    const raw = mu * months * vf.factor;
    recommended = policy.round_up === false ? Math.round(raw) : Math.ceil(raw);
    if (recommended < floor) recommended = floor;
    reason = `${cls}·${vTier}·${months}月用量×${mu}${vf.factor < 1 ? `·${vf.tier}×${vf.factor}` : ''}`;
  } else {
    recommended = floor;
    reason = `${cls}·${vTier}（月用量未填，取下限${floor}）`;
  }
  return { recommended, months, value_tier: vTier, volume_factor: vf.factor, volume_tier: vf.tier, classification: cls, floor, reason };
}

router.get('/inventory-policy', requirePerm('material:view'), (req, res) => {
  res.json(loadInventoryPolicy());
});

router.put('/inventory-policy', requirePerm('material:edit'), (req, res) => {
  const cur = loadInventoryPolicy();
  const next = Object.assign({}, cur, req.body || {});
  try {
    fs.writeFileSync(POLICY_FILE, JSON.stringify(next, null, 2), 'utf8');
    res.json({ message: '库存策略已保存', data: next });
  } catch (e) { res.status(500).json({ error: '保存失败: ' + e.message }); }
});

// 计算推荐：body { ids?:[], apply?:false, only_gap?:false, only_with_usage?:false, limit?:500 }
router.post('/inventory-policy/recommend', requirePerm('material:view'), (req, res) => {
  const policy = loadInventoryPolicy();
  const table = getTable('materials');
  table._invalidate();
  let mats = table.all();
  const ids = Array.isArray(req.body.ids) && req.body.ids.length ? new Set(req.body.ids.map(Number)) : null;
  if (ids) mats = mats.filter(m => ids.has(m.id));
  const limit = Math.min(parseInt(req.body.limit) || 2000, 20000);

  const results = [];
  for (const m of mats) {
    const r = computeRecommendedMin(m, policy);
    const cur = Number(m.min_inventory) || 0;
    const gap = r.recommended - cur;
    const action = gap > 0 ? 'increase' : gap < 0 ? 'decrease' : 'ok';
    if (req.body.only_gap && action === 'ok') continue;
    if (req.body.only_with_usage && !(Number(m.monthly_usage) > 0)) continue;
    results.push({
      id: m.id, material_code: m.material_code, material_name: m.material_name,
      supplier: m.supplier || '', classification: r.classification,
      standard_cost: Number(m.standard_cost) || 0, value_tier: r.value_tier,
      monthly_usage: Number(m.monthly_usage) || 0, volume: Number(m.volume) || 0, volume_tier: r.volume_tier,
      current_min: cur, recommended_min: r.recommended, gap, action, months: r.months,
      volume_factor: r.volume_factor, reason: r.reason
    });
    if (results.length >= limit) break;
  }

  let applied = 0;
  if (req.body.apply) {
    const ts = now();
    results.forEach(r => { table.update(r.id, { min_inventory: r.recommended_min, updated_at: ts }); applied++; });
  }
  results.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  res.json({
    total_scanned: mats.length, computed: results.length, applied,
    policy_version: policy.version || 1,
    results
  });
});

// 仅应用勾选的物料（或全部有差距的）
router.post('/inventory-policy/apply', requirePerm('material:edit'), (req, res) => {
  const policy = loadInventoryPolicy();
  const table = getTable('materials');
  table._invalidate();
  let mats = table.all();
  const ids = Array.isArray(req.body.ids) && req.body.ids.length ? new Set(req.body.ids.map(Number)) : null;
  if (ids) mats = mats.filter(m => ids.has(m.id));
  const ts = now();
  let applied = 0;
  const details = [];
  mats.forEach(m => {
    const r = computeRecommendedMin(m, policy);
    const cur = Number(m.min_inventory) || 0;
    if (r.recommended !== cur) {
      table.update(m.id, { min_inventory: r.recommended, updated_at: ts });
      applied++;
      if (details.length < 200) details.push({ id: m.id, code: m.material_code, from: cur, to: r.recommended });
    }
  });
  res.json({ message: '已应用推荐最小库存', applied, details });
});

router.get('/:id', requirePerm('material:view'), (req, res) => {
  const table = getTable('materials');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '物料不存在' });
  res.json(row);
});

router.post('/', requirePerm('material:create'), (req, res) => {
  const { product_id, material_name, material_code, category, specs, material_type,
          unit, standard_cost, processing_cost, processing_loss, supplier,
          status, unit_price, quantity,
          kit_cost, cable_cost, light_source_cost, driver_cost, battery_cost,
          bracket_cost, switch_cost, solar_panel_cost, socket_cost, box_cost,
          manual_cost, packaging_cost, accessory_cost, labor_cost,
          certificate_required, remarks,
          classification, inventory_qty, min_inventory, monthly_usage,
          procurement_enabled, procurement_cycle, procurement_qty, last_purchase_date, volume } = req.body;
  if (!material_name) return res.status(400).json({ error: '物料名称为必填项' });
  if (!material_code) return res.status(400).json({ error: '物料编码为必填项' });

  const table = getTable('materials');
  const existing = table.all().find(m => m.material_code === material_code);
  if (existing) return res.status(400).json({ error: '物料编码已存在', data: existing });

  const procFields = {
    procurement_enabled: Number(procurement_enabled) === 1 ? 1 : 0,
    procurement_cycle: Number(procurement_cycle) || 0,
    procurement_qty: Number(procurement_qty) || 0,
    last_purchase_date: last_purchase_date || ''
  };
  procFields.next_purchase_date = computeNextPurchaseDate(procFields);

  const result = table.insert({
    product_id: product_id || null, material_name, material_code: material_code || '',
    category: category || '', specs: specs || '', material_type: material_type || '',
    unit: unit || '个', standard_cost: standard_cost ? Number(standard_cost) : 0,
    processing_cost: processing_cost ? Number(processing_cost) : 0,
    processing_loss: processing_loss ? Number(processing_loss) : 0,
    supplier: supplier || '', status: status || 'active',
    unit_price: unit_price ? Number(unit_price) : 0, quantity: quantity ? Number(quantity) : 0,
    classification: classification || '通用物料',
    inventory_qty: inventory_qty ? Number(inventory_qty) : 0,
    min_inventory: min_inventory ? Number(min_inventory) : 0,
    monthly_usage: monthly_usage ? Number(monthly_usage) : 0,
    kit_cost: kit_cost ? Number(kit_cost) : 0, cable_cost: cable_cost ? Number(cable_cost) : 0,
    light_source_cost: light_source_cost ? Number(light_source_cost) : 0,
    driver_cost: driver_cost ? Number(driver_cost) : 0, battery_cost: battery_cost ? Number(battery_cost) : 0,
    bracket_cost: bracket_cost ? Number(bracket_cost) : 0, switch_cost: switch_cost ? Number(switch_cost) : 0,
    solar_panel_cost: solar_panel_cost ? Number(solar_panel_cost) : 0,
    socket_cost: socket_cost ? Number(socket_cost) : 0, box_cost: box_cost ? Number(box_cost) : 0,
    manual_cost: manual_cost ? Number(manual_cost) : 0, packaging_cost: packaging_cost ? Number(packaging_cost) : 0,
    accessory_cost: accessory_cost ? Number(accessory_cost) : 0, labor_cost: labor_cost ? Number(labor_cost) : 0,
    certificate_required: certificate_required ? Number(certificate_required) : 0, remarks: remarks || '',
    procurement_enabled: procFields.procurement_enabled,
    procurement_cycle: procFields.procurement_cycle,
    procurement_qty: procFields.procurement_qty,
    last_purchase_date: procFields.last_purchase_date,
    next_purchase_date: procFields.next_purchase_date,
    volume: volume ? Number(volume) : 0,
    bom_usage_count: 0, used_in_products: '', created_at: now(), updated_at: now()
  });
  res.json({ message: '物料创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('material:edit'), (req, res) => {
  const table = getTable('materials');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '物料不存在' });
  const fields = { updated_at: now() };
  ['product_id', 'material_name', 'material_code', 'category', 'specs', 'material_type',
   'unit', 'supplier', 'status', 'remarks', 'classification', 'used_in_products',
   'last_purchase_date'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['standard_cost', 'processing_cost', 'processing_loss', 'unit_price', 'quantity',
   'kit_cost', 'cable_cost', 'light_source_cost', 'driver_cost', 'battery_cost',
   'bracket_cost', 'switch_cost', 'solar_panel_cost', 'socket_cost', 'box_cost',
   'manual_cost', 'packaging_cost', 'accessory_cost', 'labor_cost',
   'inventory_qty', 'min_inventory', 'monthly_usage', 'bom_usage_count',
   'procurement_enabled', 'procurement_cycle', 'procurement_qty', 'volume',
   'certificate_required'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f] !== null ? Number(req.body[f]) : 0;
  });
  // 采购周期相关字段变更时，重新计算下次采购日期
  if (fields.procurement_enabled !== undefined || fields.procurement_cycle !== undefined || fields.last_purchase_date !== undefined) {
    fields.next_purchase_date = computeNextPurchaseDate({
      procurement_enabled: fields.procurement_enabled !== undefined ? fields.procurement_enabled : existing.procurement_enabled,
      procurement_cycle: fields.procurement_cycle !== undefined ? fields.procurement_cycle : existing.procurement_cycle,
      last_purchase_date: fields.last_purchase_date !== undefined ? fields.last_purchase_date : existing.last_purchase_date
    });
  }
  table.update(req.params.id, fields);

  const classificationChanged = fields.classification !== undefined && fields.classification !== existing.classification;
  const typeChanged = fields.material_type !== undefined && fields.material_type !== existing.material_type;
  let bomSynced = 0;
  if (classificationChanged || typeChanged) {
    const bomTable = getTable('product_bom');
    bomTable._invalidate();
    const code = (fields.material_code !== undefined ? fields.material_code : existing.material_code);
    if (code) {
      const bomFields = { updated_at: now() };
      if (classificationChanged) bomFields.material_category = fields.classification;
      if (typeChanged) bomFields.material_type = fields.material_type;
      bomTable.all().filter(b => b.code === code).forEach(b => {
        bomTable.update(b.id, bomFields);
        bomSynced++;
      });
    }
  }

  res.json({ message: '物料更新成功', data: table.findById(req.params.id), bomSynced });
});

// 批量删除：body { ids:[] }
router.post('/batch-delete', requirePerm('material:delete'), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids必须为非空数组' });
  const table = getTable('materials');
  table._invalidate();
  let deleted = 0;
  const notFound = [];
  ids.forEach(id => {
    const existing = table.findById(id);
    if (!existing) { notFound.push(id); return; }
    table.delete(id);
    deleted++;
  });
  res.json({ message: '批量删除完成', deleted, not_found: notFound });
});

// 批量设置状态：body { ids:[], status:'active'|'inactive' }
router.post('/batch-status', requirePerm('material:edit'), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  const status = req.body.status;
  if (!ids.length) return res.status(400).json({ error: 'ids必须为非空数组' });
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'status必须为 active 或 inactive' });
  const table = getTable('materials');
  table._invalidate();
  const ts = now();
  let updated = 0;
  const notFound = [];
  ids.forEach(id => {
    const existing = table.findById(id);
    if (!existing) { notFound.push(id); return; }
    table.update(id, { status, updated_at: ts });
    updated++;
  });
  res.json({ message: '批量状态更新完成', updated, status, not_found: notFound });
});

router.delete('/:id', requirePerm('material:delete'), (req, res) => {
  const table = getTable('materials');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '物料不存在' });
  table.delete(req.params.id);
  res.json({ message: '物料删除成功' });
});

// ===== 从BOM同步物料标准成本 =====
// 按 material_code 汇总 BOM 中各组件的 unit_price（取最高价作为标准成本，确保覆盖实际成本）
// body { method?: 'max'|'avg'|'latest', onlyMissing?: boolean }
router.post('/sync-cost-from-bom', requirePerm('material:edit'), (req, res) => {
  const method = ['max', 'avg', 'latest'].includes(req.body.method) ? req.body.method : 'max';
  const onlyMissing = req.body.onlyMissing !== false; // 默认只填充空缺的
  const bomTable = getTable('bom_items');
  const matTable = getTable('materials');
  bomTable._invalidate(); matTable._invalidate();

  // 收集每个物料代码的成本数据
  const costByCode = {};
  for (const b of bomTable.all()) {
    const code = (b.material_code || '').trim();
    if (!code) continue;
    const price = Number(b.unit_price) || 0;
    if (price <= 0) continue;
    if (!costByCode[code]) costByCode[code] = { prices: [], latest: 0, latestAt: '' };
    costByCode[code].prices.push(price);
    const upd = b.updated_at || b.created_at || '';
    if (upd > costByCode[code].latestAt) {
      costByCode[code].latestAt = upd;
      costByCode[code].latest = price;
    }
  }

  const materials = matTable.all();
  const ts = now();
  let updated = 0, skipped = 0, unmatched = 0;
  const details = [];
  for (const m of materials) {
    const code = (m.material_code || '').trim();
    if (!code) { skipped++; continue; }
    const data = costByCode[code];
    if (!data) { unmatched++; continue; }
    if (onlyMissing && Number(m.standard_cost) > 0) { skipped++; continue; }
    let cost = 0;
    if (method === 'avg') {
      cost = data.prices.reduce((s, p) => s + p, 0) / data.prices.length;
    } else if (method === 'latest') {
      cost = data.latest;
    } else {
      cost = Math.max(...data.prices); // max 覆盖所有产品的实际采购价
    }
    cost = Math.round(cost * 10000) / 10000;
    if (Number(m.standard_cost) !== cost) {
      m.standard_cost = cost;
      m.updated_at = ts;
      updated++;
      if (details.length < 20) details.push({ id: m.id, code, name: (m.material_name || '').substring(0, 20), from: 0, to: cost, sources: data.prices.length });
    }
  }
  matTable.saveNow();
  matTable._invalidate();
  res.json({
    message: `从BOM同步标准成本完成：更新${updated}个物料（方法=${method}，仅空缺=${onlyMissing}；BOM有成本的物料代码${Object.keys(costByCode).length}个，本地未匹配${unmatched}，跳过${skipped}）`,
    updated, unmatched, skipped, method, only_missing: onlyMissing,
    sample: details
  });
});

module.exports = router;
