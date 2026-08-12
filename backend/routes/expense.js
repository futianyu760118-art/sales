/**
 * 费用库（经营中心）
 * ------------------------------------------------------------------
 * 汇集企业全部费用明细：手工录入 / Excel 导入 / 外部 API 对接
 * 提供费用分析（按大类、部门、账期、来源、支付状态等多维度）
 * 设计对标「物料库」模式：JSON 存储 + 权限校验 + 仪表盘 + 导入 + 对外同步
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('expenses');

// ===== 常量 =====
const NUM_FIELDS = ['amount', 'tax_rate', 'tax_amount', 'total_amount', 'amiba_id'];
const STR_FIELDS = [
  'expense_code', 'expense_name', 'expense_category', 'expense_type',
  'department', 'project', 'order_no', 'supplier', 'occur_date', 'account_period',
  'currency', 'payment_method', 'payment_status', 'payee', 'invoice_no',
  'invoice_type', 'source', 'remarks'
];
const ALLOWED_SORT = [
  'id', 'expense_code', 'expense_name', 'expense_category', 'department',
  'supplier', 'occur_date', 'account_period', 'amount', 'tax_amount',
  'total_amount', 'payment_status', 'source', 'created_at'
];

// 费用大类标准（供前端下拉 + 校验参考）
const EXPENSE_CATEGORIES = [
  '办公费', '差旅费', '水电费', '房租', '物流运输费', '营销推广费',
  '业务招待费', '研发费', '检测认证费', '模具费', '工具耗材',
  '维修维护费', '通讯费', '财务费用', '税费', '保险费', '福利费',
  '培训费', '其他'
];
const PAYMENT_METHODS = ['银行转账', '现金', '支票', '承兑汇票', '微信', '支付宝', '其他'];
const PAYMENT_STATUSES = ['未付', '部分付款', '已付'];
const INVOICE_TYPES = ['增专', '增普', '普通发票', '收据', '无票'];
const SOURCES = ['手工录入', 'Excel导入', '外部API'];

// ===== 工具函数 =====
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}

// 根据发生日期推导归属账期（YYYY-MM）
function derivePeriod(occurDate) {
  if (!occurDate) return '';
  const s = String(occurDate).replace('/', '-').substring(0, 10);
  return s.length >= 7 ? s.substring(0, 7) : '';
}

// 计算税额/价税合计（缺失时自动补全）
function normalizeRecord(r) {
  const amount = toNum(r.amount);
  const taxRate = toNum(r.tax_rate);
  const taxAmount = r.tax_amount !== undefined && r.tax_amount !== '' ? toNum(r.tax_amount) : Math.round(amount * taxRate / 100 * 100) / 100;
  const totalAmount = r.total_amount !== undefined && r.total_amount !== '' ? toNum(r.total_amount) : Math.round((amount + taxAmount) * 100) / 100;
  const period = r.account_period || derivePeriod(r.occur_date);
  const source = r.source || '手工录入';
  return Object.assign({}, r, {
    amount, tax_rate: taxRate, tax_amount: taxAmount, total_amount: totalAmount,
    account_period: period, source,
    currency: r.currency || 'CNY',
    payment_status: r.payment_status || '未付',
    payment_method: r.payment_method || '',
    occur_date: r.occur_date || '',
    remarks: r.remarks || ''
  });
}

// 费用编码自动生成：FY + 年月(YYYYMM) + - + 4位流水号，如 FY202607-0001
// 基于归属账期（无则当前年月），在同前缀已有编码中取最大流水号 + 1
function genExpenseCode(table, period) {
  const ym = (period || now().substring(0, 7)).replace('-', '');
  const prefix = 'FY' + ym;
  let maxSeq = 0;
  table.all().forEach(r => {
    const code = (r.expense_code || '').trim();
    if (code.startsWith(prefix + '-')) {
      const seq = parseInt(code.substring(prefix.length + 1), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return prefix + '-' + String(maxSeq + 1).padStart(4, '0');
}

// ===== 列表（分页/筛选/排序）=====
router.get('/', requirePerm('expense:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, category, type, department, project,
          supplier, payment_status, source, account_period,
          occur_from, occur_to, amount_min, amount_max, sort_by, sort_order } = req.query;
  const table = getTable('expenses');
  const filter = (r) => {
    if (category && r.expense_category !== category) return false;
    if (type && !(r.expense_type || '').includes(type)) return false;
    if (department && r.department !== department) return false;
    if (project && !(r.project || '').includes(project)) return false;
    if (supplier && !(r.supplier || '').includes(supplier)) return false;
    if (payment_status && r.payment_status !== payment_status) return false;
    if (source && r.source !== source) return false;
    if (account_period && r.account_period !== account_period) return false;
    if (occur_from && (r.occur_date || '') < occur_from) return false;
    if (occur_to && (r.occur_date || '') > occur_to) return false;
    if (amount_min !== undefined && amount_min !== '' && toNum(r.amount) < toNum(amount_min)) return false;
    if (amount_max !== undefined && amount_max !== '' && toNum(r.amount) > toNum(amount_max)) return false;
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      const hay = [r.expense_code, r.expense_name, r.expense_category, r.expense_type,
        r.department, r.supplier, r.project, r.invoice_no, r.remarks].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  };
  const orderBy = ALLOWED_SORT.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && String(sort_order).toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// 筛选项可选值
router.get('/meta/filter-options', requirePerm('expense:view'), (req, res) => {
  const table = getTable('expenses');
  table._invalidate();
  const all = table.all();
  const uniq = key => [...new Set(all.map(r => r[key]).filter(v => v !== undefined && v !== null && String(v).trim() !== ''))];
  res.json({
    categories: uniq('expense_category'),
    departments: uniq('department'),
    types: uniq('expense_type'),
    suppliers: uniq('supplier'),
    projects: uniq('project'),
    payment_statuses: uniq('payment_status'),
    sources: uniq('source'),
    account_periods: uniq('account_period').sort().reverse(),
    standard_categories: EXPENSE_CATEGORIES,
    standard_payment_methods: PAYMENT_METHODS,
    standard_payment_statuses: PAYMENT_STATUSES,
    standard_invoice_types: INVOICE_TYPES,
    standard_sources: SOURCES
  });
});

// ===== 仪表盘 / 费用分析 =====
// 通用：可选按 account_period / category / department 范围筛选
function parseStatsFilter(q) {
  const period = String(q.account_period || '').trim();
  const category = String(q.category || '').trim();
  const department = String(q.department || '').trim();
  const source = String(q.source || '').trim();
  const occurFrom = String(q.occur_from || '').trim();
  const occurTo = String(q.occur_to || '').trim();
  return (r) => {
    if (period && r.account_period !== period) return false;
    if (category && r.expense_category !== category) return false;
    if (department && r.department !== department) return false;
    if (source && r.source !== source) return false;
    if (occurFrom && (r.occur_date || '') < occurFrom) return false;
    if (occurTo && (r.occur_date || '') > occurTo) return false;
    return true;
  };
}

router.get('/dashboard/stats', requirePerm('expense:view'), (req, res) => {
  const table = getTable('expenses');
  table._invalidate();
  const f = parseStatsFilter(req.query);
  const all = table.all().filter(f);

  let totalAmount = 0, totalTax = 0, totalAll = 0;
  let paid = 0, unpaid = 0, partial = 0;
  const byCategory = {}, byDepartment = {}, byMonth = {}, bySource = {}, byPaymentStatus = {}, bySupplier = {};
  const topItems = [];

  all.forEach(r => {
    const amt = toNum(r.amount);
    const tax = toNum(r.tax_amount);
    const tot = toNum(r.total_amount);
    totalAmount += amt; totalTax += tax; totalAll += tot;
    const cat = r.expense_category || '未分类';
    byCategory[cat] = (byCategory[cat] || 0) + amt;
    const dep = r.department || '未分配';
    byDepartment[dep] = (byDepartment[dep] || 0) + amt;
    const mon = r.account_period || derivePeriod(r.occur_date) || '未知';
    byMonth[mon] = (byMonth[mon] || 0) + amt;
    const src = r.source || '未知';
    bySource[src] = (bySource[src] || 0) + 1;
    const ps = r.payment_status || '未付';
    byPaymentStatus[ps] = (byPaymentStatus[ps] || 0) + amt;
    if (ps === '已付') paid += amt; else if (ps === '部分付款') partial += amt; else unpaid += amt;
    const sup = r.supplier || '';
    if (sup) bySupplier[sup] = (bySupplier[sup] || 0) + amt;
    topItems.push({ id: r.id, expense_code: r.expense_code, expense_name: r.expense_name,
      expense_category: cat, department: r.department || '', amount: amt, occur_date: r.occur_date || '' });
  });

  const sortPairs = (obj, n) => Object.entries(obj).map(([k, v]) => ({ name: k, value: Math.round(v * 100) / 100 }))
    .sort((a, b) => b.value - a.value).slice(0, n || 9999);
  const months = Object.keys(byMonth).sort();
  const trend = months.map(m => ({ month: m, amount: Math.round(byMonth[m] * 100) / 100 }));
  const lastMonth = months[months.length - 1] || '';
  const prevMonth = months[months.length - 2] || '';
  const mom = (lastMonth && prevMonth) ? Math.round((byMonth[lastMonth] - byMonth[prevMonth]) / (byMonth[prevMonth] || 1) * 1000) / 10 : 0;

  res.json({
    total: all.length,
    total_amount: Math.round(totalAmount * 100) / 100,
    total_tax: Math.round(totalTax * 100) / 100,
    total_with_tax: Math.round(totalAll * 100) / 100,
    paid_amount: Math.round(paid * 100) / 100,
    unpaid_amount: Math.round(unpaid * 100) / 100,
    partial_amount: Math.round(partial * 100) / 100,
    by_category: sortPairs(byCategory, 15),
    by_department: sortPairs(byDepartment, 15),
    by_month: trend,
    by_source: sortPairs(bySource, 10),
    by_payment_status: sortPairs(byPaymentStatus, 10),
    top_suppliers: sortPairs(bySupplier, 10),
    top_items: topItems.sort((a, b) => b.amount - a.amount).slice(0, 15),
    last_month: lastMonth, prev_month: prevMonth, mom_percent: mom
  });
});

// 数据质量检查
router.get('/quality-check', requirePerm('expense:view'), (req, res) => {
  const table = getTable('expenses');
  table._invalidate();
  const all = table.all();
  const issues = [];
  const sevOrder = { severe: 0, warning: 1, info: 2 };
  const codeCount = {};
  all.forEach(r => { const c = (r.expense_code || '').trim(); if (c) codeCount[c] = (codeCount[c] || 0) + 1; });
  all.forEach(r => {
    const push = (type, severity, message) => issues.push({
      id: r.id, expense_code: r.expense_code || '', expense_name: r.expense_name || '', type, severity, message
    });
    if (!r.expense_name) push('empty_name', 'severe', '费用名称为空');
    if (!r.occur_date) push('empty_date', 'severe', '发生日期为空');
    if (r.expense_code && codeCount[r.expense_code] > 1) push('dup_code', 'severe', `费用编码重复(共${codeCount[r.expense_code]}条)`);
    if (toNum(r.amount) <= 0) push('zero_amount', 'severe', '金额为0或未填');
    if (toNum(r.amount) < 0) push('neg_amount', 'severe', '金额为负数');
    if (!r.expense_category) push('no_category', 'warning', '未设置费用大类');
    if (!r.department) push('no_dept', 'warning', '未设置所属部门');
    if (!r.account_period) push('no_period', 'warning', '未归属账期');
    if (!r.source) push('no_source', 'info', '未标记数据来源');
  });
  const bySeverity = { severe: 0, warning: 0, info: 0 };
  const affectedIds = new Set();
  issues.forEach(i => { bySeverity[i.severity]++; affectedIds.add(i.id); });
  res.json({
    total: all.length,
    affected: affectedIds.size,
    issue_count: issues.length,
    by_severity: bySeverity,
    pass_rate: all.length ? Math.round((1 - affectedIds.size / all.length) * 1000) / 10 : 100,
    issues: issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])
  });
});

// 导出 CSV
router.get('/export/csv', requirePerm('expense:view'), (req, res) => {
  const table = getTable('expenses');
  table._invalidate();
  const f = parseStatsFilter(req.query);
  const rows = table.all().filter(f).sort((a, b) => (b.occur_date || '').localeCompare(a.occur_date || ''));
  const headers = ['费用编码', '费用名称', '费用大类', '费用细类', '所属部门', '关联项目', '收款方',
    '发生日期', '归属账期', '金额', '税率%', '税额', '价税合计', '币种', '支付方式', '支付状态',
    '经办人', '发票号', '发票类型', '数据来源', '备注'];
  const data = rows.map(r => [
    r.expense_code, r.expense_name, r.expense_category, r.expense_type, r.department, r.project, r.supplier,
    r.occur_date, r.account_period, toNum(r.amount), toNum(r.tax_rate), toNum(r.tax_amount), toNum(r.total_amount),
    r.currency, r.payment_method, r.payment_status, r.payee, r.invoice_no, r.invoice_type, r.source, r.remarks
  ].map(v => String(v == null ? '' : v).replace(/,/g, '，')));
  let csv = headers.join(',') + '\n';
  data.forEach(r => csv += r.join(',') + '\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=expenses.csv');
  res.send('\uFEFF' + csv);
});

// 单条详情（放在所有具名单段路径之后，避免 /:id 抢占 /quality-check 等）
router.get('/:id', requirePerm('expense:view'), (req, res) => {
  const table = getTable('expenses');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '费用记录不存在' });
  res.json(row);
});

// ===== 外部 API 对接（恒剑OA 数据供给：HMAC-SHA256 签名）=====
// 数据源：科目余额 subject_balances（费用类科目发生额）+ 供应商付款 supplier-payment（发票明细）
// 签名串 = timestamp + app_key + endpoint_code + query_string（query_string 与实际请求 URL 的 ? 后内容完全一致）
function loadExternalConfig() {
  try {
    const file = path.join(__dirname, '..', '..', 'database', 'expense_external_config.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return {
    enabled: false,
    base_url: 'https://192.168.0.127:18084',
    app_key: '', app_secret: '',
    // TLS servername：当 base_url 是 IP 时，用此域名做 TLS 握手以匹配证书 SAN（解决 hostname/IP 校验错误）
    server_name: 'hjoa.chinahy-soft.com',
    // 科目余额：HMAC 可对接（内部可暴露接口 int:finance.subject_balances.list）
    // 供应商付款：OA 用 OAuth2 认证，非 HMAC，当前凭证体系下不可对接，需另配 OAuth2 用户名密码
    sources: ['subject_balances'],
    // 科目余额
    sb_endpoint: 'int:finance.subject_balances.list',
    sb_path: '/api/v1/basicdata/subject-balances',
    sb_subject_category: '', sb_fiscal_year: '', sb_fiscal_month: '',
    // 供应商付款（OAuth2，当前不可用，保留配置以备后续接入）
    sp_endpoint: 'int:materials.supplier_payment.list',
    sp_path: '/api/v1/materials/supplier-payment',
    sp_payment_month: '', sp_supplier_name: ''
  };
}

// 构造有序 query string（跳过空值，用于签名且与实际请求一致）
function _buildQs(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map(k => k + '=' + encodeURIComponent(params[k]))
    .join('&');
}

// HMAC 签名调用
function _callSigned(cfg, endpointCode, pathName, queryParams) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const http = require('http'); const https = require('https');
    const qs = _buildQs(queryParams || {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const str = timestamp + (cfg.app_key || '') + (endpointCode || '') + qs;
    const signature = (cfg.app_key && cfg.app_secret) ? crypto.createHmac('sha256', cfg.app_secret).update(str, 'utf8').digest('hex') : '';
    const base = (cfg.base_url || '').replace(/\/$/, '');
    let u;
    try { u = new URL(base + pathName); } catch (e) { return reject(new Error('base_url 配置无效: ' + base)); }
    const isHttps = u.protocol === 'https:';
    // 关键：当 host 是 IP 时，TLS 必须用证书 SAN 里的域名做 servername
    // （Node v22+ 不允许 servername=IP，且 SAN 不含 IP 时 hostname 校验失败）
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(':');
    const servername = isHttps && isIp ? (cfg.server_name || u.hostname) : u.hostname;
    const options = {
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (qs ? '?' + qs : ''),
      method: 'GET',
      headers: Object.assign({ 'X-Timestamp': timestamp }, cfg.app_key ? { 'X-App-Key': cfg.app_key } : {}, signature ? { 'X-Signature': signature } : {}),
      timeout: 30000,
      ...(isHttps ? { rejectUnauthorized: false } : {}),
      servername
    };
    const lib = isHttps ? https : http;
    const r = lib.request(options, (resp) => {
      let body = '';
      resp.on('data', c => body += c);
      resp.on('end', () => {
        if (resp.statusCode >= 400) return reject(new Error('HTTP ' + resp.statusCode + ' · ' + body));
        try {
          const j = JSON.parse(body);
          if (j.code !== undefined && j.code !== 0) return reject(new Error('HTTP ' + resp.statusCode + ' · code=' + j.code + ' · ' + (j.message || j.detail || '')));
          resolve(j);
        } catch (e) { reject(new Error('HTTP ' + resp.statusCode + ' · 解析失败: ' + body)); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时')); });
    r.end();
  });
}

// 分页拉取全部 items（page_size 对方接口最大 100，自动翻页）
async function _fetchAll(cfg, endpointCode, pathName, baseParams) {
  const all = []; let page = 1; const pageSize = 100; let total = 0;
  do {
    const resp = await _callSigned(cfg, endpointCode, pathName, Object.assign({}, baseParams, { page, page_size: pageSize }));
    const data = resp.data || resp;
    const items = data.items || data.records || data.list || [];
    total = (data.total != null) ? data.total : (items.length < pageSize ? (page - 1) * pageSize + items.length : page * pageSize + 1);
    all.push(...items);
    if (items.length < pageSize) break;
    page++;
    if (page > 500) break;
  } while (all.length < total);
  return all;
}

function _lastDay(y, m) { try { return new Date(y, m, 0).getDate(); } catch (e) { return 28; } }

// 科目余额 → 费用记录
function _mapSb(it) {
  const fm = it.fiscal_month ? String(it.fiscal_month).padStart(2, '0') : '';
  const period = it.fiscal_year && fm ? it.fiscal_year + '-' + fm : '';
  const occur = period ? (period + '-' + String(_lastDay(it.fiscal_year, it.fiscal_month)).padStart(2, '0')) : '';
  const amt = toNum(it.credit_amount_month) || toNum(it.credit_amount_year);
  return {
    expense_code: 'OA-SB-' + it.id,
    expense_name: (it.subject_name || '未命名科目') + (it.item_name ? ' (' + it.item_name + ')' : ''),
    expense_category: it.subject_category || it.subject_name || '',
    expense_type: it.subject_code || '',
    project: it.item_name || '',
    occur_date: occur, account_period: period, amount: amt,
    payment_status: '已付', currency: 'CNY',
    remarks: '科目编码:' + (it.subject_code || '') + (it.subject_category ? ' [' + it.subject_category + ']' : ''),
    source: '外部API'
  };
}

// 供应商付款 → 费用记录（按发票明细展开）
function _mapSp(it) {
  const out = [];
  (it.invoices || []).forEach(inv => {
    const invDate = inv.invoice_date || it.invoice_date || '';
    const period = invDate ? invDate.substring(0, 7) : (it.payment_month || it.schedule_month || '');
    const invAmt = toNum(inv.invoice_amount);
    const paid = toNum(inv.paid_amount);
    const ps = invAmt > 0 ? (paid >= invAmt ? '已付' : (paid > 0 ? '部分付款' : '未付')) : '未付';
    out.push({
      expense_code: 'OA-SP-' + (inv.invoice_no || (it.supplier_code + '-' + (inv.line_no || '0'))),
      expense_name: (it.supplier_name || '供应商') + ' 货款' + (inv.invoice_no ? '(' + inv.invoice_no + ')' : ''),
      expense_category: '采购货款', supplier: it.supplier_name || '',
      occur_date: invDate, account_period: period, amount: invAmt,
      payment_method: it.payment_method || '', payment_status: ps, invoice_no: inv.invoice_no || '',
      currency: 'CNY', remarks: '供应商编码:' + (it.supplier_code || ''), source: '外部API'
    });
  });
  return out;
}

router.get('/external/config', requirePerm('expense:view'), (req, res) => res.json(loadExternalConfig()));
router.put('/external/config', requirePerm('expense:edit'), (req, res) => {
  const cur = loadExternalConfig();
  const next = Object.assign({}, cur, req.body || {});
  try {
    const file = path.join(__dirname, '..', '..', 'database', 'expense_external_config.json');
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    res.json({ message: '外部对接配置已保存', data: next });
  } catch (e) { res.status(500).json({ error: '保存失败: ' + e.message }); }
});

// 测试连接：分别测 health.ping 与科目余额接口，返回详细诊断
router.post('/external/test', requirePerm('expense:view'), async (req, res) => {
  const cfg = Object.assign({}, loadExternalConfig(), req.body || {});
  if (!cfg.base_url || !cfg.app_key || !cfg.app_secret) return res.status(400).json({ ok: false, error: '请先填写 base_url / AppKey / AppSecret' });
  const mk = (m) => { const o = { ok: m.ok }; if (m.ok && m.extra) o.extra = m.extra; if (!m.ok) o.error = m.err; return o; };
  // 1) health.ping
  let ping = { ok: false };
  try { await _callSigned(cfg, 'int:health.ping', '/api/v1/common/ping', {}); ping.ok = true; }
  catch (e) { ping.err = e.message; }
  // 2) 科目余额（实际同步用的接口，拉1条）
  let sb = { ok: false };
  try {
    const r = await _callSigned(cfg, cfg.sb_endpoint, cfg.sb_path, { page: 1, page_size: 1 });
    const d = r.data || r;
    sb.ok = true; sb.extra = 'total=' + (d.total != null ? d.total : (d.items || []).length);
  } catch (e) { sb.err = e.message; }
  const ok = sb.ok;
  let hint = '';
  const allErr = (sb.err || '') + ' ' + (ping.err || '');
  if (/HTTP 401/.test(allErr)) hint = 'AppKey/AppSecret 无效，或该接口未在 API Key 里授权（到 OA「API Key 管理」勾选 subject_balances / int:health.ping）';
  else if (/HTTP 403/.test(allErr)) hint = '签名不匹配 / 时间戳超时 / IP 不在白名单。检查：服务器时间是否准、AppSecret 是否完整复制、IP 白名单是否含本机';
  else if (/HTTP 404/.test(allErr)) hint = '接口路径或 endpoint_code 不对（subject_balances 需在 OA 注册为 @exposable）';
  else if (/ENOTFOUND|ECONNREFUSED|请求超时/.test(allErr)) hint = '网络不通：确认 base_url 端口（API=18084，非 swagger 的 18085）、服务是否可达';
  res.json({ ok, ping: mk(ping), subject_balances: mk(sb), hint });
});

// 同步外部数据
router.post('/sync-from-external', requirePerm('expense:create'), async (req, res) => {
  const cfg = loadExternalConfig();
  if (!cfg.enabled || !cfg.base_url) return res.status(400).json({ error: '外部对接未启用，请先在「外部对接」页配置并启用' });
  if (!cfg.app_key || !cfg.app_secret) return res.status(400).json({ error: '缺少 AppKey/AppSecret' });
  const sources = Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : ['subject_balances', 'supplier_payment'];
  const table = getTable('expenses');
  table._invalidate();
  const ts = now();
  const result = { subject_balances: { added: 0, updated: 0, skipped: 0, total: 0 }, supplier_payment: { added: 0, updated: 0, skipped: 0, total: 0 }, errors: [] };

  async function upsert(rec) {
    if (!rec.expense_name && !rec.expense_code) return 'skip';
    const r = normalizeRecord(rec);
    const exist = r.expense_code ? table.all().find(x => x.expense_code === r.expense_code) : null;
    if (exist) { await table.update(exist.id, Object.assign({}, r, { updated_at: ts })); return 'upd'; }
    await table.insert(Object.assign({}, r, { created_at: ts, updated_at: ts })); return 'add';
  }

  if (sources.indexOf('subject_balances') >= 0) {
    try {
      const params = {};
      if (cfg.sb_subject_category) params.subject_category = cfg.sb_subject_category;
      if (cfg.sb_fiscal_year) params.fiscal_year = cfg.sb_fiscal_year;
      if (cfg.sb_fiscal_month) params.fiscal_month = cfg.sb_fiscal_month;
      const list = await _fetchAll(cfg, cfg.sb_endpoint, cfg.sb_path, params);
      result.subject_balances.total = list.length;
      for (const it of list) {
        const k = await upsert(_mapSb(it));
        if (k === 'add') result.subject_balances.added++; else if (k === 'upd') result.subject_balances.updated++; else result.subject_balances.skipped++;
      }
    } catch (e) { result.errors.push('科目余额: ' + e.message); }
  }
  if (sources.indexOf('supplier_payment') >= 0) {
    try {
      const params = {};
      if (cfg.sp_payment_month) params.payment_month = cfg.sp_payment_month;
      if (cfg.sp_supplier_name) params.supplier_name = cfg.sp_supplier_name;
      const list = await _fetchAll(cfg, cfg.sp_endpoint, cfg.sp_path, params);
      result.supplier_payment.total = list.length;
      for (const it of list) {
        for (const rec of _mapSp(it)) {
          const k = await upsert(rec);
          if (k === 'add') result.supplier_payment.added++; else if (k === 'upd') result.supplier_payment.updated++; else result.supplier_payment.skipped++;
        }
      }
    } catch (e) { result.errors.push('供应商付款: ' + e.message); }
  }
  const added = result.subject_balances.added + result.supplier_payment.added;
  const updated = result.subject_balances.updated + result.supplier_payment.updated;
  res.json(Object.assign({
    message: '同步完成：新增 ' + added + '，更新 ' + updated + (result.errors.length ? '（部分失败：' + result.errors.join('；') + '）' : ''),
    added, updated
  }, result));
});

// ===== CRUD =====
router.post('/', requirePerm('expense:create'), async (req, res) => {
  const body = req.body || {};
  if (!body.expense_name) return res.status(400).json({ error: '费用名称为必填项' });
  const rec = normalizeRecord(body);
  const table = getTable('expenses');
  if (rec.expense_code) {
    const dup = table.all().find(r => r.expense_code === rec.expense_code);
    if (dup) return res.status(400).json({ error: '费用编码已存在', data: dup });
  } else {
    rec.expense_code = genExpenseCode(table, rec.account_period);
  }
  const ts = now();
  const result = await table.insert(Object.assign({}, rec, { created_at: ts, updated_at: ts }));
  res.json({ message: '费用记录创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('expense:edit'), async (req, res) => {
  const table = getTable('expenses');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '费用记录不存在' });
  const rec = normalizeRecord(Object.assign({}, existing, req.body));
  if (rec.expense_code && rec.expense_code !== existing.expense_code) {
    const dup = table.all().find(r => r.expense_code === rec.expense_code && r.id !== existing.id);
    if (dup) return res.status(400).json({ error: '费用编码已存在' });
  }
  const fields = { updated_at: now() };
  STR_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = rec[f]; });
  NUM_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = rec[f]; });
  // 金额相关联动：金额/税率/税额/价税合计任一变化时重算（忽略 existing 中的旧税额/旧合计）
  const amtChanged = ['amount', 'tax_rate', 'tax_amount', 'total_amount'].some(f => req.body[f] !== undefined);
  if (amtChanged) {
    const amount = rec.amount;
    const taxRate = rec.tax_rate;
    const taxAmount = req.body.tax_amount !== undefined ? rec.tax_amount : Math.round(amount * taxRate / 100 * 100) / 100;
    const totalAmount = req.body.total_amount !== undefined ? rec.total_amount : Math.round((amount + taxAmount) * 100) / 100;
    fields.amount = amount; fields.tax_rate = taxRate;
    fields.tax_amount = taxAmount; fields.total_amount = totalAmount;
  }
  // 发生日期变化且未单独改账期 → 重推账期
  if (req.body.occur_date !== undefined && req.body.account_period === undefined) {
    fields.account_period = derivePeriod(rec.occur_date);
  }
  await table.update(req.params.id, fields);
  res.json({ message: '费用记录更新成功', data: table.findById(req.params.id) });
});

// 批量更新（支持表格内联编辑）
router.post('/batch-update', requirePerm('expense:edit'), async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items必须为数组' });
  const table = getTable('expenses');
  const ts = now();
  let updated = 0, skipped = 0;
  for (const item of items) {
    const ex = table.findById(item.id);
    if (!ex) { skipped++; return; }
    const rec = normalizeRecord(Object.assign({}, ex, item));
    const fields = { updated_at: ts };
    STR_FIELDS.forEach(f => { if (item[f] !== undefined) fields[f] = rec[f]; });
    NUM_FIELDS.forEach(f => { if (item[f] !== undefined) fields[f] = rec[f]; });
    if (['amount', 'tax_rate', 'tax_amount', 'total_amount'].some(f => item[f] !== undefined)) {
      const amount = rec.amount;
      const taxRate = rec.tax_rate;
      const taxAmount = item.tax_amount !== undefined ? rec.tax_amount : Math.round(amount * taxRate / 100 * 100) / 100;
      const totalAmount = item.total_amount !== undefined ? rec.total_amount : Math.round((amount + taxAmount) * 100) / 100;
      fields.amount = amount; fields.tax_rate = taxRate;
      fields.tax_amount = taxAmount; fields.total_amount = totalAmount;
    }
    if (item.occur_date !== undefined && item.account_period === undefined) {
      fields.account_period = derivePeriod(rec.occur_date);
    }
    await table.update(item.id, fields);
    updated++;
  }
  res.json({ message: '批量更新成功', updated, skipped });
});

router.post('/batch-delete', requirePerm('expense:delete'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids必须为非空数组' });
  const table = getTable('expenses');
  let deleted = 0; const notFound = [];
  for (const id of ids) {
    if (!table.findById(id)) { notFound.push(id); continue; }
    await table.delete(id); deleted++;
  }
  res.json({ message: '批量删除完成', deleted, not_found: notFound });
});

router.delete('/:id', requirePerm('expense:delete'), async (req, res) => {
  const table = getTable('expenses');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '费用记录不存在' });
  await table.delete(req.params.id);
  res.json({ message: '费用记录删除成功' });
});

module.exports = router;
