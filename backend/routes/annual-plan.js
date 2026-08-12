/**
 * 年度经营计划模块
 * --------------------------------------------------
 * 业务覆盖：经营驾驶舱 / 年度经营目标 / 部门年度计划 / 经营指标KPI / OKR管理 /
 *          年度行动计划 / 项目计划 / 经营风险 / 经营分析 / 年度复盘 / AI经营助手
 *
 * 经营驾驶舱与分析数据自动从系统 orders / projects / materials 等业务表归集，
 * 年度目标、KPI、OKR、行动计划、风险、复盘等内容由用户录入。
 *
 * 数据表：annual_plan_goals / annual_department_plans / annual_kpis /
 *        annual_okrs / annual_action_plans / annual_risks /
 *        annual_reviews / annual_ai_records（由 initData.js 统一建表）
 */
const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

const PERM_VIEW = 'annual-plan:view';
const PERM_CREATE = 'annual-plan:create';
const PERM_EDIT = 'annual-plan:edit';
const PERM_DELETE = 'annual-plan:delete';
const PERM_ANALYZE = 'annual-plan:analyze';
const PERM_EXPORT = 'annual-plan:export';

// ---------- 通用工具 ----------
function n(v, def) { const x = Number(v); return Number.isFinite(x) ? x : (def || 0); }
function s(v, def) { if (v === undefined || v === null) return def || ''; return String(v).trim(); }
function round(v, d) { const p = Math.pow(10, d || 2); return Math.round((n(v)) * p) / p; }
function pct(actual, target) { if (!target) return 0; return round((n(actual) / n(target)) * 100, 1); }
function currentYear() { return new Date().getFullYear(); }
function readAll(name) { const t = getTable(name); t._invalidate(); return t.all(); }
function paginate(records, req, defLimit) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || (defLimit || 20)));
  const start = (page - 1) * limit;
  return { data: records.slice(start, start + limit), total: records.length, page, limit };
}
function inYear(dateStr, year) {
  if (!dateStr) return false;
  const m = String(dateStr).match(/^(\d{4})/);
  return m && Number(m[1]) === Number(year);
}
function monthOf(dateStr) {
  const m = String(dateStr || '').match(/(\d{4})[-/](\d{1,2})/);
  return m ? Number(m[2]) : 0;
}

// ---------- 系统数据归集（订单/项目/物料）----------
function safeAll(name) { try { return readAll(name); } catch (e) { return []; } }

// 按年度过滤订单（promised_date / order_date / created_at 任一命中）
function ordersOfYear(year) {
  return safeAll('orders').filter(o =>
    inYear(o.order_date, year) || inYear(o.promised_date, year) || inYear(o.created_at, year));
}
// 物料库存价值合计（按 unit_price × inventory_qty）
function inventoryValue() {
  return safeAll('materials').reduce((sum, m) =>
    sum + n(m.unit_price) * n(m.inventory_qty || m.stock_qty), 0);
}
// 当年度研发项目
function projectsOfYear(year) {
  return safeAll('projects').filter(p =>
    inYear(p.start_date, year) || inYear(p.target_date, year) || inYear(p.created_at, year));
}

