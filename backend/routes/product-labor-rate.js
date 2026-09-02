/**
 * 成品工价库（经营中心）
 * ------------------------------------------------------------------
 * 维护"产品(bom_no) → 单台成品工价"主数据，作为订单分析 calcPlanCost 注入
 * 成品工价时的唯一权威来源。
 *
 * 数据来源：手工录入 / Excel 导入 / 外部 ERP（HJ 基础数据库-对外接口）API 同步。
 *
 * 外部接口约定（HJ 基础数据库对外接口）：
 *   base_url      例：http://127.0.0.1:5000/api/external
 *   api_key       X-API-Key 鉴权头（由环境变量 EBMS_EXTERNAL_API_KEY 注入，或在配置页填写）
 *   data_table    同步表（默认 t_BOSAssemblyPriceEntry）
 *   item_table    产品主数据表（默认 t_ICItemCore，用于关联 FNumber/FName）
 *
 * 字段映射（可按需扩展）：
 *   FItemID        ←→   product_id（关联 key）
 *   FNumber        →    product_code（带"1.3.1."前缀的层级编码）
 *   FShortNumber   →    bom_no（主匹配键）
 *   FName          →    product_name
 *   FPrice         →    labor_rate（元/台工价）
 *   WProcedure     →    remarks（工序/前加工/包装）
 *   FNOTE          →    remarks
 *   FID+FDate      →    effective_date（来自头表 t_BOSAssemblyPrice.FDate）
 *
 * 字段说明（详见 订单分析库-成品工价贯通整体方案.md 3.1）：
 *   bom_no            主匹配键（与 order_products.bom_no 对齐）
 *   product_code      产品编码（冗余，便于检索/兜底匹配）
 *   product_name      产品名称
 *   labor_rate        单台成品工价（元/台）
 *   labor_rate_type   计价方式：标准工价/实测工价/暂估工价
 *   process_cost      单台工艺成本（可选，默认归入人工）
 *   effective_date    生效日
 *   expire_date       失效日（空=长期有效）
 *   source            erp_sync / manual / pricing_import
 *   audit_status      pending / approved / disabled
 *   approved_by       审核人
 *   remarks           备注
 *
 * 匹配优先级（calcPlanCost 调用 lookupFinishedLabor 时）：
 *   bom_no 精确 → product_code → audit_status=approved 且生效期内最新。
 */
const express = require('express');
const logger = require('../lib/logger');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { EXTERNAL_API_KEY } = require('../lib/secrets');

ensureTable('product_labor_rate');

// ===== 常量 =====
const RATE_TYPES = ['标准工价', '实测工价', '暂估工价'];
const SOURCES = ['manual', 'erp_sync', 'pricing_import'];
const AUDIT_STATUS = ['pending', 'approved', 'disabled'];

const NUM_FIELDS = ['labor_rate', 'process_cost'];
const STR_FIELDS = [
  'bom_no', 'product_code', 'product_name', 'labor_rate_type',
  'effective_date', 'expire_date', 'source', 'audit_status',
  'approved_by', 'remarks'
];

// ===== 工具 =====
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// 当年自然年起始日（如 2026-01-01）
function yearStart() {
  const y = new Date().getFullYear();
  return y + '-01-01';
}

function normalize(r) {
  const o = Object.assign({}, r);
  o.bom_no = (o.bom_no || '').trim();
  o.product_code = (o.product_code || '').trim();
  o.product_name = (o.product_name || '').trim();
  o.labor_rate_type = o.labor_rate_type || '标准工价';
  o.source = o.source || 'manual';
  o.audit_status = o.audit_status || 'pending';
  if (o.effective_date && typeof o.effective_date === 'string') {
    o.effective_date = o.effective_date.substring(0, 10);
  }
  if (o.expire_date && typeof o.expire_date === 'string') {
    o.expire_date = o.expire_date.substring(0, 10);
  }
  o.labor_rate = r2(o.labor_rate);
  o.process_cost = r2(o.process_cost);
  o.remarks = o.remarks || '';
  o.approved_by = o.approved_by || '';
  return o;
}

// ===== 过滤选项 =====
router.get('/meta/filter-options', requirePerm('labor-rate:view'), (req, res) => {
  const table = getTable('product_labor_rate');
  const records = table.all();
  const bomNos = [...new Set(records.map(r => r.bom_no).filter(Boolean))].sort();
  const productCodes = [...new Set(records.map(r => r.product_code).filter(Boolean))].sort();
  const rateTypes = [...new Set(records.map(r => r.labor_rate_type).filter(Boolean))].sort();
  const sources = [...new Set(records.map(r => r.source).filter(Boolean))].sort();
  res.json({
    bom_nos: bomNos,
    product_codes: productCodes,
    rate_types: rateTypes.length ? rateTypes : RATE_TYPES,
    sources: sources.length ? sources : SOURCES,
    audit_statuses: AUDIT_STATUS,
    constants: { RATE_TYPES, SOURCES, AUDIT_STATUS }
  });
});

