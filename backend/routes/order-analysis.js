/**
 * 订单分析库（经营中心）
 * ------------------------------------------------------------------
 * 四大能力：
 *   1. 订单审核：待审核 → 审核通过/驳回，留痕 review_logs
 *   2. 计划成本核算：BOM × 当前物料库单价（物料/工/费用 三层），落 plan 快照
 *   3. 同类订单差异比对：按产品编码 / 客户 / BOM 物料构成相似度 命中并逐项对比
 *   4. 计划 vs 实际比对：实际物料=领料单(material_issues)、人工=labor、费用=expenses，
 *      按 order_no 归集，分层差异，超支标红
 * 数据均来自系统内既有表，外部不对接。
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const externalSync = require('./external-sync');
const fetchExternal = externalSync.fetchExternal;
const fetchAllPages = externalSync.fetchAllPages;
const https = require('https');
const crypto = require('crypto');
const { APP_KEY: _ERP_KEY, APP_SECRET: _ERP_SECRET } = require('../lib/secrets');

// SPC boms.tree 接口签名（basicdata 风格：timestamp + app_key + ep + qs）
function _callErpExt(ep, qs) {
  return new Promise((resolve) => {
    if (!_ERP_KEY || !_ERP_SECRET) {
      return resolve({ s: 0, b: '未配置环境变量 EBMS_APP_KEY / EBMS_APP_SECRET' });
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const signStr = ts + _ERP_KEY + ep + qs;
    const sign = crypto.createHmac('sha256', _ERP_SECRET).update(signStr).digest('hex');
    const urlPath = '/api/v1/external/' + ep.replace(/\./g, '/') + '?' + qs;
    const req = https.request({
      hostname: '192.168.0.127', port: 18084, method: 'GET', rejectUnauthorized: false,
      path: urlPath,
      headers: { 'X-App-Key': _ERP_KEY, 'X-Timestamp': ts, 'X-Signature': sign },
      timeout: 15000
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d })); });
    req.on('error', () => resolve({ s: 0, b: 'err' }));
    req.on('timeout', () => { req.destroy(); resolve({ s: 0, b: 'timeout' }); });
    req.end();
  });
}

// 从 SPC 获取预组装的多级 BOM 树（boms.list → boms.tree）
// 结果按 bom_no 缓存（结构稳定；单价在转换时实时取物料库，故缓存原始树即可）
const _spcRawCache = new Map(); // bom_no -> { data, ts }
const _SPC_TTL = 30 * 60 * 1000; // 30 分钟
async function fetchSpcBomTree(bomNo) {
  const _c = _spcRawCache.get(bomNo);
  if (_c && Date.now() - _c.ts < _SPC_TTL) return _c.data;
  try {
    // 1. bom_no → bom_id
    const qs1 = 'bom_no=' + encodeURIComponent(bomNo) + '&page=1&page_size=1';
    const r1 = await _callErpExt('boms.list', qs1);
    if (r1.s !== 200) return null;
    const j1 = JSON.parse(r1.b);
    const items = (j1.data && j1.data.items) || [];
    if (!items.length) return null;
    const bomId = items[0].bom_id;
    // 2. boms.tree
    const qs2 = 'bom_id=' + encodeURIComponent(bomId);
    const r2 = await _callErpExt('boms.tree', qs2);
    if (r2.s !== 200) return null;
    const j2 = JSON.parse(r2.b);
    const data = j2.data || null;
    if (data) {
      _spcRawCache.set(bomNo, { data, ts: Date.now() });
      // 防内存无限增长：超过阈值时清理过期项，仍超则整体清空
      if (_spcRawCache.size > 3000) {
        const nowTs = Date.now();
        for (const [k, v] of _spcRawCache) { if (nowTs - v.ts >= _SPC_TTL) _spcRawCache.delete(k); }
        if (_spcRawCache.size > 3000) _spcRawCache.clear();
      }
    }
    return data;
  } catch (e) { return null; }
}

// 将 SPC 树转换为本地格式（含成本计算）
function _convertSpcTree(spcNodes, priceMap, orderQty, depth, laborRateMap) {
  depth = depth || 1;
  return spcNodes.map(function(n) {
    var mc = (n.material_code || '').trim();
    var curPrice = priceMap[mc];
    var useCurrent = curPrice !== undefined && curPrice !== 0;
    var unitPrice = useCurrent ? curPrice : 0;
    var lineQty = toNum(n.standard_qty) || 1;
    var mat = unitPrice * lineQty;
    var isSelfMade = n.has_sub_bom;
    // 工价库补入：只要 material_code 在工价库有 approved 工价就注入（不限于 has_sub_bom）
    var lr = laborRateMap ? (laborRateMap[mc] || 0) : 0;
    var labTotal = lr * lineQty * orderQty;
    var node = {
      material_code: mc,
      material_name: n.material_name || '',
      spec: n.spec_model || '',
      unit: n.unit || '',
      material_attr: isSelfMade ? '自制' : '外购',
      depth: depth,
      bom_qty: r2(lineQty),
      unit_price: r2(unitPrice),
      price_source: useCurrent ? '物料库当前价' : (unitPrice ? 'BOM单价' : '无价'),
      total_qty: r2(lineQty * orderQty),
      material_amount: r2(mat * orderQty),
      labor_amount: r2(labTotal),
      expense_amount: 0,
      line_total: r2(mat * orderQty + labTotal),
      has_children: !!(n.children && n.children.length),
      children: []
    };
    if (n.children && n.children.length) {
      node.children = _convertSpcTree(n.children, priceMap, orderQty, depth + 1, laborRateMap);
      // 父件物料成本 = 子件合计
      var cMat = 0;
      node.children.forEach(function(c) { cMat += c.material_amount; });
      node.material_amount = r2(cMat);
      node.line_total = r2(node.material_amount + node.labor_amount);
    }
    node.material_rollup = node.material_amount;
    node.labor_rollup = node.labor_amount;
    node.expense_rollup = 0;
    node.total_rollup = r2(node.material_amount + node.labor_amount);
    node.purchase_confirm_cost = node.material_amount;
    node.actual_cost = 0;
    return node;
  });
}

// 共享产品 BOM 构建：SPC boms.tree 优先 → 本地 BOM → 外部 bom_details 回退
// 供 _attachBomTrees / calcPlanCost / _computeOrderPlanCost 统一使用，保证三视图一致
async function buildProductBomAsync(prod, priceMap, laborRateMap) {
  const _isGeneric = function(code){ return !code || code === '3.1.FJ' || /^3\.1\.[A-Z]{2,4}$/.test(code); };
  const candidates = [
    prod.bom_no,
    (!_isGeneric(prod.product_code) ? prod.product_code : ''),
    prod.bom_no ? prod.bom_no.replace(/^3\.1\./, '') : '',
    (!_isGeneric(prod.product_code) ? (prod.product_code || '').replace(/^3\.1\./, '') : '')
  ].filter(Boolean);
  const qty = prod.quantity || 1;
  // 0) SPC 预组装树优先（SPC 为 ERP 权威多级 BOM，材料口径准确；本地 BOM 的 spcExpandBFS 会重复展开致材料偏高）
  if (prod.bom_no) {
    try {
      const spcData = await fetchSpcBomTree(prod.bom_no);
      if (spcData && spcData.tree && spcData.tree.length && spcData.total_nodes > 0) {
        const spcTree = _convertSpcTree(spcData.tree, priceMap, qty, 1, laborRateMap);
        const pMat = spcTree.reduce((s, n) => s + n.material_amount, 0);
        // 人工：深度累加所有节点的组件工价（工价库 approved，按 material_code 匹配）
        let pLab = 0;
        (function deepLab(nodes){ nodes.forEach(function(n){ pLab += Number(n.labor_amount)||0; if(n.children&&n.children.length) deepLab(n.children); }); })(spcTree);
        return { tree: spcTree, material: r2(pMat), labor: r2(pLab), expense: 0, total: r2(pMat + pLab), has_bom: true, source: 'spc' };
      }
    } catch (e) {}
  }
  // 1) 本地 BOM 回退：先找有层级的 BOM，都没有层级则用第一个有数据的
  let _hierTree = null, _flatTree = null;
  for (const tryCode of candidates) {
    const tree = buildBomTree(tryCode, qty, priceMap, laborRateMap);
    if (!tree.nodes || !tree.nodes.length) continue;
    const hasH = tree.nodes.some(n => n.has_children || (n.children && n.children.length > 0));
    const hasSM = tree.nodes.some(n => n.material_attr === '自制' || n.material_attr === '委外加工');
    if (hasH && !_hierTree) _hierTree = tree;
    else if (!hasH) {
      if (!_flatTree || (hasSM && !_flatTree.nodes.some(n => n.material_attr === '自制'))) _flatTree = tree;
    }
  }
  const bestTree = _hierTree || _flatTree;
  if (bestTree) {
    return { tree: bestTree.nodes, material: bestTree.material, labor: bestTree.labor, expense: bestTree.expense, total: bestTree.total, has_bom: true, source: 'local' };
  }
  // 2) 外部 bom_details 回退（SPC/本地均无数据时）
  if (prod.bom_no || prod.product_code) {
    try {
      const bomSearchKey = prod.bom_no || (prod.product_code || '').replace(/^3\.1\./, '').split('-').slice(0, -2).join('-');
      const bomData = await fetchExternal('boms.list', { bom_no: bomSearchKey, page: 1, page_size: 1 });
      if (bomData.items && bomData.items.length > 0) {
        const bomId = bomData.items[0].bom_id;
        const detailData = await fetchExternal('bom_details.list', { bom_id: bomId, page: 1, page_size: 200 });
        if (detailData.items && detailData.items.length) {
          const erpTree = _buildTreeFromExternalBom(detailData.items, qty);
          if (erpTree && erpTree.length) {
            let mat = 0, lab = 0, exp = 0;
            erpTree.forEach(n => { mat += toNum(n.material_amount || 0); lab += toNum(n.labor_amount || 0); exp += toNum(n.expense_amount || 0); });
            return { tree: erpTree, material: r2(mat), labor: r2(lab), expense: r2(exp), total: r2(mat + lab + exp), has_bom: true, source: 'external' };
          }
        }
      }
    } catch (e) {}
  }
  return { tree: [], material: 0, labor: 0, expense: 0, total: 0, has_bom: false, source: 'none' };
}

ensureTable('order_analysis');
ensureTable('order_review_logs');
ensureTable('order_cost_snapshots');
ensureTable('order_products'); // 订单多产品：order_id -> [product_code, product_name]

// ===== 工具 =====
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}
const r2 = n => Math.round(toNum(n) * 100) / 100;

// 物料库当前单价映射：material_code -> unit_price
let _matPriceCache = null, _matPriceTs = 0;
function buildMaterialPriceMap() {
  const mat = getTable('materials');
  // 5 分钟缓存，避免每次核算全表扫描
  if (_matPriceCache && Date.now() - _matPriceTs < 5 * 60 * 1000) return _matPriceCache;
  mat._invalidate();
  const map = {};
  mat.all().forEach(m => {
    const code = (m.material_code || '').trim();
    if (code) {
      // 同编码取最新（updated_at 最大）单价
      if (map[code] === undefined || String(m.updated_at || '') > String(map[code + '__ts'] || '')) {
        map[code] = toNum(m.unit_price);
        map[code + '__ts'] = m.updated_at || '';
      }
    }
  });
  // 清理临时键
  Object.keys(map).forEach(k => { if (k.endsWith('__ts')) delete map[k]; });
  _matPriceCache = map;
  _matPriceTs = Date.now();
  return map;
}
function clearMatPriceCache() { _matPriceCache = null; _matPriceTs = 0; _bomIndexCache = null; _bomIndexTs = 0; }

// ===== 成品工价库索引（bom_no → labor_rate），5 分钟缓存 =====
// 用于 BOM 子件人工补入：当 BOM 自带 direct_labor=0 时，从工价库查单台工价
let _laborRateCache = null, _laborRateTs = 0;
function buildLaborRateMap() {
  if (_laborRateCache && Date.now() - _laborRateTs < 5 * 60 * 1000) return _laborRateCache;
  try {
    const lr = getTable('product_labor_rate');
    lr._invalidate();
    const map = {};
    lr.all().forEach(r => {
      // 只取 approved 且在生效期内的，同 bom_no 取最新
      if (r.audit_status !== 'approved') return;
      const today = new Date().toISOString().substring(0, 10);
      if (r.effective_date && r.effective_date > today) return;
      if (r.expire_date && r.expire_date < today) return;
      const key = (r.bom_no || '').trim();
      if (!key) return;
      // 同 bom_no 多版本时：updated_at 最新的优先，同时间戳则 id 最大（调整后的新版本）优先
      const prevTs = map[key + '__ts'] || '';
      const prevId = map[key + '__id'] || 0;
      if (map[key] === undefined || String(r.updated_at || '') > prevTs ||
          (String(r.updated_at || '') === prevTs && r.id > prevId)) {
        map[key] = toNum(r.labor_rate);
        map[key + '__ts'] = r.updated_at || '';
        map[key + '__id'] = r.id;
      }
    });
    Object.keys(map).forEach(k => { if (k.endsWith('__ts') || k.endsWith('__id') || k.endsWith('__src')) delete map[k]; });
    _laborRateCache = map;
  } catch(e) { _laborRateCache = {}; }
  _laborRateTs = Date.now();
  return _laborRateCache;
}
function clearLaborRateCache() { _laborRateCache = null; _laborRateTs = 0; }

// ===== 订单计划成本缓存（用于列表接口展示 plan_total_cost）=====
// 与 /line-items 用同一算法（合并 order_products 同型号 qty + 去重 BOM + 子 BOM 递归 + 外购件提位）
// 缓存键：orderId，值：{material, labor, expense, total}
const _orderPlanCostCache = new Map();
let _opIndexCache = null, _opIndexTs = 0;
function getOrderProductsIndex() {
  if (_opIndexCache && Date.now() - _opIndexTs < 60 * 1000) return _opIndexCache;
  const op = getTable('order_products');
  op._invalidate();
  const idx = {};
  op.all().forEach(r => {
    const oid = Number(r.order_id);
    if (!isNaN(oid)) (idx[oid] = idx[oid] || []).push(r);
  });
  _opIndexCache = idx; _opIndexTs = Date.now();
  return idx;
}

function _invalidateOrderPlanCostCache(orderId) {
  if (orderId != null) _orderPlanCostCache.delete(Number(orderId));
  else _orderPlanCostCache.clear();
  _opIndexCache = null;
}

function _computeOrderPlanCost(orderId) {
  const cached = _orderPlanCostCache.get(Number(orderId));
  if (cached) return cached;

  const orders = getTable('orders');
  const order = orders.findById(Number(orderId));
  if (!order) return null;
  const ops = (getOrderProductsIndex()[Number(orderId)] || []);
  if (!ops.length) return null;

  // 按 product_code + bom_no 合并 qty（同产品不同 BOM 变体分别核算）
  const agg = {};
  ops.forEach(p => {
    const k = (p.product_code || '') + '||' + (p.bom_no || '');
    if (!p.product_code) return;
    if (!agg[k]) agg[k] = { product_code: p.product_code, quantity: 0, bom_no: p.bom_no || '' };
    agg[k].quantity += toNum(p.quantity);
  });
  const mergedProducts = Object.values(agg);

  const priceMap = buildMaterialPriceMap();
  const laborRateMap = buildLaborRateMap();
  let matTotal = 0, labTotal = 0, expTotal = 0;
  for (const prod of mergedProducts) {
    const tree = buildBomTreeForProduct(prod, priceMap, laborRateMap);
    matTotal += Number(tree.material) || 0;
    labTotal += Number(tree.labor) || 0;
    expTotal += Number(tree.expense) || 0;
  }

  // 加入成品工价 + 费用
  // 优先从 product_labor_rate（工价库 approved）读取，其次从 order_analysis.product_rates 回退
  const analysis = getTable('order_analysis');
  const card = analysis.all().find(a => a.order_id === Number(orderId));
  let rateTotal = 0, feeTotal = 0;
  const rateSource = {}; // 记录每个产品的工价来源
  // 先从工价库查
  mergedProducts.forEach(prod => {
    const key = prod.bom_no || prod.product_code;
    if (!key) return;
    const qty = Number(prod.quantity) || 1;
    // 1. 工价库 approved
    if (laborRateMap[key] && laborRateMap[key] > 0) {
      const rate = Number(laborRateMap[key]) || 0;
      rateTotal += rate * qty;
      feeTotal += rate * 0.25 * qty;
      rateSource[key] = '工价库(' + rate + ')';
      return;
    }
    // 2. order_analysis.product_rates 回退
    if (card && card.product_rates) {
      try {
        const rates = JSON.parse(card.product_rates);
        if (rates[key] != null) {
          const rate = Number(rates[key]) || 0;
          if (rate > 0) {
            rateTotal += rate * qty;
            feeTotal += rate * 0.25 * qty;
            rateSource[key] = '订单录入(' + rate + ')';
          }
        }
      } catch(e) {}
    }
  });

  const result = {
    material: r2(matTotal),
    labor: r2(labTotal + rateTotal),
    expense: r2(expTotal + feeTotal),
    total: r2(matTotal + labTotal + expTotal + rateTotal + feeTotal)
  };
  _orderPlanCostCache.set(Number(orderId), result);
  return result;
}

// 外部 ERP 工价数据源配置（labor_rate_endpoint）
function getLaborRateConfig() {
  let epCode = 'labor_rates.list', configField = 'labor_amount';
  try {
    const settings = getTable('system_settings');
    const cfgRow = settings.all().find(r => r.key === 'labor_rate_endpoint');
    if (cfgRow) {
      const c = JSON.parse(cfgRow.value || '{}');
      epCode = c.endpoint || epCode;
      configField = c.field || configField;
    }
  } catch(e) {}
  return { endpoint: epCode, field: configField };
}

// 从外部 ERP labor_rates.list 自动导入成品工价并持久化到 order_analysis.product_rates
// 只补缺失 bom_no 的工价（已有值不覆盖），锁定订单跳过；导入后失效 plan 成本缓存
async function autoImportLaborRates(orderId) {
  try {
    const oid = Number(orderId);
    const ops = (getOrderProductsIndex()[oid] || []);
    const bomNos = [...new Set(ops.map(p => (p.bom_no || '').trim()).filter(Boolean))];
    if (!bomNos.length) return { called: 0, updated: 0 };
    const analysis = getTable('order_analysis');
    analysis._invalidate();
    const card = analysis.all().find(a => a.order_id === oid);
    if (card && card.is_locked) return { called: 0, updated: 0, locked: true };
    let saved = {};
    if (card && card.product_rates) { try { saved = JSON.parse(card.product_rates); } catch(e) {} }
    const missing = bomNos.filter(bn => saved[bn] == null);
    if (!missing.length) return { called: 0, updated: 0, missing: 0 };
    const cfg = getLaborRateConfig();
    const fetched = {};
    await Promise.all(missing.map(async (bn) => {
      try {
        const d = await Promise.race([
          fetchExternal(cfg.endpoint, { bom_no: bn, page: 1, page_size: 1 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
        ]);
        const its = (d && d.items) || (d && d.data && d.data.items) || [];
        if (its.length) {
          const r = Number(its[0][cfg.field] || its[0].labor_amount || its[0].wage || its[0].labor_cost || 0);
          if (r > 0) fetched[bn] = r;
        }
      } catch(e) {}
    }));
    if (!Object.keys(fetched).length) return { called: missing.length, updated: 0 };
    Object.keys(fetched).forEach(bn => { saved[bn] = fetched[bn]; });
    if (!card) {
      card = { order_id: oid, order_no: (ops[0] && ops[0].order_no) || '', created_at: now(), updated_at: now() };
      const ins = await analysis.insert(card);
      card.id = ins.lastID;
    }
    await analysis.update(card.id, { product_rates: JSON.stringify(saved), updated_at: now() });
    analysis._invalidate();
    _invalidateOrderPlanCostCache(oid);
    return { called: missing.length, updated: Object.keys(fetched).length };
  } catch (e) {
    return { called: 0, updated: 0, error: e.message };
  }
}

// 同步版产品 BOM 核算：优先取 SPC 缓存树，未命中回退本地 BOM
// （与异步 buildProductBomAsync 同口径，但仅走缓存/本地，供 _computeOrderPlanCost 同步使用）
function buildBomTreeForProduct(prod, priceMap, laborRateMap) {
  // 0) SPC 缓存树优先（与 buildProductBomAsync 同口径）
  if (prod.bom_no) {
    const _c = _spcRawCache.get(prod.bom_no);
    if (_c && Date.now() - _c.ts < _SPC_TTL && _c.data && _c.data.tree && _c.data.tree.length && _c.data.total_nodes > 0) {
      const spcTree = _convertSpcTree(_c.data.tree, priceMap, prod.quantity || 1, 1, laborRateMap);
      const pMat = spcTree.reduce((s, n) => s + n.material_amount, 0);
      let pLab = 0;
      (function deepLab(nodes){ nodes.forEach(function(n){ pLab += Number(n.labor_amount)||0; if(n.children&&n.children.length) deepLab(n.children); }); })(spcTree);
      return { material: r2(pMat), labor: r2(pLab), expense: 0, total: r2(pMat + pLab) };
    }
  }
  // 1) 本地 BOM 回退
  var _skipGeneric = !prod.product_code || prod.product_code === '3.1.FJ' || /^3\.1\.[A-Z]{1,6}$/.test(prod.product_code);
  const candidates = [
    prod.bom_no,
    _skipGeneric ? '' : prod.product_code,
    prod.bom_no ? prod.bom_no.replace(/^3\.1\./, '') : '',
    _skipGeneric ? '' : (prod.product_code || '').replace(/^3\.1\./, '')
  ].filter(Boolean);
  let _hTree = null, _fTree = null;
  for (const tryCode of candidates) {
    const t = buildBomTree(tryCode, prod.quantity || 1, priceMap, laborRateMap);
    if (!t.nodes || !t.nodes.length) continue;
    const h = t.nodes.some(n => n.has_children || (n.children && n.children.length > 0));
    const hasSelfMade = t.nodes.some(n => n.material_attr === '自制' || n.material_attr === '委外加工');
    if (h && !_hTree) _hTree = t;
    else if (!h) {
      if (!_fTree || (hasSelfMade && !_fTree.nodes.some(n => n.material_attr === '自制'))) _fTree = t;
    }
  }
  const tree = _hTree || _fTree;
  if (tree) return { material: tree.material || 0, labor: tree.labor || 0, expense: tree.expense || 0, total: tree.total || 0 };
  return { material: 0, labor: 0, expense: 0, total: 0 };
}

// 取某 product_code 的 BOM 明细（有效行）
// 性能：bom_items 已达 10 万行级，逐产品 _invalidate 会整表重读+解析 JSON（批量展开时为灾难）。
// 改为产品编码索引缓存（5 分钟），批量核算只扫一次全表。
let _bomIndexCache = null, _bomIndexTs = 0;
function getBomIndex() {
  if (_bomIndexCache && Date.now() - _bomIndexTs < 5 * 60 * 1000) return _bomIndexCache;
  const bom = getTable('bom_items');
  bom._invalidate();
  const idx = {};
  bom.all().forEach(b => {
    const pc = (b.product_code || '').trim();
    if (!pc) return;
    if (String(b.is_disabled || '0') === '1') return;
    (idx[pc] = idx[pc] || []).push(b);
  });
  _bomIndexCache = idx; _bomIndexTs = Date.now();
  return idx;
}
function getBomLines(productCode) {
  if (!productCode) return [];
  const idx = getBomIndex();
  return idx[String(productCode).trim()] || [];
}

// ===== 单行成本：成本 + BOM工价 + BOM费用 =====
// 成本 = 物料库当前单价 × BOM数量
// BOM工价 = direct_labor + outsource_labor + processing_fee（若有）
// BOM费用 = variable_overhead + fixed_overhead（若有）
// 以上三者都纳入产品成本（与自制件整体成本一致）
function lineCostPerUnit(line, priceMap, laborRateMap) {
  const lineQty = toNum(line.quantity) || 0;
  const bomUnitPrice = toNum(line.unit_price);
  const curPrice = priceMap[(line.material_code || '').trim()];
  const useCurrent = curPrice !== undefined && curPrice !== 0;
  const unitPrice = useCurrent ? curPrice : bomUnitPrice;
  const priceSource = useCurrent ? '物料库当前价' : (bomUnitPrice ? 'BOM单价' : '无价');
  const mat = unitPrice * lineQty;
  // BOM 自制件工价：直接人工 + 外协人工 + 加工费
  let lab = (toNum(line.direct_labor) + toNum(line.outsource_labor) + toNum(line.processing_fee)) * lineQty;
  let labSource = 'BOM自带';
  // BOM 自带工价为 0 时，从成品工价库补入（按 material_code 匹配 approved 工价）
  if (lab === 0 && laborRateMap) {
    const rate = laborRateMap[(line.material_code || '').trim()];
    if (rate && rate > 0) {
      lab = rate * lineQty;
      labSource = '工价库';
    }
  }
  // BOM 自制件费用：变动制造费用 + 固定制造费用
  const exp = (toNum(line.variable_overhead) + toNum(line.fixed_overhead)) * lineQty;
  return { unitPrice, priceSource, bomUnitPrice, bomQty: lineQty, mat, lab, exp, labSource };
}

// level 深度：'.1'->1, '..2'->2, '...3'->3；'0.1'(产品根)->0
function levelDepth(line) {
  const s = String(line.level || '.1').trim();
  if (s.indexOf('0') === 0) return 0; // 产品根行
  let d = 0;
  for (const ch of s) { if (ch === '.') d++; else break; }
  return d || 1;
}

// 构建多级 BOM 树（按 level 缩进 + 行序确定父子关系），含成本逐级汇总
function buildBomTree(productCode, orderQty, priceMap, laborRateMap) {
  const bomLines = getBomLines(productCode);
  if (!bomLines.length) return { nodes: [], warnings: ['产品 ' + productCode + ' 在 BOM 中无明细'] };
  const warnings = [];
  const lines = bomLines.filter(l => levelDepth(l) > 0); // 排除产品根行(0.1)

  // ===== 树构建后合并重复节点（同 depth+code 节点合并子件，避免重复计数且保留层级）=====
  // 重复行是外部同步的数据复制 bug（同一物料出现多次），不是真实多次需求。
  // 合并时：保留首次出现的 bom_qty（不累加），子件取并集。
  function _mergeDupNodes(nodes) {
    const map = new Map();
    const result = [];
    for (const n of nodes) {
      const key = n.depth + '|' + (n.material_code || '');
      const existing = map.get(key);
      if (existing) {
        // 合并子件（避免重复，保留所有子件）
        for (const c of n.children) {
          if (!existing.children.some(x => x.material_code === c.material_code && x.depth === c.depth)) {
            existing.children.push(c);
          }
        }
        // 不累加数量（重复行是数据复制，非真实需求）
      } else {
        map.set(key, n);
        result.push(n);
      }
    }
    // 递归合并子件
    result.forEach(n => { if (n.children && n.children.length) n.children = _mergeDupNodes(n.children); });
    return result;
  }

  const root = { depth: 0, children: [] };
  const stack = [root];
  lines.forEach(line => {
    const d = levelDepth(line);
    while (stack.length > 1 && stack[stack.length - 1].depth >= d) stack.pop();
    const c = lineCostPerUnit(line, priceMap, laborRateMap);
    const node = {
      material_code: line.material_code || '',
      material_name: line.material_name || '',
      spec: line.spec || '',
      unit: line.unit || '',
      material_attr: line.material_attr || '',
      key_part: line.key_part || '',
      depth: d,
      bom_qty: c.bomQty,
      unit_price: c.unitPrice,
      price_source: c.priceSource,
      _matPerParent: c.mat, _labPerParent: c.lab, _expPerParent: c.exp,
      children: []
    };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });

  // 合并重复节点（同 depth+code 合并子件，避免重复计数且保留层级）
  root.children = _mergeDupNodes(root.children);

  // ===== SPC 多级 BOM 展开（BFS + material_id 桥接 + 防环 + 限深）=====
  // 核心规则：子件的 material_code 在 bom_items 中是否存在 product_code 记录，
  // 若存在则该子件有下一级 BOM，继续展开；否则为叶子节点，停止。
  // 数量计算：纯连乘 standard_qty × parent_factor（不除 base_qty）。
  (function spcExpandBFS() {
    const MAX_LEVEL = 20;
    const visited = new Set(); // material_code 防环
    function expandOne(node, depth) {
      if (depth >= MAX_LEVEL) return;
      if (node.children && node.children.length) return; // 已有子件（来自 dot-format 层级）
      const mc = (node.material_code || '').trim();
      if (!mc || visited.has(mc)) return;
      // 查询该子件是否有自己的 BOM（material_code 作为 product_code）
      const subLines = getBomLines(mc).filter(function(l) {
        return levelDepth(l) > 0 && (l.material_code || '').trim();
      });
      if (!subLines.length) return;
      visited.add(mc);
      // 构建子树（扁平 → 树）
      const subStack = [{ depth: 0, children: [] }];
      subLines.forEach(function(line) {
        const sd = levelDepth(line);
        while (subStack.length > 1 && subStack[subStack.length - 1].depth >= sd) subStack.pop();
        const sc = lineCostPerUnit(line, priceMap, laborRateMap);
        const sn = {
          material_code: line.material_code || '',
          material_name: line.material_name || '',
          spec: line.spec || '',
          unit: line.unit || '',
          material_attr: line.material_attr || '',
          key_part: line.key_part || '',
          depth: sd,
          bom_qty: sc.bomQty,
          unit_price: sc.unitPrice,
          price_source: sc.priceSource,
          _matPerParent: sc.mat, _labPerParent: sc.lab, _expPerParent: sc.exp,
          children: []
        };
        subStack[subStack.length - 1].children.push(sn);
        subStack.push(sn);
      });
      if (subStack[0].children.length) {
        node.children = subStack[0].children;
        // 递归展开下一层
        node.children.forEach(function(c) { expandOne(c, depth + 1); });
      }
    }
    // BFS：从所有根节点开始
    root.children.forEach(function(n) { expandOne(n, 1); });
  })();

  // ===== 数据纠错：外购件不应有子件 =====
  // 因 BOM 数据中可能出现"外购件"被错误缩进而挂上了子件（如热熔胶下挂着毛坯件），
  // 若直接 rollup 会造成成本重复计算（外购单价 + 子件成本）。
  // 这里把外购件的子件提升为同级兄弟节点（修正隶属关系 + 避免重复计算）。
  root.children = (function detachPurchasedChildren(nodes) {
    const out = [];
    nodes.forEach(n => {
      const isPurchased = n.material_attr === '外购' || n.material_attr === '外购件' || n.material_attr === '外购标准件';
      if (isPurchased && n.children && n.children.length) {
        // 外购件有子件 → 保留外购件本身，把子件全部提到同级
        out.push(n);
        // 先递归修正子件（可能嵌套）
        detachPurchasedChildren(n.children).forEach(c => {
          c.depth = n.depth; // 保持与父件同级
          out.push(c);
        });
        n.children = [];
        n.has_children = false;
      } else {
        out.push(n);
        if (n.children && n.children.length) {
          n.children = detachPurchasedChildren(n.children);
        }
      }
    });
    return out;
  })(root.children);

  // 递归：所有层级统一用 orderQty 作为乘数（BOM中 qty 是整灯用量）
  function rollup(node, multiplier) {
    node.total_qty = r2(node.bom_qty * multiplier);
    var ownMat = r2(node._matPerParent * multiplier);
    var ownLab = r2(node._labPerParent * multiplier);
    var ownExp = r2(node._expPerParent * multiplier);
    // 先递归子件
    node.children.forEach(ch => { rollup(ch, multiplier); });
    if (node.children.length > 0) {
      // 有子件：物料成本 = 子件合计，但保留自身的人工/费用（自制件的加工费等）
      let rMat = 0;
      node.children.forEach(ch => { rMat += ch.material_rollup; });
      node.material_amount = r2(rMat);
      node.labor_amount = ownLab; // 保留自身人工（加工费等）
      node.expense_amount = ownExp;
      node.material_rollup = r2(rMat);
      node.labor_rollup = r2(ownLab);
      node.expense_rollup = r2(ownExp);
    } else {
      node.material_amount = ownMat;
      node.labor_amount = ownLab;
      node.expense_amount = ownExp;
      node.material_rollup = ownMat;
      node.labor_rollup = ownLab;
      node.expense_rollup = ownExp;
    }
    node.line_total = r2(node.material_amount + node.labor_amount + node.expense_amount);
    node.total_rollup = r2(node.material_rollup + node.labor_rollup + node.expense_rollup);
    node.has_children = node.children.length > 0;
    node.purchase_confirm_cost = node.material_amount;
    node.actual_cost = 0;
    delete node._matPerParent; delete node._labPerParent; delete node._expPerParent;
  }
  root.children.forEach(n => rollup(n, orderQty));

  // 产品级汇总：根节点成本之和
  // 规则：若自制件有子件且子件包含外购物料（真实组件），则用 rollup（含子件成本）；
  //       若子件全是自制（制造阶段），则用自身 material_amount（整体成本，避免重复）
  // 产品级汇总：根节点 material_amount 之和（整体成本模型：自制件 unit_price 含子件）
  let pMat = 0, pLab = 0, pExp = 0;
  root.children.forEach(n => {
    pMat += n.material_amount || 0;
    pLab += n.labor_amount || 0;
    pExp += n.expense_amount || 0;
  });
  return {
    nodes: root.children,
    material: r2(pMat), labor: r2(pLab), expense: r2(pExp), total: r2(pMat + pLab + pExp),
    warnings
  };
}

// 把树扁平化成行（兼容旧 lines 字段，带 depth 用于缩进展示）
function flattenTree(nodes, out) {
  out = out || [];
  nodes.forEach(n => {
    out.push({
      material_code: n.material_code, material_name: n.material_name, spec: n.spec, unit: n.unit,
      material_attr: n.material_attr, key_part: n.key_part, depth: n.depth,
      has_children: n.has_children,
      bom_qty: r2(n.bom_qty), total_qty: n.total_qty, unit_price: r2(n.unit_price), price_source: n.price_source,
      material_amount: n.material_amount, labor_amount: n.labor_amount, expense_amount: n.expense_amount,
      line_total: n.line_total,
      material_rollup: n.material_rollup, labor_rollup: n.labor_rollup, expense_rollup: n.expense_rollup,
      total_rollup: n.total_rollup
    });
    if (n.children && n.children.length) flattenTree(n.children, out);
  });
  return out;
}

// ===== 订单 BOM 明细同步：把分级 BOM 物料持久化为订单的明细行 =====
// 每次同步覆盖该订单的明细行（保留层级路径，便于查询/导出/汇总）
// opts.skipCacheClear: 批量同步场景下由外层统一清一次缓存，避免每条订单都重建 BOM 索引
ensureTable('order_bom_details');
async function syncOrderBomDetails(orderId, opts) {
  opts = opts || {};
  const orders = getTable('orders');
  const order = orders.findById(orderId);
  if (!order) return { synced: 0, ok: false, reason: '订单不存在' };
  if (!order.product_code) return { synced: 0, ok: false, reason: '订单未关联产品型号', code: 'NO_PRODUCT' };
  if (!opts.skipCacheClear) clearMatPriceCache();
  const plan = await calcPlanCost(order);
  const det = getTable('order_bom_details');
  // 批量模式下不 invalidate（保留内存中已累计的其他订单明细，由外层统一 saveNow）
  if (!opts.skipSave) det._invalidate();
  // 删除该订单旧明细（批量：仅改内存不落盘，随末尾 saveNow 一次写入）
  det.deleteWhereNoSave(x => x.order_id === order.id);
  const ts = now();
  let count = 0;
  for (const p of plan.products) {
    const walk = async (nodes, parentPath, parentCode) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const path = parentPath ? (parentPath + '.' + i) : String(i);
        await det.insertNoSave({
          order_id: order.id, order_no: order.order_no,
          product_code: p.product_code, product_name: p.product_name || '',
          depth: n.depth, path: path, parent_path: parentPath || '', parent_material_code: parentCode || '',
          material_code: n.material_code || '', material_name: n.material_name || '', spec: n.spec || '', unit: n.unit || '',
          material_attr: n.material_attr || '', key_part: n.key_part || '',
          bom_qty: r2(n.bom_qty), total_qty: n.total_qty, unit_price: r2(n.unit_price), price_source: n.price_source || '',
          material_amount: n.material_amount, labor_amount: n.labor_amount, expense_amount: n.expense_amount, line_total: n.line_total,
          material_rollup: n.material_rollup, labor_rollup: n.labor_rollup, expense_rollup: n.expense_rollup, total_rollup: n.total_rollup,
          has_children: n.has_children ? 1 : 0, order_qty: p.order_qty, order_amount: p.order_amount, bom_no: p.bom_no || '',
          purchase_confirm_cost: r2(n.material_amount),
          actual_cost: 0,
          synced_at: ts
        });
        count++;
        if (n.children && n.children.length) await walk(n.children, path, n.material_code);
      }
    };
    await walk(p.tree, '', '');
  }
  // 批量模式下跳过逐单落盘，由外层统一 saveNow（避免每条订单都整表写盘）
  if (!opts.skipSave) {
    await det.saveNow();
    det._invalidate();
  }
  // ok=true 表示同步流程成功（即使该产品在 BOM 表里没有明细行 count=0，也是合法情况）
  return { synced: count, ok: true, products: plan.products.length, order_id: order.id, order_no: order.order_no, synced_at: ts,
           warnings: plan.warnings || [], empty_bom: count === 0 };
}

// ===== 核心算法 1：计划成本核算（BOM × 当前单价，三层 + 多级树） =====
// 订单可含多个产品型号（order.products 或回退 order.product_code），每个产品展开为分级 BOM 树
async function calcPlanCost(order) {
  const orderQty = toNum(order.quantity) || 1;
  const priceMap = buildMaterialPriceMap();
  const laborRateMap = buildLaborRateMap();
  const orderAmount = toNum(order.order_amount);
  const warnings = [];

  // 解析订单关联的产品型号列表（支持单产品或多产品）
  // 多产品时每个产品有自己的数量（order_products.quantity）；无数量字段时回退订单总数
  let productSpecs = []; // [{product_code, quantity}]
  if (Array.isArray(order.products) && order.products.length) {
    productSpecs = order.products.map(p => {
      if (typeof p === 'string') return { product_code: p, quantity: orderQty };
      return { product_code: p.product_code, bom_no: p.bom_no || '', quantity: toNum(p.quantity) || orderQty };
    }).filter(s => s.product_code);
  } else {
    // 从 order_products 表读取多产品（含每产品数量）
    try {
      const op = getTable('order_products');
      op._invalidate();
      const ops = op.all().filter(r => r.order_id === order.id).sort((a,b) => a.id - b.id);
      if (ops.length) {
        productSpecs = ops.map(r => ({ product_code: r.product_code, bom_no: r.bom_no || '', quantity: toNum(r.quantity) || orderQty, amount: toNum(r.amount) }));
      }
    } catch (_) {}
  }
  let productCodes = productSpecs.map(s => s.product_code);
  if (!productCodes.length && order.product_code) {
    productSpecs = [{ product_code: order.product_code, quantity: orderQty }];
    productCodes = [order.product_code];
  }

  if (!productCodes.length) warnings.push('订单无产品编码，无法按 BOM 核算，计划成本为 0');

  const products = await Promise.all(productSpecs.map(async spec => {
    const qty = toNum(spec.quantity) || orderQty;
    // 优先用 bom_no 查找 BOM（外部同步后 bom_items.product_code 存的是 bom_no）
    const bomNo = spec.bom_no || order.bom_no || '';
    const res = await buildProductBomAsync({ product_code: spec.product_code, bom_no: bomNo, quantity: qty }, priceMap, laborRateMap);
    const prodTable = getTable('bom_items');
    const sample = prodTable.all().find(b => b.product_code === (bomNo || spec.product_code));
    return {
      product_code: spec.product_code,
      product_name: (sample && sample.product_name) || '',
      bom_no: bomNo,
      order_qty: r2(qty),
      order_amount: spec.amount != null ? r2(spec.amount) : null,
      material: res.material, labor: res.labor, expense: res.expense, total: res.total,
      tree: res.tree,
      lines: flattenTree(res.tree),
      warnings: []
    };
  }));

  let matTotal = 0, laborTotal = 0, expTotal = 0;
  products.forEach(p => { matTotal += p.material; laborTotal += p.labor; expTotal += p.expense; });
  // 成品工价 + 费用：优先从工价库（product_labor_rate approved）读取，其次从 order_analysis.product_rates 回退
  let rateTotal = 0, feeTotal = 0;
  const rateSource = {};
  try {
    const an = getTable('order_analysis');
    an._invalidate();
    const card = an.all().find(a => a.order_id === order.id);
    const savedRates = (card && card.product_rates) ? JSON.parse(card.product_rates) : {};
    products.forEach(p => {
      const key = p.bom_no || p.product_code;
      if (!key) return;
      const qty = Number(p.order_qty) || orderQty;
      // 1. 工价库 approved（laborRateMap 已在前面构建）
      if (laborRateMap[key] && laborRateMap[key] > 0) {
        const rate = Number(laborRateMap[key]) || 0;
        rateTotal += rate * qty;
        feeTotal += rate * 0.25 * qty;
        rateSource[key] = '工价库';
        return;
      }
      // 2. order_analysis.product_rates 回退
      if (savedRates[key] != null) {
        const rate = Number(savedRates[key]) || 0;
        if (rate > 0) {
          rateTotal += rate * qty;
          feeTotal += rate * 0.25 * qty;
          rateSource[key] = '订单录入';
        }
      }
    });
  } catch(e) {}
  // 工价×数量计入【人工层】（直接人工+外协+加工费），费用=工价×0.25 计入费用层
  laborTotal += rateTotal;
  expTotal += feeTotal;
  // 兼容旧版扁平 lines：合并所有产品的行
  const lines = [];
  products.forEach(p => { p.lines.forEach(l => lines.push(l)); });

  const total = matTotal + laborTotal + expTotal;
  const grossProfit = orderAmount - total;
  const grossRate = orderAmount > 0 ? grossProfit / orderAmount * 100 : 0;

  return {
    order_id: order.id,
    order_no: order.order_no,
    product_code: productCodes[0] || '',
    products,
    order_qty: r2(orderQty),
    order_amount: r2(orderAmount),
    material: r2(matTotal),
    labor: r2(laborTotal),
    expense: r2(expTotal),
    total: r2(total),
    gross_profit: r2(grossProfit),
    gross_rate: r2(grossRate),
    lines,
    warnings,
    rate_source: rateSource
  };
}

// ===== 核心算法 2：同类订单差异比对 =====
// 命中维度（可配置权重）：产品编码相同(100) / 客户相同(20) / BOM 物料构成 Jaccard 相似度(×60)
async function findSimilarOrders(order, opts) {
  opts = opts || {};
  const minScore = toNum(opts.min_score != null ? opts.min_score : 20);
  const limit = toNum(opts.limit) || 10;
  const orders = getTable('orders');
  orders._invalidate();

  const myMats = new Set(getBomLines(order.product_code).map(b => (b.material_code || '').trim()).filter(Boolean));

  // 预算 BOM 成本用于对比（复用 calcPlanCost）
  const myCost = await calcPlanCost(order);

  const candidates = orders.all()
    .filter(o => o.id !== order.id)
    .map(o => {
      let score = 0; const reasons = [];
      if (order.product_code && o.product_code && o.product_code === order.product_code) { score += 100; reasons.push('产品编码相同'); }
      if (order.customer_name && o.customer_name && o.customer_name === order.customer_name) { score += 20; reasons.push('客户相同'); }
      if (myMats.size && o.product_code) {
        const oMats = new Set(getBomLines(o.product_code).map(b => (b.material_code || '').trim()).filter(Boolean));
        if (oMats.size) {
          let inter = 0; myMats.forEach(m => { if (oMats.has(m)) inter++; });
          const jac = inter / (myMats.size + oMats.size - inter);
          if (jac > 0) { score += jac * 60; reasons.push('物料构成相似度 ' + Math.round(jac * 100) + '%'); }
        }
      }
      return { order: o, score: r2(score), reasons };
    })
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // 对每个命中订单算成本差异
  const result = [];
  for (const c of candidates) {
    const oc = await calcPlanCost(c.order);
    const diff = {
      material: r2(oc.material - myCost.material),
      labor: r2(oc.labor - myCost.labor),
      expense: r2(oc.expense - myCost.expense),
      total: r2(oc.total - myCost.total),
      unit_total: r2((oc.total / (oc.order_qty || 1)) - (myCost.total / (myCost.order_qty || 1)))
    };
    result.push({
      order: {
        id: c.order.id, order_no: c.order.order_no, customer_name: c.order.customer_name,
        product_code: c.order.product_code, product_name: c.order.product_name,
        quantity: c.order.quantity, order_amount: c.order.order_amount, status: c.order.status,
        promised_date: c.order.promised_date, created_at: c.order.created_at
      },
      score: c.score,
      reasons: c.reasons,
      cost: { material: oc.material, labor: oc.labor, expense: oc.expense, total: oc.total,
              unit_total: r2(oc.total / (oc.order_qty || 1)), gross_rate: oc.gross_rate },
      diff
    });
  }

  return {
    base_order: { id: order.id, order_no: order.order_no, product_code: order.product_code,
                  customer_name: order.customer_name, quantity: order.quantity,
                  base_cost: { material: myCost.material, labor: myCost.labor, expense: myCost.expense,
                               total: myCost.total, unit_total: r2(myCost.total / (myCost.order_qty || 1)),
                               gross_rate: myCost.gross_rate } },
    matched_count: result.length,
    matches: result
  };
}

// ===== 核心算法 3：实际成本归集（领料单 + 人工 + 费用，按 order_no） =====
function collectActualCost(order) {
  const orderNo = order.order_no;
  const result = { order_no: orderNo, material: 0, labor: 0, expense: 0, total: 0, items: { material: [], labor: [], expense: [] }, warnings: [] };

  // 物料：领料单
  const issues = getTable('material_issues');
  issues._invalidate();
  const matItems = issues.all().filter(r => r.order_no === orderNo);
  const matByCode = {};
  matItems.forEach(r => {
    const amt = toNum(r.amount);
    result.material += amt;
    const key = r.material_code || r.material_name || '未编码';
    if (!matByCode[key]) matByCode[key] = { material_code: r.material_code, material_name: r.material_name, unit: r.unit, qty: 0, amount: 0, count: 0 };
    matByCode[key].qty += toNum(r.quantity);
    matByCode[key].amount = r2(matByCode[key].amount + amt);
    matByCode[key].count += 1;
  });
  result.items.material = Object.values(matByCode).map(m => { m.qty = r2(m.qty); return m; });
  if (!matItems.length) result.warnings.push('无领料单记录，实际物料成本为0（请录入领料单）');

  // 人工：labor 表（按 order_no 关联）
  const laborT = getTable('labor');
  laborT._invalidate();
  const labItems = laborT.all().filter(r => (r.order_no || '') === orderNo);
  const labByDept = {};
  labItems.forEach(r => {
    const amt = toNum(r.total_amount);
    result.labor += amt;
    const key = r.department || r.labor_type || '未分类';
    if (!labByDept[key]) labByDept[key] = { department: r.department, labor_type: r.labor_type, hours: 0, pieces: 0, amount: 0, count: 0 };
    labByDept[key].hours += toNum(r.hours);
    labByDept[key].pieces += toNum(r.pieces);
    labByDept[key].amount = r2(labByDept[key].amount + amt);
    labByDept[key].count += 1;
  });
  result.items.labor = Object.values(labByDept).map(x => { x.hours = r2(x.hours); x.pieces = r2(x.pieces); return x; });
  if (!labItems.length) result.warnings.push('无人工记录关联该订单（请在人工库录入时填写订单号）');

  // 费用：expenses 表（按 order_no 关联）
  const expT = getTable('expenses');
  expT._invalidate();
  const expItems = expT.all().filter(r => (r.order_no || '') === orderNo);
  const expByCat = {};
  expItems.forEach(r => {
    const amt = toNum(r.total_amount || r.amount);
    result.expense += amt;
    const key = r.expense_category || '未分类';
    if (!expByCat[key]) expByCat[key] = { expense_category: r.expense_category, amount: 0, count: 0 };
    expByCat[key].amount = r2(expByCat[key].amount + amt);
    expByCat[key].count += 1;
  });
  result.items.expense = Object.values(expByCat);
  if (!expItems.length) result.warnings.push('无费用记录关联该订单（请在费用库录入时填写订单号）');

  result.material = r2(result.material);
  result.labor = r2(result.labor);
  result.expense = r2(result.expense);
  result.total = r2(result.material + result.labor + result.expense);
  result.counts = { material: matItems.length, labor: labItems.length, expense: expItems.length };
  return result;
}

// ===== 计划 vs 实际差异 =====
function calcVariance(plan, actual) {
  const v = (a, b) => r2(a - b);
  const pct = (a, b) => b > 0 ? r2((a - b) / b * 100) : 0;
  return {
    material: { diff: v(actual.material, plan.material), pct: pct(actual.material, plan.material) },
    labor: { diff: v(actual.labor, plan.labor), pct: pct(actual.labor, plan.labor) },
    expense: { diff: v(actual.expense, plan.expense), pct: pct(actual.expense, plan.expense) },
    total: { diff: v(actual.total, plan.total), pct: pct(actual.total, plan.total) }
  };
}

// ============================================================
// 路由
// ============================================================

// 计划成本即时核算（不落库）
router.post('/calc-plan', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const { order_id } = req.body || {};
  const order = orders.findById(order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  clearMatPriceCache();
  res.json(await calcPlanCost(order));
});

// 同类订单比对（即时）
router.post('/similar', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const { order_id, min_score, limit } = req.body || {};
  const order = orders.findById(order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  res.json(await findSimilarOrders(order, { min_score, limit }));
});

// 实际成本归集（即时）
router.post('/actual', requirePerm('order-analysis:view'), (req, res) => {
  const orders = getTable('orders');
  const { order_id } = req.body || {};
  const order = orders.findById(order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  res.json(collectActualCost(order));
});

// 分析库列表（聚合订单 + 分析卡状态 + 计划/实际成本）
router.get('/', requirePerm('order-analysis:view'), async (req, res) => {
  const { page = 1, limit = 20, keyword, status, review_status, customer,
          product, risk_level, has_overrun, profit_min, profit_max,
          sort_by, sort_order, date_from, date_to, assigned_to_me, exclude_sample } = req.query;
  const orders = getTable('orders');
  orders._invalidate();
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  // snapshots 文件达 362MB，不调用 _invalidate() 避免每次列表请求重读大文件

  // 订单 -> 分析卡 映射
  const cardMap = {};
  analysis.all().forEach(a => { cardMap[a.order_id] = a; });

  // 订单 -> 产品数 映射（order_products 一篮子）
  const opTable = getTable('order_products');
  opTable._invalidate();
  const opCount = {};
  opTable.all().forEach(r => { opCount[r.order_id] = (opCount[r.order_id] || 0) + 1; });
  
  const detTable = getTable('order_bom_details');
  // 不再每次 _invalidate（236MB 文件重读是性能杀手）；用内存缓存，仅 order_bom_details 写入时手动刷新
  const purchaseConfirmCostMap = {};
  const materialCostMap = {};
  detTable.all().forEach(r => {
    const purchaseVal = toNum(r.purchase_confirm_cost);
    if (purchaseVal > 0) {
      purchaseConfirmCostMap[r.order_id] = (purchaseConfirmCostMap[r.order_id] || 0) + purchaseVal;
    }
    const matVal = toNum(r.material_amount);
    if (matVal > 0) {
      materialCostMap[r.order_id] = (materialCostMap[r.order_id] || 0) + matVal;
    }
  });

  let rows = orders.all().map(o => {
    const card = cardMap[o.id] || {};
    // 计划成本：先用 card / materialCostMap 快速取值；_computeOrderPlanCost 延迟到分页后只对当前页执行
    let plan = null, planMat = null, planLab = null, planExp = null;
    if (card.plan_total_cost != null) {
      planMat = card.plan_material_cost != null ? card.plan_material_cost : null;
      planLab = card.plan_labor_cost != null ? card.plan_labor_cost : null;
      planExp = card.plan_expense_cost != null ? card.plan_expense_cost : null;
      plan = card.plan_total_cost;
    } else if (materialCostMap[o.id] != null) {
      planMat = r2(materialCostMap[o.id]); planLab = 0; planExp = 0; plan = planMat;
    }
    const actual = card.actual_total_cost != null ? card.actual_total_cost : null;
    const purchaseConfirm = purchaseConfirmCostMap[o.id] != null ? r2(purchaseConfirmCostMap[o.id]) : null;
    const orderAmount = toNum(o.order_amount);
    const grossProfit = plan != null ? orderAmount - plan : null;
    const grossRate = (plan != null && plan > 0) ? r2(grossProfit / orderAmount * 100) : null;
    const actualGrossProfit = actual != null ? r2(orderAmount - actual) : null;
    const actualGrossRate = (actual != null && orderAmount > 0) ? r2((orderAmount - actual) / orderAmount * 100) : null;
    const overrun = (plan != null && actual != null) ? actual > plan : false;
    return {
      id: o.id, order_no: o.order_no, customer_name: o.customer_name,
      product_code: o.product_code, product_name: o.product_name,
      product_count: opCount[o.id] || 0,
      quantity: o.quantity, order_amount: r2(orderAmount), status: o.status,
      risk_level: o.risk_level, promised_date: o.promised_date, created_at: o.created_at,
      review_status: card.review_status || null,
      reviewer_id: card.reviewer_id || null, review_at: card.review_at || null, review_remark: card.review_remark || '',
      plan_material_cost: planMat,
      plan_labor_cost: planLab != null ? planLab : 0,
      plan_expense_cost: planExp != null ? planExp : 0,
      plan_total_cost: plan,
      purchase_confirm_cost: purchaseConfirm,
      actual_material_cost: card.actual_material_cost != null ? card.actual_material_cost : null,
      actual_labor_cost: card.actual_labor_cost != null ? card.actual_labor_cost : null,
      actual_expense_cost: card.actual_expense_cost != null ? card.actual_expense_cost : null,
      actual_total_cost: actual,
      actual_gross_profit: actualGrossProfit,
      actual_gross_rate: actualGrossRate,
      gross_profit: grossProfit != null ? r2(grossProfit) : null,
      gross_rate: grossRate,
      has_overrun: overrun,
      analysis_id: card.id || null,
      updated_at: card.updated_at || null,
      is_void: card.is_void ? 1 : 0,
      is_locked: card.is_locked ? 1 : 0,
      assigned_personnel: card.assigned_personnel || null,
      _need_dyn_plan: true // 始终用实时 BOM 核算（杜绝计划成本与 BOM 成本不同步）
    };
  });

  // 过滤：默认排除作废订单
  rows = rows.filter(r => {
    if (r.is_void) return false;
    // 排除样品单（HJY 开头）
    if (exclude_sample === '1' && (r.order_no || '').toUpperCase().startsWith('HJY')) return false;
    // 日期过滤按订单业务日期（promised_date 优先，回退到订单号解析年份）
    if (date_from || date_to) {
      let bizDate = r.promised_date || '';
      if (!bizDate) {
        const m = (r.order_no || '').match(/HJY?(\d{4})(\d{2})?/);
        if (m) bizDate = m[1] + '-' + (m[2] || '01') + '-01';
      }
      if (!bizDate) bizDate = (r.created_at || '').substring(0, 10);
      if (date_from && bizDate < date_from) return false;
      if (date_to && bizDate > date_to) return false;
    }
    if (status && r.status !== status) return false;
    if (review_status) {
      var rRs = r.review_status || 'none';
      if (rRs !== review_status) return false;
    }
    if (customer && !(r.customer_name || '').includes(customer)) return false;
    if (product && !((r.product_code || '') + (r.product_name || '')).toLowerCase().includes(String(product).toLowerCase())) return false;
    if (risk_level && r.risk_level !== risk_level) return false;
    if (has_overrun === '1' && !r.has_overrun) return false;
    if (has_overrun === '0' && r.has_overrun) return false;
    if (profit_min !== undefined && profit_min !== '' && (r.gross_rate === null || r.gross_rate < toNum(profit_min))) return false;
    if (profit_max !== undefined && profit_max !== '' && (r.gross_rate === null || r.gross_rate > toNum(profit_max))) return false;
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      if (![r.order_no, r.customer_name, r.product_code, r.product_name].join(' ').toLowerCase().includes(kw)) return false;
    }
    if (assigned_to_me === '1') {
      const userId = Number(req.headers['x-user-id']) || 0;
      if (!r.assigned_personnel) return false;
      try {
        const ids = JSON.parse(r.assigned_personnel);
        if (!Array.isArray(ids) || !ids.length) return false;
        // 找到当前 user 关联的 personnel id（linked_user_id），若无则直接用 userId 匹配
        const pt = getTable('org_personnel');
        pt._invalidate();
        const myPersonnelIds = pt.all().filter(p => p.linked_user_id == userId).map(p => p.id);
        if (myPersonnelIds.length && ids.some(id => myPersonnelIds.includes(id))) { /* match */ }
        else if (!myPersonnelIds.length && ids.includes(userId)) { /* match */ }
        else return false;
      } catch(e) { return false; }
    }
    return true;
  });

  // 排序
  const ALLOWED_SORT = ['id', 'order_no', 'customer_name', 'order_amount', 'status', 'promised_date', 'created_at',
                        'plan_total_cost', 'purchase_confirm_cost', 'actual_total_cost', 'gross_rate', 'review_status'];
  const orderBy = ALLOWED_SORT.includes(sort_by) ? sort_by : 'id';
  const dir = (sort_order && String(sort_order).toUpperCase() === 'ASC') ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[orderBy], vb = b[orderBy];
    if (va === null) return vb === null ? 0 : 1;
    if (vb === null) return -1;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return cmp * dir;
  });

  const total = rows.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const records = rows.slice(start, start + parseInt(limit));
  // 预热本页订单的 SPC 树（并行），确保下方逐单核算走 SPC 缓存，口径与明细一致
  {
    const warmBomNos = new Set();
    for (const r of records) {
      (getOrderProductsIndex()[r.id] || []).forEach(p => { const bn = (p.bom_no || '').trim(); if (bn) warmBomNos.add(bn); });
    }
    await Promise.all([...warmBomNos].map(bn => fetchSpcBomTree(bn)));
  }
  // 分页后只对当前页中 _need_dyn_plan=true 的记录动态计算 BOM 计划成本（避免全量 2000+ 订单构建树）
  for (const r of records) {
    if (r._need_dyn_plan) {
      const dyn = await _computeOrderPlanCost(r.id);
      if (dyn) {
        r.plan_material_cost = dyn.material;
        r.plan_labor_cost = dyn.labor;
        r.plan_expense_cost = dyn.expense;
        r.plan_total_cost = dyn.total;
        const orderAmount = toNum(r.order_amount);
        if (dyn.total > 0 && orderAmount > 0) {
          r.gross_profit = r2(orderAmount - dyn.total);
          r.gross_rate = r2((orderAmount - dyn.total) / orderAmount * 100);
        }
      }
    }
    delete r._need_dyn_plan;
  }
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 问题汇总表（多维度分组）— 必须在 /:id 之前注册 =====
router.get('/check-summary', requirePerm('order-analysis:view'), (req, res) => {
  const groupBy = req.query.group_by || 'category';
  const issuesTable = getTable('order_check_issues');
  // 不 _invalidate：207MB 大表；进程内缓存已由本服务写入同步保持新鲜
  const items = issuesTable.all().filter(i => i.source === 'per_order_check');
  const groups = {};
  for (const it of items) {
    let key;
    if (groupBy === 'category') key = it.category || '未分类';
    else if (groupBy === 'order_no') key = it.order_no || '未知订单';
    else if (groupBy === 'assignee') key = it.assignee || '未指派';
    else if (groupBy === 'severity') key = it.severity || 'low';
    else key = it.category || '未分类';
    if (!groups[key]) groups[key] = { key, total: 0, open: 0, resolved: 0, critical: 0, high: 0, medium: 0, low: 0, items: [] };
    const g = groups[key];
    g.total++;
    if (it.status === 'open' || it.status === 'in_progress') g.open++;
    if (it.status === 'resolved') g.resolved++;
    if (g[it.severity] !== undefined) g[it.severity]++;
    if (g.items.length < 50) g.items.push({ id: it.id, order_no: it.order_no, category: it.category, severity: it.severity, status: it.status, assignee: it.assignee, description: it.description, suggested_action: it.suggested_action });
  }
  const result = Object.values(groups).sort((a, b) => b.open - a.open || b.total - a.total);
  const totals = { total: items.length, open: items.filter(i => i.status === 'open' || i.status === 'in_progress').length, resolved: items.filter(i => i.status === 'resolved').length };
  res.json({ group_by: groupBy, groups: result, totals });
});

