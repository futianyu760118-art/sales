/**
 * 人工库（经营中心）
 * ------------------------------------------------------------------
 * 汇集企业全部人工支出明细：计时 / 计件 / 月薪 / 外包 / 临时，含社保公积金等
 * 数据来源：手工录入 / Excel 导入 / 外部 API 对接
 * 提供人工成本分析（按类型、部门、月份、项目等多维度）
 * 设计对标「物料库」与「费用库」模式
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('labor');

// ===== 常量 =====
const NUM_FIELDS = [
  'hours', 'overtime_hours', 'pieces', 'unit_price', 'base_amount',
  'overtime_pay', 'subsidy', 'bonus', 'social_insurance', 'housing_fund',
  'total_amount', 'amiba_id'
];
const STR_FIELDS = [
  'labor_code', 'employee_name', 'employee_no', 'department', 'position',
  'labor_type', 'work_date', 'work_month', 'project', 'source', 'remarks'
];
const ALLOWED_SORT = [
  'id', 'labor_code', 'employee_name', 'employee_no', 'department', 'position',
  'labor_type', 'work_date', 'work_month', 'hours', 'pieces', 'unit_price',
  'base_amount', 'total_amount', 'source', 'created_at'
];

const LABOR_TYPES = ['计时', '计件', '月薪', '外包', '临时'];
const SOURCES = ['手工录入', 'Excel导入', '外部API'];

// ===== 工具函数 =====
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}

function deriveMonth(workDate) {
  if (!workDate) return '';
  const s = String(workDate).replace('/', '-').substring(0, 10);
  return s.length >= 7 ? s.substring(0, 7) : '';
}

// 计算合计人工支出（按类型）
// 计时：单价×工时 + 加班费 + 补贴 + 奖金 + 社保 + 公积金
// 计件：单价×件数 + 补贴 + 奖金 + 社保 + 公积金
// 月薪/外包/临时：基本工资 + 加班费 + 补贴 + 奖金 + 社保 + 公积金
function computeTotal(r) {
  const unitPrice = toNum(r.unit_price);
  const hours = toNum(r.hours);
  const pieces = toNum(r.pieces);
  const base = toNum(r.base_amount);
  let core = 0;
  const lt = r.labor_type || '';
  if (lt === '计时') core = unitPrice * hours;
  else if (lt === '计件') core = unitPrice * pieces;
  else core = base; // 月薪/外包/临时
  const total = core
    + toNum(r.overtime_pay)
    + toNum(r.subsidy)
    + toNum(r.bonus)
    + toNum(r.social_insurance)
    + toNum(r.housing_fund);
  return Math.round(total * 100) / 100;
}

function normalizeRecord(r) {
  const rec = Object.assign({}, r);
  rec.unit_price = toNum(rec.unit_price);
  rec.hours = toNum(rec.hours);
  rec.pieces = toNum(rec.pieces);
  rec.base_amount = toNum(rec.base_amount);
  rec.overtime_hours = toNum(rec.overtime_hours);
  rec.overtime_pay = toNum(rec.overtime_pay);
  rec.subsidy = toNum(rec.subsidy);
  rec.bonus = toNum(rec.bonus);
  rec.social_insurance = toNum(rec.social_insurance);
  rec.housing_fund = toNum(rec.housing_fund);
  rec.total_amount = (rec.total_amount !== undefined && rec.total_amount !== '' && !(rec._auto_total === false))
    ? toNum(rec.total_amount) : computeTotal(rec);
  // 若未显式提供合计，则自动计算
  if (r.total_amount === undefined || r.total_amount === '') rec.total_amount = computeTotal(rec);
  rec.work_month = rec.work_month || deriveMonth(rec.work_date);
  rec.source = rec.source || '手工录入';
  rec.labor_type = rec.labor_type || '月薪';
  rec.remarks = rec.remarks || '';
  return rec;
}

// 人工编码自动生成：LR + 年月(YYYYMM) + - + 4位流水号，如 LR202607-0001
function genLaborCode(table, month) {
  const ym = (month || now().substring(0, 7)).replace('-', '');
  const prefix = 'LR' + ym;
  let maxSeq = 0;
  table.all().forEach(r => {
    const code = (r.labor_code || '').trim();
    if (code.startsWith(prefix + '-')) {
      const seq = parseInt(code.substring(prefix.length + 1), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return prefix + '-' + String(maxSeq + 1).padStart(4, '0');
}

// ===== 列表 =====
router.get('/', requirePerm('labor:view'), (req, res) => {
  const { page = 1, limit = 20, keyword, labor_type, department, project,
          employee_name, source, work_month, work_from, work_to,
          amount_min, amount_max, sort_by, sort_order } = req.query;
  const table = getTable('labor');
  const filter = (r) => {
    if (labor_type && r.labor_type !== labor_type) return false;
    if (department && r.department !== department) return false;
    if (project && !(r.project || '').includes(project)) return false;
    if (employee_name && !(r.employee_name || '').includes(employee_name)) return false;
    if (source && r.source !== source) return false;
    if (work_month && r.work_month !== work_month) return false;
    if (work_from && (r.work_date || '') < work_from) return false;
    if (work_to && (r.work_date || '') > work_to) return false;
    if (amount_min !== undefined && amount_min !== '' && toNum(r.total_amount) < toNum(amount_min)) return false;
    if (amount_max !== undefined && amount_max !== '' && toNum(r.total_amount) > toNum(amount_max)) return false;
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      const hay = [r.labor_code, r.employee_name, r.employee_no, r.department, r.position,
        r.labor_type, r.project, r.remarks].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  };
  const orderBy = ALLOWED_SORT.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && String(sort_order).toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/meta/filter-options', requirePerm('labor:view'), (req, res) => {
  const table = getTable('labor');
  table._invalidate();
  const all = table.all();
  const uniq = key => [...new Set(all.map(r => r[key]).filter(v => v !== undefined && v !== null && String(v).trim() !== ''))];
  res.json({
    labor_types: uniq('labor_type'),
    departments: uniq('department'),
    positions: uniq('position'),
    projects: uniq('project'),
    employees: uniq('employee_name'),
    sources: uniq('source'),
    work_months: uniq('work_month').sort().reverse(),
    standard_labor_types: LABOR_TYPES,
    standard_sources: SOURCES
  });
});

// ===== 仪表盘 / 人工成本分析 =====
function parseStatsFilter(q) {
  const month = String(q.work_month || '').trim();
  const laborType = String(q.labor_type || '').trim();
  const department = String(q.department || '').trim();
  const source = String(q.source || '').trim();
  const workFrom = String(q.work_from || '').trim();
  const workTo = String(q.work_to || '').trim();
  return (r) => {
    if (month && r.work_month !== month) return false;
    if (laborType && r.labor_type !== laborType) return false;
    if (department && r.department !== department) return false;
    if (source && r.source !== source) return false;
    if (workFrom && (r.work_date || '') < workFrom) return false;
    if (workTo && (r.work_date || '') > workTo) return false;
    return true;
  };
}

router.get('/dashboard/stats', requirePerm('labor:view'), (req, res) => {
  const table = getTable('labor');
  table._invalidate();
  const f = parseStatsFilter(req.query);
  const all = table.all().filter(f);

  let totalCost = 0, totalHours = 0, totalOvertimeHours = 0, totalPieces = 0;
  let totalBase = 0, totalOvertime = 0, totalSubsidy = 0, totalBonus = 0;
  let totalSocial = 0, totalFund = 0;
  const byType = {}, byDepartment = {}, byMonth = {}, byProject = {}, bySource = {}, byEmployee = {};
  const employeeSet = new Set();

  all.forEach(r => {
    const tot = toNum(r.total_amount);
    totalCost += tot;
    totalHours += toNum(r.hours);
    totalOvertimeHours += toNum(r.overtime_hours);
    totalPieces += toNum(r.pieces);
    totalBase += toNum(r.base_amount);
    totalOvertime += toNum(r.overtime_pay);
    totalSubsidy += toNum(r.subsidy);
    totalBonus += toNum(r.bonus);
    totalSocial += toNum(r.social_insurance);
    totalFund += toNum(r.housing_fund);
    const lt = r.labor_type || '未分类';
    byType[lt] = (byType[lt] || 0) + tot;
    const dep = r.department || '未分配';
    byDepartment[dep] = (byDepartment[dep] || 0) + tot;
    const mon = r.work_month || deriveMonth(r.work_date) || '未知';
    byMonth[mon] = (byMonth[mon] || 0) + tot;
    const proj = r.project || '无项目';
    byProject[proj] = (byProject[proj] || 0) + tot;
    const src = r.source || '未知';
    bySource[src] = (bySource[src] || 0) + 1;
    if (r.employee_name) {
      employeeSet.add(r.employee_name);
      byEmployee[r.employee_name] = (byEmployee[r.employee_name] || 0) + tot;
    }
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
    headcount: employeeSet.size,
    total_cost: Math.round(totalCost * 100) / 100,
    total_hours: Math.round(totalHours * 100) / 100,
    total_overtime_hours: Math.round(totalOvertimeHours * 100) / 100,
    total_pieces: Math.round(totalPieces * 100) / 100,
    total_base: Math.round(totalBase * 100) / 100,
    total_overtime_pay: Math.round(totalOvertime * 100) / 100,
    total_subsidy: Math.round(totalSubsidy * 100) / 100,
    total_bonus: Math.round(totalBonus * 100) / 100,
    total_social_insurance: Math.round(totalSocial * 100) / 100,
    total_housing_fund: Math.round(totalFund * 100) / 100,
    by_type: sortPairs(byType, 10),
    by_department: sortPairs(byDepartment, 15),
    by_month: trend,
    by_project: sortPairs(byProject, 15),
    by_source: sortPairs(bySource, 10),
    top_employees: sortPairs(byEmployee, 15),
    last_month: lastMonth, prev_month: prevMonth, mom_percent: mom,
    cost_per_hour: totalHours > 0 ? Math.round(totalCost / totalHours * 100) / 100 : 0
  });
});

// 数据质量检查
router.get('/quality-check', requirePerm('labor:view'), (req, res) => {
  const table = getTable('labor');
  table._invalidate();
  const all = table.all();
  const issues = [];
  const sevOrder = { severe: 0, warning: 1, info: 2 };
  const codeCount = {};
  all.forEach(r => { const c = (r.labor_code || '').trim(); if (c) codeCount[c] = (codeCount[c] || 0) + 1; });
  all.forEach(r => {
    const push = (type, severity, message) => issues.push({
      id: r.id, labor_code: r.labor_code || '', employee_name: r.employee_name || '', type, severity, message
    });
    if (!r.employee_name) push('empty_employee', 'severe', '员工姓名为空');
    if (!r.work_date) push('empty_date', 'severe', '工作日期为空');
    if (r.labor_code && codeCount[r.labor_code] > 1) push('dup_code', 'severe', `人工编码重复(共${codeCount[r.labor_code]}条)`);
    if (!r.labor_type) push('no_type', 'warning', '未设置人工类型');
    if (!r.department) push('no_dept', 'warning', '未设置部门');
    if (r.labor_type === '计时' && toNum(r.hours) <= 0) push('time_no_hours', 'warning', '计时类型但工时为0');
    if (r.labor_type === '计件' && toNum(r.pieces) <= 0) push('piece_no_qty', 'warning', '计件类型但件数为0');
    if (toNum(r.total_amount) <= 0) push('zero_total', 'warning', '合计金额为0');
    if (!r.work_month) push('no_month', 'info', '未归属月份');
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
router.get('/export/csv', requirePerm('labor:view'), (req, res) => {
  const table = getTable('labor');
  table._invalidate();
  const f = parseStatsFilter(req.query);
  const rows = table.all().filter(f).sort((a, b) => (b.work_date || '').localeCompare(a.work_date || ''));
  const headers = ['人工编码', '员工姓名', '工号', '部门', '岗位', '人工类型', '工作日期', '归属月份',
    '工时', '加班工时', '件数', '单价', '基本工资', '加班费', '补贴', '奖金/绩效', '社保', '公积金',
    '合计金额', '关联项目', '数据来源', '备注'];
  const data = rows.map(r => [
    r.labor_code, r.employee_name, r.employee_no, r.department, r.position, r.labor_type, r.work_date, r.work_month,
    toNum(r.hours), toNum(r.overtime_hours), toNum(r.pieces), toNum(r.unit_price), toNum(r.base_amount),
    toNum(r.overtime_pay), toNum(r.subsidy), toNum(r.bonus), toNum(r.social_insurance), toNum(r.housing_fund),
    toNum(r.total_amount), r.project, r.source, r.remarks
  ].map(v => String(v == null ? '' : v).replace(/,/g, '，')));
  let csv = headers.join(',') + '\n';
  data.forEach(r => csv += r.join(',') + '\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=labor.csv');
  res.send('\uFEFF' + csv);
});

// 单条详情（放在所有具名单段路径之后，避免 /:id 抢占 /quality-check 等）
router.get('/:id', requirePerm('labor:view'), (req, res) => {
  const table = getTable('labor');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '人工记录不存在' });
  res.json(row);
});

// ===== 外部 API 对接（可配置，缺失时优雅降级）=====
function loadExternalConfig() {
  try {
    const file = path.join(__dirname, '..', '..', 'database', 'labor_external_config.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return { enabled: false, base_url: '', app_key: '', app_secret: '', endpoint_code: 'labor.list' };
}
router.get('/external/config', requirePerm('labor:view'), (req, res) => res.json(loadExternalConfig()));
router.put('/external/config', requirePerm('labor:edit'), (req, res) => {
  const cur = loadExternalConfig();
  const next = Object.assign({}, cur, req.body || {});
  try {
    const file = path.join(__dirname, '..', '..', 'database', 'labor_external_config.json');
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    res.json({ message: '外部对接配置已保存', data: next });
  } catch (e) { res.status(500).json({ error: '保存失败: ' + e.message }); }
});

router.post('/sync-from-external', requirePerm('labor:create'), async (req, res) => {
  const cfg = loadExternalConfig();
  if (!cfg.enabled || !cfg.base_url) {
    return res.status(400).json({ error: '外部对接未启用，请先在「外部对接」配置 base_url 并启用' });
  }
  let remote;
  try { remote = await callExternalLabor(cfg); }
  catch (e) { return res.status(502).json({ error: '外部API调用失败: ' + e.message }); }
  const list = Array.isArray(remote) ? remote : (remote.records || remote.data || remote.list || []);
  const table = getTable('labor');
  table._invalidate();
  const ts = now();
  let added = 0, updated = 0, skipped = 0;
  for (const item of list) {
    const rec = normalizeRecord({
      labor_code: item.labor_code || item.code || '',
      employee_name: item.employee_name || item.name || '',
      employee_no: item.employee_no || item.no || '',
      department: item.department || '',
      position: item.position || '',
      labor_type: item.labor_type || item.type || '月薪',
      work_date: item.work_date || item.date || '',
      work_month: item.work_month || item.month || '',
      hours: item.hours || 0,
      overtime_hours: item.overtime_hours || 0,
      pieces: item.pieces || 0,
      unit_price: item.unit_price || 0,
      base_amount: item.base_amount || 0,
      overtime_pay: item.overtime_pay || 0,
      subsidy: item.subsidy || 0,
      bonus: item.bonus || 0,
      social_insurance: item.social_insurance || 0,
      housing_fund: item.housing_fund || 0,
      total_amount: item.total_amount || 0,
      project: item.project || '',
      remarks: item.remarks || '',
      source: '外部API'
    });
    if (!rec.employee_name) { skipped++; continue; }
    const code = rec.labor_code;
    const exist = code ? table.all().find(r => r.labor_code === code) : null;
    if (exist) {
      await table.update(exist.id, Object.assign({}, rec, { updated_at: ts }));
      updated++;
    } else {
      await table.insert(Object.assign({}, rec, { created_at: ts, updated_at: ts }));
      added++;
    }
  }
  res.json({ message: '外部API同步完成', added, updated, skipped, total: list.length });
});

function callExternalLabor(cfg) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const https = require('https');
    const http = require('http');
    const url = new URL(cfg.base_url);
    const isHttps = url.protocol === 'https:';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = timestamp + (cfg.app_key || '') + (cfg.endpoint_code || 'labor.list');
    const signature = cfg.app_secret ? crypto.createHmac('sha256', cfg.app_secret).update(stringToSign, 'utf8').digest('hex') : '';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers: Object.assign({ 'X-Timestamp': timestamp }, cfg.app_key ? { 'X-App-Key': cfg.app_key } : {}, signature ? { 'X-Signature': signature } : {}),
      timeout: 30000,
      ...(isHttps ? { rejectUnauthorized: false } : {})  // 容忍自签证书
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

// ===== CRUD =====
router.post('/', requirePerm('labor:create'), async (req, res) => {
  const body = req.body || {};
  if (!body.employee_name) return res.status(400).json({ error: '员工姓名为必填项' });
  const rec = normalizeRecord(body);
  const table = getTable('labor');
  if (rec.labor_code) {
    const dup = table.all().find(r => r.labor_code === rec.labor_code);
    if (dup) return res.status(400).json({ error: '人工编码已存在', data: dup });
  } else {
    rec.labor_code = genLaborCode(table, rec.work_month);
  }
  const ts = now();
  const result = await table.insert(Object.assign({}, rec, { created_at: ts, updated_at: ts }));
  res.json({ message: '人工记录创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('labor:edit'), async (req, res) => {
  const table = getTable('labor');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '人工记录不存在' });
  const rec = normalizeRecord(Object.assign({}, existing, req.body));
  if (rec.labor_code && rec.labor_code !== existing.labor_code) {
    const dup = table.all().find(r => r.labor_code === rec.labor_code && r.id !== existing.id);
    if (dup) return res.status(400).json({ error: '人工编码已存在' });
  }
  const fields = { updated_at: now() };
  STR_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = rec[f]; });
  NUM_FIELDS.forEach(f => { if (req.body[f] !== undefined) fields[f] = rec[f]; });
  // 任一金额/工时/件数变化 → 重算合计
  const costChanged = NUM_FIELDS.some(f => f !== 'total_amount' && req.body[f] !== undefined);
  if (costChanged) fields.total_amount = computeTotal(rec);
  if (req.body.work_date !== undefined && req.body.work_month === undefined) {
    fields.work_month = deriveMonth(rec.work_date);
  }
  await table.update(req.params.id, fields);
  res.json({ message: '人工记录更新成功', data: table.findById(req.params.id) });
});

router.post('/batch-update', requirePerm('labor:edit'), async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items必须为数组' });
  const table = getTable('labor');
  const ts = now();
  let updated = 0, skipped = 0;
  for (const item of items) {
    const ex = table.findById(item.id);
    if (!ex) { skipped++; continue; }
    const rec = normalizeRecord(Object.assign({}, ex, item));
    const fields = { updated_at: ts };
    STR_FIELDS.forEach(f => { if (item[f] !== undefined) fields[f] = rec[f]; });
    NUM_FIELDS.forEach(f => { if (item[f] !== undefined) fields[f] = rec[f]; });
    if (NUM_FIELDS.some(f => f !== 'total_amount' && item[f] !== undefined)) {
      fields.total_amount = computeTotal(rec);
    }
    if (item.work_date !== undefined && item.work_month === undefined) {
      fields.work_month = deriveMonth(rec.work_date);
    }
    await table.update(item.id, fields);
    updated++;
  }
  res.json({ message: '批量更新成功', updated, skipped });
});

router.post('/batch-delete', requirePerm('labor:delete'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids必须为非空数组' });
  const table = getTable('labor');
  let deleted = 0; const notFound = [];
  for (const id of ids) {
    if (!table.findById(id)) { notFound.push(id); continue; }
    await table.delete(id); deleted++;
  }
  res.json({ message: '批量删除完成', deleted, not_found: notFound });
});

router.delete('/:id', requirePerm('labor:delete'), async (req, res) => {
  const table = getTable('labor');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '人工记录不存在' });
  await table.delete(req.params.id);
  res.json({ message: '人工记录删除成功' });
});

module.exports = router;