// ===== 列表（含分页/筛选/排序） =====
router.get('/', requirePerm('labor-rate:view'), (req, res) => {
  const {
    page = 1, limit = 20, keyword, bom_no, product_code, labor_rate_type,
    source, audit_status, rate_min, rate_max,
    sort_by = 'updated_at', sort_order = 'DESC'
  } = req.query;
  const table = getTable('product_labor_rate');
  const kw = (keyword || '').trim().toLowerCase();
  const records = table.all().filter(r => {
    if (bom_no && r.bom_no !== bom_no) return false;
    if (product_code && r.product_code !== product_code) return false;
    if (labor_rate_type && r.labor_rate_type !== labor_rate_type) return false;
    if (source && r.source !== source) return false;
    if (audit_status && r.audit_status !== audit_status) return false;
    if (rate_min !== undefined && rate_min !== '' && Number(r.labor_rate) < Number(rate_min)) return false;
    if (rate_max !== undefined && rate_max !== '' && Number(r.labor_rate) > Number(rate_max)) return false;
    if (kw) {
      const hay = [r.bom_no, r.product_code, r.product_name, r.remarks, r.approved_by]
        .map(v => String(v || '').toLowerCase()).join('|');
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  // 排序
  const dir = String(sort_order).toUpperCase() === 'ASC' ? 1 : -1;
  records.sort((a, b) => {
    const va = a[sort_by], vb = b[sort_by];
    if (va === vb) return 0;
    if (va === undefined || va === null || va === '') return 1;
    if (vb === undefined || vb === null || vb === '') return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
  const total = records.length;
  const offset = (Number(page) - 1) * Number(limit);
  const data = records.slice(offset, offset + Number(limit));
  res.json({ data, total, page: Number(page), limit: Number(limit) });
});

// ===== 看板统计 =====
router.get('/dashboard/stats', requirePerm('labor-rate:view'), (req, res) => {
  const records = getTable('product_labor_rate').all();
  const total = records.length;
  const approved = records.filter(r => r.audit_status === 'approved').length;
  const pending = records.filter(r => r.audit_status === 'pending').length;
  const disabled = records.filter(r => r.audit_status === 'disabled').length;
  const rateValues = records.filter(r => r.audit_status === 'approved')
    .map(r => Number(r.labor_rate) || 0).filter(v => v > 0);
  const avgRate = rateValues.length ? rateValues.reduce((a, b) => a + b, 0) / rateValues.length : 0;
  const maxRate = rateValues.length ? Math.max(...rateValues) : 0;
  const minRate = rateValues.length ? Math.min(...rateValues) : 0;

  // 按来源 / 按计价方式 / 按 audit 分布
  const bySource = {};
  const byRateType = {};
  records.forEach(r => {
    const s = r.source || 'manual';
    bySource[s] = (bySource[s] || 0) + 1;
    const t = r.labor_rate_type || '标准工价';
    byRateType[t] = (byRateType[t] || 0) + 1;
  });

  res.json({
    total, approved, pending, disabled,
    avg_rate: r2(avgRate), max_rate: r2(maxRate), min_rate: r2(minRate),
    by_source: Object.entries(bySource).map(([k, v]) => ({ name: k, value: v })),
    by_rate_type: Object.entries(byRateType).map(([k, v]) => ({ name: k, value: v })),
    by_audit: [
      { name: 'approved', label: '已审核', value: approved },
      { name: 'pending', label: '待审核', value: pending },
      { name: 'disabled', label: '已停用', value: disabled }
    ]
  });
});

// ===== 数据质检 =====
router.get('/quality-check', requirePerm('labor-rate:view'), (req, res) => {
  const records = getTable('product_labor_rate').all();
  const issues = [];
  const seen = new Map(); // bom_no -> [ids]
  records.forEach(r => {
    if (!r.bom_no) {
      issues.push({ id: r.id, severity: 'severe', message: 'bom_no 缺失（主匹配键）' });
    }
    if (r.labor_rate === undefined || r.labor_rate === null || r.labor_rate === '' || Number(r.labor_rate) < 0) {
      issues.push({ id: r.id, severity: 'severe', message: '工价缺失或为负数' });
    }
    if (r.audit_status === 'pending' && r.labor_rate_type === '标准工价') {
      issues.push({ id: r.id, severity: 'warning', message: '标准工价尚未审核，建议尽快审批' });
    }
    if (r.effective_date && r.expire_date && r.effective_date > r.expire_date) {
      issues.push({ id: r.id, severity: 'severe', message: '生效日 > 失效日，区间不合法' });
    }
    if (r.bom_no) {
      const arr = seen.get(r.bom_no) || [];
      arr.push(r.id);
      seen.set(r.bom_no, arr);
    }
  });
  // 同 bom_no 重复 + 都处于 approved 且日期区间重叠：严重
  seen.forEach((ids, bom) => {
    if (ids.length < 2) return;
    const items = ids.map(id => records.find(r => r.id === id)).filter(Boolean);
    const ap = items.filter(r => r.audit_status === 'approved');
    if (ap.length < 2) {
      issues.push({ id: ids[0], severity: 'warning', message: `bom_no ${bom} 存在 ${ids.length} 条记录（含未审核/停用），请确认版本` });
      return;
    }
    // 区间重叠检测
    for (let i = 0; i < ap.length; i++) {
      for (let j = i + 1; j < ap.length; j++) {
        const a = ap[i], b = ap[j];
        const aS = a.effective_date || '0000-00-00';
        const aE = a.expire_date || '9999-12-31';
        const bS = b.effective_date || '0000-00-00';
        const bE = b.expire_date || '9999-12-31';
        if (aS <= bE && bS <= aE) {
          issues.push({ id: a.id, severity: 'severe', message: `bom_no ${bom} 审核通过的工价区间与另一条（id=${b.id}）重叠` });
        }
      }
    }
  });
  const total = records.length;
  const affected = new Set(issues.map(i => i.id)).size;
  res.json({
    total, issue_count: issues.length, affected,
    pass_rate: total ? Math.round((1 - affected / total) * 1000) / 10 : 100,
    issues
  });
});

// ===== 导出 CSV =====
router.get('/export/csv', requirePerm('labor-rate:view'), (req, res) => {
  const records = getTable('product_labor_rate').all();
  const headers = ['bom_no', 'product_code', 'product_name', 'labor_rate', 'labor_rate_type',
    'process_cost', 'effective_date', 'expire_date', 'source', 'audit_status',
    'approved_by', 'remarks', 'created_at', 'updated_at'];
  const csv = [headers.join(',')].concat(records.map(r => headers.map(h => {
    const v = r[h];
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="product_labor_rate_${Date.now()}.csv"`);
  res.send('\ufeff' + csv);
});

// ===== 详情 =====
router.get('/:id', requirePerm('labor-rate:view'), (req, res) => {
  const r = getTable('product_labor_rate').findById(req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  res.json(r);
});

// ===== 按成品 BOM 层级查询工价（含所有下级子件，递归全展开）=====
// GET /by-product/tree?bom_no=HJ-8110-709-01&product_code=3.1.HJ-8110-001
router.get('/by-product/tree', requirePerm('labor-rate:view'), (req, res) => {
  const { bom_no, product_code } = req.query;
  const rootKey = (bom_no || product_code || '').trim();
  if (!rootKey) return res.status(400).json({ error: 'bom_no 或 product_code 必填' });

  // 1. 用 order-analysis 的缓存索引（5 分钟缓存，避免重复加载 65MB bom_items）
  let bomIndex = {};
  try {
    const oa = require('./order-analysis');
    // getBomIndex 不是导出函数，直接读已缓存的 _bomIndexCache
    bomIndex = oa.getBomIndex ? oa.getBomIndex() : {};
  } catch(e) {}
  // 如果拿不到缓存索引，自己建（不加 _invalidate，用内存缓存）
  if (!bomIndex || Object.keys(bomIndex).length === 0) {
    const bomTable = getTable('bom_items');
    const allBom = bomTable.all(); // 从内存缓存读，不 _invalidate
    allBom.forEach(b => {
      const pc = (b.product_code || '').trim();
      if (!pc) return;
      if (String(b.is_disabled || '0') === '1') return;
      (bomIndex[pc] = bomIndex[pc] || []).push(b);
    });
  }

  // 2. 确定根 product_code（从 order_products 反查 + 多种变体尝试）
  const opTable = getTable('order_products');
  opTable._invalidate();
  const rootCandidates = new Set([rootKey]);
  // 从 order_products 按 bom_no 找 product_code
  opTable.all().forEach(op => {
    if ((op.bom_no || '').trim() === rootKey && op.product_code) {
      rootCandidates.add(op.product_code.trim());
    }
  });
  // 从 product_labor_rate 按 bom_no 找 product_code
  const lrTable0 = getTable('product_labor_rate');
  lrTable0._invalidate();
  lrTable0.all().forEach(r => {
    if ((r.bom_no || '').trim() === rootKey && r.product_code) {
      rootCandidates.add(r.product_code.trim());
    }
  });
  // 变体
  rootCandidates.add(rootKey.replace(/^3\.1\./, ''));
  rootCandidates.add('3.1.' + rootKey);

  // 3. 递归收集所有子件 material_code（跨 BOM 全展开，防环）
  const allCodes = new Set(); // 所有出现过的 material_code
  const codeInfo = new Map(); // code → {name, attr, depth（最小深度）}
  const visitedBom = new Set(); // 已展开过的 product_code（防环）

  function collectFromBom(pc, depth) {
    if (depth > 25 || visitedBom.has(pc)) return;
    visitedBom.add(pc);
    const lines = bomIndex[pc];
    if (!lines) return;
    for (const line of lines) {
      const mc = (line.material_code || '').trim();
      if (!mc) continue;
      const existing = codeInfo.get(mc);
      if (!existing || depth < existing.depth) {
        codeInfo.set(mc, {
          code: mc,
          name: (line.material_name || '').trim(),
          attr: (line.material_attr || '').trim(),
          spec: (line.spec || '').trim(),
          depth: depth
        });
      }
      allCodes.add(mc);
      // 递归：该子件可能有自己的 BOM（material_code 作为 product_code 查）
      // 尝试多种 key 变体
      const subKeys = [mc, mc.replace(/^3\.1\./, ''), '3.1.' + mc];
      for (const sk of subKeys) {
        if (bomIndex[sk] && !visitedBom.has(sk)) {
          collectFromBom(sk, depth + 1);
        }
      }
    }
  }

  // 从所有可能的根 product_code 展开（限时 5 秒防止死循环/超时）
  const _expandStart = Date.now();
  try {
    for (const rc of rootCandidates) {
      if (Date.now() - _expandStart > 5000) break;
      if (bomIndex[rc] && !visitedBom.has(rc)) {
        collectFromBom(rc, 1);
      }
    }
  } catch(e) { logger.warn('[product-labor-rate] BOM 展开异常:', e.message); }

  // 4. 组装后代列表（按 depth 排序）
  const descendants = [...codeInfo.values()].sort((a, b) => a.depth - b.depth);

  // 5. 从工价库匹配（根 + 所有子件）
  const lrTable = getTable('product_labor_rate');
  lrTable._invalidate();
  const allRates = lrTable.all();
  const matched = [];
  const seenIds = new Set();

  // 根节点匹配
  const rootMatchKeys = new Set([rootKey, rootKey.replace(/^3\.1\./, '')]);
  rootCandidates.forEach(c => rootMatchKeys.add(c));
  for (const r of allRates) {
    if (seenIds.has(r.id)) continue;
    if (rootMatchKeys.has(r.bom_no) || rootMatchKeys.has(r.product_code)) {
      seenIds.add(r.id);
      matched.push({ ...r, _depth: 0, _bom_name: '成品', _bom_attr: '' });
    }
  }
  // 子件匹配
  for (const d of descendants) {
    for (const r of allRates) {
      if (seenIds.has(r.id)) continue;
      if (r.bom_no === d.code || r.product_code === d.code) {
        seenIds.add(r.id);
        matched.push({ ...r, _depth: d.depth, _bom_name: d.name, _bom_attr: d.attr });
      }
    }
  }

  // 排序：根 → depth 升序
  matched.sort((a, b) => (a._depth || 0) - (b._depth || 0));

  res.json({
    root: { bom_no: bom_no || '', product_code: product_code || '', key: rootKey, candidates: [...rootCandidates].filter(c => bomIndex[c]) },
    total_bom_nodes: descendants.length,
    matched_rates: matched.length,
    data: matched
  });
});

// ===== 可选的成品列表（供前端下拉选择）=====
router.get('/products/list', requirePerm('labor-rate:view'), (req, res) => {
  const { keyword } = req.query;
  // 从 order_products 取所有不同的 bom_no + product_code + product_name
  const opTable = getTable('order_products');
  opTable._invalidate();
  const kw = (keyword || '').trim().toLowerCase();
  const seen = new Set();
  const products = [];
  opTable.all().forEach(p => {
    const key = (p.bom_no || '') + '|' + (p.product_code || '');
    if (seen.has(key)) return;
    seen.add(key);
    const bomNo = (p.bom_no || '').trim();
    const code = (p.product_code || '').trim();
    const name = (p.product_name || '').trim();
    if (!bomNo && !code) return;
    if (kw) {
      const hay = [bomNo, code, name].join(' ').toLowerCase();
      if (!hay.includes(kw)) return;
    }
    products.push({ bom_no: bomNo, product_code: code, product_name: name });
  });
  // 也从 product_labor_rate 表补充（source=order_analysis 的成品工价）
  const lrTable = getTable('product_labor_rate');
  lrTable._invalidate();
  lrTable.all().forEach(r => {
    const key = (r.bom_no || '') + '|' + (r.product_code || '');
    if (seen.has(key)) return;
    seen.add(key);
    const bomNo = (r.bom_no || '').trim();
    const code = (r.product_code || '').trim();
    if (!bomNo && !code) return;
    if (kw) {
      const hay = [bomNo, code, r.product_name || ''].join(' ').toLowerCase();
      if (!hay.includes(kw)) return;
    }
    products.push({ bom_no: bomNo, product_code: code, product_name: r.product_name || '' });
  });
  products.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || ''));
  res.json({ data: products.slice(0, 500), total: products.length });
});

// ===== 按 bom_no 查询（供 calcPlanCost 内部/前端预填） =====
router.get('/by-bom/lookup', requirePerm('labor-rate:view'), (req, res) => {
  const { bom_no, product_code, date } = req.query;
  if (!bom_no && !product_code) {
    return res.status(400).json({ error: 'bom_no 或 product_code 至少传一个' });
  }
  const records = getTable('product_labor_rate').all();
  const checkDate = date || new Date().toISOString().substring(0, 10);

  // 1) bom_no 精确
  let hit = null;
  if (bom_no) {
    const candidates = records
      .filter(r => r.bom_no === bom_no)
      .filter(r => r.audit_status === 'approved')
      .filter(r => !r.effective_date || r.effective_date <= checkDate)
      .filter(r => !r.expire_date || r.expire_date >= checkDate)
      .sort((a, b) => {
        const cmp = (b.updated_at || '').localeCompare(a.updated_at || '');
        return cmp !== 0 ? cmp : (b.id - a.id); // 同时间戳时新 id 优先（调整后的新版本）
      });
    if (candidates.length) hit = candidates[0];
  }
  // 2) product_code 兜底
  if (!hit && product_code) {
    const code = String(product_code).replace(/^\d+\./, '');
    const candidates = records
      .filter(r => r.product_code === product_code || r.product_code === code)
      .filter(r => r.audit_status === 'approved')
      .filter(r => !r.effective_date || r.effective_date <= checkDate)
      .filter(r => !r.expire_date || r.expire_date >= checkDate)
      .sort((a, b) => {
        const cmp = (b.updated_at || '').localeCompare(a.updated_at || '');
        return cmp !== 0 ? cmp : (b.id - a.id);
      });
    if (candidates.length) hit = candidates[0];
  }
  res.json({ data: hit, hit: !!hit, check_date: checkDate });
});

// ===== 外部对接配置（HJ 基础数据库-对外接口） =====
// 旧版字段（app_key/app_secret/endpoint_code）保留兼容，但优先使用新字段
const ERP_CFG_FILE = path.join(__dirname, '..', '..', 'database', 'product_labor_rate_external_config.json');
const DEFAULT_CFG = {
  enabled: false,
  base_url: 'http://127.0.0.1:5000/api/external',  // 对外接口 base
  api_key: EXTERNAL_API_KEY,                      // X-API-Key（环境变量 EBMS_EXTERNAL_API_KEY）
  data_table: 't_BOSAssemblyPriceEntry',          // 工价明细表
  item_table: 't_ICItemCore',                     // 产品主数据表（用于关联）
  limit: 5000
};
function loadErpCfg() {
  try {
    if (fs.existsSync(ERP_CFG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(ERP_CFG_FILE, 'utf8'));
      // 兼容老配置：把 app_key → api_key，base_url 保留
      if (!cfg.api_key && cfg.app_key) cfg.api_key = cfg.app_key;
      if (!cfg.base_url) cfg.base_url = DEFAULT_CFG.base_url;
      return Object.assign({}, DEFAULT_CFG, cfg);
    }
  } catch (e) {}
  return Object.assign({}, DEFAULT_CFG);
}
router.get('/external/config', requirePerm('labor-rate:view'), (req, res) => res.json(loadErpCfg()));
router.put('/external/config', requirePerm('labor-rate:edit'), (req, res) => {
  const cur = loadErpCfg();
  const next = Object.assign({}, cur, req.body || {});
  try {
    fs.writeFileSync(ERP_CFG_FILE, JSON.stringify(next, null, 2), 'utf8');
    res.json({ message: '外部对接配置已保存', data: next });
  } catch (e) { res.status(500).json({ error: '保存失败: ' + e.message }); }
});

// 健康检查：用当前保存的（或请求体传入的）配置探测 ERP
router.post('/external/test', requirePerm('labor-rate:view'), async (req, res) => {
  const cfg = Object.assign({}, loadErpCfg(), req.body || {});
  const steps = { ping: { ok: false } };
  if (!cfg.base_url) {
    steps.ping = { ok: false, error: 'base_url 为空' };
    return res.json({ ok: false, steps, hint: '请先填写接口地址（例：http://127.0.0.1:5000/api/external）' });
  }
  // 探测 1：连通性
  let r;
  try {
    r = await callExternalRaw(cfg, '/status');
  } catch (e) {
    steps.ping = { ok: false, error: e.message };
    // 自动探测：尝试同子网的其他常见地址，提示用户可能的真实 URL
    const suggestions = await scanLocalNetwork(cfg);
    const baseHint = explainExternalError(e) || '网络/连接错误';
    const autoHint = suggestions.length ? `。已自动扫描同网段，发现可访问的地址：${suggestions.map(s => s.url).join('、')}` : '。可尝试在 ERP 服务器本机执行：curl ' + cfg.base_url + '/status';
    return res.json({ ok: false, steps, hint: baseHint + autoHint, suggestions });
  }
  steps.ping = { ok: true, status: r.status, content_type: r.contentType, sample: r.body.substring(0, 200) };
  if (r.status === 401 || r.status === 403) {
    return res.json({ ok: false, steps, hint: '鉴权失败：X-API-Key 不正确或已失效' });
  }
  // 探测 2：鉴权
  let modR;
  try { modR = await callExternalRaw(cfg, '/modules'); }
  catch (e) {
    steps.parse = { ok: false, error: '鉴权接口调用失败: ' + e.message };
    return res.json({ ok: false, steps, hint: explainExternalError(e) || '鉴权接口不可达' });
  }
  steps.parse = { ok: modR.status >= 200 && modR.status < 300, status: modR.status, sample: modR.body.substring(0, 150) };
  if (!steps.parse.ok) {
    return res.json({ ok: false, steps, hint: '鉴权失败（status=' + modR.status + '），请检查 X-API-Key' });
  }
  // 探测 3：数据可达
  const tbl = cfg.data_table || 't_BOSAssemblyPriceEntry';
  let dataR;
  try { dataR = await callExternalRaw(cfg, '/data/' + tbl + '?limit=1'); }
  catch (e) {
    steps.shape = { ok: false, error: e.message };
    return res.json({ ok: false, steps, hint: '数据表 ' + tbl + ' 不可达' });
  }
  let dataParsed = null;
  try { dataParsed = JSON.parse(dataR.body); } catch (e) {}
  const list = dataParsed && (Array.isArray(dataParsed) ? dataParsed : (dataParsed.data || dataParsed.records || dataParsed.list || []));
  steps.shape = {
    ok: list.length > 0,
    status: dataR.status,
    count: list.length,
    sample_keys: (list[0] && typeof list[0] === 'object') ? Object.keys(list[0]).slice(0, 15) : []
  };
  const allOk = steps.ping.ok && steps.parse.ok && steps.shape.ok;
  return res.json({
    ok: allOk,
    steps,
    hint: allOk ? null :
      (!steps.shape.ok ? ('表 ' + tbl + ' 返回空数据，可尝试更换 data_table；当前 sample_keys=' + JSON.stringify(steps.shape.sample_keys)) :
       '配置未完全通过，请检查上方步骤')
  });
});

function explainExternalError(e) {
  const m = String(e.message || '');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/.test(m)) return '无法连接 ERP，请检查网络/IP/端口/防火墙';
  if (/证书|unable to verify|certificate|TLSV|EHOSTUNREACH/.test(m)) return 'TLS/证书错误，ERP 站点证书无效或被中间设备劫持';
  if (/超时|timeout/.test(m)) return '请求超时，请检查 ERP 是否可达或网络是否稳定';
  return null;
}

// 自动扫描常见内网 IP 段，探测 ERP 对外接口可达性
async function scanLocalNetwork(cfg) {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const subnets = new Set();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) {
        const parts = i.address.split('.');
        subnets.add(parts[0] + '.' + parts[1] + '.' + parts[2]);
      }
    }
  }
  const ports = [5000, 8000, 8080, 18080, 18084, 80, 443];
  const targets = [];
  for (const subnet of subnets) {
    // 扫子网前 20 个 + 后 20 个常用地址（避开网关、本机）
    const candidates = [];
    for (let h = 1; h <= 20; h++) candidates.push(subnet + '.' + h);
    for (let h = 100; h <= 120; h++) candidates.push(subnet + '.' + h);
    for (let h = 200; h <= 220; h++) candidates.push(subnet + '.' + h);
    for (const host of candidates) targets.push(host);
  }
  const hits = [];
  await Promise.all(targets.map(host => Promise.race([
    new Promise(resolve => {
      const http = require('http');
      const https = require('https');
      let probed = false;
      for (const port of ports) {
        const isHttps = port === 443;
        const lib = isHttps ? https : http;
        const req = lib.request({ hostname: host, port, path: '/api/external/status', method: 'GET', timeout: 1500, rejectUnauthorized: false, headers: cfg.api_key ? { 'X-API-Key': cfg.api_key } : {} }, (resp) => {
          if (probed) return;
          probed = true;
          if (resp.statusCode === 200) {
            let body = '';
            resp.on('data', c => body += c);
            resp.on('end', () => {
              try {
                const j = JSON.parse(body);
                if (j && (j.ok || j.database)) {
                  hits.push({ url: `http://${host}:${port}/api/external`, status: resp.statusCode, sample: body.substring(0, 80) });
                }
              } catch (e) {}
              resolve();
            });
          } else {
            resp.resume();
            resolve();
          }
        });
        req.on('error', () => { if (!probed) { probed = true; resolve(); } });
        req.on('timeout', () => { req.destroy(); if (!probed) { probed = true; resolve(); } });
        req.end();
      }
      if (!probed) resolve();
    }),
    new Promise(resolve => setTimeout(resolve, 2000))
  ])));
  return hits.slice(0, 10);
}