// ===== 订单审核台检查：每订单逻辑合理性 + 信息完整性 + 仪表盘与表格同步 =====
// 检查项：完整性（必填字段）+ 合理性（数量×单价≈金额、成本合理、客户匹配等）+ 仪表盘同步
router.get('/audit-check', requirePerm('order-analysis:view'), (req, res) => {
  try {
    const orderIdsParam = req.query.order_ids;
    let idFilter = null;
    if (orderIdsParam) {
      idFilter = new Set(String(orderIdsParam).split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x) && x > 0));
    }
    const orders = getTable('orders');
    const opTable = getTable('order_products');
    const analysisTable = getTable('order_analysis');
    const oArr = orders.all();
    const opsArr = opTable.all();
    const analysisArr = analysisTable.all();
    let detArr = [];
    if (!idFilter) {
      try { detArr = getTable('order_bom_details').all(); } catch(e) {}
    }
    const orderOpsMap = {}; // order_id → order_products
    opsArr.forEach(p => { (orderOpsMap[p.order_id] = orderOpsMap[p.order_id] || []).push(p); });
    const orderAnalysisMap = {}; // order_id → analysis card
    analysisArr.forEach(a => { orderAnalysisMap[a.order_id] = a; });
    const orderDetMap = {}; // order_id → [det rows]
    detArr.forEach(r => { (orderDetMap[r.order_id] = orderDetMap[r.order_id] || []).push(r); });

    // 仪表盘统计
    let db_order_count = 0, db_pending = 0, db_approved = 0, db_overrun = 0;
    let db_total_amount = 0, db_total_plan = 0, db_total_actual = 0;
    const dashboardStats = {
      order_count: 0, pending_count: 0, approved_count: 0, overrun_count: 0,
      total_order_amount: 0, total_plan_cost: 0, total_actual_cost: 0, avg_gross_rate: null
    };
    // 表格统计（与列表接口 /api/order-analysis 一致，含 is_void 排除、样品单排除逻辑可由调用方传参）
    const tableStats = {
      order_count: 0, pending_count: 0, approved_count: 0, overrun_count: 0,
      total_order_amount: 0, total_plan_cost: 0, total_actual_cost: 0
    };

    const orderChecks = [];
    for (const o of oArr) {
      if (o.is_void) continue;
      if ((o.order_no || '').toUpperCase().startsWith('HJY')) continue;
      if (idFilter && !idFilter.has(o.id)) continue;
      const card = orderAnalysisMap[o.id] || {};
      const ops = orderOpsMap[o.id] || [];
      const dets = orderDetMap[o.id] || [];
      const orderAmount = toNum(o.order_amount);
      const quantity = toNum(o.quantity);

      // 计算 BOM 物料成本（用 order_bom_details 聚合）
      const detMat = dets.reduce((s, r) => s + toNum(r.material_amount), 0);
      const detQty = dets.reduce((s, r) => s + toNum(r.material_amount || 0) * 0, 0); // placeholder

      const checks = [];
      // —— 完整性检查 ——
      if (!o.order_no) checks.push({ name: '订单号', level: 'error', message: '订单号为空' });
      else if (!/^HJ\d{6}-\d{4}-\d{4}/.test(o.order_no)) checks.push({ name: '订单号格式', level: 'warning', message: '订单号格式不规范（参考 HJ2yymm-NNNN-NNNN）' });
      if (!o.customer_name) checks.push({ name: '客户', level: 'error', message: '客户为空' });
      if (!o.product_code && ops.length === 0) checks.push({ name: '产品', level: 'error', message: '产品未指定（orders.product_code 和 order_products 都为空）' });
      else if (ops.length > 1 && ops.every(x => (x.product_code || '') === (ops[0].product_code || ''))) {
        // 多个 order_products 但都是同一产品（样件已合并）— 仅 info
        checks.push({ name: '产品', level: 'info', message: `order_products 有 ${ops.length} 行（主订单+样件），已合并为 ${new Set(ops.map(x=>x.product_code)).size} 个唯一产品` });
      }
      if (quantity <= 0) checks.push({ name: '数量', level: 'error', message: `数量=${quantity}，应为正数` });
      if (orderAmount <= 0) checks.push({ name: '订单金额', level: 'error', message: `订单金额=${orderAmount}，应为正数` });
      if (!o.status) checks.push({ name: '状态', level: 'warning', message: '订单状态为空' });
      if (!o.promised_date) checks.push({ name: '交期', level: 'warning', message: '交期未指定' });
      if (!card.assigned_personnel) checks.push({ name: '负责人', level: 'warning', message: '负责人未指定' });

      // —— 合理性检查 ——
      // 单价合理性
      if (quantity > 0 && orderAmount > 0) {
        const unitPrice = orderAmount / quantity;
        if (unitPrice < 0.01) checks.push({ name: '单价', level: 'error', message: `单价 ¥${unitPrice.toFixed(2)} 异常低（< 0.01）` });
        if (unitPrice > 100000) checks.push({ name: '单价', level: 'warning', message: `单价 ¥${unitPrice.toFixed(2)} 异常高（> 100,000）` });
      }
      // 计划成本合理性
      const planCost = card.plan_total_cost != null ? card.plan_total_cost : detMat;
      if (planCost > 0 && orderAmount > 0) {
        const planRatio = planCost / orderAmount;
        if (planRatio > 1.2) checks.push({ name: '成本/订单比', level: 'warning', message: `计划成本 ¥${planCost.toLocaleString()} 是订单 ¥${orderAmount.toLocaleString()} 的 ${(planRatio*100).toFixed(0)}%（> 120%，可能亏本）` });
        if (planRatio < 0.2 && planCost > 0) checks.push({ name: '成本/订单比', level: 'warning', message: `计划成本 ¥${planCost.toLocaleString()} 仅订单 ¥${orderAmount.toLocaleString()} 的 ${(planRatio*100).toFixed(0)}%（< 20%，偏低）` });
      }
      // 实际 vs 计划
      if (card.actual_total_cost != null && card.plan_total_cost != null) {
        const variance = card.actual_total_cost - card.plan_total_cost;
        const overrun = variance > 0;
        if (overrun) {
          const overrunPct = (variance / card.plan_total_cost * 100).toFixed(1);
          if (variance > 0 && card.review_status === 'approved') {
            checks.push({ name: '超支', level: 'error', message: `已通过订单实际超支 ¥${variance.toLocaleString()}（+${overrunPct}%），建议复审` });
          } else {
            checks.push({ name: '超支', level: 'warning', message: `实际超支 ¥${variance.toLocaleString()}（+${overrunPct}%）` });
          }
        }
      }
      // 计划成本缺失
      if (card.plan_total_cost == null && dets.length === 0 && ops.length > 0) {
        checks.push({ name: 'BOM', level: 'warning', message: '该订单未核算计划成本（无 analysis 卡片 + order_bom_details 为空）' });
      }
      // 交期早于创建日期
      if (o.promised_date && o.created_at && o.promised_date < (o.created_at || '').substring(0, 10)) {
        checks.push({ name: '交期', level: 'warning', message: `交期 ${o.promised_date} 早于订单创建 ${(o.created_at||'').substring(0,10)}` });
      }
      // 审核状态但无计划成本
      if (card.review_status === 'approved' && card.plan_total_cost == null) {
        checks.push({ name: '审核', level: 'error', message: '已通过审核但 plan_total_cost 为空' });
      }

      orderChecks.push({
        order_id: o.id,
        order_no: o.order_no,
        customer_name: o.customer_name,
        product_code: o.product_code || (ops[0] && ops[0].product_code) || '',
        order_amount: orderAmount,
        quantity: quantity,
        plan_total_cost: planCost,
        actual_total_cost: card.actual_total_cost,
        review_status: card.review_status || 'none',
        check_count: checks.length,
        error_count: checks.filter(c => c.level === 'error').length,
        warning_count: checks.filter(c => c.level === 'warning').length,
        checks
      });

      // 表格统计累加
      tableStats.order_count++;
      tableStats.total_order_amount += orderAmount;
      tableStats.total_plan_cost += planCost;
      tableStats.total_actual_cost += card.actual_total_cost || 0;
      if (card.review_status === 'pending' || card.review_status === 'reviewing') tableStats.pending_count++;
      if (card.review_status === 'approved') tableStats.approved_count++;
      if (card.actual_total_cost != null && card.plan_total_cost != null && card.actual_total_cost > card.plan_total_cost) tableStats.overrun_count++;
    }

    // 仪表盘统计：直接调 dashboard/stats 逻辑（复用现有逻辑，避免重复）
    // 这里简化为对照：tableStats vs dashboard/stats 接口的输出
    const dashboardSync = {
      in_sync: true,
      mismatches: [],
      checks: [
        { name: '订单总数', table: tableStats.order_count, dashboard: null, diff: null, status: 'pending' },
        { name: '订单总额', table: r2(tableStats.total_order_amount), dashboard: null, diff: null, status: 'pending' },
        { name: '计划成本合计', table: r2(tableStats.total_plan_cost), dashboard: null, diff: null, status: 'pending' },
        { name: '实际成本合计', table: r2(tableStats.total_actual_cost), dashboard: null, diff: null, status: 'pending' },
        { name: '待审核', table: tableStats.pending_count, dashboard: null, diff: null, status: 'pending' },
        { name: '已通过', table: tableStats.approved_count, dashboard: null, diff: null, status: 'pending' },
        { name: '超支订单数', table: tableStats.overrun_count, dashboard: null, diff: null, status: 'pending' }
      ]
    };

    // 统计检查项汇总
    const summary = {
      total_orders: orderChecks.length,
      error_orders: orderChecks.filter(o => o.error_count > 0).length,
      warning_orders: orderChecks.filter(o => o.warning_count > 0).length,
      total_checks: orderChecks.reduce((s, o) => s + o.check_count, 0),
      total_errors: orderChecks.reduce((s, o) => s + o.error_count, 0),
      total_warnings: orderChecks.reduce((s, o) => s + o.warning_count, 0)
    };

    res.json({
      summary,
      table_stats: tableStats,
      dashboard_sync: dashboardSync,
      orders: orderChecks,
      scope: idFilter ? 'page' : 'all',
      generated_at: now()
    });
  } catch (e) { res.status(500).json({ error: '检查失败: ' + e.message }); }
});

