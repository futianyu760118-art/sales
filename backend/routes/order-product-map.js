/**
 * 订单-产品映射表（订单导入时自动关联产品型号 + 展开分级BOM物料）
 * ------------------------------------------------------------------
 * 解决外部ERP订单编码与BOM产品编码不互通的问题：
 *   维护映射规则（订单某字段值 → BOM产品编码），导入时自动查表关联，
 *   关联成功后自动按当前单价展开该产品的分级BOM物料并生成计划成本快照。
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('order_product_map');

const MATCH_FIELDS = [
  { key: 'customer_name', label: '客户名称/编码（订单的 customer_name 字段）' },
  { key: 'customer_code', label: '客户代码（customer_code）' },
  { key: 'order_no', label: '订单号（order_no）' },
  { key: 'product_code', label: '产品编码（product_code，原样透传）' }
];
const MATCH_TYPES = [
  { key: 'exact', label: '精确匹配' },
  { key: 'prefix', label: '前缀匹配' },
  { key: 'contains', label: '包含匹配' }
];

function toNum(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

// ===== 核心：按映射表为订单解析产品型号 =====
// 返回 {product_code, product_name, map_id} 或 null
function resolveProductForOrder(order) {
  const table = getTable('order_product_map');
  table._invalidate();
  const rules = table.all().slice().sort((a, b) => (toNum(b.priority) || 0) - (toNum(a.priority) || 0));
  for (const r of rules) {
    if (!r.product_code || r.disabled) continue;
    const fieldVal = String(order[r.match_field] || '').trim();
    if (!fieldVal) continue;
    const key = String(r.match_key || '').trim();
    if (!key) continue;
    const t = r.match_type || 'exact';
    let hit = false;
    if (t === 'exact') hit = fieldVal === key;
    else if (t === 'prefix') hit = fieldVal.startsWith(key) || key.startsWith(fieldVal) && fieldVal.length > 3;
    else if (t === 'contains') hit = fieldVal.includes(key) || key.includes(fieldVal);
    if (hit) return { product_code: r.product_code, product_name: r.product_name || '', map_id: r.id, rule_id: r.id };
  }
  return null;
}

// ===== 自动展开分级BOM（调用 order-analysis 的计划成本核算）=====
async function autoExpandBom(orderId) {
  const orderAnalysis = require('./order-analysis');
  const orders = getTable('orders');
  const order = orders.findById(orderId);
  if (!order || !order.product_code) return null;
  orderAnalysis.clearMatPriceCache();
  const plan = await orderAnalysis.calcPlanCost(order);
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const snap = getTable('order_cost_snapshots');
  const logs = getTable('order_review_logs');
  const ts = now();
  let card = analysis.all().find(a => a.order_id === order.id);
  let cardId;
  const cardFields = {
    order_no: order.order_no,
    review_status: (card && card.review_status) || 'pending',
    plan_material_cost: plan.material, plan_labor_cost: plan.labor,
    plan_expense_cost: plan.expense, plan_total_cost: plan.total,
    plan_snapshot_at: ts, plan_gross_profit: plan.gross_profit, plan_gross_rate: plan.gross_rate,
    updated_at: ts
  };
  if (card) { cardId = card.id; await analysis.update(card.id, cardFields); }
  else {
    const r = await analysis.insert(Object.assign({
      order_id: order.id, reviewer_id: null, review_at: null, review_remark: '',
      actual_material_cost: null, actual_labor_cost: null, actual_expense_cost: null, actual_total_cost: null,
      actual_snapshot_at: null, created_at: ts
    }, cardFields));
    cardId = r.lastID;
  }
  // 写计划快照前清理旧快照（防重）
  for (const old of snap.all().filter(s => s.order_analysis_id === cardId && s.snapshot_type === 'plan')) {
    try { await snap.delete(old.id); } catch(_) {}
  }
  await snap.insert({
    order_analysis_id: cardId, order_id: order.id, order_no: order.order_no,
    snapshot_type: 'plan', material: plan.material, labor: plan.labor,
    expense: plan.expense, total: plan.total, order_qty: plan.order_qty,
    order_amount: plan.order_amount, gross_profit: plan.gross_profit, gross_rate: plan.gross_rate,
    products: plan.products, lines: plan.lines, warnings: plan.warnings,
    snapshot_time: ts, created_at: ts, source: 'import-auto'
  });
  // 同步分级 BOM 明细到订单号下（持久化为订单明细行）
  let detailsSynced = 0;
  try { const ds = await orderAnalysis.syncOrderBomDetails(order.id); detailsSynced = ds.synced || 0; } catch (_) {}
  return { card_id: cardId, plan_total: plan.total, lines: plan.lines.length, details_synced: detailsSynced };
}

// ===== 列表 =====
router.get('/', requirePerm('order-analysis:view'), (req, res) => {
  const { keyword, match_field, product_code } = req.query;
  const table = getTable('order_product_map');
  table._invalidate();
  let rows = table.all();
  if (match_field) rows = rows.filter(r => r.match_field === match_field);
  if (product_code) rows = rows.filter(r => (r.product_code || '').includes(product_code));
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    rows = rows.filter(r => [r.match_key, r.product_code, r.product_name, r.remarks].join(' ').toLowerCase().includes(kw));
  }
  rows.sort((a, b) => (b.id - a.id));
  res.json({ data: rows, total: rows.length });
});

// 元数据（匹配字段/类型 + BOM产品可选）
router.get('/meta', requirePerm('order-analysis:view'), (req, res) => {
  const bom = getTable('bom_items');
  bom._invalidate();
  const seen = {}; const products = [];
  bom.all().forEach(b => {
    const pc = (b.product_code || '').trim();
    if (!pc || seen[pc]) return;
    seen[pc] = 1;
    products.push({ product_code: pc, product_name: b.product_name || '' });
  });
  products.sort((a, b) => a.product_code.localeCompare(b.product_code));
  res.json({ match_fields: MATCH_FIELDS, match_types: MATCH_TYPES, bom_products: products });
});

// 覆盖统计（多少订单已映射/未映射）
router.get('/coverage', requirePerm('order-analysis:view'), (req, res) => {
  const orders = getTable('orders');
  orders._invalidate();
  const all = orders.all();
  let mapped = 0, unmapped = 0;
  const unmappedSample = [];
  all.forEach(o => {
    const r = resolveProductForOrder(o);
    if (r) mapped++;
    else { unmapped++; if (unmappedSample.length < 50) unmappedSample.push({ id: o.id, order_no: o.order_no, customer_name: o.customer_name, customer_code: o.customer_code }); }
  });
  res.json({ total: all.length, mapped, unmapped, unmapped_sample: unmappedSample });
});

// ===== CRUD =====
router.post('/', requirePerm('order-analysis:edit'), async (req, res) => {
  const b = req.body || {};
  if (!b.match_field || !b.match_key || !b.product_code) return res.status(400).json({ error: 'match_field/match_key/product_code 必填' });
  const table = getTable('order_product_map');
  // 查 BOM 产品名
  const bom = getTable('bom_items');
  const bomRow = bom.all().find(x => x.product_code === b.product_code);
  const ts = now();
  const rec = {
    match_field: b.match_field,
    match_type: b.match_type || 'exact',
    match_key: String(b.match_key).trim(),
    product_code: String(b.product_code).trim(),
    product_name: b.product_name || (bomRow && bomRow.product_name) || '',
    priority: Number(b.priority) || 0,
    disabled: b.disabled ? 1 : 0,
    remarks: b.remarks || '',
    created_at: ts, updated_at: ts
  };
  const r = await table.insert(rec);
  res.json({ message: '映射规则已创建', data: table.findById(r.lastID) });
});

router.put('/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  const table = getTable('order_product_map');
  const ex = table.findById(req.params.id);
  if (!ex) return res.status(404).json({ error: '映射规则不存在' });
  const b = req.body || {};
  const fields = { updated_at: now() };
  ['match_field', 'match_type', 'match_key', 'product_code', 'product_name', 'remarks'].forEach(f => { if (b[f] !== undefined) fields[f] = b[f]; });
  if (b.match_key !== undefined) fields.match_key = String(b.match_key).trim();
  if (b.product_code !== undefined) fields.product_code = String(b.product_code).trim();
  if (b.priority !== undefined) fields.priority = Number(b.priority) || 0;
  if (b.disabled !== undefined) fields.disabled = b.disabled ? 1 : 0;
  if (b.product_code !== undefined && !b.product_name) {
    const bom = getTable('bom_items');
    const bomRow = bom.all().find(x => x.product_code === b.product_code);
    if (bomRow) fields.product_name = bomRow.product_name || '';
  }
  await table.update(req.params.id, fields);
  res.json({ message: '已更新', data: table.findById(req.params.id) });
});

router.delete('/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  const table = getTable('order_product_map');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '映射规则不存在' });
  await table.delete(req.params.id);
  res.json({ message: '已删除' });
});

// ===== 批量应用：对现有订单解析映射 + 回填 product_code + 自动展开BOM =====
// body: { expand_bom?: true(默认), only_unmapped?: true(仅处理未关联产品的订单) }
router.post('/apply', requirePerm('order-analysis:edit'), async (req, res) => {
  const expandBom = req.body.expand_bom !== false;
  const onlyUnmapped = req.body.only_unmapped !== false;
  const orders = getTable('orders');
  orders._invalidate();
  const all = orders.all();
  let resolved = 0, alreadyLinked = 0, noRule = 0, expanded = 0, failed = 0;
  const noRuleSample = [];
  for (const o of all) {
    if (onlyUnmapped && o.product_code) { alreadyLinked++; continue; }
    const r = resolveProductForOrder(o);
    if (!r) { noRule++; if (noRuleSample.length < 30) noRuleSample.push({ id: o.id, order_no: o.order_no, customer_name: o.customer_name }); continue; }
    await orders.update(o.id, { product_code: r.product_code, product_name: r.product_name, updated_at: now() });
    resolved++;
    if (expandBom) {
      try { const e = await autoExpandBom(o.id); if (e) expanded++; else failed++; }
      catch (e) { failed++; }
    }
  }
  orders._invalidate();
  res.json({
    message: '映射应用完成',
    total_orders: all.length, resolved, already_linked: alreadyLinked, no_rule: noRule,
    bom_expanded: expanded, expand_failed: failed, no_rule_sample: noRuleSample
  });
});

// 为单个订单解析并展开（订单分析库详情页"自动关联"按钮调用）
router.post('/resolve/:orderId', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const r = resolveProductForOrder(order);
  if (!r) return res.status(404).json({ error: '未找到匹配的映射规则', code: 'NO_RULE' });
  await orders.update(order.id, { product_code: r.product_code, product_name: r.product_name, updated_at: now() });
  let expanded = null;
  if (req.body.expand_bom !== false) {
    try { expanded = await autoExpandBom(order.id); } catch (e) {}
  }
  res.json({ message: '已关联产品型号', product_code: r.product_code, product_name: r.product_name, expanded });
});

// ===== 智能型号段匹配：客户编码尾部型号段 → BOM产品编码 =====
// 业务背景：外部ERP订单不带产品编码（product_code 全 null）；客户编码（如 HJ003.177-585）
// 尾部内嵌产品型号段（585），可段级匹配 BOM 产品编码（如 JWA02-B1WA20C-585-02）。
// 一单多产品（一篮子）：命中的全部候选挂 order_products，product_code 置为最高分者，自动展开BOM。
// body: { apply?: true(默认), include_mapped?: true(默认，连同已有产品的订单一起重算覆盖), max_candidates?: 12 }
router.post('/auto-map-token', requirePerm('order-analysis:edit'), async (req, res) => {
  const doApply = req.body.apply !== false;
  const includeMapped = req.body.include_mapped !== false;
  const maxCand = Math.min(parseInt(req.body.max_candidates) || 12, 30);
  const bom = getTable('bom_items');
  bom._invalidate();
  const prodName = {};
  bom.all().forEach(b => { const p = (b.product_code || '').trim(); if (p && !(p in prodName)) prodName[p] = b.product_name || ''; });
  const prods = Object.keys(prodName);
  const prodSegs = {};
  prods.forEach(p => { prodSegs[p] = p.split('-').map(s => s.trim()); });
  const stripZeros = s => String(s).replace(/^0+(?=\d)/, '');
  function extractToken(cust) {
    const parts = String(cust || '').split(/[-.]/).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const t = parts[i].replace(/[A-Za-z]+$/, ''); // 去尾部字母 354PR->354 / 256JY->256
      if (t.length >= 3 && !/^0+$/.test(t)) return t; // 只取最后一个有效型号段
    }
    return '';
  }
  const isMain = p => !/^(Y-|P-|FJ-|CustBOM)/.test(p); // 主产品宇宙：排除样品/派生/附件/客户定制
  const verOf = c => { const m = c.product_code.match(/-(\d+)$/); return m ? parseInt(m[1], 10) : 0; };
  function matchIn(universe, tok) {
    const hits = [];
    for (const p of universe) {
      const segs = prodSegs[p];
      let score = 0, lastSegHit = false;
      const lastIdx = segs.length - 1;
      segs.forEach((s, i) => {
        let sc = 0;
        if (s === tok || stripZeros(s) === stripZeros(tok)) sc = 100;
        else if (s.length > tok.length && s.endsWith(tok) && /[A-Za-z]/.test(s[s.length - tok.length - 1])) sc = 80;
        if (sc) { if (sc > score) score = sc; if (i === lastIdx) lastSegHit = true; }
      });
      if (!score) continue;
      if (p.startsWith('P-')) score -= 5;
      if (p.startsWith('Y-')) score -= 8;
      if (p.startsWith('FJ-')) score -= 6;
      if (p.startsWith('3.1.')) score += 3;
      hits.push({ product_code: p, product_name: prodName[p] || '', score, _last: lastSegHit });
    }
    return hits;
  }
  function matchProducts(cust) {
    const tok = extractToken(cust);
    if (!tok) return [];
    // 两档：主产品宇宙优先，无命中回退全量
    let hits = matchIn(prods.filter(isMain), tok);
    if (!hits.length) hits = matchIn(prods, tok);
    if (!hits.length) return [];
    // 泛型号识别：命中段落在产品码末段的比例>60% → 该段是版本号而非型号（如 001），不用
    const lastRatio = hits.filter(h => h._last).length / hits.length;
    if (lastRatio > 0.6 || hits.length > maxCand * 8) return [];
    // 排序：分数 → 段数少（标准单品）→ 版本高 → 编码
    hits.sort((a, b) => b.score - a.score || prodSegs[a.product_code].length - prodSegs[b.product_code].length || verOf(b) - verOf(a) || a.product_code.localeCompare(b.product_code));
    // 前缀去重：3.1.X / P-X / Y-X / FJ-X 与 X 视为同一基础型号，保留高分者
    const seenBase = {};
    const out = [];
    for (const c of hits) {
      const base = c.product_code.replace(/^(P-|Y-|FJ-|3\.1\.)/, '');
      if (seenBase[base]) continue;
      seenBase[base] = 1;
      out.push(c);
      if (out.length >= maxCand) break;
    }
    return out;
  }
  const orders = getTable('orders');
  orders._invalidate();
  const op = getTable('order_products');
  op._invalidate();
  const ts = now();
  const prodExists = {};
  prods.forEach(p => { prodExists[p] = 1; });
  const results = { total: 0, mapped_orders: 0, products_attached: 0, bom_expanded: 0, expand_failed: 0, phantom_cleared: 0, uncovered: [], sample: [] };
  for (const o of orders.all()) {
    if (!includeMapped && o.product_code) continue;
    results.total++;
    // 幽灵产品清理：已指派的产品在 BOM 库不存在（旧规则错误数据），成本必为 0，清除
    if (doApply && o.product_code && !prodExists[o.product_code]) {
      await orders.update(o.id, { product_code: '', product_name: '', updated_at: ts });
      o.product_code = ''; o.product_name = '';
      op.deleteWhereNoSave(x => x.order_id === o.id);
      results.phantom_cleared++;
    }
    const cands = matchProducts(o.customer_name);
    if (!cands.length) {
      if (results.uncovered.length < 50) results.uncovered.push({ order_no: o.order_no, customer_name: o.customer_name, product_code: o.product_code || '' });
      continue;
    }
    if (results.sample.length < 15) results.sample.push({ order_no: o.order_no, customer_name: o.customer_name, candidates: cands.map(c => c.product_code) });
    if (doApply) {
      // 仅清除自动匹配的（保留用户手动添加的 source='manual'）
      op.deleteWhereNoSave(x => x.order_id === o.id && x.source !== 'manual');
      // 每产品数量 = 订单总数 / 候选数（均分估算，用户可在界面调整为实际数量）
      const ordQty = toNum(o.quantity) || 0;
      const ordAmt = toNum(o.order_amount) || 0;
      const perQty = cands.length ? Math.round((ordQty / cands.length) * 100) / 100 : 0;
      const perAmt = cands.length ? Math.round((ordAmt / cands.length) * 100) / 100 : 0;
      for (const c of cands) {
        op.insertNoSave({ order_id: o.id, order_no: o.order_no, product_code: c.product_code, product_name: c.product_name, quantity: perQty, amount: perAmt, source: 'auto-token', created_at: ts, updated_at: ts });
        results.products_attached++;
      }
      await op.saveNow();
      await orders.update(o.id, { product_code: cands[0].product_code, product_name: cands[0].product_name, updated_at: ts });
      o.product_code = cands[0].product_code;
      try { const e = await autoExpandBom(o.id); if (e) results.bom_expanded++; } catch (_) { results.expand_failed++; }
    } else {
      results.products_attached += cands.length;
    }
    results.mapped_orders++;
  }
  if (doApply) { op._invalidate(); orders._invalidate(); }
  res.json({
    message: (doApply ? '已按型号段重算覆盖' : '预览') + '：命中订单 ' + results.mapped_orders + '/' + results.total +
      '，挂产品 ' + results.products_attached + ' 个' + (doApply ? '，展开BOM ' + results.bom_expanded + ' 单' : '') +
      (results.phantom_cleared ? '，清除幽灵产品指派 ' + results.phantom_cleared + ' 单' : '') +
      (results.expand_failed ? '，展开失败 ' + results.expand_failed : '') + '，未覆盖 ' + (results.total - results.mapped_orders) + ' 单',
    applied: doApply, ...results
  });
});

module.exports = router;
module.exports.resolveProductForOrder = resolveProductForOrder;
module.exports.autoExpandBom = autoExpandBom;