// 调用 HJ 对外接口：base_url + path（path 以 / 开头则追加到 base.path 后）
function callExternalRaw(cfg, path) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    let base;
    try { base = new URL(cfg.base_url); } catch (e) { return reject(new Error('base_url 格式无效')); }
    let urlStr;
    if (path.startsWith('http://') || path.startsWith('https://')) {
      urlStr = path;
    } else if (path.startsWith('/')) {
      // 绝对路径：追加到 base.path 后（保留 /api/external 这种前缀）
      const basePath = (base.pathname || '').replace(/\/$/, '');
      urlStr = base.protocol + '//' + base.host + basePath + path;
    } else {
      urlStr = base.href.replace(/\/$/, '') + '/' + path;
    }
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 拼接失败: ' + urlStr)); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'Accept': 'application/json' }, cfg.api_key ? { 'X-API-Key': cfg.api_key } : {}),
      timeout: 30000,
      ...(isHttps ? { rejectUnauthorized: false } : {})
    };
    const r = lib.request(options, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => resolve({
        status: resp.statusCode,
        body,
        contentType: resp.headers['content-type'] || ''
      }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时（30s）')); });
    r.end();
  });
}

// 批量探针：扫一批候选路径找可用接口
router.post('/external/probe', requirePerm('labor-rate:view'), async (req, res) => {
  const cfg = Object.assign({}, loadErpCfg(), req.body || {});
  if (!cfg.base_url) return res.status(400).json({ error: 'base_url 必填' });
  const paths = Array.isArray(req.body && req.body.paths) && req.body.paths.length ? req.body.paths : [
    '/status', '/modules', '/tables', '/data/t_BOSAssemblyPriceEntry?limit=1',
    '/data/t_BOSAssemblyPrice?limit=1', '/data/t_ICItemCore?limit=1',
    '/data/t_ICItemBase?limit=1', '/data/StdCost_ItemStdPrice?limit=1',
    '/data/StdCost_ItemStdPriceEntry?limit=1'
  ];
  const results = [];
  await Promise.all(paths.map(p => new Promise(resolve => {
    callExternalRaw(cfg, p).then(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.body); } catch (e) {}
      const isJSON = parsed !== null;
      const looksLikeAPI = isJSON && (Array.isArray(parsed) || parsed.data || parsed.records || parsed.list || parsed.modules || parsed.items || parsed.database !== undefined);
      results.push({
        path: p,
        status: r.status,
        content_type: r.contentType.split(';')[0] || '',
        is_json: isJSON,
        looks_like_api: looksLikeAPI,
        sample: r.body.substring(0, 150),
        top_keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 8) : []
      });
      resolve();
    }).catch(e => {
      results.push({ path: p, ok: false, error: e.message });
      resolve();
    });
  })));
  results.sort((a, b) => {
    const sa = (a.is_json ? 2 : 0) + (a.looks_like_api ? 4 : 0) + (a.status >= 200 && a.status < 400 ? 1 : 0);
    const sb = (b.is_json ? 2 : 0) + (b.looks_like_api ? 4 : 0) + (b.status >= 200 && b.status < 400 ? 1 : 0);
    return sb - sa;
  });
  res.json({ base_url: cfg.base_url, count: results.length, results });
});