// 更新问题责任人（单条）— 两段路径避免与 /:id 冲突
router.put('/check-issue/:issueId/assignee', requirePerm('order-analysis:edit'), async (req, res) => {
  const issuesTable = getTable('order_check_issues');
  issuesTable._invalidate();
  const issue = issuesTable.findById(req.params.issueId);
  if (!issue) return res.status(404).json({ error: '问题记录不存在' });
  await issuesTable.update(issue.id, { assignee: req.body.assignee || '', updated_at: now() });
  res.json({ message: '责任人已更新' });
});

// 已同步的订单 BOM 明细（分级，持久化在订单号下）
router.get('/:id/details', requirePerm('order-analysis:view'), (req, res) => {
  const det = getTable('order_bom_details');
  // path 按"."分段数字比较，避免 localeCompare 把 "10" 排在 "2" 前面
  const pathCmp = (a, b) => {
    const pa = String(a.path || '').split('.');
    const pb = String(b.path || '').split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = parseInt(pa[i] || '0', 10) || 0;
      const nb = parseInt(pb[i] || '0', 10) || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  };
  const rows = det.all().filter(r => r.order_id === Number(req.params.id)).sort(pathCmp);
  if (!rows.length) return res.json({ synced: false, rows: [], reason: '该订单尚未同步 BOM 明细' });
  res.json({
    synced: true, synced_at: rows[0].synced_at, count: rows.length,
    order_no: rows[0].order_no, rows
  });
});