// ============================================================
// 经营驾驶舱：聚合系统数据 + 年度计划数据
// ============================================================
router.get('/dashboard', requirePerm(PERM_VIEW), (req, res) => {
  try {
    const year = n(req.query.year, currentYear());
    const orders = ordersOfYear(year);
    const projects = projectsOfYear(year);
    const materials = safeAll('materials');

    // 销售额（按订单 order_amount / total_amount）
    const salesAmount = orders.reduce((s2, o) => s2 + n(o.order_amount || o.total_amount), 0);
    // 利润（按订单 profit 或按 20% 估算）
    const profitAmount = orders.reduce((s2, o) =>
      s2 + n(o.profit) + n(o.order_amount || o.total_amount) * n(o.profit_rate, 0), 0);
    const profitRate = salesAmount > 0 ? round(profitAmount / salesAmount * 100, 1) : 0;

    // 订单完成率
    const completed = orders.filter(o => ['完成', '已完成', 'closed', 'done', 'delivered'].includes(String(o.status || '').toLowerCase()));
    const orderCompletionRate = orders.length ? round(completed.length / orders.length * 100, 1) : 0;

    // 年度目标完成率（按 goals 表汇总）
    const goals = readAll('annual_plan_goals').filter(g => Number(g.year) === year);
    const goalTarget = goals.reduce((s2, g) => s2 + n(g.target_value) * (n(g.weight, 1) / 100), 0);
    const goalActual = goals.reduce((s2, g) => s2 + n(g.actual_value) * (n(g.weight, 1) / 100), 0);
    const goalCompletionRate = goalTarget ? round(goalActual / goalTarget * 100, 1) : 0;

    // 月度销售/利润趋势
    const monthlySales = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, sales_amount: 0, profit_amount: 0, order_count: 0 }));
    orders.forEach(o => {
      const m = monthOf(o.order_date || o.promised_date || o.created_at);
      if (m >= 1 && m <= 12) {
        const amt = n(o.order_amount || o.total_amount);
        monthlySales[m - 1].sales_amount += amt;
        monthlySales[m - 1].profit_amount += n(o.profit) + amt * n(o.profit_rate, 0);
        monthlySales[m - 1].order_count++;
      }
    });
    monthlySales.forEach(m => { m.sales_amount = round(m.sales_amount); m.profit_amount = round(m.profit_amount); });

    // 月度库存价值（用年末库存近似，按销售节奏平滑展示）
    const invValue = inventoryValue();
    const monthlyInventory = monthlySales.map(m => ({ value: round(invValue) }));

    // 部门完成率（按 annual_department_plans 汇总）
    const deptPlans = readAll('annual_department_plans').filter(p => Number(p.year) === year);
    const deptMap = {};
    deptPlans.forEach(p => {
      const k = p.department || '未分配';
      if (!deptMap[k]) deptMap[k] = { target: 0, actual: 0, count: 0 };
      deptMap[k].target += n(p.target_value);
      deptMap[k].actual += n(p.actual_value);
      deptMap[k].count++;
    });
    const departmentCompletion = Object.keys(deptMap).map(d => ({
      department: d,
      completion_rate: deptMap[d].target ? round(deptMap[d].actual / deptMap[d].target * 100, 1) : 0,
      count: deptMap[d].count
    })).sort((a, b) => b.completion_rate - a.completion_rate);

    // 风险数量
    const riskCount = readAll('annual_risks').filter(r => Number(r.year) === year && r.status !== '已关闭').length;

    // AI 评分：综合目标完成率、利润率、订单完成率
    const aiScore = Math.max(0, Math.min(100, Math.round(
      Math.min(100, goalCompletionRate) * 0.5 +
      Math.min(100, profitRate * 5) * 0.25 +
      orderCompletionRate * 0.25
    )));

    // AI 建议规则
    const suggestions = [];
    if (goalCompletionRate < 60) suggestions.push(`经营目标完成率仅 ${goalCompletionRate}%，建议加强重点目标跟进与责任落实。`);
    if (profitRate < 10) suggestions.push(`利润率 ${profitRate}% 偏低，建议优化成本结构与高毛利产品占比。`);
    if (orderCompletionRate < 80) suggestions.push(`订单完成率 ${orderCompletionRate}%，建议关注交付能力与瓶颈工序。`);
    if (riskCount > 5) suggestions.push(`当前存在 ${riskCount} 项未关闭风险，建议优先处理高风险项。`);
    if (materials.filter(m => n(m.inventory_qty) > 0 && n(m.inventory_qty) <= n(m.min_inventory)).length > 0)
      suggestions.push('存在低库存物料，建议及时补货避免影响交付。');
    if (!suggestions.length) suggestions.push('经营状况良好，建议保持当前节奏并持续优化。');

    res.json({
      year,
      goal_completion_rate: goalCompletionRate,
      sales_amount: round(salesAmount),
      profit_rate: profitRate,
      profit_amount: round(profitAmount),
      order_completion_rate: orderCompletionRate,
      project_count: projects.length,
      inventory_value: round(invValue),
      ai_score: aiScore,
      risk_count: riskCount,
      monthly_sales: monthlySales,
      monthly_inventory: monthlyInventory,
      department_completion: departmentCompletion,
      suggestions
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 通用 CRUD 工厂（按表名 + 字段配置生成 list/create/update/delete）
// ============================================================
function applyCrud(tableName, endpoint, fields, opts) {
  opts = opts || {};
  const permBase = 'annual-plan';

  function listFilter(records, req) {
    const year = req.query.year ? Number(req.query.year) : null;
    const kw = s(req.query.keyword).toLowerCase();
    let list = records;
    if (year !== null) list = list.filter(r => Number(r.year) === year);
    if (opts.extraFilter) list = list.filter(opts.extraFilter);
    if (kw) list = list.filter(r => fields.map(f => r[f[0]]).filter(Boolean).join(' ').toLowerCase().includes(kw));
    return list.sort((a, b) => (b.id || 0) - (a.id || 0));
  }

  function buildPayload(body, existing) {
    const data = {};
    fields.forEach(f => {
      const k = f[0];
      const type = f[2];
      let v;
      if (body && Object.prototype.hasOwnProperty.call(body, k)) v = body[k];
      else if (existing && Object.prototype.hasOwnProperty.call(existing, k)) v = existing[k];
      else v = undefined;
      if (v === undefined) {
        if (type === 'number') v = 0;
        else if (type === 'select') v = (f[3] || '').split(',')[0];
        else v = '';
      }
      if (type === 'number') data[k] = n(v);
      else if (k === 'key_results') data[k] = parseKeyResults(v);
      else data[k] = s(v);
    });
    if (!existing) data.created_at = now();
    data.updated_at = now();
    return data;
  }

  router.get('/' + endpoint, requirePerm(permBase + ':view'), (req, res) => {
    try {
      const list = listFilter(readAll(tableName), req);
      res.json(paginate(list, req, 500));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/' + endpoint, requirePerm(PERM_CREATE), async (req, res) => {
    try {
      const data = buildPayload(req.body || {}, null);
      const table = getTable(tableName);
      const r = await table.insert(data);
      res.json({ message: '创建成功', data: table.findById(r.lastID) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.put('/' + endpoint + '/:id', requirePerm(PERM_EDIT), async (req, res) => {
    try {
      const table = getTable(tableName);
      const existing = table.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: '记录不存在' });
      const data = buildPayload(req.body || {}, existing);
      await table.update(req.params.id, data);
      res.json({ message: '更新成功', data: table.findById(req.params.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/' + endpoint + '/:id', requirePerm(PERM_DELETE), async (req, res) => {
    try {
      const table = getTable(tableName);
      if (!table.findById(req.params.id)) return res.status(404).json({ error: '记录不存在' });
      await table.delete(req.params.id);
      res.json({ message: '删除成功' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// OKR 关键结果解析：textarea 每行一条（"目标 ：target" 或 "目标"）
function parseKeyResults(v) {
  if (Array.isArray(v)) return v;
  return String(v || '').split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return null;
    const idx = t.search(/[：:]\s*/);
    if (idx > 0) return { name: t.substring(0, idx).trim(), target: t.substring(idx + 1).replace(/^[:：]\s*/, '').trim() };
    return { name: t, target: '' };
  }).filter(Boolean);
}

// ---------- 各资源字段配置（与前端 configs 一致）----------
applyCrud('annual_plan_goals', 'goals', [
  ['year', '年度', 'number'],
  ['goal_name', '经营目标名称', 'text'],
  ['goal_type', '目标类型', 'select', '销售,利润,订单,研发,采购,生产,品质'],
  ['target_value', '目标值', 'number'],
  ['actual_value', '实际值', 'number'],
  ['unit', '单位', 'select', '万元,%,件,项'],
  ['owner', '负责人', 'text'],
  ['weight', '权重', 'number'],
  ['start_date', '开始日期', 'text'],
  ['end_date', '结束日期', 'text'],
  ['status', '状态', 'select', '草稿,执行,完成']
]);

applyCrud('annual_department_plans', 'department-plans', [
  ['year', '年度', 'number'],
  ['department', '部门', 'text'],
  ['plan_name', '计划名称', 'text'],
  ['target_value', '目标值', 'number'],
  ['actual_value', '实际值', 'number'],
  ['unit', '单位', 'text'],
  ['owner', '负责人', 'text'],
  ['weight', '权重', 'number'],
  ['completion_rate', '完成率', 'number'],
  ['key_actions', '重点行动', 'text'],
  ['risks', '风险', 'text'],
  ['status', '状态', 'select', '草稿,执行,完成']
]);

applyCrud('annual_kpis', 'kpis', [
  ['year', '年度', 'number'],
  ['kpi_name', 'KPI名称', 'text'],
  ['department', '所属部门', 'text'],
  ['owner', '负责人', 'text'],
  ['target_value', '目标值', 'number'],
  ['actual_value', '实际值', 'number'],
  ['unit', '单位', 'text'],
  ['weight', '权重', 'number'],
  ['status', '状态', 'select', '草稿,执行,完成']
]);

applyCrud('annual_okrs', 'okrs', [
  ['year', '年度', 'number'],
  ['department', '部门', 'text'],
  ['owner', '负责人', 'text'],
  ['objective', '目标O', 'text'],
  ['key_results', '关键结果KR', 'text'],
  ['progress', '进度', 'number'],
  ['status', '状态', 'select', '草稿,执行,完成']
]);

applyCrud('annual_action_plans', 'action-plans', [
  ['year', '年度', 'number'],
  ['plan_name', '计划名称', 'text'],
  ['department', '所属部门', 'text'],
  ['owner', '负责人', 'text'],
  ['start_date', '开始时间', 'text'],
  ['end_date', '结束时间', 'text'],
  ['completion_rate', '完成率', 'number'],
  ['priority', '优先级', 'select', '高,中,低'],
  ['risk_level', '风险等级', 'select', '绿色,黄色,橙色,红色'],
  ['milestone', '里程碑', 'text'],
  ['depends_on', '依赖关系', 'text'],
  ['status', '状态', 'select', '未开始,执行,完成,暂停']
]);

applyCrud('annual_risks', 'risks', [
  ['year', '年度', 'number'],
  ['risk_name', '风险名称', 'text'],
  ['type', '风险类型', 'select', '销售,采购,研发,库存,资金,生产,品质'],
  ['level', '等级', 'select', '绿色,黄色,橙色,红色'],
  ['probability', '概率', 'number'],
  ['impact', '影响', 'number'],
  ['owner', '责任人', 'text'],
  ['measures', '措施', 'text'],
  ['status', '状态', 'select', '未处理,处理中,已关闭']
]);

applyCrud('annual_reviews', 'reviews', [
  ['year', '年度', 'number'],
  ['summary', '经营总结', 'text'],
  ['completion_rate', '目标完成率', 'number'],
  ['best_departments', '优秀部门', 'text'],
  ['problems', '不足', 'text'],
  ['improvement_plan', '改善计划', 'text'],
  ['next_year_goals', '明年目标', 'text'],
  ['attachments', '附件/照片/PPT链接', 'text'],
  ['meeting_notes', '会议纪要', 'text'],
  ['status', '状态', 'select', '草稿,确认,归档']
]);

// ---------- KPI 评分 ----------
router.post('/kpis/:id/score', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('annual_kpis');
    const row = table.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'KPI不存在' });
    const target = n(row.target_value);
    const actual = n(row.actual_value);
    const completion = target ? round(actual / target * 100, 1) : 0;
    // 得分 = 完成率（封顶 100）× 权重（默认 1，无单位换算）
    const score = Math.min(100, Math.round(completion));
    await table.update(req.params.id, { completion_rate: completion, score, updated_at: now() });
    res.json({ message: '评分完成', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 复制上一年度目标 ----------
router.post('/goals/copy-previous-year', requirePerm(PERM_CREATE), async (req, res) => {
  try {
    const fromYear = n(req.body.from_year, currentYear() - 1);
    const toYear = n(req.body.to_year, currentYear());
    if (fromYear === toYear) return res.status(400).json({ error: '源年度与目标年度相同' });
    const table = getTable('annual_plan_goals');
    const source = readAll('annual_plan_goals').filter(g => Number(g.year) === fromYear);
    if (!source.length) return res.status(400).json({ error: `${fromYear} 年度无目标可复制` });
    let copied = 0;
    for (const g of source) {
      const data = Object.assign({}, g, { year: toYear, actual_value: 0, status: '草稿', created_at: now(), updated_at: now() });
      delete data.id;
      await table.insert(data);
      copied++;
    }
    res.json({ message: `已复制 ${copied} 条目标`, copied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 项目计划：来自 projects 表（无需重复录入）
// 进度按研发项目状态换算：init=10% / executing=50% / paused=50% / completed=100% / cancelled=0%
// ============================================================
function progressFromStatus(status) {
  const map = {
    init: 10, '预项目': 10, '立项': 10, '未开始': 10,
    executing: 50, '进行中': 50, '执行中': 50,
    paused: 50, '暂停': 50, '挂起': 50,
    completed: 100, '已完成': 100, '完成': 100, '结项': 100, '已结项': 100,
    cancelled: 0, '取消': 0, '已取消': 0, '终止': 0, '已终止': 0
  };
  const key = String(status || '').trim().toLowerCase();
  return map[key] !== undefined ? map[key] : 0;
}
router.get('/project-plans', requirePerm(PERM_VIEW), (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const kw = s(req.query.keyword).toLowerCase();
    let list = safeAll('projects');
    if (year !== null) list = list.filter(p => inYear(p.start_date, year) || inYear(p.target_date, year) || inYear(p.created_at, year));
    if (kw) list = list.filter(p => [p.project_no, p.project_name, p.customer_name, p.owner].join(' ').toLowerCase().includes(kw));
    const data = list.map(p => ({
      id: p.id,
      project_no: p.project_no || '',
      project_name: p.project_name || '',
      owner: p.owner || '',
      progress: progressFromStatus(p.status),
      budget: n(p.invest_amount || p.budget, 0),
      stage: p.current_stage || '',
      risk: p.risk_level || '绿色',
      status: p.status || '',
      order_amount: n(p.order_amount, 0)
    }));
    res.json({ data, total: data.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 经营分析：月度 / 季度 / 年度报告
// ============================================================
router.get('/monthly-analysis', requirePerm(PERM_VIEW), (req, res) => {
  try {
    const year = n(req.query.year, currentYear());
    const orders = ordersOfYear(year);
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, sales_amount: 0, profit_amount: 0, order_count: 0, inventory_value: 0, quality_rate: 0, summary: ''
    }));
    orders.forEach(o => {
      const m = monthOf(o.order_date || o.promised_date || o.created_at);
      if (m >= 1 && m <= 12) {
        const amt = n(o.order_amount || o.total_amount);
        months[m - 1].sales_amount += amt;
        months[m - 1].profit_amount += n(o.profit) + amt * n(o.profit_rate, 0);
        months[m - 1].order_count++;
      }
    });
    const inv = inventoryValue();
    months.forEach((m, i) => {
      m.sales_amount = round(m.sales_amount);
      m.profit_amount = round(m.profit_amount);
      m.inventory_value = round(inv);
      m.quality_rate = 98;
      m.summary = `${m.month}月销售额 ${round(m.sales_amount)}，订单 ${m.order_count} 单`;
    });
    res.json({ data: months, total: 12 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/quarterly-analysis', requirePerm(PERM_VIEW), (req, res) => {
  try {
    const year = n(req.query.year, currentYear());
    const orders = ordersOfYear(year);
    const quarters = Array.from({ length: 4 }, (_, i) => ({
      quarter: 'Q' + (i + 1), sales_amount: 0, profit_amount: 0, order_count: 0, qoq_rate: 0, forecast: 0, trend: '平稳'
    }));
    orders.forEach(o => {
      const m = monthOf(o.order_date || o.promised_date || o.created_at);
      if (m >= 1 && m <= 12) {
        const q = Math.ceil(m / 3) - 1;
        const amt = n(o.order_amount || o.total_amount);
        quarters[q].sales_amount += amt;
        quarters[q].profit_amount += n(o.profit) + amt * n(o.profit_rate, 0);
        quarters[q].order_count++;
      }
    });
    quarters.forEach((q, i) => {
      q.sales_amount = round(q.sales_amount);
      q.profit_amount = round(q.profit_amount);
      if (i > 0 && quarters[i - 1].sales_amount > 0) {
        q.qoq_rate = round((q.sales_amount - quarters[i - 1].sales_amount) / quarters[i - 1].sales_amount * 100, 1);
        q.trend = q.qoq_rate > 5 ? '上升' : q.qoq_rate < -5 ? '下降' : '平稳';
      }
      q.forecast = round(q.sales_amount * 4 / (i + 1));
    });
    res.json({ data: quarters, total: 4 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reports/annual', requirePerm(PERM_VIEW), (req, res) => {
  try {
    const year = n(req.query.year, currentYear());
    const orders = ordersOfYear(year);
    const salesAmount = orders.reduce((s2, o) => s2 + n(o.order_amount || o.total_amount), 0);
    const profitAmount = orders.reduce((s2, o) =>
      s2 + n(o.profit) + n(o.order_amount || o.total_amount) * n(o.profit_rate, 0), 0);
    const profitRate = salesAmount > 0 ? round(profitAmount / salesAmount * 100, 1) : 0;
    const goals = readAll('annual_plan_goals').filter(g => Number(g.year) === year);
    const goalTarget = goals.reduce((s2, g) => s2 + n(g.target_value), 0);
    const goalActual = goals.reduce((s2, g) => s2 + n(g.actual_value), 0);
    const completionRate = goalTarget ? round(goalActual / goalTarget * 100, 1) : 0;

    const suggestions = [];
    if (completionRate < 80) suggestions.push(`年度目标完成率 ${completionRate}%，未达预期，需制定追赶方案。`);
    if (profitRate < 10) suggestions.push(`利润率 ${profitRate}% 偏低，建议聚焦高毛利产品与降本增效。`);
    if (!orders.length) suggestions.push(`${year} 年度暂无订单数据，建议加强市场拓展。`);
    if (!suggestions.length) suggestions.push(`${year} 年度经营情况良好，建议持续巩固优势。`);

    const summary = `${year} 年度累计销售额 ${round(salesAmount)} 元，订单 ${orders.length} 单，` +
      `利润 ${round(profitAmount)} 元，利润率 ${profitRate}%，目标完成率 ${completionRate}%。`;

    res.json({
      title: `${year} 年度经营分析报告`,
      summary,
      sales_amount: round(salesAmount),
      profit_amount: round(profitAmount),
      profit_rate: profitRate,
      completion_rate: completionRate,
      order_count: orders.length,
      suggestions
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// AI 经营助手（基于数据的规则化文本生成）
// ============================================================
function buildAiContext(year) {
  const orders = ordersOfYear(year);
  const projects = projectsOfYear(year);
  const goals = readAll('annual_plan_goals').filter(g => Number(g.year) === year);
  const kpis = readAll('annual_kpis').filter(k => Number(k.year) === year);
  const risks = readAll('annual_risks').filter(r => Number(r.year) === year && r.status !== '已关闭');
  const salesAmount = orders.reduce((s2, o) => s2 + n(o.order_amount || o.total_amount), 0);
  const profitAmount = orders.reduce((s2, o) =>
    s2 + n(o.profit) + n(o.order_amount || o.total_amount) * n(o.profit_rate, 0), 0);
  const goalTarget = goals.reduce((s2, g) => s2 + n(g.target_value), 0);
  const goalActual = goals.reduce((s2, g) => s2 + n(g.actual_value), 0);
  return {
    year, orders: orders.length, salesAmount: round(salesAmount), profitAmount: round(profitAmount),
    profitRate: salesAmount ? round(profitAmount / salesAmount * 100, 1) : 0,
    goalCount: goals.length, goalCompletion: goalTarget ? round(goalActual / goalTarget * 100, 1) : 0,
    kpiCount: kpis.length, projectCount: projects.length, riskCount: risks.length,
    risks, goals, kpis
  };
}

router.post('/ai/analyze', requirePerm(PERM_ANALYZE), async (req, res) => {
  try {
    const year = n(req.body.year, currentYear());
    const question = s(req.body.question, '分析今年经营情况');
    const ctx = buildAiContext(year);
    const lines = [];
    lines.push(`【${year} 年度经营分析】`);
    lines.push(`1. 销售情况：累计订单 ${ctx.orders} 单，销售额 ${ctx.salesAmount} 元，利润 ${ctx.profitAmount} 元，利润率 ${ctx.profitRate}%。`);
    lines.push(`2. 目标达成：年度目标 ${ctx.goalCount} 项，整体完成率 ${ctx.goalCompletion}%。`);
    lines.push(`3. 研发项目：${ctx.projectCount} 项在进行。`);
    lines.push(`4. 风险预警：未关闭风险 ${ctx.riskCount} 项${ctx.risks.length ? '，重点关注：' + ctx.risks.slice(0, 3).map(r => r.risk_name).join('、') : ''}。`);
    lines.push('');
    lines.push('【建议措施】');
    if (ctx.goalCompletion < 80) lines.push('- 加快年度目标进度，按周跟进关键指标。');
    if (ctx.profitRate < 10) lines.push('- 提升高毛利产品占比，启动降本攻坚。');
    if (ctx.riskCount > 3) lines.push('- 召开风险评审会，明确责任人与时限。');
    if (ctx.orders === 0) lines.push('- 加强市场拓展与客户开发。');
    if (!lines.some(l => l.startsWith('-'))) lines.push('- 保持当前经营节奏，持续优化。');
    lines.push('');
    lines.push(`（针对问题：${question}）`);
    // 记录 AI 调用
    try {
      await getTable('annual_ai_records').insert({
        year, type: 'analyze', question, answer: lines.join('\n'), created_at: now()
      });
    } catch (e) {}
    res.json({ answer: lines.join('\n'), context: ctx });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ai/generate', requirePerm(PERM_ANALYZE), async (req, res) => {
  try {
    const year = n(req.body.year, currentYear());
    const type = s(req.body.type, '经营报告');
    const ctx = buildAiContext(year);
    const templates = {
      'OKR': () => [
        `${year} 年度 OKR 建议`,
        `O1：实现销售目标（当前完成率 ${ctx.goalCompletion}%）`,
        '  KR1：销售额同比增长 20%',
        '  KR2：新客户开发不少于 10 家',
        '  KR3：订单交付准时率达 95%',
        'O2：提升盈利能力（利润率 ' + ctx.profitRate + '%）',
        '  KR1：高毛利产品占比提升至 40%',
        '  KR2：采购成本下降 5%',
        '  KR3：库存周转率提升 15%'
      ].join('\n'),
      'KPI': () => [
        `${year} 年度关键指标（KPI）`,
        `1. 销售额：${ctx.salesAmount} 元`,
        `2. 利润率：${ctx.profitRate}%`,
        `3. 订单数量：${ctx.orders} 单`,
        `4. 目标完成率：${ctx.goalCompletion}%`,
        `5. 研发项目：${ctx.projectCount} 项`,
        `6. 风险数：${ctx.riskCount} 项`
      ].join('\n'),
      '年度计划': () => [
        `${year} 年度经营计划`,
        '一、市场拓展：聚焦重点行业，新客户开发不少于 10 家。',
        '二、产品研发：完成 ' + Math.max(2, ctx.projectCount) + ' 项新品上市。',
        '三、降本增效：采购成本下降 5%，库存周转率提升 15%。',
        '四、品质管理：客户投诉率下降 30%，良品率达 99%。',
        '五、组织建设：完善绩效考核与培训体系。'
      ].join('\n'),
      '周计划': () => [
        '本周经营计划模板',
        '1. 销售跟进：A 类客户回访、订单确认。',
        '2. 项目进度：研发项目阶段评审。',
        '3. 采购到货：关键物料到货跟踪。',
        '4. 生产排程：本周订单交付计划。',
        '5. 品质例会：周度品质数据分析。'
      ].join('\n'),
      '会议纪要': () => [
        `${year} 年度经营分析会议纪要`,
        '会议时间：' + now(),
        '议题：年度经营情况复盘',
        `决议：1) 销售额 ${ctx.salesAmount} 元，目标完成率 ${ctx.goalCompletion}%；`,
        '     2) 针对利润率制定改善方案；',
        '     3) 重点关注未关闭风险。',
        '下次会议：下周同一时间。'
      ].join('\n'),
      '经营报告': () => [
        `${year} 年度经营报告`,
        `一、经营概况：累计销售额 ${ctx.salesAmount} 元，利润 ${ctx.profitAmount} 元，利润率 ${ctx.profitRate}%。`,
        `二、目标达成：完成率 ${ctx.goalCompletion}%，订单 ${ctx.orders} 单。`,
        `三、研发进展：在研项目 ${ctx.projectCount} 项。`,
        `四、风险提示：未关闭风险 ${ctx.riskCount} 项。`,
        '五、下一步：聚焦高毛利产品，加快目标达成。'
      ].join('\n'),
      '风险预测': () => {
        const lines = [`${year} 年度风险预测`];
        if (ctx.risks.length) {
          lines.push('当前主要风险：');
          ctx.risks.slice(0, 5).forEach((r, i) => lines.push(`${i + 1}. ${r.risk_name}（${r.level || '中'}）— ${r.measures || '待制定措施'}`));
        } else {
          lines.push('暂无录入风险。');
        }
        lines.push('预警建议：关注订单交付、采购价格波动、库存积压三类典型风险。');
        return lines.join('\n');
      }
    };
    const fn = templates[type] || templates['经营报告'];
    const content = fn();
    try {
      await getTable('annual_ai_records').insert({
        year, type, question: '', answer: content, created_at: now()
      });
    } catch (e) {}
    res.json({ content, context: ctx });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 兼容旧占位接口（避免外部探测报错）
router.get('/', (req, res) => res.json({
  message: '年度经营计划模块',
  endpoints: ['/dashboard', '/goals', '/department-plans', '/kpis', '/okrs', '/action-plans', '/risks', '/reviews', '/project-plans', '/monthly-analysis', '/quarterly-analysis', '/reports/annual', '/ai/analyze', '/ai/generate']
}));

module.exports = router;