// ===== 同步外部 ERP 工价审核表 =====
function callExternalErp(cfg) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const https = require('https');
    const http = require('http');
    const url = new URL(cfg.base_url);
    const isHttps = url.protocol === 'https:';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = timestamp + (cfg.app_key || '') + (cfg.endpoint_code || 'labor_rates.list');
    const signature = cfg.app_secret ? crypto.createHmac('sha256', cfg.app_secret).update(stringToSign, 'utf8').digest('hex') : '';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: Object.assign({ 'X-Timestamp': timestamp },
        cfg.app_key ? { 'X-App-Key': cfg.app_key } : {},
        signature ? { 'X-Signature': signature } : {}),
      timeout: 30000,
      ...(isHttps ? { rejectUnauthorized: false } : {})
    };
    const lib = isHttps ? https : http;
    const r = lib.request(options, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        try { const j = JSON.parse(body); resolve(j.data || j.records || j.list || j); }
        catch (e) { reject(new Error('解析响应失败: ' + body.substring(0, 200))); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时')); });
    r.end();
  });
}

router.post('/sync-from-external', requirePerm('labor-rate:create'), async (req, res) => {
  const cfg = Object.assign({}, loadErpCfg(), req.body && req.body.config || {});
  if (!cfg.enabled || !cfg.base_url) {
    return res.status(400).json({ error: '外部对接未启用，请先在「外部对接」配置 base_url 并启用' });
  }
  if (!cfg.api_key) {
    return res.status(400).json({ error: '缺少 X-API-Key，请设置环境变量 EBMS_EXTERNAL_API_KEY 或在配置中填写 api_key' });
  }
  const dataTable = cfg.data_table || 't_BOSAssemblyPriceEntry';
  const itemTable = cfg.item_table || 't_ICItemCore';
  const limit = Number(cfg.limit) || 5000;
  const ts = now();

  // Step 1: 取工价明细
  let dataRaw;
  try { dataRaw = await callExternalRaw(cfg, '/data/' + dataTable + '?limit=' + limit); }
  catch (e) { return res.status(502).json({ error: '取 ' + dataTable + ' 失败: ' + e.message, hint: explainExternalError(e) || '网络/连接错误' }); }
  if (dataRaw.status === 401 || dataRaw.status === 403) {
    return res.status(401).json({ error: '鉴权失败（status=' + dataRaw.status + '），请检查 X-API-Key' });
  }
  let dataParsed;
  try { dataParsed = JSON.parse(dataRaw.body); }
  catch (e) { return res.status(502).json({ error: dataTable + ' 响应不是 JSON', hint: 'base_url/api_key 错误或目标表不存在' }); }
  const entries = Array.isArray(dataParsed) ? dataParsed : (dataParsed.data || dataParsed.records || dataParsed.list || []);
  if (!entries.length) {
    return res.json({ message: '外部表 ' + dataTable + ' 返回 0 条记录', added: 0, updated: 0, kept: 0, skipped: 0, total: 0 });
  }

  // Step 2: 取产品主数据（FNumber/FShortNumber/FName），建立 FItemID → item 的索引
  let itemMap = new Map();
  try {
    const itemRaw = await callExternalRaw(cfg, '/data/' + itemTable + '?limit=50000');
    if (itemRaw.status === 200) {
      const itemParsed = JSON.parse(itemRaw.body);
      const items = Array.isArray(itemParsed) ? itemParsed : (itemParsed.data || itemParsed.records || itemParsed.list || []);
      for (const it of items) {
        if (it.FItemID) itemMap.set(Number(it.FItemID), it);
      }
    }
  } catch (e) {
    // 取不到 item 表也不致命：用 entry 自带字段兜底
  }

  // Step 3: 取工价头表（提供 FDate 生效日）— 可选
  let headerMap = new Map();
  try {
    const headerTable = dataTable.replace(/Entry$/, '');
    const headerRaw = await callExternalRaw(cfg, '/data/' + headerTable + '?limit=10000');
    if (headerRaw.status === 200) {
      const headerParsed = JSON.parse(headerRaw.body);
      const headers = Array.isArray(headerParsed) ? headerParsed : (headerParsed.data || headerParsed.records || headerParsed.list || []);
      for (const h of headers) {
        if (h.FID) headerMap.set(Number(h.FID), h);
      }
    }
  } catch (e) {}

  // Step 4: 映射 → upsert
  const table = getTable('product_labor_rate');
  let added = 0, updated = 0, kept = 0, skipped = 0;
  const skipReasons = {};
  for (const e of entries) {
    const itemId = Number(e.FItemID || e.item_id);
    const item = itemMap.get(itemId) || {};
    const bom = String(item.FShortNumber || item.FNumber || e.FItemID || '').trim();
    if (!bom) { skipped++; skipReasons['no_bom_no'] = (skipReasons['no_bom_no'] || 0) + 1; continue; }
    const productCode = String(item.FNumber || '');
    const productName = String(item.FName || '');
    const rate = toNum(e.FPrice !== undefined ? e.FPrice : (e.labor_rate !== undefined ? e.labor_rate : 0));
    const header = headerMap.get(Number(e.FID)) || {};
    const effDate = (header.FDate ? String(header.FDate).substring(0, 10) : (e.FDate ? String(e.FDate).substring(0, 10) : ts.substring(0, 10)));
    const wProcedure = String(e.WProcedure || '');
    const fNote = String(e.FNOTE || '');
    const remarks = (wProcedure + (fNote ? ' / ' + fNote : '')).substring(0, 200);
    const rec = normalize({
      bom_no: bom,
      product_code: productCode,
      product_name: productName,
      labor_rate: rate,
      labor_rate_type: '标准工价',
      process_cost: 0,
      effective_date: effDate,
      expire_date: '',
      source: 'erp_sync',
      audit_status: 'pending',
      remarks: remarks
    });
    const exist = table.all().find(r => r.bom_no === bom);
    if (exist) {
      if (rate > 0 && Number(exist.labor_rate) !== rate) {
        await table.update(exist.id, Object.assign({}, rec, { updated_at: ts }));
        updated++;
      } else {
        kept++;
      }
    } else {
      await table.insert(Object.assign({}, rec, { created_at: ts, updated_at: ts }));
      added++;
    }
  }
  res.json({
    message: '同步完成（' + dataTable + ' × ' + itemTable + '）',
    added, updated, kept, skipped,
    total: entries.length,
    skip_reasons: skipReasons,
    sample: entries.slice(0, 3)
  });
});