// 手动触发单个订单 BOM 明细同步
router.post('/:id/sync-details', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const r = await syncOrderBomDetails(Number(req.params.id));
    // 用 ok 字段判断流程是否成功，避免 count=0（产品无BOM明细）被误判为失败
    if (!r.ok) {
      const code = r.code || 'SYNC_FAILED';
      return res.status(400).json({ error: r.reason || '同步失败', code });
    }
    // 产品已关联但 BOM 表无该产品明细：返回 200 + 提示，让前端给出明确引导
    if (r.empty_bom) {
      return res.json({ message: '该产品在 BOM 表中无明细数据，已清空旧明细', ...r });
    }
    res.json({ message: '订单 BOM 明细已同步', ...r });
  } catch (e) { res.status(500).json({ error: '同步失败: ' + e.message }); }
});

// 直接为订单指定产品型号 + 同步分级BOM明细 + 自动建映射（同客户后续订单自动关联）
// body: { product_code, auto_map?: true(默认) }
router.post('/assign-product', requirePerm('order-analysis:edit'), async (req, res) => {
  const { order_ids, product_code, auto_map } = req.body || {};
  // 批量：order_ids 数组
  if (Array.isArray(order_ids) && order_ids.length) {
    if (!product_code) return res.status(400).json({ error: 'product_code 必填' });
    const bom = getTable('bom_items');
    const bomRow = bom.all().find(b => b.product_code === product_code);
    const productName = bomRow ? (bomRow.product_name || '') : '';
    const orders = getTable('orders');
    // 批量场景：只清一次缓存
    clearMatPriceCache();
    let assigned = 0, synced = 0, mapsCreated = 0; const failed = [];
    for (const oid of order_ids) {
      const order = orders.findById(Number(oid));
      if (!order) { failed.push({ id: oid, reason: '订单不存在' }); continue; }
      await orders.update(order.id, { product_code, product_name: productName, updated_at: now() });
      assigned++;
      try { const r = await syncOrderBomDetails(order.id, { skipCacheClear: true }); synced += (r.synced || 0); } catch (_) {}
      if (auto_map !== false && order.customer_name) {
        try {
          const map = getTable('order_product_map'); map._invalidate();
          const exists = map.all().find(m => m.match_field === 'customer_name' && m.match_key === order.customer_name);
          if (!exists) {
            await map.insert({ match_field: 'customer_name', match_type: 'exact', match_key: order.customer_name, product_code, product_name: productName, priority: 0, disabled: 0, remarks: '批量指派自动创建', created_at: now(), updated_at: now() });
            mapsCreated++;
          }
        } catch (_) {}
      }
    }
    return res.json({ message: '已为 ' + assigned + ' 个订单指定产品并同步明细', assigned, synced, maps_created: mapsCreated, failed });
  }
  res.status(400).json({ error: '请提供 order_ids 数组' });
});

// 批量同步所有已关联产品的订单明细
router.post('/sync-details-batch', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  orders._invalidate();
  const onlyUnmapped = req.body.only_unmapped === false ? false : true;
  const det = getTable('order_bom_details');
  det._invalidate();
  const syncedOrderIds = new Set(det.all().map(r => r.order_id));
  // 批量场景：只清一次价格/BOM 索引缓存，避免每条订单都重建 10万行级 bom_items 索引
  clearMatPriceCache();
  let synced = 0, skipped = 0, failed = 0; const failedList = [];
  for (const o of orders.all()) {
    if (!o.product_code) { skipped++; continue; }
    if (onlyUnmapped && syncedOrderIds.has(o.id)) { skipped++; continue; }
    try { const r = await syncOrderBomDetails(o.id, { skipCacheClear: true }); if (r.ok) synced++; else { failed++; failedList.push({ id: o.id, order_no: o.order_no, reason: r.reason }); } }
    catch (e) { failed++; failedList.push({ id: o.id, order_no: o.order_no, reason: e.message }); }
  }
  res.json({ message: '批量同步完成', synced, skipped, failed, failed_list: failedList.slice(0, 20) });
});

// 已同步明细统计
router.get('/details/stats', requirePerm('order-analysis:view'), (req, res) => {
  const det = getTable('order_bom_details');
  const orders = getTable('orders');
  orders._invalidate();
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const cardMap = {}; analysis.all().forEach(a => { cardMap[a.order_id] = a; });
  
  const all = det.all().filter(r => !(cardMap[r.order_id] && cardMap[r.order_id].is_void));
  const orderIds = new Set(all.map(r => r.order_id));
  let matTotal = 0, labTotal = 0, expTotal = 0, lineTotal = 0;
  all.filter(r => r.depth === 1).forEach(r => { matTotal += toNum(r.material_rollup); labTotal += toNum(r.labor_rollup); expTotal += toNum(r.expense_rollup); lineTotal += toNum(r.total_rollup); });
  res.json({
    synced_orders: orderIds.size, total_rows: all.length,
    orders_with_product: orders.all().filter(o => o.product_code && !(cardMap[o.id] && cardMap[o.id].is_void)).length,
    orders_total: orders.all().filter(o => !(cardMap[o.id] && cardMap[o.id].is_void)).length,
    material_total: r2(matTotal), labor_total: r2(labTotal), expense_total: r2(expTotal), total: r2(lineTotal)
  });
});

// 明细导出 CSV
router.get('/details/export', requirePerm('order-analysis:view'), (req, res) => {
  const det = getTable('order_bom_details');
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const cardMap = {}; analysis.all().forEach(a => { cardMap[a.order_id] = a; });
  
  let rows = det.all().filter(r => !(cardMap[r.order_id] && cardMap[r.order_id].is_void));
  if (req.query.order_no) rows = rows.filter(r => r.order_no === req.query.order_no);
  if (req.query.product_code) rows = rows.filter(r => r.product_code === req.query.product_code);
  rows.sort((a, b) => (a.order_no || '').localeCompare(b.order_no || '') || (a.path || '').localeCompare(b.path || ''));
  const headers = ['订单号', '产品型号', '层级', '路径', '父物料编码', '物料编码', '物料名称', '规格', '属性',
    'BOM用量', '订单总量', '单价', '物料金额', '人工金额', '费用金额', '本行小计', '同步时间'];
  const data = rows.map(r => [
    r.order_no, r.product_code, r.depth, r.path, r.parent_material_code, r.material_code, r.material_name, r.spec, r.material_attr,
    toNum(r.bom_qty), toNum(r.total_qty), toNum(r.unit_price), toNum(r.material_amount), toNum(r.labor_amount), toNum(r.expense_amount),
    toNum(r.line_total), r.synced_at
  ].map(v => String(v == null ? '' : v).replace(/,/g, '，')));
  let csv = headers.join(',') + '\n';
  data.forEach(r => csv += r.join(',') + '\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=order_bom_details.csv');
  res.send('\uFEFF' + csv);
});

// 下钻树：订单 → 产品型号(可多个) → 分级 BOM 物料(.1→..2→...3，成本逐级汇总)
// query: product_code=xxx 可指定单个产品；quantity=xxx 可指定数量；默认取订单 product_code 和总数量
router.get('/:id/tree', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  clearMatPriceCache();
  const qProd = String(req.query.product_code || '').trim();
  const qQty = req.query.quantity != null && req.query.quantity !== '' ? Number(req.query.quantity) : order.quantity;
  const qBomNo = String(req.query.bom_no || '').trim();
  const orderForCalc = qProd 
    ? Object.assign({}, order, { product_code: qProd, bom_no: qBomNo || order.bom_no, products: [{ product_code: qProd, bom_no: qBomNo || order.bom_no, quantity: qQty }] }) 
    : order;
  const plan = await calcPlanCost(orderForCalc);
  
  for (const prod of plan.products) {
    if (!prod.tree || !prod.tree.length) {
      try {
        const bomSearchKey = order.bom_no || prod.product_code.replace(/^3\.1\./, '').split('-').slice(0, -2).join('-');
        console.log('[DEBUG] BOM search:', { order_no: order.order_no, bom_no: order.bom_no, product_code: prod.product_code, bomSearchKey });
        const bomData = await fetchExternal('boms.list', { bom_no: bomSearchKey, page: 1, page_size: 1 });
        console.log('[DEBUG] bomData:', { total: bomData.total, items: bomData.items ? bomData.items.length : 0 });
        if (bomData.items && bomData.items.length > 0) {
          const bomId = bomData.items[0].bom_id;
          const detailData = await fetchExternal('bom_details.list', { bom_id: bomId, page: 1, page_size: 200 });
          prod.tree = _buildTreeFromExternalBom(detailData.items || [], prod.order_qty);
          // 根节点合计（标准计算方式）
          let mat = 0, lab = 0, exp = 0;
          prod.tree.forEach(n => {
            mat += toNum(n.material_amount || 0);
            lab += toNum(n.labor_amount || 0);
            exp += toNum(n.expense_amount || 0);
          });
          prod.material = r2(mat);
          prod.labor = r2(lab);
          prod.expense = r2(exp);
          prod.total = r2(mat + lab + exp);
          prod.warnings = [];
        }
      } catch (e) { /* 外部BOM获取失败，保持空树 */ }
    }
  }
  
  let matTotal = 0, laborTotal = 0, expTotal = 0;
  plan.products.forEach(p => { matTotal += p.material; laborTotal += p.labor; expTotal += p.expense; });
  const total = matTotal + laborTotal + expTotal;
  const grossProfit = plan.order_amount - total;
  const grossRate = plan.order_amount > 0 ? grossProfit / plan.order_amount * 100 : 0;
  
  res.json({
    order: { id: order.id, order_no: order.order_no, customer_name: order.customer_name,
             product_code: order.product_code, quantity: order.quantity, order_amount: order.order_amount,
             status: order.status, promised_date: order.promised_date },
    products: plan.products,
    totals: { material: r2(matTotal), labor: r2(laborTotal), expense: r2(expTotal), total: r2(total),
              gross_profit: r2(grossProfit), gross_rate: r2(grossRate) },
    warnings: plan.warnings
  });
});