// ===== BOM 树代理：GET /external/boms/tree?bom_id=... =====
// 透传 ERP 返回的多级 BOM 树，前端可渲染或用于诊断
router.get('/external/bom-tree', requirePerm('labor-rate:view'), async (req, res) => {
  const cfg = Object.assign({}, loadErpCfg(), req.query || {});
  if (!cfg.base_url) return res.status(400).json({ error: '外部对接未配置 base_url' });
  if (!cfg.api_key) return res.status(400).json({ error: '缺少 X-API-Key（环境变量 EBMS_EXTERNAL_API_KEY 或配置中填写）' });
  const bomId = String(req.query.bom_id || '').trim();
  if (!bomId) return res.status(400).json({ error: 'bom_id 必填（例：?bom_id=JFS22-B1WB10S27-46-01）' });
  let raw;
  try { raw = await callExternalRaw(cfg, '/boms/tree?bom_id=' + encodeURIComponent(bomId)); }
  catch (e) { return res.status(502).json({ error: '取 BOM 树失败: ' + e.message, hint: explainExternalError(e) || '网络/连接错误' }); }
  if (raw.status === 401 || raw.status === 403) {
    return res.status(401).json({ error: '鉴权失败（status=' + raw.status + '），请检查 X-API-Key' });
  }
  let parsed;
  try { parsed = JSON.parse(raw.body); }
  catch (e) { return res.status(502).json({ error: 'BOM 树响应不是 JSON', sample: raw.body.substring(0, 200) }); }
  // 兼容多种返回形态：根对象 / tree 字段 / nodes 数组
  const nodes = Array.isArray(parsed) ? parsed : (parsed.nodes || parsed.data || parsed.records || []);
  const tree = parsed.tree || (Array.isArray(parsed) ? parsed[0] : (nodes.length ? parsed : null));
  const stats = analyzeBomTree(nodes, tree);
  res.json({
    bom_id: bomId,
    status: raw.status,
    raw: parsed,
    nodes,
    tree,
    stats
  });
});

// 分析 BOM 树：节点数、最大深度、叶子数、关键字段汇总
function analyzeBomTree(nodes, tree) {
  const out = { total_nodes: 0, max_depth: 0, leaf_nodes: 0, root_count: 0, materials: [], missing_material_id: 0 };
  if (!Array.isArray(nodes) || !nodes.length) {
    if (tree) {
      out.total_nodes = 1;
      out.max_depth = 1;
    }
    return out;
  }
  out.total_nodes = nodes.length;
  const hasParentId = nodes.some(n => n.parent_id !== undefined || n.parentId !== undefined || n.pid !== undefined);
  if (!hasParentId) {
    // 没有父子关系字段，返回单层列表
    out.max_depth = 1;
    out.root_count = nodes.length;
    out.leaf_nodes = nodes.length;
    out.materials = nodes.slice(0, 10).map(n => ({ id: n.material_id || n.materialId || n.id, code: n.material_code || n.code || n.number, name: n.material_name || n.name, qty: n.qty || n.quantity }));
    return out;
  }
  const childMap = new Map();
  const nodeMap = new Map();
  nodes.forEach(n => {
    const id = n.material_id !== undefined ? n.material_id : (n.materialId !== undefined ? n.materialId : n.id);
    const parent = n.parent_id !== undefined ? n.parent_id : (n.parentId !== undefined ? n.parentId : (n.pid !== undefined ? n.pid : null));
    nodeMap.set(id, n);
    if (parent !== null && parent !== undefined && parent !== '') {
      if (!childMap.has(parent)) childMap.set(parent, []);
      childMap.get(parent, []).push(id);
    } else {
      out.root_count++;
    }
  });
  const roots = nodes.filter(n => {
    const parent = n.parent_id !== undefined ? n.parent_id : (n.parentId !== undefined ? n.parentId : n.pid);
    return parent === null || parent === undefined || parent === '';
  });
  function depth(id, d) {
    const kids = childMap.get(id) || [];
    if (!kids.length) { out.leaf_nodes++; return d; }
    let max = d;
    for (const k of kids) max = Math.max(max, depth(k, d + 1));
    return max;
  }
  roots.forEach(r => {
    const id = r.material_id !== undefined ? r.material_id : (r.materialId !== undefined ? r.materialId : r.id);
    out.max_depth = Math.max(out.max_depth, depth(id, 1));
  });
  out.materials = roots.slice(0, 10).map(n => ({
    id: n.material_id || n.materialId || n.id,
    code: n.material_code || n.code || n.number,
    name: n.material_name || n.name,
    qty: n.qty || n.quantity
  }));
  out.missing_material_id = nodes.filter(n => !(n.material_id || n.materialId || n.id)).length;
  return out;
}