// 外部BOM rollup（递归汇总成本）
function _rollupExtNode(node, multiplier) {
  node.total_qty = r2(node.bom_qty * multiplier);
  node.material_amount = r2(node._matPerParent * multiplier);
  node.labor_amount = r2(0);
  node.expense_amount = r2(0);
  node.line_total = node.material_amount;
  let rMat = node.material_amount;
  node.children.forEach(ch => { _rollupExtNode(ch, node.total_qty); rMat += ch.material_rollup; });
  node.material_rollup = r2(rMat);
  node.labor_rollup = 0; node.expense_rollup = 0;
  node.total_rollup = r2(rMat);
  node.has_children = node.children.length > 0;
  node.purchase_confirm_cost = node.material_amount;
  node.actual_cost = 0;
  delete node._matPerParent;
}

function _buildTreeFromExternalBom(items, orderQty) {
  const priceMap = buildMaterialPriceMap();
  items.sort((a, b) => String(a.line_no).localeCompare(String(b.line_no), 'zh-CN', { numeric: true }));

  // 检测是否有层级字段（level/depth/indent 等）
  const hasLevel = items.some(it => it.level || it.depth || it.indent_level);
  if (hasLevel) {
    // 有层级 → 用栈构建多级树（与 buildBomTree 相同算法）
    const root = { depth: 0, children: [] };
    const stack = [root];
    items.forEach(line => {
      const d = levelDepth(line); // 复用 levelDepth（支持 .1/..2 和 numeric）
      while (stack.length > 1 && stack[stack.length - 1].depth >= d) stack.pop();
      const matCode = (line.material_code || '').trim();
      const bomQty = toNum(line.standard_qty || line.quantity || 1);
      const bomPrice = toNum(line.unit_price || 0);
      const curPrice = priceMap[matCode];
      const useCurrent = curPrice !== undefined && curPrice !== 0;
      const unitPrice = useCurrent ? curPrice : bomPrice;
      const priceSource = useCurrent ? '物料库当前价' : (bomPrice ? 'BOM单价' : '无价');
      const mat = r2(unitPrice * bomQty);
      const node = {
        material_code: line.material_code || '', material_name: line.material_name || '',
        spec: line.spec_model || '', unit: '', material_attr: line.material_attr || '',
        depth: d, bom_qty: r2(bomQty), unit_price: r2(unitPrice), price_source: priceSource,
        _matPerParent: mat, _labPerParent: 0, _expPerParent: 0, children: []
      };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    });
    // rollup
    root.children.forEach(n => _rollupExtNode(n, orderQty));
    return root.children;
  }

  // 无层级 → 扁平结构
  const nodes = items.map(line => {
    const matCode = (line.material_code || '').trim();
    const bomQty = toNum(line.standard_qty || 1);
    const bomPrice = toNum(line.unit_price || 0);
    const curPrice = priceMap[matCode];
    const useCurrent = curPrice !== undefined && curPrice !== 0;
    const unitPrice = useCurrent ? curPrice : bomPrice;
    const priceSource = useCurrent ? '物料库当前价' : (bomPrice ? 'BOM单价' : '无价');
    const totalQty = r2(bomQty * orderQty);
    const matAmt = r2(totalQty * unitPrice);
    return {
      material_code: line.material_code || '',
      material_name: line.material_name || '',
      spec: line.spec_model || '',
      unit: '',
      material_attr: '',
      key_part: '',
      depth: 1,
      bom_qty: bomQty,
      unit_price: unitPrice,
      price_source: priceSource,
      total_qty: totalQty,
      material_amount: matAmt,
      labor_amount: 0,
      expense_amount: 0,
      line_total: matAmt,
      material_rollup: matAmt,
      labor_rollup: 0,
      expense_rollup: 0,
      total_rollup: matAmt,
      has_children: false,
      children: [],
      purchase_confirm_cost: matAmt,
      actual_cost: 0
    };
  });

  return nodes;
}

// 详情（含计划快照 / 实际归集 / 同类 / 审核日志）
router.get('/:id', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  const snap = getTable('order_cost_snapshots');
  const logs = getTable('order_review_logs');
  // 注意：不调用 _invalidate() —— snapshots 文件达 362MB，每次重读会卡数秒
  // 缓存在启动时加载，新增记录通过 in-memory 更新自动可见

  const card = analysis.all().find(a => a.order_id === order.id);
  const cardId = card && card.id;
  const planSnap = cardId ? snap.all().filter(s => s.order_analysis_id === cardId && s.snapshot_type === 'plan').sort((a, b) => (b.id - a.id))[0] : null;
  const actualSnap = cardId ? snap.all().filter(s => s.order_analysis_id === cardId && s.snapshot_type === 'actual').sort((a, b) => (b.id - a.id))[0] : null;
  const reviewLogs = cardId ? logs.all().filter(l => l.order_analysis_id === cardId).sort((a, b) => (a.id - b.id)) : [];

  // 解析 assigned_personnel 为数组
  let assignedPersonnel = [];
  if (card && card.assigned_personnel) {
    try { assignedPersonnel = JSON.parse(card.assigned_personnel); } catch(e) {}
  }
  // 获取人员名称
  const pt = getTable('org_personnel');
  pt._invalidate();
  const persMap = {};
  pt.all().forEach(p => { persMap[p.id] = p.name; });

  // 获取订单的真实产品列表（order_products）—— 详情比对要以真实产品为准
  const opTable = getTable('order_products');
  opTable._invalidate();
  const orderProducts = opTable.all().filter(r => r.order_id === order.id).sort((a, b) => a.id - b.id);

  // 预热该订单产品的 SPC 树（并行），确保 plan_cost 与明细(BOM展开)同口径
  {
    const warmBomNos = new Set(orderProducts.map(p => (p.bom_no || '').trim()).filter(Boolean));
    await Promise.all([...warmBomNos].map(bn => fetchSpcBomTree(bn)));
  }

  // 自动从外部 ERP 导入成品工价（补缺失 bom_no），使人工费自动进入 plan_cost
  await autoImportLaborRates(order.id);

  // 实时 BOM 计划成本：用 calcPlanCost（与明细/提交同口径，含 BOM 组件人工 + 成品工价），
  // 保证详情页 plan_cost 与快照/明细面板完全一致
  const _pc = await calcPlanCost(order);
  const dynPlanCost = { material: _pc.material, labor: _pc.labor, expense: _pc.expense, total: _pc.total };

  res.json({
    order,
    order_products: orderProducts,
    analysis: card ? { ...card, assigned_personnel_arr: assignedPersonnel, assigned_personnel_names: assignedPersonnel.map(id => persMap[id] || id).filter(Boolean) } : null,
    plan_cost: dynPlanCost,
    plan_snapshot: planSnap || null,
    actual_snapshot: actualSnap || null,
    review_logs: reviewLogs
  });
});