// ===== 新增 =====
router.post('/', requirePerm('labor-rate:create'), async (req, res) => {
  const body = normalize(req.body || {});
  if (!body.bom_no) return res.status(400).json({ error: 'bom_no 为必填项（主匹配键）' });
  if (!body.labor_rate && body.labor_rate !== 0) return res.status(400).json({ error: '工价(labor_rate)为必填项' });
  const table = getTable('product_labor_rate');
  const dup = table.all().find(r => r.bom_no === body.bom_no && r.audit_status !== 'disabled');
  if (dup && (req.body && req.body.force !== true)) {
    return res.status(400).json({ error: `bom_no ${body.bom_no} 已存在记录（id=${dup.id}），如需覆盖请传 force=true`, data: dup });
  }
  if (dup && req.body.force === true) {
    await table.update(dup.id, Object.assign({}, body, { updated_at: now() }));
    return res.json({ message: '工价已更新', data: table.findById(dup.id) });
  }
  const ts = now();
  const result = await table.insert(Object.assign({}, body, { created_at: ts, updated_at: ts }));
  res.json({ message: '工价创建成功', data: table.findById(result.lastID) });
});

// ===== 修改 =====
router.put('/:id', requirePerm('labor-rate:edit'), async (req, res) => {
  const id = Number(req.params.id);
  const table = getTable('product_labor_rate');
  const cur = table.findById(id);
  if (!cur) return res.status(404).json({ error: '记录不存在' });
  const body = normalize(Object.assign({}, cur, req.body || {}));
  await table.update(id, Object.assign({}, body, { updated_at: now() }));
  res.json({ message: '工价已更新', data: table.findById(id) });
});

// ===== 批量导入/upsert（前端"粘贴两列"或 Excel） =====
router.post('/batch', requirePerm('labor-rate:create'), async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : (req.body && req.body.records) || [];
  if (!list.length) return res.status(400).json({ error: 'records 不能为空' });
  const table = getTable('product_labor_rate');
  const ts = now();
  let added = 0, updated = 0, skipped = 0;
  for (const raw of list) {
    const item = normalize(Object.assign({ source: 'manual', audit_status: 'pending' }, raw));
    if (!item.bom_no) { skipped++; continue; }
    const exist = table.all().find(r => r.bom_no === item.bom_no);
    if (exist) {
      await table.update(exist.id, Object.assign({}, item, { updated_at: ts }));
      updated++;
    } else {
      await table.insert(Object.assign({}, item, { created_at: ts, updated_at: ts }));
      added++;
    }
  }
  res.json({ message: '批量导入完成', added, updated, skipped, total: list.length });
});

// ===== 批量更新（前端行内编辑） =====
router.post('/batch-update', requirePerm('labor-rate:edit'), async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : (req.body && req.body.records) || [];
  if (!list.length) return res.status(400).json({ error: 'records 不能为空' });
  const table = getTable('product_labor_rate');
  const ts = now();
  let updated = 0, notFound = 0;
  for (const raw of list) {
    if (!raw.id) continue;
    const cur = table.findById(raw.id);
    if (!cur) { notFound++; continue; }
    const body = normalize(Object.assign({}, cur, raw));
    await table.update(cur.id, Object.assign({}, body, { updated_at: ts }));
    updated++;
  }
  res.json({ message: '批量更新完成', updated, not_found: notFound, total: list.length });
});

// ===== 批量删除 =====
router.post('/batch-delete', requirePerm('labor-rate:delete'), async (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids 不能为空' });
  const table = getTable('product_labor_rate');
  let n = 0;
  for (const id of ids) {
    const r = await table.delete(Number(id));
    n += (r && r.changes) || 0;
  }
  res.json({ message: `已删除 ${n} 条`, deleted: n });
});

// ===== 删除 =====
router.delete('/:id', requirePerm('labor-rate:delete'), async (req, res) => {
  const r = await getTable('product_labor_rate').delete(req.params.id);
  if (!r || !r.changes) return res.status(404).json({ error: '记录不存在' });
  res.json({ message: '已删除' });
});

// ===== 工价调整（版本管理：旧记录设过期日，新记录生效日=今天）=====
// 历史订单快照不变，新订单自动采用新工价
router.post('/:id/adjust', requirePerm('labor-rate:edit'), async (req, res) => {
  const id = Number(req.params.id);
  const { new_rate, effective_date, remarks } = req.body || {};
  if (!new_rate || Number(new_rate) <= 0) {
    return res.status(400).json({ error: '请填写有效的新工价' });
  }
  const table = getTable('product_labor_rate');
  table._invalidate();
  const cur = table.findById(id);
  if (!cur) return res.status(404).json({ error: '记录不存在' });

  const ts = now();
  const today = ts.substring(0, 10);
  const effDate = effective_date || today;

  // 1. 旧记录设 expire_date = 生效日前一天（即生效日当天新记录的 updated_at 更新，自动优先）
  await table.update(id, {
    expire_date: effDate,
    remarks: (cur.remarks || '') + ' | 已调整',
    updated_at: ts
  });

  // 2. 新建记录（继承 bom_no/product_code/product_name，新工价）
  const newRec = normalize({
    bom_no: cur.bom_no,
    product_code: cur.product_code,
    product_name: cur.product_name,
    labor_rate: Number(new_rate),
    labor_rate_type: cur.labor_rate_type || '标准工价',
    process_cost: cur.process_cost || 0,
    effective_date: effDate,
    expire_date: '',
    source: 'adjust',
    audit_status: 'approved', // 调整后直接生效（旧价已审核→新价继承信任）
    approved_by: cur.approved_by || '',
    remarks: remarks || ('由 ¥' + cur.labor_rate + ' 调整为 ¥' + Number(new_rate))
  });
  const result = await table.insert(Object.assign({}, newRec, { created_at: ts, updated_at: ts }));

  // 3. 清缓存让下次读取生效
  try { require('./order-analysis').clearLaborRateCache(); } catch(e) {}

  res.json({
    message: `工价已调整：¥${cur.labor_rate} → ¥${Number(new_rate)}（生效日 ${effDate}）`,
    old: table.findById(id),
    new: table.findById(result.lastID)
  });
});

// ===== 查看某 bom_no 的工价历史版本 =====
router.get('/history/:bomNo', requirePerm('labor-rate:view'), (req, res) => {
  const bomNo = (req.params.bomNo || '').trim();
  if (!bomNo) return res.status(400).json({ error: 'bomNo 必填' });
  const table = getTable('product_labor_rate');
  table._invalidate();
  const versions = table.all()
    .filter(r => r.bom_no === bomNo)
    .sort((a, b) => String(b.effective_date || '').localeCompare(String(a.effective_date || '')));
  res.json({ bom_no: bomNo, total: versions.length, data: versions });
});

// ===== 从 bom_items 全表同步自制/外加工物料工价 =====
// 扫描 BOM 明细表，提取所有 material_attr IN ('自制','委外加工','外加工') 的物料，
// 按 material_code 去重，取 direct_labor+outsource_labor+processing_fee 作为工价
router.post('/sync-from-bom', requirePerm('labor-rate:create'), async (req, res) => {
  const bomTable = getTable('bom_items');
  bomTable._invalidate();
  const allLines = bomTable.all();
  const lrTable = getTable('product_labor_rate');
  lrTable._invalidate();
  const ts = now();
  const yStart = yearStart();

  // 按 material_code 去重，取人工最大的那条
  const dedup = new Map();
  let scanned = 0;
  for (const line of allLines) {
    scanned++;
    const attr = String(line.material_attr || '').trim();
    if (attr !== '自制' && attr !== '委外加工' && attr !== '外加工') continue;
    const code = String(line.material_code || '').trim();
    if (!code) continue;
    const labor = toNum(line.direct_labor) + toNum(line.outsource_labor) + toNum(line.processing_fee);
    const existing = dedup.get(code);
    if (!existing || labor > existing.labor) {
      dedup.set(code, {
        code, name: String(line.material_name || '').trim(),
        spec: String(line.spec || '').trim(), unit: String(line.unit || '').trim(),
        attr, labor: Math.round(labor * 10000) / 10000
      });
    }
  }

  let added = 0, updated = 0, skipped = 0;
  for (const item of dedup.values()) {
    const existing = lrTable.all().find(r => r.bom_no === item.code && r.audit_status !== 'disabled');
    const rate = Math.round(item.labor * 100) / 100;
    const rateType = item.attr === '自制' ? '标准工价' : '暂估工价';
    const remarks = 'BOM同步/' + item.attr + (item.spec ? '/规格:' + item.spec.substring(0, 30) : '');
    if (existing) {
      // 只在工价不同或来源不是 bom_sync 时更新；不覆盖 manual/order_analysis 的已审核值
      if (existing.source === 'bom_sync' || (existing.labor_rate === 0 && rate > 0)) {
        if (Number(existing.labor_rate) !== rate) {
          await lrTable.update(existing.id, {
            labor_rate: rate, product_name: item.name || existing.product_name,
            labor_rate_type: rateType, source: 'bom_sync', remarks, updated_at: ts
          });
          updated++;
        } else { skipped++; }
      } else { skipped++; }
    } else {
      await lrTable.insert({
        bom_no: item.code, product_code: item.code, product_name: item.name,
        labor_rate: rate, labor_rate_type: rateType, process_cost: 0,
        effective_date: yStart, expire_date: '',
        source: 'bom_sync',
        audit_status: 'pending',
        approved_by: '', remarks,
        created_at: ts, updated_at: ts
      });
      added++;
    }
  }
  res.json({
    message: `BOM同步完成：扫描 ${scanned} 行，去重 ${dedup.size} 个自制/外加工物料，新增 ${added}，更新 ${updated}，跳过 ${skipped}`,
    scanned, unique: dedup.size, added, updated, skipped
  });
});

module.exports = router;