// 从外部ERP获取工价（工价审核表，按 bom_no 匹配）
router.get('/:id/labor-rates', requirePerm('order-analysis:view'), async (req, res) => {
  const orderId = Number(req.params.id);
  const ops = getOrderProductsIndex()[orderId] || [];
  const bomNos = [...new Set(ops.map(p => (p.bom_no || '').trim()).filter(Boolean))];
  if (!bomNos.length) return res.json({ rates: {}, source: 'no_bom_no' });

  const settings = getTable('system_settings');
  const cfgRow = settings.all().find(r => r.key === 'labor_rate_endpoint');
  let endpointCode = 'labor_rates.list';
  let configField = 'labor_amount';
  if (cfgRow) { try { const c = JSON.parse(cfgRow.value); endpointCode = c.endpoint || endpointCode; configField = c.field || configField; } catch(e) {} }

  const rates = {};
  let fetched = 0;
  const tasks = bomNos.map(async (bomNo) => {
    try {
      const data = await Promise.race([
        fetchExternal(endpointCode, { bom_no: bomNo, page: 1, page_size: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ]);
      const items = (data && data.items) || (data && data.data && data.data.items) || [];
      if (items.length) {
        const item = items[0];
        const rate = Number(item[configField] || item.labor_amount || item.wage || item.labor_cost || item.price || 0);
        if (rate > 0) { rates[bomNo] = rate; fetched++; }
      }
    } catch(e) {}
  });
  await Promise.all(tasks);
  res.json({ rates, source: fetched > 0 ? 'erp' : 'empty', fetched, total: bomNos.length, endpoint: endpointCode });
});

// 产品型号搜索（从 BOM 取，供订单关联产品/展开多产品）
router.get('/meta/products', requirePerm('order-analysis:view'), (req, res) => {
  const kw = String(req.query.keyword || '').trim().toLowerCase();
  // 用缓存的 bom 索引（避免重读 10 万行文件）
  const idx = getBomIndex();
  const list = [];
  for (const [pc, rows] of Object.entries(idx)) {
    if (!pc) continue;
    const mats = [];
    rows.forEach(r => {
      if (r.material_code) mats.push(r.material_code.toLowerCase());
      if (r.material_name) mats.push(r.material_name.toLowerCase());
    });
    list.push({ product_code: pc, product_name: rows[0]?.product_name || '', line_count: rows.length, _mats: mats });
  }
  const filtered = kw ? list.filter(x => {
    if ((x.product_code + ' ' + x.product_name).toLowerCase().includes(kw)) return true;
    return (x._mats || []).some(m => m.includes(kw));
  }) : list;
  filtered.sort((a, b) => b.line_count - a.line_count);
  res.json({ data: filtered.slice(0, 100).map(x => ({ product_code: x.product_code, product_name: x.product_name, line_count: x.line_count })), total: list.length });
});

// 人员下拉（用于指定负责人）
router.get('/meta/personnel', requirePerm('order-analysis:view'), (req, res) => {
  const pt = getTable('org_personnel');
  pt._invalidate();
  const list = pt.all().filter(p => p.status === 'active').map(p => ({ id: p.id, name: p.name, department_name: p.department_name || '' }));
  res.json({ data: list, total: list.length });
});

// 保存成品工价（持久化到 order_analysis，供计划成本计算使用）
// 同时同步到 product_labor_rate 表（成品工价库），source='order_analysis'
router.put('/:id/product-rates', requirePerm('order-analysis:edit'), async (req, res) => {
  const oid = Number(req.params.id);
  const rates = req.body.rates || {}; // { bom_no: rate_per_unit }
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  let card = analysis.all().find(a => a.order_id === oid);
  if (!card) {
    card = { order_id: oid, order_no: '', created_at: now(), updated_at: now() };
    const r = await analysis.insert(card);
    card.id = r.lastID;
  }
  if (card.is_locked) {
    return res.status(400).json({ error: '订单已锁定，禁止修改成品工价', locked: true });
  }
  await analysis.update(card.id, { product_rates: JSON.stringify(rates), updated_at: now() });
  analysis._invalidate();
  _invalidateOrderPlanCostCache(oid);

  // ===== 同步到成品工价库（product_labor_rate）=====
  let synced = 0;
  try {
    const lrTable = getTable('product_labor_rate');
    lrTable._invalidate();
    const ops = getOrderProductsIndex()[oid] || [];
    const ts = now();
    for (const [bomNo, rateVal] of Object.entries(rates)) {
      const rate = Number(rateVal);
      if (!bomNo || !rate || rate <= 0) continue;
      // 从 order_products 找产品信息
      const op = ops.find(p => (p.bom_no || '').trim() === bomNo || (p.product_code || '').trim() === bomNo);
      const productCode = (op && op.product_code) || bomNo;
      const productName = (op && op.product_name) || '';
      const existing = lrTable.all().find(r => r.bom_no === bomNo && r.audit_status !== 'disabled');
      if (existing) {
        // 已有记录且工价不同 → 更新（保留原有 audit_status）
        if (Number(existing.labor_rate) !== rate) {
          await lrTable.update(existing.id, {
            labor_rate: Math.round(rate * 100) / 100,
            product_code: productCode,
            product_name: productName || existing.product_name,
            source: 'order_analysis',
            updated_at: ts
          });
          synced++;
        }
      } else {
        // 新增（默认 pending 待审核）
        await lrTable.insert({
          bom_no: bomNo,
          product_code: productCode,
          product_name: productName,
          labor_rate: Math.round(rate * 100) / 100,
          labor_rate_type: '实测工价',
          process_cost: 0,
          effective_date: ts.substring(0, 10),
          expire_date: '',
          source: 'order_analysis',
          audit_status: 'pending',
          approved_by: '',
          remarks: '来自订单分析自动同步',
          created_at: ts,
          updated_at: ts
        });
        synced++;
      }
    }
  } catch (e) {
    console.warn('[order-analysis] 同步工价到 product_labor_rate 失败:', e.message);
  }

  res.json({ message: '工价已保存' + (synced ? `，已同步 ${synced} 条到成品工价库` : ''), rates, synced });
});

// ===== 将订单分析的工价同步到成品工价库（不检查锁定，只读 product_rates 并 upsert）=====
// 支持单订单 / 全量批量
router.post('/sync-rates-to-library', requirePerm('order-analysis:edit'), async (req, res) => {
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const allCards = analysis.all();
  const lrTable = getTable('product_labor_rate');
  lrTable._invalidate();
  const opIdx = getOrderProductsIndex();
  const ts = now();
  let totalOrders = 0, totalSynced = 0, totalSkipped = 0;
  const details = [];

  for (const card of allCards) {
    if (!card.product_rates) continue;
    let rates;
    try { rates = JSON.parse(card.product_rates); } catch(e) { continue; }
    if (!rates || typeof rates !== 'object') continue;
    const oid = card.order_id;
    const ops = opIdx[oid] || [];
    let orderSynced = 0;
    for (const [bomNo, rateVal] of Object.entries(rates)) {
      const rate = Number(rateVal);
      if (!bomNo || !rate || rate <= 0) { totalSkipped++; continue; }
      const op = ops.find(p => (p.bom_no||'').trim() === bomNo || (p.product_code||'').trim() === bomNo);
      const productCode = (op && op.product_code) || bomNo;
      const productName = (op && op.product_name) || '';
      const existing = lrTable.all().find(r => r.bom_no === bomNo && r.audit_status !== 'disabled');
      if (existing) {
        if (Number(existing.labor_rate) !== rate) {
          await lrTable.update(existing.id, {
            labor_rate: Math.round(rate*100)/100,
            product_code: productCode,
            product_name: productName || existing.product_name,
            source: 'order_analysis', updated_at: ts
          });
          orderSynced++; totalSynced++;
        } else {
          totalSkipped++;
        }
      } else {
        await lrTable.insert({
          bom_no: bomNo, product_code: productCode, product_name: productName,
          labor_rate: Math.round(rate*100)/100, labor_rate_type: '实测工价',
          process_cost: 0, effective_date: ts.substring(0,10), expire_date: '',
          source: 'order_analysis', audit_status: 'pending', approved_by: '',
          remarks: '来自订单 ' + (card.order_no||oid) + ' 工价同步',
          created_at: ts, updated_at: ts
        });
        orderSynced++; totalSynced++;
      }
    }
    if (orderSynced > 0) {
      totalOrders++;
      details.push({ order_id: oid, order_no: card.order_no, synced: orderSynced });
    }
  }
  res.json({
    message: `同步完成：${totalOrders} 个订单，${totalSynced} 条工价入库，${totalSkipped} 条跳过`,
    total_orders: totalOrders, total_synced: totalSynced, total_skipped: totalSkipped,
    details: details.slice(0, 50)
  });
});

// 单订单同步（不检查锁定）
router.post('/:id/sync-rates-to-library', requirePerm('order-analysis:edit'), async (req, res) => {
  const oid = Number(req.params.id);
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const card = analysis.all().find(a => a.order_id === oid);
  if (!card) {
    return res.json({ message: '该订单无分析数据', synced: 0 });
  }
  const ts = now();
  const yStart = new Date().getFullYear() + '-01-01';
  const orderNo = card.order_no || String(oid);
  const lrTable = getTable('product_labor_rate');
  lrTable._invalidate();
  let synced = 0;
  const breakdown = { product_rate: 0, self_made: 0, outsourced: 0, labor_line: 0 };

  // ---- Part A: 成品工价（product_rates）----
  if (card.product_rates) {
    try {
      const rates = JSON.parse(card.product_rates);
      const ops = getOrderProductsIndex()[oid] || [];
      for (const [bomNo, rateVal] of Object.entries(rates)) {
        const rate = Number(rateVal);
        if (!bomNo || !rate || rate <= 0) continue;
        const op = ops.find(p => (p.bom_no||'').trim() === bomNo || (p.product_code||'').trim() === bomNo);
        const productCode = (op && op.product_code) || bomNo;
        const productName = (op && op.product_name) || '';
        const existing = lrTable.all().find(r => r.bom_no === bomNo && r.audit_status !== 'disabled');
        if (existing) {
          if (Number(existing.labor_rate) !== rate) {
            await lrTable.update(existing.id, { labor_rate: Math.round(rate*100)/100, product_code: productCode, product_name: productName||existing.product_name, source: 'order_analysis', updated_at: ts });
            synced++; breakdown.product_rate++;
          }
        } else {
          await lrTable.insert({ bom_no: bomNo, product_code: productCode, product_name: productName, labor_rate: Math.round(rate*100)/100, labor_rate_type: '实测工价', process_cost: 0, effective_date: yStart, expire_date: '', source: 'order_analysis', audit_status: 'pending', approved_by: '', remarks: '来自订单 '+orderNo+' 成品工价', created_at: ts, updated_at: ts });
          synced++; breakdown.product_rate++;
        }
      }
    } catch(e) {}
  }

  // ---- Part B: BOM 明细中的自制/外加工物料 + 人工行 ----
  try {
    const snapTable = getTable('order_cost_snapshots');
    snapTable._invalidate();
    // 取最新的 plan 快照
    const snapRow = snapTable.all()
      .filter(s => s.order_analysis_id === card.id && s.snapshot_type === 'plan')
      .sort((a, b) => b.id - a.id)[0];
    if (snapRow && snapRow.lines) {
      // lines 可能是数组、JSON 字符串数组、或含 lines 字段的对象
      let lines = snapRow.lines;
      if (typeof lines === 'string') {
        try { lines = JSON.parse(lines); } catch(e) { lines = null; }
      }
      if (lines && !Array.isArray(lines) && Array.isArray(lines.lines)) {
        lines = lines.lines;
      }
      if (Array.isArray(lines)) {
        for (const line of lines) {
          const attr = String(line.material_attr || '').trim();
          const labor = Number(line.labor_amount) || 0;
          if (attr !== '自制' && attr !== '外加工' && labor <= 0) continue;
          const bomNo = String(line.material_code || '').trim();
          if (!bomNo) continue;
          const existing = lrTable.all().find(r => r.bom_no === bomNo && r.audit_status !== 'disabled');
          const rate = Math.round(labor * 100) / 100;
          const productName = String(line.material_name || '').trim();
          const spec = String(line.spec || '').trim();
          const unit = String(line.unit || '').trim();
          const qty = Number(line.total_qty) || 0;
          const remarkParts = ['来自订单 ' + orderNo];
          if (attr) remarkParts.push(attr);
          if (spec) remarkParts.push('规格:' + spec);
          if (qty) remarkParts.push('用量:' + qty + (unit || ''));
          const remarks = remarkParts.join(' / ').substring(0, 200);
          const rateType = attr === '自制' ? '实测工价' : (attr === '外加工' ? '暂估工价' : '实测工价');
          if (existing) {
            if (Number(existing.labor_rate) !== rate || existing.source !== 'order_analysis') {
              await lrTable.update(existing.id, {
                labor_rate: rate, product_code: bomNo,
                product_name: productName || existing.product_name,
                labor_rate_type: existing.labor_rate_type || rateType,
                source: 'order_analysis', remarks, updated_at: ts
              });
              synced++;
              if (attr === '自制') breakdown.self_made++;
              else if (attr === '外加工') breakdown.outsourced++;
              else breakdown.labor_line++;
            }
          } else {
            await lrTable.insert({
              bom_no: bomNo, product_code: bomNo, product_name: productName,
              labor_rate: rate, labor_rate_type: rateType, process_cost: 0,
              effective_date: yStart, expire_date: '',
              source: 'order_analysis', audit_status: 'pending', approved_by: '',
              remarks, created_at: ts, updated_at: ts
            });
            synced++;
            if (attr === '自制') breakdown.self_made++;
            else if (attr === '外加工') breakdown.outsourced++;
            else breakdown.labor_line++;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[order-analysis] BOM 明细同步失败:', e.message);
  }

  res.json({
    message: `订单 ${orderNo} 同步完成，${synced} 条入库（成品工价 ${breakdown.product_rate}，自制 ${breakdown.self_made}，外加工 ${breakdown.outsourced}，人工行 ${breakdown.labor_line}）`,
    synced, breakdown, order_id: oid
  });
});

// 设定订单分析负责人（可多人）
router.put('/:id/assign-personnel', requirePerm('order-analysis:audit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  let card = analysis.all().find(a => a.order_id === order.id);
  if (!card) return res.status(400).json({ error: '该订单尚未提交审核（无分析卡）' });
  const ids = Array.isArray(req.body.personnel_ids) ? req.body.personnel_ids : [];
  await analysis.update(card.id, { assigned_personnel: JSON.stringify(ids), updated_at: now() });
  res.json({ message: '负责人已指定' });
});

// 筛选项 / 下拉
router.get('/meta/filter-options', requirePerm('order-analysis:view'), (req, res) => {
  const orders = getTable('orders');
  orders._invalidate();
  const uniq = key => [...new Set(orders.all().map(r => r[key]).filter(v => v !== undefined && v !== null && String(v).trim() !== ''))];
  res.json({
    statuses: uniq('status'),
    risk_levels: uniq('risk_level'),
    customers: uniq('customer_name').slice(0, 100),
    products: uniq('product_code').slice(0, 100),
    review_statuses: ['pending', 'reviewing', 'approved', 'rejected']
  });
});

// 统计卡片（支持筛选参数过滤）
router.get('/dashboard/stats', requirePerm('order-analysis:view'), (req, res) => {
  const { keyword, status, review_status, customer, product, risk_level, has_overrun, profit_min, profit_max, date_from, date_to, exclude_sample } = req.query;
  const orders = getTable('orders');
  orders._invalidate();
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const cardMap = {}; analysis.all().forEach(a => { cardMap[a.order_id] = a; });

  const detTable = getTable('order_bom_details');
  // 不 _invalidate：236MB 大表每次重读需数秒；进程内缓存已由本服务 insert/update/delete 同步保持新鲜
  const materialCostMap = {};
  detTable.all().forEach(r => {
    const lineTotal = toNum(r.line_total);
    const purchaseVal = toNum(r.purchase_confirm_cost);
    const matVal = toNum(r.material_amount);
    const val = lineTotal > 0 ? lineTotal : (purchaseVal > 0 ? purchaseVal : matVal);
    if (val > 0) {
      materialCostMap[r.order_id] = (materialCostMap[r.order_id] || 0) + val;
    }
  });

  let orderCount = 0, reviewedCount = 0, approvedCount = 0, pendingCount = 0;
  let totalPlan = 0, totalActual = 0, totalOrderAmount = 0, overrunCount = 0;
  orders.all().forEach(o => {
    if (cardMap[o.id] && cardMap[o.id].is_void) return;
    // 排除样品单（HJY 开头）
    if (exclude_sample === '1' && (o.order_no || '').toUpperCase().startsWith('HJY')) return;

    // 日期过滤按订单业务日期（promised_date 优先，回退到订单号解析年份）
    if (date_from || date_to) {
      let bizDate = o.promised_date || '';
      if (!bizDate) {
        const m = (o.order_no || '').match(/HJY?(\d{4})(\d{2})?/);
        if (m) bizDate = m[1] + '-' + (m[2] || '01') + '-01';
      }
      if (!bizDate) bizDate = (o.created_at || '').substring(0, 10);
      if (date_from && bizDate < date_from) return;
      if (date_to && bizDate > date_to) return;
    }

    if (status && o.status !== status) return;
    if (review_status && (cardMap[o.id] || {}).review_status !== review_status) return;
    if (customer && !(o.customer_name || '').includes(customer)) return;
    if (product && !((o.product_code || '') + (o.product_name || '')).toLowerCase().includes(String(product).toLowerCase())) return;
    if (risk_level && o.risk_level !== risk_level) return;
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      if (![o.order_no, o.customer_name, o.product_code, o.product_name].join(' ').toLowerCase().includes(kw)) return;
    }

    orderCount++;
    totalOrderAmount += toNum(o.order_amount);
    
    const plan = materialCostMap[o.id] != null ? toNum(materialCostMap[o.id]) : (cardMap[o.id] ? toNum(cardMap[o.id].plan_total_cost) : 0);
    const actual = cardMap[o.id] ? toNum(cardMap[o.id].actual_total_cost) : 0;
    const grossRate = plan > 0 ? (toNum(o.order_amount) - plan) / (toNum(o.order_amount) || 1) * 100 : null;
    
    if (has_overrun === '1' && !(actual > plan && plan > 0)) return;
    if (has_overrun === '0' && (actual > plan && plan > 0)) return;
    if (profit_min !== undefined && profit_min !== '' && (grossRate === null || grossRate < toNum(profit_min))) return;
    if (profit_max !== undefined && profit_max !== '' && (grossRate === null || grossRate > toNum(profit_max))) return;

    const c = cardMap[o.id];
    if (c) {
      if (c.review_status === 'approved') approvedCount++;
      else if (c.review_status === 'pending' || c.review_status === 'reviewing') pendingCount++;
      if (c.review_status) reviewedCount++;
    } else {
      pendingCount++;
    }
    
    if (plan > 0) totalPlan += plan;
    if (actual > 0) totalActual += actual;
    if (plan > 0 && actual > plan) overrunCount++;
  });
  res.json({
    order_count: orderCount,
    reviewed_count: reviewedCount,
    approved_count: approvedCount,
    pending_count: pendingCount,
    total_order_amount: r2(totalOrderAmount),
    total_plan_cost: r2(totalPlan),
    total_actual_cost: r2(totalActual),
    cost_variance: r2(totalActual - totalPlan),
    overrun_count: overrunCount,
    avg_gross_rate: totalPlan > 0 ? r2((totalOrderAmount - totalPlan) / (totalOrderAmount || 1) * 100) : null
  });
});

// ===== 提交审核（创建分析卡 + 落计划快照） =====
router.post('/', requirePerm('order-analysis:audit'), async (req, res) => {
  const orders = getTable('orders');
  const { order_id, review_remark } = req.body || {};
  const order = orders.findById(order_id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const exist = analysis.all().find(a => a.order_id === order.id);
  if (exist && exist.review_status === 'approved') {
    return res.status(400).json({ error: '该订单已审核通过，如需重审请先重置' });
  }

clearMatPriceCache();
  // 自动从外部 ERP 导入成品工价，确保提交快照含人工费（与实时 plan_cost 同口径）
  await autoImportLaborRates(order.id);
  const plan = await calcPlanCost(order);
  const operatorId = Number(req.body.user_id || req.headers['x-user-id']) || null;
  const ts = now();

  let cardId;
  const cardFields = {
    order_id: order.id, order_no: order.order_no,
    review_status: 'pending',
    assigned_personnel: '[]',
    reviewer_id: null, review_at: null, review_remark: review_remark || '',
    plan_material_cost: plan.material, plan_labor_cost: plan.labor,
    plan_expense_cost: plan.expense, plan_total_cost: plan.total,
    plan_snapshot_at: ts, plan_gross_profit: plan.gross_profit, plan_gross_rate: plan.gross_rate,
    actual_material_cost: null, actual_labor_cost: null, actual_expense_cost: null, actual_total_cost: null,
    actual_snapshot_at: null, updated_at: ts
  };
  if (exist) {
    cardId = exist.id;
    await analysis.update(exist.id, Object.assign({}, cardFields, { review_status: exist.review_status === 'rejected' ? 'pending' : (exist.review_status || 'pending') }));
  } else {
    const r = await analysis.insert(Object.assign({ created_at: ts }, cardFields));
    cardId = r.lastID;
  }

  // 落计划快照（去重：删除同类旧快照）
  const snap = getTable('order_cost_snapshots');
  for (const old of snap.all().filter(s => s.order_analysis_id === cardId && s.snapshot_type === 'plan')) {
    try { await snap.delete(old.id); } catch(_) {}
  }
  await snap.insert({
    order_analysis_id: cardId, order_id: order.id, order_no: order.order_no,
    snapshot_type: 'plan', material: plan.material, labor: plan.labor,
    expense: plan.expense, total: plan.total, order_qty: plan.order_qty,
    order_amount: plan.order_amount, gross_profit: plan.gross_profit, gross_rate: plan.gross_rate,
    lines: plan.lines, warnings: plan.warnings, snapshot_time: ts, created_at: ts
  });

  // 审核日志
  const logs = getTable('order_review_logs');
  await logs.insert({
    order_analysis_id: cardId, order_id: order.id, order_no: order.order_no,
    action: 'submit', operator_id: operatorId, comment: review_remark || '提交审核',
    from_status: exist ? (exist.review_status || null) : null, to_status: 'pending',
    cost_snapshot: { plan_total: plan.total, material: plan.material, labor: plan.labor, expense: plan.expense },
    at: ts
  });

  res.json({ message: '已提交审核并生成计划成本快照', analysis_id: cardId, plan_cost: { material: plan.material, labor: plan.labor, expense: plan.expense, total: plan.total, gross_rate: plan.gross_rate } });
});

// ===== 审核：通过 / 驳回 / 重置 =====
router.put('/:id/review', requirePerm('order-analysis:audit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const card = analysis.all().find(a => a.order_id === order.id);
  if (!card) return res.status(400).json({ error: '该订单尚未提交审核（无分析卡）' });

  const action = req.body.action; // approve | reject | reset
  const comment = req.body.comment || '';
  const operatorId = Number(req.body.user_id || req.headers['x-user-id']) || null;
  if (!['approve', 'reject', 'reset'].includes(action)) return res.status(400).json({ error: 'action 必须为 approve/reject/reset' });

  const fromStatus = card.review_status;
  let toStatus;
  if (action === 'approve') toStatus = 'approved';
  else if (action === 'reject') toStatus = 'rejected';
  else toStatus = 'pending';

  const ts = now();
  await analysis.update(card.id, {
    review_status: toStatus,
    reviewer_id: operatorId,
    review_at: ts,
    review_remark: comment || card.review_remark || '',
    updated_at: ts
  });

  const logs = getTable('order_review_logs');
  await logs.insert({
    order_analysis_id: card.id, order_id: order.id, order_no: order.order_no,
    action, operator_id: operatorId, comment,
    from_status: fromStatus, to_status: toStatus, at: ts
  });

  res.json({ message: '审核操作成功', review_status: toStatus });
});

// ===== 实际成本归集并落快照（订单完工后） =====
router.post('/:id/collect-actual', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  let card = analysis.all().find(a => a.order_id === order.id);

  const actual = collectActualCost(order);
  const orderAmount = toNum(order.order_amount);
  const actualGrossProfit = r2(orderAmount - actual.total);
  const actualGrossRate = orderAmount > 0 ? r2(actualGrossProfit / orderAmount * 100) : 0;
  const planGp = card && card.plan_gross_profit != null ? toNum(card.plan_gross_profit) : null;
  const planGr = card && card.plan_gross_rate != null ? toNum(card.plan_gross_rate) : null;
  let grossVariance = null;
  if (planGp != null) {
    grossVariance = {
      plan_gross_profit: r2(planGp), actual_gross_profit: actualGrossProfit,
      profit_diff: r2(actualGrossProfit - planGp),
      plan_gross_rate: planGr, actual_gross_rate: actualGrossRate,
      rate_diff: r2(actualGrossRate - planGr)
    };
  }
  const ts = now();
  let cardId;
  if (card) {
    cardId = card.id;
    await analysis.update(card.id, {
      actual_material_cost: actual.material, actual_labor_cost: actual.labor,
      actual_expense_cost: actual.expense, actual_total_cost: actual.total,
      actual_gross_profit: actualGrossProfit, actual_gross_rate: actualGrossRate,
      actual_snapshot_at: ts, updated_at: ts
    });
  } else {
    // 没有分析卡也允许直接归集实际（自动建卡，状态 pending）
    const r = await analysis.insert({
      order_id: order.id, order_no: order.order_no, review_status: 'pending',
      reviewer_id: null, review_at: null, review_remark: '',
      plan_material_cost: null, plan_labor_cost: null, plan_expense_cost: null, plan_total_cost: null,
      plan_snapshot_at: null, plan_gross_profit: null, plan_gross_rate: null,
      actual_material_cost: actual.material, actual_labor_cost: actual.labor,
      actual_expense_cost: actual.expense, actual_total_cost: actual.total,
      actual_gross_profit: actualGrossProfit, actual_gross_rate: actualGrossRate,
      actual_snapshot_at: ts, created_at: ts, updated_at: ts
    });
    cardId = r.lastID;
  }

  const snap = getTable('order_cost_snapshots');
  for (const old of snap.all().filter(s => s.order_analysis_id === cardId && s.snapshot_type === 'actual')) {
    try { await snap.delete(old.id); } catch(_) {}
  }
  await snap.insert({
    order_analysis_id: cardId, order_id: order.id, order_no: order.order_no,
    snapshot_type: 'actual', material: actual.material, labor: actual.labor,
    expense: actual.expense, total: actual.total,
    items: actual.items, counts: actual.counts, warnings: actual.warnings,
    snapshot_time: ts, created_at: ts
  });

  // 计算差异（若有计划快照）
  const planSnap = snap.all().filter(s => s.order_analysis_id === cardId && s.snapshot_type === 'plan').sort((a, b) => b.id - a.id)[0];
  let variance = null;
  if (planSnap) {
    variance = calcVariance(
      { material: planSnap.material, labor: planSnap.labor, expense: planSnap.expense, total: planSnap.total },
      { material: actual.material, labor: actual.labor, expense: actual.expense, total: actual.total }
    );
  }

  res.json({
    message: '实际成本已归集并生成快照', analysis_id: cardId,
    actual: { material: actual.material, labor: actual.labor, expense: actual.expense, total: actual.total, counts: actual.counts,
              order_amount: r2(orderAmount), gross_profit: actualGrossProfit, gross_rate: actualGrossRate },
    variance, gross_variance: grossVariance
  });
});

// ===== 多维分析报表 =====
router.get('/report/summary', requirePerm('order-analysis:view'), (req, res) => {
  const { group_by = 'customer', status, review_status, customer, product, risk_level,
          has_overrun, profit_min, profit_max, date_from, date_to } = req.query;
  const orders = getTable('orders');
  orders._invalidate();
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const cardMap = {}; analysis.all().forEach(a => { cardMap[a.order_id] = a; });

  const groups = {};
  let totals = { order_count: 0, order_amount: 0, plan_cost: 0, actual_cost: 0, gross_profit: 0, actual_gp: 0 };

  orders.all().forEach(o => {
    // 过滤：排除作废订单
    const card = cardMap[o.id] || {};
    if (card.is_void) return;
    if (status && o.status !== status) return;
    if (review_status && card.review_status !== review_status) return;
    if (customer && !(o.customer_name || '').includes(customer)) return;
    if (product && !((o.product_code || '') + (o.product_name || '')).toLowerCase().includes(String(product).toLowerCase())) return;
    if (risk_level && o.risk_level !== risk_level) return;
    if (date_from && (o.promised_date || '') < date_from) return;
    if (date_to && (o.promised_date || '') > date_to) return;
    const plan = toNum(card.plan_total_cost);
    const actual = toNum(card.actual_total_cost);
    if (has_overrun === '1' && !(actual > plan && plan > 0)) return;
    if (has_overrun === '0' && (actual > plan && plan > 0)) return;
    const orderAmount = toNum(o.order_amount);
    const grossRate = plan > 0 ? (orderAmount - plan) / (orderAmount || 1) * 100 : null;
    if (profit_min !== undefined && profit_min !== '' && (grossRate === null || grossRate < toNum(profit_min))) return;
    if (profit_max !== undefined && profit_max !== '' && (grossRate === null || grossRate > toNum(profit_max))) return;

    let key;
    if (group_by === 'customer') key = o.customer_name || '未填';
    else if (group_by === 'product') key = o.product_code || o.product_name || '未填';
    else if (group_by === 'status') key = o.status || 'open';
    else if (group_by === 'review_status') key = (cardMap[o.id] || {}).review_status || '未提交';
    else if (group_by === 'risk') key = o.risk_level || '未填';
    else if (group_by === 'month') key = String(o.promised_date || o.created_at || '').substring(0, 7) || '未填';
    else key = o.customer_name || '未填';

    if (!groups[key]) groups[key] = { name: key, order_count: 0, order_amount: 0, plan_cost: 0, actual_cost: 0, gross_profit: 0, actual_gp: 0, overrun_count: 0 };
    const g = groups[key];
    g.order_count++; g.order_amount += orderAmount; g.plan_cost += plan; g.actual_cost += actual;
    g.gross_profit += (orderAmount - plan);
    if (actual > 0) g.actual_gp += (orderAmount - actual);
    if (actual > plan && plan > 0) g.overrun_count++;
    totals.order_count++; totals.order_amount += orderAmount; totals.plan_cost += plan; totals.actual_cost += actual; totals.gross_profit += (orderAmount - plan);
    if (actual > 0) totals.actual_gp += (orderAmount - actual);
  });

  const arr = Object.values(groups).map(g => ({
    name: g.name, order_count: g.order_count,
    order_amount: r2(g.order_amount), plan_cost: r2(g.plan_cost), actual_cost: r2(g.actual_cost),
    variance: r2(g.actual_cost - g.plan_cost), gross_profit: r2(g.gross_profit),
    gross_rate: g.order_amount > 0 ? r2(g.gross_profit / g.order_amount * 100) : 0,
    actual_gross_profit: r2(g.actual_gp),
    actual_gross_rate: g.order_amount > 0 ? r2(g.actual_gp / g.order_amount * 100) : 0,
    overrun_count: g.overrun_count,
    avg_order_amount: r2(g.order_amount / (g.order_count || 1))
  })).sort((a, b) => b.order_amount - a.order_amount);

  res.json({
    group_by, groups: arr,
    totals: {
      order_count: totals.order_count, order_amount: r2(totals.order_amount),
      plan_cost: r2(totals.plan_cost), actual_cost: r2(totals.actual_cost),
      variance: r2(totals.actual_cost - totals.plan_cost),
      gross_profit: r2(totals.gross_profit),
      gross_rate: totals.order_amount > 0 ? r2(totals.gross_profit / totals.order_amount * 100) : 0,
      actual_gross_profit: r2(totals.actual_gp),
      actual_gross_rate: totals.order_amount > 0 ? r2(totals.actual_gp / totals.order_amount * 100) : 0
    }
  });
});

// 导出 CSV
router.get('/export/csv', requirePerm('order-analysis:view'), (req, res) => {
  const orders = getTable('orders');
  orders._invalidate();
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const cardMap = {}; analysis.all().forEach(a => { cardMap[a.order_id] = a; });

  const headers = ['订单号', '客户', '产品编码', '产品名称', '数量', '订单金额', '状态', '风险',
    '审核状态', '计划物料', '计划人工', '计划费用', '计划总成本', '计划毛利', '计划毛利率%',
    '实际物料', '实际人工', '实际费用', '实际总成本', '实际毛利', '实际毛利率%', '毛利变动',
    '总差异', '差异率%', '是否超支', '交期'];
  const data = orders.all().filter(o => !(cardMap[o.id] && cardMap[o.id].is_void)).map(o => {
    const c = cardMap[o.id] || {};
    const plan = toNum(c.plan_total_cost); const actual = toNum(c.actual_total_cost);
    const amt = toNum(o.order_amount);
    const gp = amt - plan;
    const gr = plan > 0 ? r2(gp / amt * 100) : '';
    const agp = actual > 0 ? amt - actual : '';
    const agr = actual > 0 && amt > 0 ? r2(agp / amt * 100) : '';
    const gpDiff = (agp !== '' && plan > 0) ? r2(agp - gp) : '';
    const diff = actual - plan; const diffPct = plan > 0 ? r2(diff / plan * 100) : '';
    return [o.order_no, o.customer_name, o.product_code, o.product_name, toNum(o.quantity), amt, o.status, o.risk_level,
      c.review_status || '', toNum(c.plan_material_cost), toNum(c.plan_labor_cost), toNum(c.plan_expense_cost), plan,
      r2(gp), gr, toNum(c.actual_material_cost), toNum(c.actual_labor_cost), toNum(c.actual_expense_cost), actual,
      agp !== '' ? r2(agp) : '', agr, gpDiff,
      r2(diff), diffPct, (plan > 0 && actual > plan) ? '是' : (actual ? '否' : ''), o.promised_date]
      .map(v => String(v == null ? '' : v).replace(/,/g, '，'));
  });
  let csv = headers.join(',') + '\n';
  data.forEach(r => csv += r.join(',') + '\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=order_analysis.csv');
  res.send('\uFEFF' + csv);
});

// ===== 订单多产品管理 =====

// 获取订单的产品列表
router.get('/:id/products', requirePerm('order-analysis:view'), (req, res) => {
  const op = getTable('order_products');
  op._invalidate();
  const rows = op.all().filter(r => r.order_id === Number(req.params.id)).sort((a,b) => a.id - b.id);
  res.json({ data: rows, total: rows.length });
});

// 为订单添加产品（自动同步 BOM 明细）
router.post('/:id/products', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const { product_code, product_name } = req.body || {};
  if (!product_code) return res.status(400).json({ error: 'product_code 必填' });
  const op = getTable('order_products');
  op._invalidate();
  // 查重
  const exists = op.all().find(r => r.order_id === Number(req.params.id) && r.product_code === product_code);
  if (exists) return res.status(400).json({ error: '该产品已添加到此订单' });
  const ts = now();
  const r = await op.insert({
    order_id: order.id, order_no: order.order_no,
    product_code, product_name: product_name || '', source: 'manual',
    created_at: ts, updated_at: ts
  });
  // 给订单主表 product_code 回填（如无则填第一个）
  if (!order.product_code) {
    await orders.update(order.id, { product_code, product_name: product_name || '', updated_at: ts });
  }
  res.json({ message: '产品已添加', data: op.findById(r.lastID) });
});

// 更新订单产品的数量/金额（每产品独立，用于一篮子多产品核算）
router.put('/:id/products/:pid', requirePerm('order-analysis:edit'), async (req, res) => {
  const op = getTable('order_products');
  const row = op.findById(req.params.pid);
  if (!row) return res.status(404).json({ error: '产品记录不存在' });
  if (Number(row.order_id) !== Number(req.params.id)) return res.status(400).json({ error: '产品不属于该订单' });
  const b = req.body || {};
  const fields = { updated_at: now() };
  if (b.quantity !== undefined) fields.quantity = toNum(b.quantity);
  if (b.amount !== undefined) fields.amount = toNum(b.amount);
  if (b.product_name !== undefined) fields.product_name = b.product_name;
  await op.update(req.params.pid, fields);
  res.json({ message: '已更新', data: op.findById(req.params.pid) });
});

// 删除订单的产品
router.delete('/:id/products/:pid', requirePerm('order-analysis:edit'), async (req, res) => {
  const op = getTable('order_products');
  const row = op.findById(req.params.pid);
  if (!row) return res.status(404).json({ error: '产品记录不存在' });
  if (Number(row.order_id) !== Number(req.params.id)) return res.status(400).json({ error: '产品不属于该订单' });
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  await op.delete(req.params.pid);
  op._invalidate();
  // 如果删除的是订单主表 product_code，且还有其他产品，则更新主表为第一个
  if (order && order.product_code === row.product_code) {
    const remaining = op.all().filter(r => r.order_id === Number(req.params.id)).sort((a,b) => a.id - b.id);
    if (remaining.length) {
      await orders.update(order.id, { product_code: remaining[0].product_code, product_name: remaining[0].product_name || '', updated_at: now() });
    }
  }
  res.json({ message: '产品已移除' });
});

// 获取订单的产品/行项目（合并 order_products + 同 order_no 的 orders 行）
// 优先查询外部 API（orders.list 按 order_no 过滤 + products.list 关键字），合并去重；
// 外部不可用时回退本地 order_products + siblings。
// query: ?source=local 强制只读本地（不调用外部 API，速度快）
router.get('/:id/line-items', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  // ----- 本地数据（始终读取，作为回退 + 补全 order_no/数量/金额等明细）-----
  const op = getTable('order_products');
  op._invalidate();
  const localOrderProducts = op.all().filter(r => r.order_id === Number(req.params.id)).sort((a, b) => a.id - b.id);
  const siblingRows = orders.all().filter(r => r.order_no === order.order_no && r.id !== order.id);

  // 始终使用本地 order_products 作为权威数据源（与 plan_cost 一致，杜绝外部数据差异）
  {
    const localProds = _mergeLocalProducts(order, localOrderProducts, siblingRows);
    const _pm = buildMaterialPriceMap();
    let _epCode = 'labor_rates.list', _field = 'labor_amount';
    {
      const settings = getTable('system_settings');
      const cfgRow = settings.all().find(r => r.key === 'labor_rate_endpoint');
      if (cfgRow) { try { const c = JSON.parse(cfgRow.value); _epCode = c.endpoint || _epCode; _field = c.field || _field; } catch(e) {} }
    }
    const _bomNos = [...new Set(localProds.map(p => (p.bom_no || '').trim()).filter(Boolean))];
    const _rateMap = {};
    if (_bomNos.length) {
      await Promise.all(_bomNos.map(async (bn) => {
        try {
          const d = await Promise.race([
            fetchExternal(_epCode, { bom_no: bn, page: 1, page_size: 1 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
          ]);
          const its = (d && d.items) || (d && d.data && d.data.items) || [];
          if (its.length) { const r = Number(its[0][_field] || its[0].labor_amount || 0); if (r > 0) _rateMap[bn] = r; }
        } catch(e) {}
      }));
    }
    localProds.forEach(p => { const bn = (p.bom_no || '').trim(); if (_rateMap[bn]) p.labor_rate = _rateMap[bn]; });
    await _attachBomTrees(localProds, _pm, buildLaborRateMap());
    _invalidateOrderPlanCostCache(req.params.id);
      // 从 order_analysis 加载已保存的成品工价
      const _anTable = getTable('order_analysis');
      const _anCard = _anTable.all().find(a => a.order_id === Number(req.params.id));
      let _savedRates = {};
      if (_anCard && _anCard.product_rates) { try { _savedRates = JSON.parse(_anCard.product_rates); } catch(e) {} }
      // 写入每个产品的 labor_rate（后端保存的优先于 ERP）
      localProds.forEach(p => {
        const bn = (p.bom_no || '').trim();
        if (bn && _savedRates[bn] != null) p.labor_rate = _savedRates[bn];
      });
      return res.json({
      order: _orderSummary(order),
      order_products: localOrderProducts,
      siblings: siblingRows.map(_siblingBrief),
      products: localProds.filter(p => (p.bom_no || '').trim() && (p.product_code || '').trim()),
      source: 'local',
      _labor: { called: _bomNos.length, fetched: Object.keys(_rateMap).length, ep: _epCode }
    });
  }

  // ----- 外部 API 优先：order_details.list 按 order_no 查询 → 拿到该订单的全部明细行（含产品编码）-----
  const externalProducts = [];
  const seenCodes = new Set();
  const errors = [];
  const orderNo = (order.order_no || '').trim();
  const customerName = (order.customer_name || '').trim();
  let externalOk = false;

  if (req.query.source !== 'local') {
    try {
      const items = await fetchAllPages('order_details.list', 200, 20, { order_no: orderNo });
      for (const it of items) {
        const code = (it.product_code || '').trim();
        const bomNo = (it.bom_no || '').trim();
        const dedupKey = bomNo || code;
        if (!dedupKey || seenCodes.has(dedupKey)) continue;
        seenCodes.add(dedupKey);
        externalProducts.push({
          product_code: code || null,
          product_name: (it.product_name || '').trim(),
          bom_no: bomNo,
          quantity: Number(it.order_qty || 0),
          amount: Number(it.order_amount || 0),
          line_no: it.line_no || '',
          source: 'external_order',
          has_bom: _bomHasProduct(code) || _bomHasProduct(bomNo)
        });
      }
      if (items.length) externalOk = true;
    } catch (e) { errors.push('order_details.list: ' + e.message); }
  }

  // 用本地数据补全外部缺失字段（数量/金额等），并附加本地手动添加的产品
  const localMerged = _mergeLocalProducts(order, localOrderProducts, siblingRows);
  for (const ext of externalProducts) {
    const local = localMerged.find(p => p.product_code === ext.product_code);
    if (local) {
      if (!ext.quantity) ext.quantity = local.quantity;
      if (!ext.amount) ext.amount = local.amount;
      if (!ext.product_name) ext.product_name = local.product_name;
      if (local.op_id) ext.op_id = local.op_id;
    }
  }
  // 以本地 order_products 为权威数据源（按 bom_no 合并数量，与 _computeOrderPlanCost 一致）
  // 外部数据仅用于补全 product_name 等字段
  const localByBom = {};
  localMerged.forEach(lp => {
    const key = (lp.bom_no || '').trim() || (lp.product_code || '').trim();
    if (!key) return;
    if (!localByBom[key]) {
      localByBom[key] = Object.assign({}, lp);
    } else {
      localByBom[key].quantity = (Number(localByBom[key].quantity) || 0) + (Number(lp.quantity) || 0);
      localByBom[key].amount = (Number(localByBom[key].amount) || 0) + (Number(lp.amount) || 0);
    }
  });
  // 用外部数据补全名称等字段（不追加外部独有的产品，保持与 plan_cost 一致）
  externalProducts.forEach(ep => {
    const epKey = (ep.bom_no || '').trim() || (ep.product_code || '').trim();
    const local = localByBom[epKey];
    if (local) {
      if (!local.product_name && ep.product_name) local.product_name = ep.product_name;
      local.source = 'external_order';
    }
  });
  externalProducts.length = 0;
  externalProducts.push(...Object.values(localByBom));

  // ===== 为所有产品构建分级 BOM 树（含递归子 BOM）— 无论外部/本地路径都执行 =====
  const _priceMap = buildMaterialPriceMap();
  const _laborRateMap = buildLaborRateMap();
  await _attachBomTrees(externalProducts, _priceMap, _laborRateMap);

  // ===== 从ERP获取工价（工价审核表，按 bom_no 匹配）=====
  // 并行查询，每个 bom_no 最多等 8 秒，ERP不可达时整体快速跳过
  const _bomNos = [...new Set(externalProducts.map(p => (p.bom_no || '').trim()).filter(Boolean))];
  const _rateMap = {};
  if (_bomNos.length) {
    const settings = getTable('system_settings');
    const cfgRow = settings.all().find(r => r.key === 'labor_rate_endpoint');
    let _epCode = 'labor_rates.list', _field = 'labor_amount';
    if (cfgRow) { try { const c = JSON.parse(cfgRow.value); _epCode = c.endpoint || _epCode; _field = c.field || _field; } catch(e) {} }
    await Promise.all(_bomNos.map(async (bn) => {
      try {
        const d = await Promise.race([
          fetchExternal(_epCode, { bom_no: bn, page: 1, page_size: 1 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
        ]);
        const its = (d && d.items) || (d && d.data && d.data.items) || [];
        if (its.length) { const r = Number(its[0][_field] || its[0].labor_amount || its[0].wage || 0); if (r > 0) _rateMap[bn] = r; }
      } catch(e) {}
    }));
  }
  externalProducts.forEach(p => { const bn = (p.bom_no || '').trim(); if (_rateMap[bn]) p.labor_rate = _rateMap[bn]; });

  // ===== BOM 客户匹配检查 =====
  // 检查每个产品的 BOM 物料编码是否包含订单客户编码片段
  // 客户编号格式 HJ<组号>.<组内>-<编号>，BOM 物料通常用「HJ<编号>」或「HJ<编号>-XX」标识（如 HJ003.37-46 → BOM 用 HJ46）
  // 不匹配时记录警告，让用户立刻发现"数据错位"问题（如 3.1.FJ 实际是 391 客户 BOM 但订单是 46 客户）
  const _custName = (order.customer_name || '').trim();
  const cnTokens = []; // 客户编码片段（按长度倒序，优先匹配长片段）
  let custNum = ''; // 末尾编号（如 HJ003.37-46 → "46"），用于模糊匹配 "46客户"
  if (_custName) {
    // 取末尾「-数字」作为客户编号
    const mEnd = _custName.match(/-\s*(\d+)\s*$/);
    if (mEnd) {
      custNum = mEnd[1];
      cnTokens.push(('HJ' + custNum).toUpperCase());
    }
    // 也尝试 HJ<组号>.<组内> 格式
    const mHyphen = _custName.match(/HJ\d+\.\d+-\d+/);
    if (mHyphen) cnTokens.push(mHyphen[0].split('-').pop().replace(/^/, 'HJ').toUpperCase());
    // 也兼容 HJ<编号> 格式
    const mDirect = _custName.match(/^HJ(\d+)/);
    if (mDirect) cnTokens.push(('HJ' + mDirect[1]).toUpperCase());
    // 模糊匹配：编号+客户（如 46 + "客户"），匹配 BOM 物料名里的 "46客户定制"
    if (custNum) cnTokens.push(custNum + '客户');
  }
  for (const prod of externalProducts) {
    if (!prod.tree || !prod.tree.length || !cnTokens.length) continue;
    // 统计 BOM 物料中含客户编码片段的节点数
    let matchNodes = 0, totalLeaf = 0;
    (function walk(nodes) {
      nodes.forEach(n => {
        if (!n.children || !n.children.length) totalLeaf++;
        const code = ((n.material_code || '') + ' ' + (n.material_name || '')).toUpperCase();
        if (cnTokens.some(t => code.includes(t))) matchNodes++;
        if (n.children) walk(n.children);
      });
    })(prod.tree);
    if (totalLeaf > 0 && matchNodes === 0) {
      prod.bom_mismatch_warning = `BOM 物料中未发现订单客户标识（${cnTokens.join('/')}），BOM 可能属于其他客户（product_code=${prod.product_code} 共 ${totalLeaf} 个物料，请核实）`;
    } else if (totalLeaf > 0 && matchNodes < totalLeaf * 0.3) {
      prod.bom_mismatch_warning = `BOM 物料中仅 ${matchNodes}/${totalLeaf} 含客户标识 ${cnTokens.join('/')}，可能部分错配`;
    }
  }

  const source = externalOk ? 'external' : (errors.length ? 'local_fallback' : 'local');
  // 最终过滤：只返回本地 order_products 中存在的产品（按 bom_no 精确匹配，保持与 plan_cost 一致）
  const _localBomSet = new Set(localOrderProducts.map(p => (p.bom_no || '').trim()).filter(Boolean));
  const _filtered = externalProducts.filter(ep => {
    const bn = (ep.bom_no || '').trim();
    if (!bn) return true;  // 无 bom_no 的保留
    return _localBomSet.has(bn);  // 有 bom_no 必须在本地存在
  });
  // /line-items 触发后失效该订单的计划成本缓存（让列表自动同步）
  _invalidateOrderPlanCostCache(req.params.id);
  res.json({
    order: _orderSummary(order),
    order_products: localOrderProducts,
    siblings: siblingRows.map(_siblingBrief),
    products: _filtered,
    source,
    _dbg: { ext: externalProducts.length, filt: _filtered.length, local: localOrderProducts.length, bom: _localBomSet.size },
    external_errors: errors.length ? errors : undefined
  });
  // /line-items 触发后失效该订单的计划成本缓存（让列表自动同步）
  _invalidateOrderPlanCostCache(req.params.id);
});

// ===== line-items 辅助函数 =====
function _orderSummary(order) {
  return {
    id: order.id, order_no: order.order_no, line_no: order.line_no, customer_name: order.customer_name,
    product_code: order.product_code, product_name: order.product_name,
    bom_no: order.bom_no || '',
    quantity: order.quantity, order_amount: order.order_amount,
    status: order.status, promised_date: order.promised_date
  };
}
function _siblingBrief(r) {
  return {
    id: r.id, line_no: r.line_no, product_code: r.product_code, product_name: r.product_name,
    quantity: r.quantity, order_amount: r.order_amount
  };
}
function _bomHasProduct(productCode) {
  if (!productCode) return false;
  const idx = getBomIndex();
  return !!(idx[String(productCode).trim()] && idx[String(productCode).trim()].length);
}

// 为产品列表逐个构建分级 BOM 树（含递归子 BOM），就地修改 products 数组
async function _attachBomTrees(products, priceMap, laborRateMap) {
  const treeCache = new Map(); // product_code → {tree, material, labor, expense, total}
  for (const prod of products) {
    if (prod.tree) continue; // 已有树，跳过
    const cacheKey = (prod.product_code || '') + '||' + (prod.bom_no || '') + '||' + (prod.quantity || 1);
    if (treeCache.has(cacheKey)) {
      const c = treeCache.get(cacheKey);
      // 深拷贝树（避免共享同一引用导致前端展开状态互串）
      prod.tree = JSON.parse(JSON.stringify(c.tree));
      prod.material = c.material; prod.labor = c.labor;
      prod.expense = c.expense; prod.total = c.total;
      prod.has_bom = c.has_bom;
      continue;
    }
    const res = await buildProductBomAsync(prod, priceMap, laborRateMap);
    prod.tree = res.tree; prod.material = res.material; prod.labor = res.labor;
    prod.expense = res.expense; prod.total = res.total; prod.has_bom = res.has_bom;
    if (res.tree && res.tree.length) {
      // 构建成功 → 写入缓存（供同编码的其他行复用）
      treeCache.set(cacheKey, {
        tree: prod.tree, material: prod.material, labor: prod.labor,
        expense: prod.expense, total: prod.total, has_bom: prod.has_bom
      });
    }
  }
  return products;
}
// 合并本地产品源（订单主表 + order_products + siblings）去重
// 按 product_code + bom_no 合并数量（主单+样件=总和，与 _computeOrderPlanCost 一致）
function _mergeLocalProducts(order, localOrderProducts, siblingRows) {
  const map = {};
  const add = (code, name, qty, amt, source, opId, bomNo, lineNo) => {
    if (!code) return;
    const key = code + '||' + (bomNo || '');
    if (!map[key]) {
      map[key] = {
        product_code: code, product_name: name || '',
        bom_no: bomNo || '',
        quantity: 0, amount: 0,
        line_no: lineNo || '', source: source || 'local', has_bom: _bomHasProduct(code),
        op_id: opId || null
      };
    }
    map[key].quantity = (Number(map[key].quantity) || 0) + (Number(qty) || 0);
    map[key].amount = (Number(map[key].amount) || 0) + (Number(amt) || 0);
  };
  localOrderProducts.forEach(p => {
    const src = p.source === 'manual' ? 'local_manual' : (p.source === 'external_order' ? 'local_import' : (p.source || 'local'));
    add(p.product_code, p.product_name, p.quantity, p.amount, src, p.id, p.bom_no, p.line_no || ('L' + p.id));
  });
  siblingRows.forEach(r => add(r.product_code, r.product_name, r.quantity, r.order_amount, 'local_sibling', null, r.bom_no, r.line_no || ('L' + r.id)));
  return Object.values(map);
}

// 重新构建树（读取 order_products 后核算）
router.get('/:id/tree-with-products', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const op = getTable('order_products');
  op._invalidate();
  const ops = op.all().filter(r => r.order_id === Number(req.params.id)).sort((a,b) => a.id - b.id);
  const orderForCalc = ops.length
    ? Object.assign({}, order, { products: ops.map(r => ({ product_code: r.product_code, product_name: r.product_name, bom_no: r.bom_no || '', quantity: toNum(r.quantity) || order.quantity })) })
    : order;
  clearMatPriceCache();
  const plan = await calcPlanCost(orderForCalc);
  res.json({
    order: { id: order.id, order_no: order.order_no, customer_name: order.customer_name,
             product_code: order.product_code, quantity: order.quantity, order_amount: order.order_amount,
             status: order.status, promised_date: order.promised_date },
    products: plan.products,
    totals: { material: plan.material, labor: plan.labor, expense: plan.expense, total: plan.total,
              gross_profit: plan.gross_profit, gross_rate: plan.gross_rate, rate_source: plan.rate_source },
    warnings: plan.warnings
  });
});

// ===== 检查结果分类 → 默认责任人映射 =====
const CATEGORY_DEFAULT_ASSIGNEE = {
  '基本信息': '客服部',
  '产品信息': '技术部',
  '数量异常': '销售部',
  '外部同步': 'IT部',
  'BOM缺失': '技术部',
  'BOM物料': '技术部',
  '物料库缺失': '采购部',
  '价格缺失': '采购部',
  'BOM检查': '技术部',
  '成本异常': '财务部',
  '利润预警': '财务部'
};

// ===== 订单检查分析接口 =====
router.get('/:id/check', requirePerm('order-analysis:view'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  const issues = [];
  const warnings = [];
  const checks = [];

  function addIssue(severity, category, description, suggestion, details) {
    var iss = { severity, category, description, suggestion, details };
    // 2开头物料编码 → 工程部
    if (details && details.material_code && String(details.material_code).startsWith('2')) {
      iss.assignee = '工程部';
    }
    issues.push(iss);
  }

  function addCheck(name, passed, message, details) {
    checks.push({ name, passed, message, details });
  }

  const orderNo = (order.order_no || '').trim();

  // 检查1：订单基本信息完整性
  if (!orderNo) {
    addIssue('critical', '基本信息', '订单号为空', '请补充订单号', { field: 'order_no' });
    addCheck('订单号完整性', false, '订单号为空', null);
  } else {
    addCheck('订单号完整性', true, `订单号: ${orderNo}`, null);
  }

  if (!order.customer_name) {
    addIssue('medium', '基本信息', '客户名称为空', '请补充客户名称', { field: 'customer_name' });
    addCheck('客户名称完整性', false, '客户名称为空', null);
  } else {
    addCheck('客户名称完整性', true, `客户: ${order.customer_name}`, null);
  }

  if (!order.product_code) {
    addIssue('high', '产品信息', '订单主产品编码为空', '请指定产品或从外部同步明细', { field: 'product_code' });
    addCheck('主产品编码', false, '主产品编码为空', null);
  } else {
    addCheck('主产品编码', true, `产品: ${order.product_code}`, null);
  }

  // 获取订单明细
  let orderProducts = [];
  try {
    const items = await fetchAllPages('order_details.list', 200, 20, { order_no: orderNo });
    orderProducts = items.map(it => ({
      product_code: (it.product_code || '').trim(),
      product_name: (it.product_name || '').trim(),
      bom_no: (it.bom_no || '').trim(),
      quantity: Number(it.order_qty || 0),
      amount: Number(it.order_amount || 0),
      line_no: it.line_no || '',
      source: 'external_order'
    }));
  } catch (e) {
    addIssue('medium', '外部同步', '无法获取外部订单明细', '请检查外部API连接', { error: e.message });
    addCheck('外部订单明细', false, '获取失败', { error: e.message });
  }

  // 检查2：订单明细完整性
  if (!orderProducts.length) {
    addIssue('critical', '产品信息', '订单无明细行', '请从外部同步订单明细或手动添加', { count: 0 });
    addCheck('订单明细数量', false, '无明细行', null);
  } else {
    addCheck('订单明细数量', true, `共 ${orderProducts.length} 条明细`, null);
  }

  // 检查3：产品编码有效性
  const matTable = getTable('materials');
  matTable._invalidate();
  const materials = matTable.all();
  const matCodeMap = new Map(materials.map(m => [(m.material_code || '').trim(), m]));

  const priceMap = buildMaterialPriceMap();

  for (const prod of orderProducts) {
    if (!prod.product_code) {
      addIssue('critical', '产品信息', `行号 ${prod.line_no} 产品编码为空`, '请指定产品编码', { line_no: prod.line_no });
      continue;
    }

    if (prod.quantity <= 0) {
      addIssue('high', '数量异常', `产品 ${prod.product_code} 数量为0或负数: ${prod.quantity}`, '请检查订单数量', { product_code: prod.product_code, quantity: prod.quantity });
    }

    // 检查BOM是否存在
    let hasBom = false;
    try {
      const bomSearchKey = prod.bom_no || prod.product_code.replace(/^3\.1\./, '').split('-').slice(0, -2).join('-');
      const bomData = await fetchExternal('boms.list', { bom_no: bomSearchKey, page: 1, page_size: 1 });
      hasBom = (bomData.total || 0) > 0;
    } catch (e) { /* BOM查询失败 */ }

    if (!hasBom) {
      addIssue('high', 'BOM缺失', `产品 ${prod.product_code} 未找到BOM`, '请检查BOM是否存在或产品编码是否正确', { product_code: prod.product_code, bom_no: prod.bom_no });
    } else {
      // 获取BOM明细检查物料
      try {
        const bomSearchKey = prod.bom_no || prod.product_code.replace(/^3\.1\./, '').split('-').slice(0, -2).join('-');
        const bomData = await fetchExternal('boms.list', { bom_no: bomSearchKey, page: 1, page_size: 1 });
        if (bomData.items && bomData.items.length > 0) {
          const bomId = bomData.items[0].bom_id;
          const detailData = await fetchExternal('bom_details.list', { bom_id: bomId, page: 1, page_size: 200 });
          const bomItems = detailData.items || [];

          for (const item of bomItems) {
            const matCode = (item.material_code || '').trim();
            const matName = (item.material_name || '').trim();
            const matSpec = (item.spec || item.spec_model || '').trim();
            const matLabel = matName ? (matCode + ' ' + matName + (matSpec ? ' (' + matSpec + ')' : '')) : matCode;
            if (!matCode) {
              addIssue('medium', 'BOM物料', `产品 ${prod.product_code} 的BOM行 ${item.line_no} 物料编码为空`, '请完善BOM数据', { product_code: prod.product_code, line_no: item.line_no });
              continue;
            }

            // 检查物料是否在本地物料库
            if (!matCodeMap.has(matCode)) {
              // 2开头物料责任部门为工程部
              var dept2 = matCode.startsWith('2') ? '工程部' : '采购部';
              addIssue('medium', '物料库缺失', `BOM物料 ${matLabel} 不在本地物料库`, `建议同步外部物料到本地（责任部门：${dept2}）`, { material_code: matCode, material_name: matName, spec: matSpec, product_code: prod.product_code, assignee: dept2 });
            }

            // 检查物料单价
            const unitPrice = priceMap[matCode] || 0;
            if (unitPrice === 0) {
              var deptP = matCode.startsWith('2') ? '工程部' : '采购部';
              addIssue('low', '价格缺失', `物料 ${matLabel} 单价为0`, `请在物料库设置单价（责任部门：${deptP}）`, { material_code: matCode, material_name: matName, spec: matSpec, product_code: prod.product_code, assignee: deptP });
            }
          }
        }
      } catch (e) {
        addIssue('low', 'BOM检查', `产品 ${prod.product_code} 的BOM明细检查失败`, '请稍后重试', { product_code: prod.product_code, error: e.message });
      }
    }
  }

  // 检查4：成本与订单金额对比
  const orderAmount = Number(order.order_amount || 0);
  let totalMaterialCost = 0;
  let totalProductQty = 0;

  for (const prod of orderProducts) {
    totalProductQty += prod.quantity;
    try {
      const bomSearchKey = prod.bom_no || prod.product_code.replace(/^3\.1\./, '').split('-').slice(0, -2).join('-');
      const bomData = await fetchExternal('boms.list', { bom_no: bomSearchKey, page: 1, page_size: 1 });
      if (bomData.items && bomData.items.length > 0) {
        const bomId = bomData.items[0].bom_id;
        const detailData = await fetchExternal('bom_details.list', { bom_id: bomId, page: 1, page_size: 200 });
        for (const item of detailData.items || []) {
          const matCode = (item.material_code || '').trim();
          const qty = toNum(item.standard_qty || 1) * prod.quantity;
          const price = priceMap[matCode] || 0;
          totalMaterialCost += qty * price;
        }
      }
    } catch (e) { /* 成本计算失败 */ }
  }

  addCheck('订单总金额', true, `¥${orderAmount.toLocaleString()}`, null);
  addCheck('物料成本合计', true, `¥${totalMaterialCost.toLocaleString()}`, null);

  if (orderAmount > 0 && totalMaterialCost > 0) {
    const grossProfit = orderAmount - totalMaterialCost;
    const grossRate = (grossProfit / orderAmount) * 100;
    addCheck('毛利润', true, `¥${grossProfit.toLocaleString()}`, null);
    addCheck('毛利率', true, `${grossRate.toFixed(2)}%`, null);

    if (grossRate < 0) {
      addIssue('critical', '成本异常', `毛利率为负: ${grossRate.toFixed(2)}%`, '物料成本超过订单金额，请检查BOM和价格', { gross_rate: grossRate, order_amount: orderAmount, material_cost: totalMaterialCost });
    } else if (grossRate < 5) {
      addIssue('high', '利润预警', `毛利率偏低: ${grossRate.toFixed(2)}%`, '建议检查成本或调整报价', { gross_rate: grossRate });
    } else if (grossRate < 15) {
      addIssue('medium', '利润预警', `毛利率一般: ${grossRate.toFixed(2)}%`, '可考虑优化成本结构', { gross_rate: grossRate });
    }
  }

  // 统计
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) {
    severityCounts[i.severity]++;
  }

  // ===== 落库：将检查结果持久化到 order_check_issues =====
  const issuesTable = getTable('order_check_issues');
  issuesTable._invalidate();
  const existingIssues = issuesTable.all().filter(i => i.order_id === order.id && i.source === 'per_order_check');
  const existingMap = {};
  existingIssues.forEach(i => { existingMap[i.category + '::' + i.description] = i; });

  const ts = now();
  for (const iss of issues) {
    const key = iss.category + '::' + iss.description;
    const assignee = iss.assignee || CATEGORY_DEFAULT_ASSIGNEE[iss.category] || '';
    if (existingMap[key]) {
      // 已有记录：更新 severity 和 detected_at，保留 assignee/status
      const ex = existingMap[key];
      Object.assign(ex, { severity: iss.severity, detected_at: ts, updated_at: ts });
      delete existingMap[key];
    } else {
      // 新问题
      issuesTable.insert({
        rule_id: 'CHECK-' + iss.category,
        rule_name: iss.category,
        category: iss.category,
        severity: iss.severity,
        scope: 'order',
        source: 'per_order_check',
        order_id: order.id,
        order_no: order.order_no,
        target_id: order.id,
        target_code: order.order_no,
        description: iss.description,
        current_value: '',
        suggested_action: iss.suggestion || '',
        assignee: assignee,
        status: 'open',
        due_date: '',
        detected_at: ts,
        created_at: ts,
        updated_at: ts
      });
    }
  }
  // 剩余在 existingMap 中的表示本次检查未再发现该问题 → 标记为 resolved
  for (const key in existingMap) {
    const ex = existingMap[key];
    if (ex.status === 'open' || ex.status === 'in_progress') {
      await issuesTable.update(ex.id, { status: 'resolved', updated_at: ts });
    }
  }

  // 按 issue 的 category 补充 assignee（保留已有的 assignee 设置）
  issues.forEach(i => { if (!i.assignee) i.assignee = CATEGORY_DEFAULT_ASSIGNEE[i.category] || ''; });

  res.json({
    order: _orderSummary(order),
    checks: checks,
    issues: issues,
    summary: {
      total_checks: checks.length,
      passed_checks: checks.filter(c => c.passed).length,
      total_issues: issues.length,
      by_severity: severityCounts,
      order_amount: orderAmount,
      material_cost: r2(totalMaterialCost),
      product_count: orderProducts.length,
      total_quantity: totalProductQty
    }
  });
});

// ===== 修改和删除 =====

// 编辑单个 BOM 明细行
router.put('/:orderId/details/:detailId', requirePerm('order-analysis:edit'), async (req, res) => {
  const det = getTable('order_bom_details');
  det._invalidate();
  let row = det.findById(req.params.detailId);
  if (!row) {
    row = det.all().find(r => r.order_id === Number(req.params.orderId) && r.path === req.params.detailId);
  }
  if (!row) return res.status(404).json({ error: '明细行不存在' });
  if (Number(row.order_id) !== Number(req.params.orderId)) return res.status(400).json({ error: '明细行不属于该订单' });
  const b = req.body || {};
  const fields = { updated_at: now() };
  ['material_code','material_name','spec','unit','material_attr','key_part','bom_qty','total_qty','unit_price','material_amount','labor_amount','expense_amount','line_total','material_rollup','labor_rollup','expense_rollup','total_rollup','purchase_confirm_cost','actual_cost'].forEach(f => {
    if (b[f] !== undefined) fields[f] = typeof b[f] === 'number' ? b[f] : b[f];
  });
  await det.update(row.id, fields);
  det._invalidate();
  res.json({ message: '明细行已更新', data: det.findById(row.id) });
});

// 删除单个 BOM 明细行
router.delete('/:orderId/details/:detailId', requirePerm('order-analysis:edit'), async (req, res) => {
  const det = getTable('order_bom_details');
  const row = det.findById(req.params.detailId);
  if (!row) return res.status(404).json({ error: '明细行不存在' });
  if (Number(row.order_id) !== Number(req.params.orderId)) return res.status(400).json({ error: '明细行不属于该订单' });
  await det.delete(req.params.detailId);
  det._invalidate();
  res.json({ message: '明细行已删除' });
});

// 删除订单所有明细（清除明细 + 可选清空产品指派）
router.delete('/:id/details', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const det = getTable('order_bom_details');
  det._invalidate();
  const rows = det.all().filter(r => r.order_id === Number(req.params.id));
  for (const r of rows) { await det.delete(r.id); }
  det._invalidate();
  const clearProduct = req.query.clear_product !== 'false';
  if (clearProduct && order.product_code) {
    await orders.update(order.id, { product_code: '', product_name: '', updated_at: now() });
  }
  res.json({ message: '已删除订单明细' + (clearProduct && order.product_code ? '并清除产品指派' : ''), deleted: rows.length });
});

// 清除产品指派（保留 BOM 明细不变）
router.delete('/:id/product', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  if (!order.product_code) return res.status(400).json({ error: '订单未关联产品型号' });
  await orders.update(order.id, { product_code: '', product_name: '', updated_at: now() });
  res.json({ message: '产品指派已清除', order_no: order.order_no });
});

// 删除订单分析记录（含分析卡、快照、审核日志）
router.delete('/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const cards = analysis.all().filter(a => a.order_id === Number(req.params.id));
  for (const card of cards) {
    const snap = getTable('order_cost_snapshots');
    const logs = getTable('order_review_logs');
    snap.all().filter(s => s.order_analysis_id === card.id).forEach(s => snap.delete(s.id));
    logs.all().filter(l => l.order_analysis_id === card.id).forEach(l => logs.delete(l.id));
    await analysis.delete(card.id);
  }
  const det = getTable('order_bom_details');
  det._invalidate();
  for (const r of det.all().filter(r => r.order_id === Number(req.params.id))) { await det.delete(r.id); }
  det._invalidate();
  const op = getTable('order_products');
  op._invalidate();
  op.all().filter(r => r.order_id === Number(req.params.id)).forEach(r => op.delete(r.id));
  orders.delete(req.params.id);
  res.json({ message: '订单已删除（含分析记录、快照、日志、BOM明细、关联产品）', removed_cards: cards.length });
});

// 作废/取消作废订单
router.patch('/:id/void', requirePerm('order-analysis:edit'), (req, res) => {
  const { is_void } = req.body;
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const card = analysis.all().find(a => a.order_id === Number(req.params.id));
  if (card) {
    analysis.update(card.id, { is_void: is_void ? 1 : 0, updated_at: now() });
  } else {
    analysis.insert({
      order_id: order.id, order_no: order.order_no,
      is_void: is_void ? 1 : 0,
      created_at: now(), updated_at: now()
    });
  }
  
  res.json({ message: is_void ? '订单已作废，不计入所有统计' : '订单已恢复，计入统计', is_void: is_void ? 1 : 0 });
});

// 锁定/解锁订单（锁定后不会被自动重算，BOM/物料/同步等都跳过）
router.patch('/:id/lock', requirePerm('order-analysis:edit'), (req, res) => {
  const orders = getTable('orders');
  const order = orders.findById(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const analysis = getTable('order_analysis');
  analysis._invalidate();
  const card = analysis.all().find(a => a.order_id === Number(req.params.id));
  const newLocked = req.body.is_locked ? 1 : 0;
  if (card) {
    analysis.update(card.id, { is_locked: newLocked, updated_at: now() });
  } else {
    analysis.insert({
      order_id: order.id, order_no: order.order_no,
      is_locked: newLocked,
      created_at: now(), updated_at: now()
    });
  }
  res.json({ message: newLocked ? '已锁定，不会被自动重算' : '已解锁，下一次核算将重新计算', is_locked: newLocked });
});

// 单订单同步：从外部 ERP 拉取该订单的产品行并 upsert 到 order_products
// 若订单已锁定，跳过同步
router.post('/:id/sync', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const orders = getTable('orders');
    orders._invalidate();
    const order = orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });

    const analysis = getTable('order_analysis');
    analysis._invalidate();
    const card = analysis.all().find(a => a.order_id === order.id);
    if (card && card.is_locked) {
      return res.json({ message: '订单已锁定，跳过同步', skipped: true, is_locked: 1, order_no: order.order_no });
    }

    // 从外部 API 拉该订单的产品行
    const items = await fetchAllPages('order_details.list', 200, 5, { order_no: order.order_no });
    const op = getTable('order_products');
    op._invalidate();
    const existing = new Set(
      op.all().filter(r => r.order_id === order.id)
        .map(r => (r.line_no || '') + '|' + (r.product_code || ''))
    );

    let created = 0, skipped = 0;
    for (const it of items) {
      const code = (it.product_code || '').trim();
      if (!code) continue;
      const key = (it.line_no || '') + '|' + code;
      if (existing.has(key)) { skipped++; continue; }
      op.insertNoSave({
        order_id: order.id, order_no: order.order_no,
        product_code: code, product_name: (it.product_name || '').trim(),
        bom_no: (it.bom_no || '').trim(),
        quantity: Number(it.order_qty || 0), amount: Number(it.order_amount || 0),
        line_no: it.line_no || '', source: 'manual_sync',
        created_at: now(), updated_at: now()
      });
      created++;
    }
    if (created > 0) await op.saveNow();

    // 重置 plan 成本相关缓存（下次列表 calcPlanCost 会重新读 order_products）
    _invalidateOrderPlanCostCache(order.id);

    res.json({
      message: '同步完成', order_no: order.order_no,
      fetched: items.length, created, skipped,
      is_locked: 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 去重：批量清理重复快照 + 空分析卡（高效：deleteWhereNoSave + 单次 saveNow） =====
router.post('/dedup', requirePerm('order-analysis:edit'), async (req, res) => {
  const analysis = getTable('order_analysis');
  const snap = getTable('order_cost_snapshots');
  const logs = getTable('order_review_logs');
  const op = getTable('order_products');
  const orders = getTable('orders');

  // 1) 快照去重：同 analysis_id+snapshot_type 只保留最新一条
  let snapBefore = 0, snapAfter = 0;
  try {
    snap._invalidate();
    const allSnaps = snap.all();
    snapBefore = allSnaps.length;
    const groups = {};
    allSnaps.forEach(s => {
      const key = s.order_analysis_id + '::' + s.snapshot_type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });
    const toDelete = new Set();
    for (const [key, list] of Object.entries(groups)) {
      if (list.length <= 1) continue;
      list.sort((a, b) => (b.id || 0) - (a.id || 0));
      for (let i = 1; i < list.length; i++) toDelete.add(list[i].id);
    }
    if (toDelete.size) {
      snap.deleteWhereNoSave(s => toDelete.has(s.id));
      await snap.saveNow();
      snapAfter = snapBefore - toDelete.size;
    }
  } catch(_) { snapAfter = snapBefore; }

  // 2) 清理空分析卡（无计划/实际成本，无快照残留）
  let cardBefore = 0, cardRemoved = 0;
  try {
    snap._invalidate();
    analysis._invalidate();
    const remainSnap = new Set(snap.all().map(s => s.order_analysis_id));
    const allCards = analysis.all();
    cardBefore = allCards.length;
    const toDelCards = allCards.filter(a =>
      !remainSnap.has(a.id) && a.plan_total_cost == null && a.actual_total_cost == null
    );
    if (toDelCards.length) {
      const cardIds = new Set(toDelCards.map(c => c.id));
      logs.deleteWhereNoSave(l => cardIds.has(l.order_analysis_id));
      await logs.saveNow();
      analysis.deleteWhereNoSave(c => cardIds.has(c.id));
      await analysis.saveNow();
      cardRemoved = toDelCards.length;
    }
  } catch(_) {}

  // 3) 清理 order_products 孤儿记录（关联的订单已被删除）
  let opRemoved = 0;
  try {
    op._invalidate();
    orders._invalidate();
    const validIds = new Set(orders.all().map(o => o.id));
    const orphans = op.all().filter(r => !validIds.has(r.order_id));
    if (orphans.length) {
      const delIds = new Set(orphans.map(r => r.id));
      op.deleteWhereNoSave(r => delIds.has(r.id));
      await op.saveNow();
      opRemoved = orphans.length;
    }
  } catch(_) {}

  res.json({
    message: '去重完成',
    snapshots_before: snapBefore, snapshots_removed: snapBefore - snapAfter, snapshots_after: snapAfter,
    cards_before: cardBefore, cards_removed: cardRemoved,
    orphan_products_removed: opRemoved
  });
});

module.exports = router;
module.exports.calcPlanCost = calcPlanCost;
module.exports.clearMatPriceCache = clearMatPriceCache;
module.exports.clearLaborRateCache = clearLaborRateCache;
module.exports.getBomIndex = getBomIndex;
module.exports.syncOrderBomDetails = syncOrderBomDetails;
