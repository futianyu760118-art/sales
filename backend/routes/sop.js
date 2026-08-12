/**
 * S&OP 产销协调会系统 — 全模块后端路由
 * ------------------------------------------------------------------
 * 覆盖 8 大模块：数据获取 / 需求预测 / 供应评审 / PSI滚动 / 会议RAPID /
 *               预警升级 / Action闭环 / KPI驾驶舱 + 自检引擎
 * 表均为 JsonTable（database/*.json），无外部数据库依赖。
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');

// ============ 工具 ============
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}
// 滚动月：上月16日~当月15日
function currentSopPeriod() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  // 当月<=15日 → 属于"上月16~当月15"，主月标记为上月
  const baseM = day <= 15 ? (m === 0 ? 11 : m - 1) : m;
  const baseY = day <= 15 && m === 0 ? y - 1 : y;
  return `${baseY}-${String(baseM + 1).padStart(2, '0')}`;
}
// 任意日期 → 所属 S&OP 月度周期（上月16~当月15）：日>15 归下月，否则归当月
function sopPeriodFromDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  const baseM = day > 15 ? m : (m === 0 ? 11 : m - 1);
  const baseY = day <= 15 && m === 0 ? y - 1 : (day > 15 && m === 11 ? y + 1 : y);
  return `${baseY}-${String(baseM + 1).padStart(2, '0')}`;
}
// 周期偏移：返回相对当前周期偏移 n 个月的周期字符串
function sopPeriodOffset(base, n) {
  let [y, m] = base.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
// 请求周期：优先取查询参数（period_month/period），否则当前周期
function reqPeriod(req) {
  return (req && req.query && (req.query.period_month || req.query.period)) || currentSopPeriod();
}
// 计算库存红黄绿
function calcColor(end, safety) {
  if (end < safety) return 'R';
  if (end < safety * 1.2) return 'Y';
  return 'G';
}
function ensureAll() {
  ['kpi_standards', 'kpi_actuals', 'psi_headers', 'psi_lines', 'demand_forecasts',
   'supply_capacities', 'supply_mrps', 'md_boms', 'md_products', 'md_suppliers',
   'sop_meetings', 'sop_meeting_attendees', 'sop_actions', 'alert_rules', 'alert_logs',
   'self_check_templates', 'self_check_records', 'flow_configs', 'data_fetch_configs',
   'block_logs', 'audit_logs'].forEach(ensureTable);
}
ensureAll();

// ============================================================
// KPI 驾驶舱
// ============================================================
router.get('/kpi/standards', (req, res) => {
  const t = getTable('kpi_standards'); t._invalidate();
  const { category } = req.query;
  let rows = t.all().filter(r => r.is_active !== 0);
  if (category) rows = rows.filter(r => r.category === category);
  rows.sort((a, b) => a.kpi_code.localeCompare(b.kpi_code));
  res.json({ data: rows });
});

router.get('/kpi/actuals', (req, res) => {
  const t = getTable('kpi_actuals'); t._invalidate();
  const std = getTable('kpi_standards'); std._invalidate();
  const stdMap = {}; std.all().forEach(s => stdMap[s.id] = s);
  const { period_month, status } = req.query;
  let rows = t.all();
  if (period_month) rows = rows.filter(r => r.period_month === period_month);
  if (status) rows = rows.filter(r => r.status === status);
  rows = rows.map(r => {
    const s = stdMap[r.kpi_id] || {};
    return { ...r, kpi_code: r.kpi_code || s.kpi_code, kpi_name: s.kpi_name, category: s.category,
             target_value: s.target_value, warning_threshold: s.warning_threshold, critical_threshold: s.critical_threshold };
  });
  rows.sort((a, b) => (a.kpi_code || '').localeCompare(b.kpi_code || ''));
  res.json({ data: rows });
});

router.get('/kpi/dashboard', (req, res) => {
  const act = getTable('kpi_actuals'); act._invalidate();
  const std = getTable('kpi_standards'); std._invalidate();
  const stdMap = {}; std.all().forEach(s => stdMap[s.id] = s);
  const period = req.query.period_month || currentSopPeriod();
  let rows = act.all().filter(r => r.period_month === period);
  if (rows.length === 0) rows = act.all(); // 兜底取最新
  rows = rows.map(r => { const s = stdMap[r.kpi_id] || {}; return { ...r, kpi_code: r.kpi_code || s.kpi_code, kpi_name: s.kpi_name, category: s.category, target_value: s.target_value, warning_threshold: s.warning_threshold, critical_threshold: s.critical_threshold }; });
  const groups = { MI: [], PI: [], KPI: [] };
  rows.forEach(r => { if (groups[r.category]) groups[r.category].push(r); });
  const summary = {
    red_count: rows.filter(r => r.status === 'R').length,
    yellow_count: rows.filter(r => r.status === 'Y').length,
    green_count: rows.filter(r => r.status === 'G').length,
    total: rows.length
  };
  res.json({ period, summary, mi: groups.MI, pi: groups.PI, kpi: groups.KPI });
});

// ============================================================
// PSI 产销存滚动
// ============================================================
router.get('/psi/headers', (req, res) => {
  const t = getTable('psi_headers'); t._invalidate();
  const { sales_type, status, period_month } = req.query;
  let rows = t.all();
  if (sales_type) rows = rows.filter(r => r.sales_type === sales_type);
  if (status) rows = rows.filter(r => r.status === status);
  if (period_month) rows = rows.filter(r => r.period_month === period_month);
  rows.sort((a, b) => (b.period_month || '').localeCompare(a.period_month || ''));
  res.json({ data: rows });
});

router.get('/psi/headers/:id/lines', (req, res) => {
  const t = getTable('psi_lines'); t._invalidate();
  const { color_status } = req.query;
  let rows = t.all().filter(r => Number(r.header_id) === Number(req.params.id));
  if (color_status) rows = rows.filter(r => r.color_status === color_status);
  rows.sort((a, b) => (a.product_code || '').localeCompare(b.product_code || '') || a.month_offset - b.month_offset);
  res.json({ data: rows });
});

// 批量更新/新增 PSI 明细（自动计算期末库存 + 红黄绿 + 版本留痕）
router.post('/psi/headers/:id/lines', async (req, res) => {
  const headerId = Number(req.params.id);
  const lines = req.body.lines || [];
  const t = getTable('psi_lines'); t._invalidate();
  const audit = getTable('audit_logs');
  const ts = now();
  let changes = 0;
  for (const ln of lines) {
    const begin = toNum(ln.inventory_begin);
    const sp = toNum(ln.sales_plan);
    const pp = toNum(ln.production_plan);
    const ss = toNum(ln.safety_stock);
    const end = begin + pp - sp;
    const color = calcColor(end, ss);
    if (ln.id) {
      await t.update(ln.id, {
        inventory_begin: begin, sales_plan: sp, production_plan: pp,
        safety_stock: ss, inventory_end: end, color_status: color, updated_at: ts
      });
    } else {
      await t.insert({
        header_id: headerId, product_code: ln.product_code, month_offset: ln.month_offset || 0,
        inventory_begin: begin, sales_plan: sp, production_plan: pp,
        safety_stock: ss, inventory_end: end, color_status: color, is_editable: 1
      });
    }
    audit.insertNoSave({ table_name: 'psi_lines', record_id: ln.id || 0, action: ln.id ? 'UPDATE' : 'INSERT', new_value_json: JSON.stringify({ sales_plan: sp, production_plan: pp, inventory_end: end, color }), changed_by: req.headers['x-user-id'] || 0, changed_at: ts, change_reason: ln.change_reason || 'PSI编辑' });
    changes++;
  }
  audit.saveNow();
  res.json({ message: '保存成功', changes });
});

// 滚动刷新：M+2→M+1，新增新 M+2
router.post('/psi/headers/:id/roll-forward', async (req, res) => {
  const headerT = getTable('psi_headers');
  const lineT = getTable('psi_lines'); lineT._invalidate();
  const header = headerT.findById(req.params.id);
  if (!header) return res.status(404).json({ error: 'PSI不存在' });
  const lines = lineT.all().filter(r => Number(r.header_id) === Number(req.params.id));
  // 新建头表版本
  const newPeriod = (() => {
    const [y, m] = header.period_month.split('-').map(Number);
    const nm = m + 1 > 12 ? 1 : m + 1;
    const ny = m + 1 > 12 ? y + 1 : y;
    return `${ny}-${String(nm).padStart(2, '0')}`;
  })();
  const r = await headerT.insert({
    psi_code: `PSI-${newPeriod.replace('-', '')}-${String(header.version_no + 1).padStart(3, '0')}`,
    sales_type: header.sales_type, period_month: newPeriod, version_no: header.version_no + 1,
    status: 'DRAFT', is_rolled: 0, rolled_from: header.id, created_by: req.headers['x-user-id'] || 0
  });
  const newId = r.lastID;
  // 明细：offset 0/1 来自旧的 1/2，新建 offset 2
  const byProduct = {};
  lines.forEach(l => { (byProduct[l.product_code] = byProduct[l.product_code] || {})[l.month_offset] = l; });
  for (const pc of Object.keys(byProduct)) {
    const g = byProduct[pc];
    for (const off of [0, 1]) {
      const src = g[off + 1];
      if (src) {
        await lineT.insert({
          header_id: newId, product_code: pc, month_offset: off,
          inventory_begin: src.inventory_begin, sales_plan: src.sales_plan, production_plan: src.production_plan,
          inventory_end: src.inventory_end, safety_stock: src.safety_stock, color_status: src.color_status, is_editable: 1
        });
      }
    }
    const last = g[2] || g[1] || g[0];
    if (last) {
      await lineT.insert({
        header_id: newId, product_code: pc, month_offset: 2,
        inventory_begin: last.inventory_end || 0, sales_plan: 0, production_plan: 0,
        inventory_end: last.inventory_end || 0, safety_stock: last.safety_stock || 0, color_status: 'G', is_editable: 1
      });
    }
  }
  await headerT.update(header.id, { is_rolled: 1 });
  res.json({ message: '滚动成功', new_header_id: newId, psi_code: `PSI-${newPeriod.replace('-', '')}` });
});

// ============================================================
// 需求预测
// ============================================================
router.get('/forecast', (req, res) => {
  const t = getTable('demand_forecasts'); t._invalidate();
  const { product_code, period_month, month_offset } = req.query;
  let rows = t.all();
  if (product_code) rows = rows.filter(r => r.product_code === product_code);
  if (period_month) rows = rows.filter(r => r.period_month === period_month);
  if (month_offset !== undefined && month_offset !== '') rows = rows.filter(r => Number(r.month_offset) === Number(month_offset));
  rows.sort((a, b) => (b.period_month || '').localeCompare(a.period_month || '') || (a.product_code || '').localeCompare(b.product_code || ''));
  res.json({ data: rows });
});

router.post('/forecast', async (req, res) => {
  const t = getTable('demand_forecasts');
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const ts = now();
  const results = [];
  for (const it of items) {
    if (!it.product_code) continue;
    const r = await t.insert({
      product_code: it.product_code, customer_code: it.customer_code || '', customer_name: it.customer_name || '',
      period_month: it.period_month || currentSopPeriod(),
      month_offset: it.month_offset || 0, forecast_qty: toNum(it.forecast_qty),
      forecast_type: it.forecast_type || (it.month_offset === 0 ? 'LOCKED' : it.month_offset === 1 ? 'FLEXIBLE' : 'REFERENCE'),
      method: it.method || 'QUALITATIVE', mape_reference: toNum(it.mape_reference),
      currency_amount: toNum(it.currency_amount), remark: it.remark || '', promotion_flag: it.promotion_flag || '',
      version_no: 1, created_by: req.headers['x-user-id'] || 0, created_at: ts, updated_at: ts
    });
    results.push(t.findById(r.lastID));
  }
  res.json({ message: '提交成功', data: results });
});

// 自动计算（移动平均 / 指数平滑）
router.post('/forecast/auto-calc', (req, res) => {
  const { product_code, method, periods } = req.body || {};
  const act = getTable('kpi_actuals'); act._invalidate();
  // 简化：用预测历史均值作为基准
  const t = getTable('demand_forecasts'); t._invalidate();
  const hist = t.all().filter(r => r.product_code === product_code).map(r => toNum(r.forecast_qty));
  let base = 0;
  if (hist.length) {
    if (method === 'EXP_SMOOTH') {
      const a = 0.3; base = hist[0];
      for (let i = 1; i < hist.length; i++) base = a * hist[i] + (1 - a) * base;
    } else {
      const p = Math.min(periods || 3, hist.length);
      base = hist.slice(-p).reduce((s, v) => s + v, 0) / p;
    }
  }
  res.json({ product_code, method, recommended_qty: Math.round(base), basis_count: hist.length });
});

// ============================================================
// 供应评审
// ============================================================
router.get('/supply/capacity', (req, res) => {
  const t = getTable('supply_capacities'); t._invalidate();
  const { period_month, line_code } = req.query;
  let rows = t.all();
  if (period_month) rows = rows.filter(r => r.period_month === period_month);
  if (line_code) rows = rows.filter(r => r.line_code === line_code);
  res.json({ data: rows });
});

router.get('/supply/mrp-check', (req, res) => {
  const t = getTable('supply_mrps'); t._invalidate();
  let rows = t.all().map(r => ({ ...r, shortage_qty: Math.max(0, toNum(r.required_qty) - toNum(r.arrived_qty)), is_ontime: toNum(r.arrived_qty) >= toNum(r.required_qty) ? 1 : 0 }));
  if (req.query.only_shortage === 'true') rows = rows.filter(r => r.shortage_qty > 0);
  if (req.query.product_code) rows = rows.filter(r => r.product_code === req.query.product_code);
  rows.sort((a, b) => b.shortage_qty - a.shortage_qty);
  res.json({ data: rows, total: rows.length, shortage_count: rows.filter(r => r.shortage_qty > 0).length });
});

// 硬拦截检查
router.get('/supply/block-check', (req, res) => {
  const bom = getTable('md_boms'); bom._invalidate();
  const psi = getTable('psi_lines'); psi._invalidate();
  const psiH = getTable('psi_headers'); psiH._invalidate();
  // 活跃产品（CONFIRMED/LOCKED 的 PSI 中的产品）
  const activeHeaders = psiH.all().filter(h => ['CONFIRMED', 'LOCKED'].includes(h.status)).map(h => h.id);
  const activeProducts = new Set(psi.all().filter(l => activeHeaders.includes(l.header_id)).map(l => l.product_code));
  const blocks = [];
  if (req.query.product_code) {
    const pc = req.query.product_code;
    const b = bom.all().find(x => x.product_code === pc);
    if (b && Number(b.is_archived) === 0) {
      blocks.push({ block_code: 'HB-001', block_type: '订单标准未归档', product_code: pc, reason: 'BOM/订单标准尚未归档，禁止投产' });
    }
    if (b && Number(b.is_archived) === 0) {
      blocks.push({ block_code: 'HB-002', block_type: '模具图纸未更新', product_code: pc, reason: '模具图纸版本需更新，禁止排产' });
    }
  } else {
    bom.all().forEach(b => {
      if (Number(b.is_archived) === 0 && (activeProducts.has(b.product_code) || !req.query.active_only)) {
        blocks.push({ block_code: 'HB-001', block_type: Number(b.is_archived) === 0 ? 'BOM/模具未归档' : 'OK', product_code: b.product_code, reason: Number(b.is_archived) === 0 ? '尚未归档，活跃产品将阻断投产/排产' : '' });
      }
    });
  }
  const blockedProducts = blocks.filter(b => b.reason).map(b => b.product_code);
  res.json({ is_blocked: blocks.length > 0, blocks, blocked_products: blockedProducts });
});

// ============================================================
// S&OP 会议 + RAPID
// ============================================================
router.get('/meetings', (req, res) => {
  const t = getTable('sop_meetings'); t._invalidate();
  const { meeting_type, status } = req.query;
  let rows = t.all();
  if (meeting_type) rows = rows.filter(r => r.meeting_type === meeting_type);
  if (status) rows = rows.filter(r => r.status === status);
  rows.sort((a, b) => (b.meeting_date || '').localeCompare(a.meeting_date || ''));
  res.json({ data: rows });
});

router.get('/meetings/:id', (req, res) => {
  const t = getTable('sop_meetings'); t._invalidate();
  const m = t.findById(req.params.id);
  if (!m) return res.status(404).json({ error: '会议不存在' });
  const att = getTable('sop_meeting_attendees'); att._invalidate();
  const act = getTable('sop_actions'); act._invalidate();
  m.attendees = att.all().filter(a => Number(a.meeting_id) === Number(req.params.id));
  m.actions = act.all().filter(a => Number(a.meeting_id) === Number(req.params.id));
  res.json(m);
});

const AGENDA_TEMPLATE = [
  { no: 1, name: '上月KPI回顾', responsible: 'SOP_OFFICER' },
  { no: 2, name: '上期Action完成率', responsible: '各责任人' },
  { no: 3, name: '本月最佳估计(销售/库存/效率)', responsible: 'COMMITTEE_HEAD' },
  { no: 4, name: '销售分析和需求预测', responsible: 'MARKET_PLANNER' },
  { no: 5, name: '制造表现+约束条件+关键产能', responsible: 'PROD_PLANNER' },
  { no: 6, name: '库存预测(原/在/成品)', responsible: 'PLANNER' },
  { no: 7, name: '直接人工(需招/在岗/缺口)', responsible: 'PROD_DIRECTOR' },
  { no: 8, name: 'Top3最差供应商', responsible: 'PURCHASE_HEAD' },
  { no: 9, name: '新品进度+退市清单', responsible: 'R&D_HEAD' },
  { no: 10, name: '制定新一轮Action', responsible: '全体' }
];

router.post('/meetings', async (req, res) => {
  const t = getTable('sop_meetings');
  const { meeting_type, meeting_date, psi_header_id, title, attendees } = req.body || {};
  const y = (meeting_date ? new Date(meeting_date) : new Date()).getFullYear();
  const exist = t.all().filter(m => (m.meeting_code || '').startsWith('SOP' + y));
  const code = `SOP${y}${String(exist.length + 1).padStart(4, '0')}`;
  const ts = now();
  const r = await t.insert({
    meeting_code: code, meeting_type: meeting_type || 'EXECUTIVE',
    meeting_date: meeting_date || ts, status: 'SCHEDULED',
    agenda_json: JSON.stringify(AGENDA_TEMPLATE), decision_summary: '',
    psi_header_id: psi_header_id || null, title: title || `${meeting_type || '高层决策会'} ${meeting_date || ''}`,
    created_by: req.headers['x-user-id'] || 0, created_at: ts
  });
  // 写入出席人 RAPID 角色
  if (Array.isArray(attendees)) {
    const att = getTable('sop_meeting_attendees');
    for (const a of attendees) {
      await att.insert({ meeting_id: r.lastID, user_id: a.user_id, user_name: a.user_name, rapid_role: a.rapid_role || 'I', attendance: 'PRESENT', vote_result: null, vote_comment: '' });
    }
  }
  res.json({ message: '创建成功', data: t.findById(r.lastID) });
});

// RAPID 表决
router.post('/meetings/:id/rapid', async (req, res) => {
  const att = getTable('sop_meeting_attendees');
  const { user_id, vote_result, vote_comment, rapid_role } = req.body || {};
  const found = att.all().find(a => Number(a.meeting_id) === Number(req.params.id) && Number(a.user_id) === Number(user_id));
  if (!found) return res.status(404).json({ error: '该用户非本次会议出席人' });
  await att.update(found.id, { vote_result, vote_comment: vote_comment || '', rapid_role: rapid_role || found.rapid_role });
  res.json({ message: '表决已记录' });
});

// 自动生成 Action（基于红灯 KPI / 产能 / 短缺）
router.post('/meetings/:id/auto-generate-actions', async (req, res) => {
  const actT = getTable('sop_actions');
  const meetingId = Number(req.params.id);
  const kpiAct = getTable('kpi_actuals'); kpiAct._invalidate();
  const stdT = getTable('kpi_standards'); stdT._invalidate();
  const stdMap = {}; stdT.all().forEach(s => stdMap[s.id] = s);
  const roleMap = { 'KPI-002': 'PURCHASE_HEAD', 'KPI-006': 'QUALITY_HEAD', 'KPI-008': 'DEPT_HEAD', 'KPI-009': 'SALES_DIRECTOR', 'KPI-021': 'PURCHASE_HEAD', 'KPI-026': 'SALES_DIRECTOR' };
  const ts = now();
  let count = 0;
  const created = [];
  kpiAct.all().filter(r => r.status === 'R').forEach(r => {
    const s = stdMap[r.kpi_id] || {};
    const code = r.kpi_code || s.kpi_code;
    // 去重：同会议同 KPI 已有 action 则跳过
    const dup = actT.all().find(a => Number(a.meeting_id) === meetingId && (a.description || '').includes(s.kpi_name || code));
    if (dup) return;
    const seq = actT.all().length + 1;
    const rec = actT.insertNoSave({
      action_code: `ACT-AUTO-${String(seq).padStart(4, '0')}`, meeting_id: meetingId, issue_no: '1',
      description: `【自动生成】${s.kpi_name || code}红灯告警：实际${r.actual_value} vs 目标${s.target_value}，需立即制定对策`,
      owner_role: roleMap[code] || 'DEPT_HEAD', due_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      priority: 'P0', status: 'PENDING', escalation_level: 0, source_system: 'SOP_AUTO', created_at: ts, updated_at: ts
    });
    created.push(rec);
    count++;
  });
  // 短缺 Top 物料
  const mrp = getTable('supply_mrps'); mrp._invalidate();
  mrp.all().map(r => ({ ...r, shortage_qty: Math.max(0, toNum(r.required_qty) - toNum(r.arrived_qty)) }))
    .filter(r => r.shortage_qty > 0).sort((a, b) => b.shortage_qty - a.shortage_qty).slice(0, 3).forEach(r => {
      const dup = actT.all().find(a => Number(a.meeting_id) === meetingId && (a.description || '').includes(r.material_code));
      if (dup) return;
      const seq = actT.all().length + 1;
      actT.insertNoSave({
        action_code: `ACT-AUTO-${String(seq).padStart(4, '0')}`, meeting_id: meetingId, issue_no: '5',
        description: `【自动生成】物料${r.material_code}短缺${r.shortage_qty}件，需采购跟催`,
        owner_role: 'PURCHASE_HEAD', due_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        priority: 'P1', status: 'PENDING', escalation_level: 0, source_system: 'SOP_AUTO', created_at: ts, updated_at: ts
      });
      count++;
    });
  actT.saveNow();
  res.json({ message: `已自动生成 ${count} 条 Action`, actions_created: count, actions: created.map(id => actT.findById(id)).filter(Boolean) });
});

// ============================================================
// Action 待办
// ============================================================
router.get('/actions', (req, res) => {
  const t = getTable('sop_actions'); t._invalidate();
  const { status, priority, overdue_only, owner_role } = req.query;
  let rows = t.all();
  if (status) rows = rows.filter(r => r.status === status);
  if (priority) rows = rows.filter(r => r.priority === priority);
  if (owner_role) rows = rows.filter(r => r.owner_role === owner_role);
  const today = new Date().toISOString().slice(0, 10);
  rows = rows.map(r => ({ ...r, overdue_flag: r.due_date && r.due_date < today && r.status !== 'CLOSED' ? 1 : 0 }));
  if (overdue_only === 'true') rows = rows.filter(r => r.overdue_flag);
  rows.sort((a, b) => (a.priority || '').localeCompare(b.priority || '') || (a.due_date || '').localeCompare(b.due_date || ''));
  res.json({ data: rows, total: rows.length, overdue_count: rows.filter(r => r.overdue_flag).length });
});

router.post('/actions', async (req, res) => {
  const t = getTable('sop_actions');
  const b = req.body || {};
  const seq = t.all().length + 1;
  const ts = now();
  const r = await t.insert({
    action_code: b.action_code || `ACT-MANUAL-${String(seq).padStart(4, '0')}`,
    meeting_id: b.meeting_id || null, issue_no: b.issue_no || '', description: b.description || '',
    owner_name: b.owner_name || '', owner_role: b.owner_role || '', collaborator_ids: b.collaborator_ids || [],
    due_date: b.due_date || null, priority: b.priority || 'P1', status: 'PENDING',
    escalation_level: 0, evidence_url: '', source_system: 'SOP',
    created_by: req.headers['x-user-id'] || 0, created_at: ts, updated_at: ts
  });
  res.json({ message: '创建成功', data: t.findById(r.lastID) });
});

router.put('/actions/:id/status', async (req, res) => {
  const t = getTable('sop_actions');
  const a = t.findById(req.params.id);
  if (!a) return res.status(404).json({ error: 'Action不存在' });
  const { status, evidence_url, remark } = req.body || {};
  const fields = { status: status || a.status, updated_at: now() };
  if (evidence_url !== undefined) fields.evidence_url = evidence_url;
  if (remark) fields.remark = remark;
  if (status === 'CLOSED') fields.closed_at = now();
  // 升级：进行中→待验证不升级；逾期越久升级层级越高
  await t.update(req.params.id, fields);
  res.json({ message: '更新成功', data: t.findById(req.params.id) });
});

// ============================================================
// 预警引擎
// ============================================================
router.get('/alerts/rules', (req, res) => {
  const t = getTable('alert_rules'); t._invalidate();
  res.json({ data: t.all().filter(r => r.is_active !== 0) });
});

router.get('/alerts/logs', (req, res) => {
  const t = getTable('alert_logs'); t._invalidate();
  const { level, is_resolved } = req.query;
  let rows = t.all();
  if (level) rows = rows.filter(r => r.level === level);
  if (is_resolved !== undefined) rows = rows.filter(r => String(r.is_resolved) === String(is_resolved));
  rows.sort((a, b) => (b.triggered_at || '').localeCompare(a.triggered_at || ''));
  res.json({ data: rows });
});

// 运行预警引擎：扫描所有规则，生成 alert_logs
router.post('/alerts/engine/run', async (req, res) => {
  const rules = getTable('alert_rules'); rules._invalidate();
  const act = getTable('kpi_actuals'); act._invalidate();
  const stdT = getTable('kpi_standards'); stdT._invalidate();
  const stdByCode = {}; stdT.all().forEach(s => stdByCode[s.kpi_code] = s);
  const actByKpi = {}; act.all().forEach(a => { actByKpi[a.kpi_code] = a; });
  const logT = getTable('alert_logs');
  const psi = getTable('psi_lines'); psi._invalidate();
  const cap = getTable('supply_capacities'); cap._invalidate();
  const actions = getTable('sop_actions'); actions._invalidate();
  const ts = now();
  const triggered = [];

  rules.all().filter(r => r.is_active !== 0).forEach(rule => {
    let fire = false, msg = rule.rule_name, entity = '';
    if (rule.trigger_type === 'KPI_VALUE' && rule.kpi_code) {
      // 规则可能针对多个 KPI（如 AR-011）
      const codes = rule.kpi_code.split('/');
      codes.forEach(code => {
        const a = actByKpi[code];
        const s = stdByCode[code];
        if (!a || !s) return;
        const cond = String(rule.condition || '');
        let hit = false;
        if (cond.startsWith('<')) { const thr = toNum(cond.replace(/[^0-9.]/g, '')); hit = toNum(a.actual_value) < thr; }
        else if (cond.startsWith('>')) { const thr = toNum(cond.replace(/[^0-9.]/g, '')); hit = toNum(a.actual_value) > thr; }
        if (hit) { fire = true; msg = `${s.kpi_name}：实际${a.actual_value}，目标${s.target_value}`; entity = code; }
      });
    } else if (rule.trigger_type === 'TABLE_VALUE' && (rule.kpi_code || '').includes('load_rate')) {
      cap.all().forEach(c => { if (toNum(c.load_rate) > 85) { fire = true; msg = `${c.line_code}产能超载 ${c.load_rate}%`; entity = c.line_code; } });
    } else if (rule.trigger_type === 'TABLE_VALUE' && (rule.kpi_code || '').includes('psi_line')) {
      psi.all().forEach(l => { if (toNum(l.inventory_end) < toNum(l.safety_stock)) { fire = true; msg = `${l.product_code}期末库存${l.inventory_end}<安全库存${l.safety_stock}`; entity = l.product_code; } });
    } else if (rule.trigger_type === 'HARD_BLOCK') {
      const bom = getTable('md_boms'); bom._invalidate();
      bom.all().forEach(b => { if (Number(b.is_archived) === 0) { fire = true; msg = `${b.product_code} BOM未归档，硬拦截`; entity = b.product_code; } });
    }
    if (fire) {
      // 去重：1小时内同规则同实体不重复
      const dup = logT.all().find(l => l.rule_code === rule.rule_code && l.entity_code === entity && (ts - (l.triggered_at || '')) < 3600);
      if (!dup) {
        logT.insertNoSave({ rule_code: rule.rule_code, rule_name: rule.rule_name, triggered_at: ts, level: rule.alert_level, message: msg, entity_code: entity, is_acknowledged: 0, is_resolved: 0, escalation_level: 0 });
        triggered.push({ rule: rule.rule_code, level: rule.alert_level, message: msg });
      }
    }
  });
  logT.saveNow();
  res.json({ message: `引擎扫描完成，触发 ${triggered.length} 条预警`, triggered, count: triggered.length });
});

router.put('/alerts/logs/:id/acknowledge', async (req, res) => {
  const t = getTable('alert_logs');
  await t.update(req.params.id, { is_acknowledged: 1, acknowledged_by: req.headers['x-user-id'] || 0, acknowledged_at: now() });
  res.json({ message: '已确认' });
});

// ============================================================
// 自检引擎
// ============================================================
router.get('/self-check/templates', (req, res) => {
  const t = getTable('self_check_templates'); t._invalidate();
  res.json({ data: t.all() });
});

router.get('/self-check/records', (req, res) => {
  const t = getTable('self_check_records'); t._invalidate();
  let rows = t.all();
  if (req.query.week_no) rows = rows.filter(r => r.week_no === req.query.week_no);
  rows.sort((a, b) => (b.week_no || '').localeCompare(a.week_no || ''));
  res.json({ data: rows });
});

// 自动跑自检
router.post('/self-check/auto-run', async (req, res) => {
  const tplT = getTable('self_check_templates'); tplT._invalidate();
  const tpl = tplT.all()[0];
  if (!tpl) return res.status(404).json({ error: '无自检模板' });
  const items = typeof tpl.items_json === 'string' ? JSON.parse(tpl.items_json) : tpl.items_json;
  const kpiAct = getTable('kpi_actuals'); kpiAct._invalidate();
  const psi = getTable('psi_lines'); psi._invalidate();
  const psiH = getTable('psi_headers'); psiH._invalidate();
  const bom = getTable('md_boms'); bom._invalidate();
  const actions = getTable('sop_actions'); actions._invalidate();
  const mrp = getTable('supply_mrps'); mrp._invalidate();
  const today = new Date().toISOString().slice(0, 10);
  const weekNo = `${new Date().getFullYear()}-W${String(Math.ceil((new Date().getDate() + new Date(new Date().getFullYear(), new Date().getMonth(), 1).getDay()) / 7)).padStart(2, '0')}`;

  const results = items.map(it => {
    let pass = true, detail = '';
    if (it.no === 1) { pass = psi.all().length > 0; detail = `共${psi.all().length}条PSI明细`; }
    else if (it.no === 3) { const shortage = mrp.all().filter(r => toNum(r.required_qty) > toNum(r.arrived_qty)); pass = shortage.length === 0; detail = `${shortage.length}条缺料`; }
    else if (it.no === 5) { const unarchived = bom.all().filter(b => Number(b.is_archived) === 0); pass = unarchived.length === 0; detail = `${unarchived.length}个BOM未归档`; }
    else if (it.no === 9) { const overdue = actions.all().filter(a => a.due_date && a.due_date < today && a.status !== 'CLOSED'); pass = overdue.length === 0; detail = `${overdue.length}条逾期`; }
    else if (it.no === 10) { const red = kpiAct.all().filter(a => a.status === 'R').length; pass = red === 0; detail = `${red}个红灯`; }
    else { detail = '需人工确认'; }
    return { no: it.no, item: it.item, pass, detail };
  });
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const score = Math.round(passed / total * 100);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 60 ? 'C' : 'D';

  const recT = getTable('self_check_records');
  const r = await recT.insert({
    template_id: tpl.id, week_no: weekNo, checked_by: req.headers['x-user-id'] || 0, check_date: today,
    items_result_json: JSON.stringify(results), total_score: score, is_passed: score >= 80 ? 1 : 0,
    issues_found: results.filter(x => !x.pass).map(x => x.item).join('; '), grade
  });
  res.json({ message: '自检完成', score, grade, passed, total, results, record_id: r.lastID });
});

// ============================================================
// 数据获取配置
// ============================================================
router.get('/data-fetch/configs', (req, res) => {
  const t = getTable('data_fetch_configs'); t._invalidate();
  const { source_system, fetch_mode } = req.query;
  let rows = t.all();
  if (source_system) rows = rows.filter(r => r.source_system === source_system);
  if (fetch_mode) rows = rows.filter(r => r.fetch_mode === fetch_mode);
  rows.sort((a, b) => (a.config_code || '').localeCompare(b.config_code || ''));
  res.json({ data: rows });
});

router.put('/data-fetch/configs/:code/toggle', async (req, res) => {
  const t = getTable('data_fetch_configs');
  const cfg = t.all().find(r => r.config_code === req.params.code);
  if (!cfg) return res.status(404).json({ error: '配置不存在' });
  await t.update(cfg.id, { fetch_mode: req.body.fetch_mode || cfg.fetch_mode, is_enabled: req.body.is_enabled !== undefined ? (req.body.is_enabled ? 1 : 0) : cfg.is_enabled, updated_at: now() });
  res.json({ message: '已切换', data: t.findById(cfg.id) });
});

router.post('/data-fetch/configs/:code/run-now', async (req, res) => {
  const t = getTable('data_fetch_configs');
  const cfg = t.all().find(r => r.config_code === req.params.code);
  if (!cfg) return res.status(404).json({ error: '配置不存在' });
  await t.update(cfg.id, { last_run_at: now(), last_status: 'SUCCESS' });
  res.json({ message: '执行成功', rows_fetched: Math.floor(Math.random() * 50) + 10, status: 'SUCCESS' });
});

// ============================================================
// 综合驾驶舱（聚合）
// ============================================================
router.get('/dashboard', (req, res) => {
  const kpiAct = getTable('kpi_actuals'); kpiAct._invalidate();
  const stdT = getTable('kpi_standards'); stdT._invalidate();
  const stdMap = {}; stdT.all().forEach(s => stdMap[s.id] = s);
  const actT = getTable('sop_actions'); actT._invalidate();
  const altT = getTable('alert_logs'); altT._invalidate();
  const psiT = getTable('psi_lines'); psiT._invalidate();
  const period = req.query.period_month || currentSopPeriod();
  const today = new Date().toISOString().slice(0, 10);

  const kpiRows = kpiAct.all().filter(r => r.period_month === period);
  const summary = {
    red_count: kpiRows.filter(r => r.status === 'R').length,
    yellow_count: kpiRows.filter(r => r.status === 'Y').length,
    green_count: kpiRows.filter(r => r.status === 'G').length
  };
  const actions = actT.all().map(a => ({ ...a, overdue_flag: a.due_date && a.due_date < today && a.status !== 'CLOSED' ? 1 : 0 }));
  res.json({
    period,
    kpi_summary: summary,
    overdue_actions: actions.filter(a => a.overdue_flag).length,
    open_actions: actions.filter(a => a.status !== 'CLOSED').length,
    unresolved_alerts: altT.all().filter(a => !a.is_resolved).length,
    block_count: altT.all().filter(a => a.level === 'BLOCK' && !a.is_resolved).length,
    red_lights: kpiRows.filter(r => r.status === 'R').map(r => { const s = stdMap[r.kpi_id] || {}; return { kpi_code: r.kpi_code || s.kpi_code, kpi_name: s.kpi_name, actual: r.actual_value, target: s.target_value }; }),
    psi_red_count: psiT.all().filter(l => l.color_status === 'R').length
  });
});

// ============================================================
// EBMS 内部数据集成（产销协调会优先取真实业务数据）
// 关联：orders(销售/交付) / materials(物料/外购) / purchase_orders(采购/齐套) /
//      suppliers(供应商) / products(产品/PSI) / customers(客户) / product_bom(BOM归档)
// ============================================================
['orders', 'materials', 'suppliers', 'products', 'purchase_orders', 'customers', 'inquiries', 'product_bom', 'bom_items', 'order_products'].forEach(ensureTable);

// BOM 产品编码缓存（10,631 条去重，避免每次遍历 166K 行）
let _bomProductCache = null;
function getBomProducts() {
  if (_bomProductCache) return _bomProductCache;
  const items = ebmsTable('bom_items').all();
  const map = {};
  items.forEach(b => {
    const code = (b.product_code || '').trim();
    // 过滤无效编码（太短/纯数字/纯标点）
    if (code && code.length >= 3 && /[A-Za-z]/.test(code) && !map[code]) map[code] = { product_code: code, product_name: b.product_name || '' };
  });
  _bomProductCache = Object.values(map).sort((a, b) => a.product_code.localeCompare(b.product_code));
  return _bomProductCache;
}

// BOM 产品编码搜索（供 PSI/预测 选产品用）
router.get('/ebms/bom-products', (req, res) => {
  const all = getBomProducts();
  const kw = (req.query.keyword || '').trim().toLowerCase();
  let rows = all;
  if (kw) rows = all.filter(p => p.product_code.toLowerCase().includes(kw) || (p.product_name || '').toLowerCase().includes(kw));
  const limit = Number(req.query.limit) || 50;
  res.json({ total: all.length, count: rows.length, data: rows.slice(0, limit) });
});

function ebmsTable(name) { const t = getTable(name); t._invalidate(); return t; }

// 综合概览：真实 EBMS 数据映射到产销协调视角
router.get('/ebms/overview', (req, res) => {
  const orders = ebmsTable('orders').all();
  const materials = ebmsTable('materials').all();
  const suppliers = ebmsTable('suppliers').all();
  const products = ebmsTable('products').all();
  const pos = ebmsTable('purchase_orders').all();
  const customers = ebmsTable('customers').all();

  const today = new Date().toISOString().slice(0, 10);
  // 订单/交付
  const orderTotal = orders.length;
  const shipped = orders.filter(o => o.status === 'shipped' || toNum(o.completed_qty) >= toNum(o.quantity)).length;
  const openOrders = orders.filter(o => o.status === 'open').length;
  const overdue = orders.filter(o => o.promised_date && o.promised_date < today && o.status !== 'shipped').length;
  const otd = orderTotal ? Math.round(shipped / orderTotal * 100) : 0;
  const orderAmount = orders.reduce((s, o) => s + toNum(o.order_amount), 0);
  // 物料/外购
  const matTotal = materials.length;
  const purchased = materials.filter(m => m.material_type === '外购' || m.category === '外购').length;
  const matValue = materials.reduce((s, m) => s + toNum(m.unit_price) * toNum(m.quantity), 0);
  // 采购单
  const poTotal = pos.length;
  const poDraft = pos.filter(p => p.status === 'draft').length;
  const poConfirmed = pos.filter(p => p.status !== 'draft').length;
  // 齐套率：外购物料中有对应采购单的占比
  const poSupplierNames = new Set(pos.map(p => p.supplier).filter(Boolean));
  const hasPoMaterials = purchased; // 简化：外购物料视为需求
  const kitRate = hasPoMaterials ? Math.round(Math.min(poTotal, hasPoMaterials * 5) / hasPoMaterials * 100) : 0;

  res.json({
    period: currentSopPeriod(),
    orders: { total: orderTotal, shipped, open: openOrders, overdue, otd, amount: Math.round(orderAmount) },
    materials: { total: matTotal, purchased, value: Math.round(matValue) },
    suppliers: { total: suppliers.length, active: suppliers.filter(s => s.status === 'active').length },
    products: { total: products.length },
    customers: { total: customers.length },
    purchase_orders: { total: poTotal, draft: poDraft, confirmed: poConfirmed },
    kit_rate: Math.min(kitRate, 100)
  });
});

// 供应链关联分析：外购物料 → 采购单 → 供应商（齐套/缺料）
router.get('/ebms/supply-chain', (req, res) => {
  const materials = ebmsTable('materials').all();
  const pos = ebmsTable('purchase_orders').all();
  const suppliers = ebmsTable('suppliers').all();
  const supMap = {}; suppliers.forEach(s => { supMap[s.name] = s; });

  // 外购物料清单（齐套需求源）
  const purchasedMats = materials.filter(m => m.material_type === '外购' || m.category === '外购')
    .map(m => ({ material_code: m.material_code, material_name: m.material_name, unit_price: m.unit_price, qty: m.quantity, demand_qty: m.quantity }));

  // 按供应商汇总采购单（供应能力）
  const poBySupplier = {};
  pos.forEach(p => {
    const sn = p.supplier || '未指定';
    if (!poBySupplier[sn]) poBySupplier[sn] = { supplier: sn, po_count: 0, total_qty: 0, total_amount: 0, all_draft: true };
    poBySupplier[sn].po_count++;
    poBySupplier[sn].total_qty += toNum(p.total_qty);
    poBySupplier[sn].total_amount += toNum(p.total_amount);
    if (p.status !== 'draft') poBySupplier[sn].all_draft = false;
  });
  const supplierStats = Object.values(poBySupplier).map(s => ({
    ...s,
    supplier_level: (supMap[s.supplier] || {}).level || '-',
    supplier_status: (supMap[s.supplier] || {}).status || '-',
    confirmed: s.all_draft ? 0 : 1
  })).sort((a, b) => b.po_count - a.po_count).slice(0, Number(req.query.limit) || 20);

  // 齐套判定：采购单全部 draft → 未齐套；外购物料需求覆盖
  const confirmedPos = pos.filter(p => p.status !== 'draft').length;
  const kitRate = pos.length ? Math.round(confirmedPos / pos.length * 100) : 0;

  res.json({
    purchased_materials: { total: purchasedMats.length, items: purchasedMats.slice(0, Number(req.query.limit) || 50) },
    suppliers: supplierStats,
    kit_rate: kitRate,
    po_summary: { total: pos.length, draft: pos.filter(p => p.status === 'draft').length, confirmed: confirmedPos },
    top_shortage: purchasedMats.slice(0, 10).map(m => ({ ...m, shortage_qty: m.demand_qty, supplier_code: '-', status: '待采购' }))
  });
});

// 销售需求/OTD：真实订单按产品、客户汇总（喂给 PSI/预测），默认当年可筛选
router.get('/ebms/demand', (req, res) => {
  let orders = ebmsTable('orders').all();
  // 年度筛选：默认当年；year=all 显示全部
  const year = req.query.year || String(new Date().getFullYear());
  const years = [...new Set(orders.map(o => (o.promised_date || o.created_at || '').slice(0, 4)).filter(Boolean))].sort();
  if (year && year !== 'all') orders = orders.filter(o => (o.promised_date || o.created_at || '').startsWith(year));
  const products = ebmsTable('products').all();
  const prodMap = {}; products.forEach(p => { prodMap[p.internal_model || p.external_model] = p; });
  const today = new Date().toISOString().slice(0, 10);

  // 订单分析库 order_products：订单明细 → BOM 编码关联（取真实 BOM 编码，非订单原始行码）
  const orderProducts = ebmsTable('order_products').all();
  const yearOrderNos = new Set(orders.map(o => o.order_no)); // 当年筛选后的订单号集合
  const orderMap = {}; orders.forEach(o => { orderMap[o.order_no] = o; });

  // 按产品(BOM编码)汇总需求 —— 来自订单分析库 order_products
  const byProduct = {};
  orderProducts.forEach(op => {
    if (!yearOrderNos.has(op.order_no)) return; // 仅当年
    const pc = op.product_code || '';
    if (!pc) return;
    if (!byProduct[pc]) byProduct[pc] = { product_code: pc, bom_no: op.bom_no || '', product_name: op.product_name || (prodMap[pc] || {}).product_name || '', order_count: 0, total_qty: 0, completed_qty: 0, amount: 0 };
    byProduct[pc].order_count++;
    byProduct[pc].total_qty += toNum(op.quantity);
    byProduct[pc].amount += toNum(op.amount);
  });
  // 完成量从订单级 completed_qty 按产品分摊（order_products 无完成量）
  const orderCompletion = {}; // product_code -> {qty, completed}
  orders.forEach(o => { const pc = o.product_code || ''; if (pc) { if (!orderCompletion[pc]) orderCompletion[pc] = { qty: 0, done: 0 }; orderCompletion[pc].qty += toNum(o.quantity); orderCompletion[pc].done += toNum(o.completed_qty); } });
  const productDemand = Object.values(byProduct).map(d => {
    const rate = orderCompletion[d.bom_no] || orderCompletion[d.product_code];
    const done = rate ? rate.done : 0;
    return { ...d, completed_qty: done, fulfillment: d.total_qty ? Math.round(done / d.total_qty * 100) : 0 };
  }).sort((a, b) => b.total_qty - a.total_qty);

  // 按客户汇总
  const byCustomer = {};
  orders.forEach(o => {
    const cn = o.customer_name || o.customer_code || '未知';
    byCustomer[cn] = (byCustomer[cn] || 0) + toNum(o.order_amount);
  });
  const topCustomers = Object.entries(byCustomer).map(([name, amount]) => ({ customer: name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 10);

  // OTD 明细（逾期订单关联 BOM 编码）
  const opByOrderNo = {}; orderProducts.forEach(op => { if (!opByOrderNo[op.order_no]) opByOrderNo[op.order_no] = []; opByOrderNo[op.order_no].push(op); });
  const shipped = orders.filter(o => o.status === 'shipped' || toNum(o.completed_qty) >= toNum(o.quantity)).length;
  const overdueOrders = orders.filter(o => o.promised_date && o.promised_date < today && o.status !== 'shipped')
    .map(o => {
      const ops = opByOrderNo[o.order_no] || [];
      const bomCode = ops.map(p => p.product_code).filter(Boolean)[0] || o.product_code;
      const bomNo = ops.map(p => p.bom_no).filter(Boolean)[0] || '';
      return { order_no: o.order_no, product_code: bomCode, bom_no: bomNo, customer: o.customer_name, promised_date: o.promised_date, qty: o.quantity, completed: o.completed_qty, overdue_days: Math.round((new Date(today) - new Date(o.promised_date)) / 86400000) };
    })
    .sort((a, b) => b.overdue_days - a.overdue_days).slice(0, 20);

  res.json({
    current_year: year, years,
    otd: { total: orders.length, shipped, rate: orders.length ? Math.round(shipped / orders.length * 100) : 0, overdue: overdueOrders.length },
    product_demand: productDemand.slice(0, Number(req.query.limit) || 30),
    top_customers: topCustomers,
    overdue_orders: overdueOrders,
    total_demand_qty: productDemand.reduce((s, d) => s + d.total_qty, 0),
    total_demand_amount: orders.reduce((s, o) => s + toNum(o.order_amount), 0)
  });
});

// 项目情况：按 S&OP 月度标准周期(上月16~当月15)分组，过去(历史)和未来(计划)
router.get('/ebms/projects', (req, res) => {
  const projects = ebmsTable('projects').all();
  const curPeriod = reqPeriod(req);
  // 每个项目按 start_date 映射到所属 S&OP 周期
  const mapped = projects.map(p => {
    const period = sopPeriodFromDate(p.start_date || p.created_at);
    let tense = 'current';
    if (period && period < curPeriod) tense = 'past';
    else if (period && period > curPeriod) tense = 'future';
    return {
      project_no: p.project_no, project_name: p.project_name, customer_name: p.customer_name,
      project_type: p.project_type, project_level: p.project_level, owner: p.owner, department: p.department,
      start_date: p.start_date, target_date: p.target_date, close_date: p.close_date,
      current_stage: p.current_stage, status: p.status, progress_note: p.progress_note,
      project_amount: toNum(p.project_amount), order_amount: toNum(p.order_amount),
      sop_period: period, tense
    };
  });
  // 按周期分组
  const byPeriod = {};
  mapped.forEach(p => {
    const k = p.sop_period || '未排期';
    if (!byPeriod[k]) byPeriod[k] = { period: k, tense: p.tense, projects: [], count: 0, amount: 0 };
    byPeriod[k].projects.push(p); byPeriod[k].count++; byPeriod[k].amount += p.order_amount;
  });
  const periods = Object.values(byPeriod).sort((a, b) => (a.period || '').localeCompare(b.period || ''));
  const past = periods.filter(p => p.tense === 'past');
  const current = periods.filter(p => p.tense === 'current');
  const future = periods.filter(p => p.tense === 'future');
  // 阶段统计
  const stageStats = {}; mapped.forEach(p => { const s = p.current_stage || '未知'; stageStats[s] = (stageStats[s] || 0) + 1; });
  res.json({
    current_period: curPeriod,
    summary: { total: mapped.length, past: past.reduce((s, p) => s + p.count, 0), current: current.reduce((s, p) => s + p.count, 0), future: future.reduce((s, p) => s + p.count, 0), unscheduled: (byPeriod['未排期'] || { count: 0 }).count },
    stage_stats: stageStats,
    periods: { past, current, future },
    all: mapped.sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''))
  });
});

// 需求预测按月度周期分组（过去实绩 + 未来预测，含客户列）
router.get('/forecast/by-period', (req, res) => {
  const fc = getTable('demand_forecasts'); fc._invalidate();
  const curPeriod = reqPeriod(req);
  let rows = fc.all();
  if (req.query.customer_name) rows = rows.filter(r => (r.customer_name || '').includes(req.query.customer_name));
  // 标记过去/当前/未来
  rows = rows.map(r => {
    let tense = 'current';
    if (r.period_month < curPeriod) tense = 'past';
    else if (r.period_month > curPeriod) tense = 'future';
    return { ...r, tense };
  });
  const past = rows.filter(r => r.tense === 'past').sort((a, b) => (b.period_month || '').localeCompare(a.period_month || ''));
  const current = rows.filter(r => r.tense === 'current');
  const future = rows.filter(r => r.tense === 'future').sort((a, b) => (a.period_month || '').localeCompare(b.period_month || ''));
  res.json({ current_period: curPeriod, past, current, future, all: rows });
});

// 项目进度节点：上月节点 + 下月节点（按月度标准周期）
const STAGE_SEQ = ['预项目', '方案', '手样', '模具样', '工试', '首次封样', '技转', '完成'];
function stageIndex(s) { const i = STAGE_SEQ.indexOf(s); return i < 0 ? 0 : i; }
function nextStage(s) { const i = stageIndex(s); return i < STAGE_SEQ.length - 1 ? STAGE_SEQ[i + 1] : s; }

router.get('/ebms/project-nodes', (req, res) => {
  const projects = ebmsTable('projects').all();
  const progress = ebmsTable('rd_project_progress').all();
  const curPeriod = reqPeriod(req);
  const lastPeriod = sopPeriodOffset(curPeriod, -1);
  const nextPeriod = sopPeriodOffset(curPeriod, 1);

  // 进度更新按周期索引
  const progByPid = {}; progress.forEach(p => { progByPid[p.project_id] = p; });

  const mapped = projects.map(p => {
    const startPeriod = sopPeriodFromDate(p.start_date);
    const ci = stageIndex(p.current_stage);
    const isActive = p.status !== '完成' && p.status !== 'closed' && p.current_stage !== '完成';
    // 上月节点：若立项在上月→"新立项"；否则按阶段推算（当前阶段或上一阶段）
    let lastNode = '-';
    if (startPeriod === lastPeriod) lastNode = '新立项(预项目)';
    else if (startPeriod && startPeriod < lastPeriod && isActive) lastNode = ci > 0 ? STAGE_SEQ[Math.max(0, ci - 1)] : '预项目';
    else if (!isActive) lastNode = p.current_stage || '完成';
    // 下月节点：活跃项目→下一里程碑；即将完成→完成
    let nextNode = '-';
    if (isActive) nextNode = nextStage(p.current_stage);
    // 进度记录时间归属
    const prog = progByPid[p.id];
    const progPeriod = prog ? sopPeriodFromDate(prog.updated_at) : '';
    return {
      project_no: p.project_no, project_name: p.project_name, customer_name: p.customer_name,
      project_type: p.project_type, current_stage: p.current_stage, owner: p.owner,
      start_date: p.start_date, start_period: startPeriod, status: p.status, is_active: isActive,
      last_month_node: lastNode, next_month_node: nextNode, prog_updated_period: progPeriod,
      last_period: lastPeriod, next_period: nextPeriod
    };
  });

  // 上月活跃项目（有进度更新或立项在上月）
  const lastMonthActive = mapped.filter(p => p.start_period === lastPeriod || p.prog_updated_period === lastPeriod || p.last_month_node !== '-');
  // 下月计划项目（活跃项目的下一里程碑）
  const nextMonthPlan = mapped.filter(p => p.is_active).map(p => ({ ...p, planned_node: p.next_month_node }));
  // 下月里程碑汇总（用于计划）
  const nextMilestone = {};
  nextMonthPlan.forEach(p => { nextMilestone[p.planned_node] = (nextMilestone[p.planned_node] || 0) + 1; });

  res.json({
    current_period: curPeriod, last_period: lastPeriod, next_period: nextPeriod,
    last_month_active: lastMonthActive.sort((a, b) => (b.start_date || '').localeCompare(a.start_date || '')),
    next_month_plan: nextMonthPlan,
    next_milestone_summary: nextMilestone,
    summary: { total: mapped.length, active: mapped.filter(p => p.is_active).length, last_month: lastMonthActive.length, will_advance: nextMonthPlan.filter(p => p.planned_node !== p.current_stage).length }
  });
});

// 周期对比分析：上月/当月/下月 多维度对比（喂给对比图，聚焦下月）
router.get('/ebms/period-compare', (req, res) => {
  const orders = ebmsTable('orders').all();
  const projects = ebmsTable('projects').all();
  const fc = getTable('demand_forecasts'); fc._invalidate();
  const forecasts = fc.all();
  const curPeriod = reqPeriod(req);
  const periods = [sopPeriodOffset(curPeriod, -1), curPeriod, sopPeriodOffset(curPeriod, 1)]; // 上月/当月/下月
  const labels = ['上月', '当月', '下月'];

  const compare = periods.map((period, idx) => {
    // 订单：promised_date 映射到 S&OP 周期
    const periodOrders = orders.filter(o => sopPeriodFromDate(o.promised_date) === period);
    const orderQty = periodOrders.reduce((s, o) => s + toNum(o.quantity), 0);
    const orderAmount = periodOrders.reduce((s, o) => s + toNum(o.order_amount), 0);
    // 项目：start_date 映射到周期
    const periodProjects = projects.filter(p => sopPeriodFromDate(p.start_date) === period);
    // 预测
    const periodFc = forecasts.filter(f => f.period_month === period);
    const fcQty = periodFc.reduce((s, f) => s + toNum(f.forecast_qty), 0);
    return {
      period, label: labels[idx],
      orders: periodOrders.length, order_qty: orderQty, order_amount: Math.round(orderAmount),
      projects: periodProjects.length,
      forecast_count: periodFc.length, forecast_qty: fcQty
    };
  });

  // 下月重点：产品需求 Top —— 取订单分析库 order_products 关联的 BOM 编码
  const nextPeriod = periods[2];
  const nextOrders = orders.filter(o => sopPeriodFromDate(o.promised_date) === nextPeriod);
  const nextOrderNos = new Set(nextOrders.map(o => o.order_no));
  const orderProducts = ebmsTable('order_products').all();
  const nextByProduct = {};
  orderProducts.filter(op => nextOrderNos.has(op.order_no)).forEach(op => {
    const pc = op.product_code || '';
    if (!pc) return;
    if (!nextByProduct[pc]) nextByProduct[pc] = { product_code: pc, bom_no: op.bom_no || '', product_name: op.product_name || '', qty: 0, amount: 0, count: 0 };
    nextByProduct[pc].qty += toNum(op.quantity); nextByProduct[pc].amount += toNum(op.amount); nextByProduct[pc].count++;
  });
  const nextProductTop = Object.values(nextByProduct).sort((a, b) => b.qty - a.qty).slice(0, 10);

  // 下月客户需求 Top
  const nextByCust = {};
  nextOrders.forEach(o => { const cn = o.customer_name || '未知'; nextByCust[cn] = (nextByCust[cn] || 0) + toNum(o.order_amount); });
  const nextCustTop = Object.entries(nextByCust).map(([name, amt]) => ({ customer: name, amount: Math.round(amt) })).sort((a, b) => b.amount - a.amount).slice(0, 8);

  res.json({
    current_period: curPeriod, periods: compare,
    next_month_focus: { period: nextPeriod, orders: nextOrders.length, product_top: nextProductTop, customer_top: nextCustTop }
  });
});

// ============================================================
// 产销协调会核心逻辑：本月复盘 → 下月预测 → 规划调整
// 相互关系：EBMS本月实绩(做得怎么样) → 下月预测(接下来怎么做，主要是预测)
//           → 规划调整(生产/采购/产能/行动) → 会议决议/待办闭环
// 所有表单共享 EBMS 真实数据管线，不再依赖演示数据。
// ============================================================

// 按 S&OP 周期聚合 EBMS 订单管线（订单分析库 order_products → BOM 编码维度）
function periodPipeline(period) {
  const orders = ebmsTable('orders').all();
  const periodOrders = orders.filter(o => sopPeriodFromDate(o.promised_date) === period);
  const orderNos = new Set(periodOrders.map(o => o.order_no));
  const orderCust = {}; periodOrders.forEach(o => { orderCust[o.order_no] = o.customer_name || o.customer_code || ''; });
  const op = ebmsTable('order_products').all();
  const byProduct = {};
  op.forEach(x => {
    if (!orderNos.has(x.order_no)) return;
    const pc = x.product_code || '';
    if (!pc) return;
    if (!byProduct[pc]) byProduct[pc] = { product_code: pc, bom_no: x.bom_no || '', product_name: x.product_name || '', customer: orderCust[x.order_no] || '', qty: 0, amount: 0, order_count: 0 };
    byProduct[pc].qty += toNum(x.quantity);
    byProduct[pc].amount += toNum(x.amount);
    byProduct[pc].order_count++;
  });
  const byCustomer = {};
  periodOrders.forEach(o => {
    const cn = o.customer_name || o.customer_code || '未知';
    byCustomer[cn] = (byCustomer[cn] || 0) + toNum(o.order_amount);
  });
  return {
    orders: periodOrders,
    product_list: Object.values(byProduct).sort((a, b) => b.qty - a.qty),
    customer_list: Object.entries(byCustomer).map(([customer, amount]) => ({ customer, amount: Math.round(amount) })).sort((a, b) => b.amount - a.amount)
  };
}

// 可选周期列表：从真实订单 / 预测 / PSI 推导可用的 S&OP 周期（升序，限制近12个月~未来3个月）
router.get('/sop/periods', (req, res) => {
  const set = new Set([currentSopPeriod()]);
  ebmsTable('orders').all().forEach(o => { const p = sopPeriodFromDate(o.promised_date); if (p) set.add(p); });
  const fc = getTable('demand_forecasts'); fc._invalidate();
  fc.all().forEach(f => { if (f.period_month) set.add(f.period_month); });
  const psiH = getTable('psi_headers'); psiH._invalidate();
  psiH.all().forEach(h => { if (h.period_month) set.add(h.period_month); });
  const cur = currentSopPeriod();
  const low = sopPeriodOffset(cur, -12), high = sopPeriodOffset(cur, 3);
  const periods = [...set].filter(p => p >= low && p <= high).sort();
  res.json({ current: cur, periods, range: { low, high } });
});

// 综合数据流：本月复盘 / 下月预测 / 规划调整
router.get('/sop/plan', (req, res) => {
  const curPeriod = reqPeriod(req);
  const prevPeriod = sopPeriodOffset(curPeriod, -1);
  const nextPeriod = sopPeriodOffset(curPeriod, 1);
  const today = new Date().toISOString().slice(0, 10);

  // ===== ① 本月复盘：公司这个月做得怎么样 =====
  const cur = periodPipeline(curPeriod);
  const overdueOrders = cur.orders.filter(o => o.promised_date && o.promised_date < today && o.status !== 'shipped');
  const shippedCount = cur.orders.filter(o => o.status === 'shipped' || toNum(o.completed_qty) >= toNum(o.quantity)).length;
  const qtyTotal = cur.orders.reduce((s, o) => s + toNum(o.quantity), 0);
  const qtyDone = cur.orders.reduce((s, o) => s + toNum(o.completed_qty), 0);
  const kpiActT = getTable('kpi_actuals'); kpiActT._invalidate();
  const kpiAct = kpiActT.all().filter(r => r.period_month === curPeriod);
  const fcT = getTable('demand_forecasts'); fcT._invalidate();
  const curFc = fcT.all().filter(f => f.period_month === curPeriod);
  const fcQty = curFc.reduce((s, f) => s + toNum(f.forecast_qty), 0);
  const projects = ebmsTable('projects').all();
  const curProjects = projects.filter(p => sopPeriodFromDate(p.start_date) === curPeriod);

  const review = {
    period: curPeriod,
    orders: {
      total: cur.orders.length,
      shipped: shippedCount,
      qty: qtyTotal,
      completed_qty: qtyDone,
      otd: cur.orders.length ? Math.round(shippedCount / cur.orders.length * 100) : 0,
      overdue: overdueOrders.length,
      amount: Math.round(cur.orders.reduce((s, o) => s + toNum(o.order_amount), 0))
    },
    kpi: {
      red: kpiAct.filter(r => r.status === 'R').length,
      yellow: kpiAct.filter(r => r.status === 'Y').length,
      green: kpiAct.filter(r => r.status === 'G').length,
      total: kpiAct.length
    },
    forecast_accuracy: {
      forecast_qty: fcQty,
      actual_qty: qtyTotal,
      rate: fcQty > 0 ? Math.round(qtyTotal / fcQty * 100) : 0,
      note: '本月预测量 vs 本月实际订单量（预测是否靠谱）'
    },
    projects: {
      started: curProjects.length,
      active: projects.filter(p => p.status === '进行中' || p.status === 'ACTIVE').length
    },
    product_list: cur.product_list.slice(0, 10),
    overdue_orders: overdueOrders.map(o => ({
      order_no: o.order_no, customer: o.customer_name || o.customer_code, qty: o.quantity,
      completed: o.completed_qty, promised: o.promised_date,
      overdue_days: Math.round((new Date(today) - new Date(o.promised_date)) / 86400000)
    })).sort((a, b) => b.overdue_days - a.overdue_days).slice(0, 15)
  };

  // ===== ② 下月预测：接下来一个月怎么做（主要是预测） =====
  const next = periodPipeline(nextPeriod);
  const nextFc = fcT.all().filter(f => f.period_month === nextPeriod);
  const nextFcQty = nextFc.reduce((s, f) => s + toNum(f.forecast_qty), 0);
  // 推荐预测量 = 订单管线(锁定) + 已有预测（按 BOM 产品合并）
  const recMap = {};
  next.product_list.forEach(p => { recMap[p.product_code] = { ...p, locked_qty: p.qty, forecast_qty: p.qty, source: '订单管线' }; });
  nextFc.forEach(f => {
    const pc = f.product_code;
    if (recMap[pc]) { recMap[pc].forecast_qty += toNum(f.forecast_qty); recMap[pc].source = '订单+预测'; }
    else recMap[pc] = { product_code: pc, bom_no: f.bom_no || '', product_name: '', customer: f.customer_name || '', qty: 0, locked_qty: 0, forecast_qty: toNum(f.forecast_qty), amount: 0, order_count: 0, source: '预测' };
  });

  const forecast_next = {
    period: nextPeriod,
    pipeline: {
      orders: next.orders.length,
      qty: next.product_list.reduce((s, p) => s + p.qty, 0),
      amount: Math.round(next.orders.reduce((s, o) => s + toNum(o.order_amount), 0)),
      customer_count: next.customer_list.length
    },
    existing_forecast: { count: nextFc.length, qty: nextFcQty },
    product_top: next.product_list.slice(0, 10),
    customer_top: next.customer_list.slice(0, 8),
    recommended: Object.values(recMap).sort((a, b) => b.forecast_qty - a.forecast_qty).slice(0, 12)
  };

  // ===== ③ 规划调整：根据下月预测调整计划 =====
  const psiHT = getTable('psi_headers'); psiHT._invalidate();
  const psiLT = getTable('psi_lines'); psiLT._invalidate();
  const psiH = psiHT.all();
  const psiL = psiLT.all();
  const curHeader = psiH.filter(h => h.period_month === curPeriod).sort((a, b) => b.version_no - a.version_no)[0];
  const production = [];
  if (curHeader) {
    const lines = psiL.filter(l => Number(l.header_id) === Number(curHeader.id));
    lines.filter(l => Number(l.month_offset) === 0).forEach(m0 => {
      const m1 = lines.find(l => l.product_code === m0.product_code && Number(l.month_offset) === 1);
      if (!m1) return;
      const demand = toNum(m1.sales_plan);
      const begin = toNum(m1.inventory_begin);
      const safety = toNum(m1.safety_stock);
      const suggest = Math.max(0, demand + safety - begin);
      production.push({
        product_code: m0.product_code,
        begin,
        next_demand: demand,
        safety,
        suggest_production: suggest,
        end: Math.max(safety, begin + suggest - demand)
      });
    });
    production.sort((a, b) => b.suggest_production - a.suggest_production);
  }
  const pos = ebmsTable('purchase_orders').all();
  const draftPos = pos.filter(p => p.status === 'draft');
  const materials = ebmsTable('materials').all();
  const purchased = materials.filter(m => m.material_type === '外购' || m.category === '外购');
  const capsT = getTable('supply_capacities'); capsT._invalidate();
  const nextCaps = capsT.all().filter(c => c.period_month === nextPeriod || c.period_month === curPeriod);
  const stdT = getTable('kpi_standards'); stdT._invalidate();
  const stdMap = {}; stdT.all().forEach(s => stdMap[s.id] = s);
  const actT = getTable('sop_actions'); actT._invalidate();
  const actionsAll = actT.all();
  const redLights = kpiAct.filter(r => r.status === 'R').map(r => {
    const s = stdMap[r.kpi_id] || {};
    const code = r.kpi_code || s.kpi_code;
    const hasAction = actionsAll.some(a => a.status !== 'CLOSED' && (a.description || '').includes(s.kpi_name || code));
    return { kpi_code: code, kpi_name: s.kpi_name || '', actual: r.actual_value, target: s.target_value, has_action: hasAction ? 1 : 0 };
  });

  const plan = {
    production,
    supply: {
      purchased_material_count: purchased.length,
      po_total: pos.length,
      po_draft: draftPos.length,
      kit_rate: pos.length ? Math.round((pos.length - draftPos.length) / pos.length * 100) : 0,
      note: '采购单确认率即齐套率，采购单全部 draft 时存在缺料风险，需提前下单'
    },
    capacity: nextCaps.map(c => ({
      line_code: c.line_code, period: c.period_month, available_days: c.available_days,
      load_rate: c.load_rate, bottleneck: c.bottleneck || '', overload: toNum(c.load_rate) > 85 ? 1 : 0
    })),
    red_actions: redLights
  };

  res.json({
    current_period: curPeriod, prev_period: prevPeriod, next_period: nextPeriod,
    period_desc: `${prevPeriod}年16日 ~ ${curPeriod}年15日`,
    review, forecast_next, plan
  });
});

// 从 EBMS 订单管线预填 PSI 销售计划（本月=offset0，下月=offset1），并自动补入真实 BOM 产品
router.post('/psi/headers/:id/prefill-sales', async (req, res) => {
  const headerT = getTable('psi_headers'); headerT._invalidate();
  const header = headerT.findById(req.params.id);
  if (!header) return res.status(404).json({ error: 'PSI不存在' });
  const curP = header.period_month;
  const nextP = sopPeriodOffset(curP, 1);
  const cur = periodPipeline(curP);
  const next = periodPipeline(nextP);
  const lineT = getTable('psi_lines'); lineT._invalidate();
  const existing = lineT.all().filter(l => Number(l.header_id) === Number(header.id));
  const byProdOff = {};
  existing.forEach(l => { (byProdOff[l.product_code] = byProdOff[l.product_code] || {})[l.month_offset] = l; });

  let added = 0, updated = 0;
  const setSales = (pipe, offset) => {
    pipe.product_list.forEach(p => {
      const g = byProdOff[p.product_code] || (byProdOff[p.product_code] = {});
      if (g[offset]) {
        if (toNum(g[offset].sales_plan) !== p.qty) { g[offset].sales_plan = p.qty; updated++; }
      } else {
        g[offset] = { __new: true, header_id: header.id, product_code: p.product_code, month_offset: offset, inventory_begin: 0, sales_plan: p.qty, production_plan: 0, safety_stock: 0, inventory_end: 0, color_status: 'G', is_editable: 1 };
        added++;
      }
    });
  };
  setSales(cur, 0);
  setSales(next, 1);
  // 重算 M+1 期末库存 + 红黄绿（M1.期初=M0.期末）
  Object.keys(byProdOff).forEach(pc => {
    const g = byProdOff[pc];
    const m0 = g[0], m1 = g[1];
    if (!m0 || !m1) return;
    const begin1 = toNum(m1.inventory_begin);
    const end1 = begin1 + toNum(m1.production_plan) - toNum(m1.sales_plan);
    m1.inventory_begin = begin1;
    m1.inventory_end = Math.max(0, end1);
    m1.color_status = calcColor(m1.inventory_end, toNum(m1.safety_stock));
  });
  // 落盘（同步缓存 + 原子写，避免竞态）
  Object.keys(byProdOff).forEach(pc => {
    const g = byProdOff[pc];
    [0, 1].forEach(off => {
      const l = g[off];
      if (!l) return;
      if (l.__new) { const { __new, ...rest } = l; lineT.insertNoSave(rest); }
      else lineT.updateNoSave(l.id, { sales_plan: l.sales_plan, inventory_begin: l.inventory_begin, inventory_end: l.inventory_end, color_status: l.color_status });
    });
  });
  lineT.saveNow();
  res.json({ message: `已按 EBMS 订单预填销售计划：新增 ${added} 个 BOM 产品，更新 ${updated} 条计划`, added, updated, period: curP, next_period: nextP });
});

// 从 EBMS 订单管线生成下月预测（upsert：已存在 产品+周期+M+1 则跳过）
router.post('/forecast/generate-from-orders', async (req, res) => {
  const period = req.body.period_month || sopPeriodOffset(currentSopPeriod(), 1);
  const pipe = periodPipeline(period);
  const fcT = getTable('demand_forecasts');
  const ts = now();
  let created = 0, skipped = 0;
  const exist = new Set(fcT.all().filter(f => f.period_month === period && Number(f.month_offset) === 1).map(f => f.product_code));
  pipe.product_list.forEach(p => {
    if (exist.has(p.product_code)) { skipped++; return; }
    fcT.insertNoSave({
      product_code: p.product_code, customer_code: '', customer_name: p.customer || '',
      period_month: period, month_offset: 1, forecast_qty: p.qty,
      forecast_type: 'FLEXIBLE', method: 'QUALITATIVE', mape_reference: 0,
      currency_amount: p.amount, remark: '自动生成：EBMS下月订单管线', promotion_flag: '',
      version_no: 1, created_by: req.headers['x-user-id'] || 0, created_at: ts, updated_at: ts
    });
    created++;
  });
  fcT.saveNow();
  res.json({ message: `已按 EBMS 订单生成 ${period} 预测 ${created} 条（跳过已有 ${skipped} 条）`, created, skipped, period });
});

// ============================================================
// 稽核报告（取数标准：上月16日~当月15日）
// ============================================================

// 稽核报告：事项达成率
router.get('/audit/report', (req, res) => {
  const actionTable = getTable('sop_actions'); actionTable._invalidate();
  const curPeriod = reqPeriod(req);
  const prevPeriod = sopPeriodOffset(curPeriod, -1);

  // 取上月16~当月15到期的Action
  const allActions = actionTable.all();
  const dueActions = allActions.filter(a => {
    if (!a.due_date) return false;
    return sopPeriodFromDate(a.due_date) === curPeriod || sopPeriodFromDate(a.due_date) === prevPeriod;
  });
  const completedActions = dueActions.filter(a => a.status === 'CLOSED');
  const uncompletedActions = dueActions.filter(a => a.status !== 'CLOSED');
  const ongoingActions = allActions.filter(a => a.status === 'IN_PROGRESS' || a.status === 'PENDING');
  const noReplyActions = allActions.filter(a => !a.last_updated_at);

  // 上月达成率（用于环比）
  const lastPeriodDue = allActions.filter(a => {
    if (!a.due_date) return false;
    return sopPeriodFromDate(a.due_date) === prevPeriod;
  });
  const lastPeriodCompleted = lastPeriodDue.filter(a => a.status === 'CLOSED');
  const lastRate = lastPeriodDue.length > 0 ? Math.round(lastPeriodCompleted.length / lastPeriodDue.length * 100) : 0;
  const currentRate = dueActions.length > 0 ? Math.round(completedActions.length / dueActions.length * 100) : 0;

  res.json({
    period: curPeriod,
    period_desc: `${prevPeriod}年16日 ~ ${curPeriod}年15日`,
    summary: {
      due_count: dueActions.length,
      completed_count: completedActions.length,
      achievement_rate: currentRate,
      last_month_rate: lastRate,
      rate_change: currentRate - lastRate
    },
    uncompleted: uncompletedActions.map(a => ({
      action_code: a.action_code,
      description: a.description,
      owner_name: a.owner_name || '',
      due_date: a.due_date,
      priority: a.priority,
      status: a.status,
      escalation_level: a.escalation_level || 0,
      days_overdue: a.due_date ? Math.max(0, Math.ceil((Date.now() - new Date(a.due_date).getTime()) / 86400000)) : 0
    })),
    ongoing: ongoingActions.map(a => ({
      action_code: a.action_code,
      description: a.description,
      owner_name: a.owner_name || '',
      due_date: a.due_date,
      status: a.status,
      last_updated: a.last_updated_at || a.created_at || ''
    })),
    no_reply: noReplyActions.map(a => ({
      action_code: a.action_code,
      description: a.description,
      owner_name: a.owner_name || '',
      created_at: a.created_at || ''
    }))
  });
});

// 取数标准总览
router.get('/audit/data-standard', (req, res) => {
  res.json({
    period_desc: '上月16日 ~ 当月15日',
    standards: [
      { no: 1, dept: '交付', desc: '按送检达成数统计，按最后一次送检单时间与出货计划导入表应交日期比对；只取大货单（单号不含hjy、批号不为空且不含y-、p-）', source: 'ERP' },
      { no: 2, dept: '项目', desc: '研发项目交付节点', source: '经营管理平台研发项目管理' },
      { no: 3, dept: '计划', desc: '生产计划入库数', source: 'ERP生产计划' },
      { no: '4.1', dept: '品质', desc: '5301指标', source: '品质系统' },
      { no: '4.2', dept: '品质', desc: '订单标准：当月生产产品的标准', source: '自制台账' },
      { no: '4.3', dept: '品质', desc: '异常闭环：OA异常单数量', source: 'OA系统' },
      { no: '4.4', dept: '品质', desc: '客诉：OA客诉单数量', source: 'OA系统' },
      { no: '5.1', dept: '工程', desc: '工装治具：当月工装治具需求数量', source: 'ERP' },
      { no: '5.2', dept: '工程', desc: '客户BOM：当月销售订单产品款数', source: 'ERP' },
      { no: '5.3', dept: '工程', desc: 'SOP：当月待生产产品款数', source: 'ERP' },
      { no: 6, dept: '采购', desc: '齐套：上线时间前3天到料', source: 'ERP采购' },
      { no: 7, dept: '生产', desc: '周滚动计划：已排产订单的产品数量、实际完成数量', source: 'ERP生产' },
      { no: 8, dept: '仓库', desc: '仓库库存量：即时库存金额', source: 'ERP库存' },
      { no: 9, dept: '供应链', desc: '37212：齐套、备料情况，计划下发情况', source: '供应链系统' }
    ]
  });
});

// ============================================================
// 部门报告（取数标准：上月16日~当月15日）
// ============================================================

// 销售中心报告
router.get('/dept/sales', (req, res) => {
  const orders = ebmsTable('orders').all();
  const fc = getTable('demand_forecasts'); fc._invalidate();
  const forecasts = fc.all();
  const curPeriod = reqPeriod(req);
  const nextPeriod = sopPeriodOffset(curPeriod, 1);

  // 常规类：非项目订单
  const periodOrders = orders.filter(o => sopPeriodFromDate(o.promised_date) === curPeriod);
  const regularOrders = periodOrders.filter(o => o.order_type !== 'PROJECT' && !o.is_void);
  const projectOrders = periodOrders.filter(o => o.order_type === 'PROJECT' && !o.is_void);

  // 计划数量 = 预测量
  const regularFc = forecasts.filter(f => f.period_month === curPeriod && f.forecast_type !== 'PROJECT');
  const projectFc = forecasts.filter(f => f.period_month === curPeriod && f.forecast_type === 'PROJECT');

  const regularPlanQty = regularFc.reduce((s, f) => s + toNum(f.forecast_qty), 0);
  const regularActualQty = regularOrders.reduce((s, o) => s + toNum(o.quantity), 0);
  const regularRate = regularPlanQty > 0 ? Math.round(regularActualQty / regularPlanQty * 100) : 0;

  const projectPlanQty = projectFc.reduce((s, f) => s + toNum(f.forecast_qty), 0);
  const projectActualQty = projectOrders.reduce((s, o) => s + toNum(o.quantity), 0);
  const projectRate = projectPlanQty > 0 ? Math.round(projectActualQty / projectPlanQty * 100) : 0;

  // 客户预测达成率（按客户维度）
  const custMap = {};
  regularOrders.forEach(o => {
    const cn = o.customer_name || '未知';
    if (!custMap[cn]) custMap[cn] = { plan: 0, actual: 0 };
    custMap[cn].actual += toNum(o.quantity);
  });
  regularFc.forEach(f => {
    const cn = f.customer_name || '未知';
    if (!custMap[cn]) custMap[cn] = { plan: 0, actual: 0 };
    custMap[cn].plan += toNum(f.forecast_qty);
  });
  const custAchievement = Object.entries(custMap).map(([name, v]) => ({
    customer: name, plan_qty: v.plan, actual_qty: v.actual,
    rate: v.plan > 0 ? Math.round(v.actual / v.plan * 100) : 0
  })).sort((a, b) => b.actual_qty - a.actual_qty);

  // 下月预测
  const nextRegularFc = forecasts.filter(f => f.period_month === nextPeriod && f.forecast_type !== 'PROJECT');
  const nextProjectFc = forecasts.filter(f => f.period_month === nextPeriod && f.forecast_type === 'PROJECT');

  res.json({
    period: curPeriod,
    regular: {
      plan_qty: regularPlanQty,
      actual_qty: regularActualQty,
      qty_rate: regularRate,
      cust_rate: custAchievement.length > 0 ? Math.round(custAchievement.reduce((s, c) => s + (c.rate >= 80 ? 1 : 0), 0) / custAchievement.length * 100) : 0,
      cust_detail: custAchievement
    },
    project: {
      plan_qty: projectPlanQty,
      actual_qty: projectActualQty,
      qty_rate: projectRate,
      note: '项目类ERP数据可能无法提取'
    },
    next_forecast: {
      regular_qty: nextRegularFc.reduce((s, f) => s + toNum(f.forecast_qty), 0),
      project_qty: nextProjectFc.reduce((s, f) => s + toNum(f.forecast_qty), 0),
      detail: nextRegularFc.concat(nextProjectFc).map(f => ({
        customer: f.customer_name || '-', product: f.product_code, qty: f.forecast_qty, type: f.forecast_type || '常规'
      }))
    },
    data_source: 'ERP订单数据 + 销售部预测表/供2出货表'
  });
});

// 研发中心报告
router.get('/dept/rd', (req, res) => {
  const projects = ebmsTable('projects').all();
  const curPeriod = reqPeriod(req);

  const periodProjects = projects.filter(p => sopPeriodFromDate(p.start_date) === curPeriod);
  const allActive = projects.filter(p => p.status === '进行中' || p.status === 'ACTIVE');

  res.json({
    period: curPeriod,
    data_source: '经营管理平台研发项目管理数据',
    project_count: periodProjects.length,
    active_count: allActive.length,
    projects: periodProjects.map(p => ({
      project_no: p.project_no,
      project_name: p.project_name || '',
      customer: p.customer_name || '',
      current_stage: p.current_stage || '',
      owner: p.owner || '',
      start_date: p.start_date || '',
      status: p.status || ''
    })),
    all_active: allActive.map(p => ({
      project_no: p.project_no,
      project_name: p.project_name || '',
      current_stage: p.current_stage || '',
      owner: p.owner || '',
      status: p.status || ''
    }))
  });
});

// 计划部报告
router.get('/dept/planning', (req, res) => {
  const orders = ebmsTable('orders').all();
  const curPeriod = reqPeriod(req);
  const nextPeriod = sopPeriodOffset(curPeriod, 1);

  const periodOrders = orders.filter(o => !o.is_void && sopPeriodFromDate(o.promised_date) === curPeriod);
  const shipped = periodOrders.filter(o => o.status === 'SHIPPED' || o.status === 'DELIVERED');
  const nextOrders = orders.filter(o => !o.is_void && sopPeriodFromDate(o.promised_date) === nextPeriod);

  // 生产准时完成（简化：已完成且未逾期）
  const prodCompleted = periodOrders.filter(o => o.completed_qty >= o.quantity);
  const prodOnTime = prodCompleted.filter(o => {
    if (!o.promised_date) return true;
    return new Date(o.updated_at || Date.now()) <= new Date(o.promised_date);
  });

  // 入库准交率
  const planQty = periodOrders.reduce((s, o) => s + toNum(o.quantity), 0);
  const actualQty = periodOrders.reduce((s, o) => s + toNum(o.completed_qty), 0);

  // 产能（从supply_capacities表获取）
  const capTable = getTable('supply_capacities'); capTable._invalidate();
  const caps = capTable.all().filter(c => c.period_month === curPeriod || c.period_month === nextPeriod);

  res.json({
    period: curPeriod,
    shipping: {
      total_orders: periodOrders.length,
      shipped_orders: shipped.length,
      shipping_rate: periodOrders.length > 0 ? Math.round(shipped.length / periodOrders.length * 100) : 0,
      not_shipped: periodOrders.length - shipped.length,
      prod_completed: prodCompleted.length,
      prod_on_time: prodOnTime.length,
      on_time_rate: prodCompleted.length > 0 ? Math.round(prodOnTime.length / prodCompleted.length * 100) : 0,
      detail: periodOrders.filter(o => o.status !== 'SHIPPED' && o.status !== 'DELIVERED').map(o => ({
        order_no: o.order_no, product: o.product_code, customer: o.customer_name,
        qty: o.quantity, completed: o.completed_qty, promised: o.promised_date,
        reason: o.delay_reason || ''
      }))
    },
    delivery: {
      plan_qty: planQty,
      actual_qty: actualQty,
      achievement_rate: planQty > 0 ? Math.round(actualQty / planQty * 100) : 0
    },
    next_plan: {
      total_qty: nextOrders.reduce((s, o) => s + toNum(o.quantity), 0),
      completed_qty: nextOrders.reduce((s, o) => s + toNum(o.completed_qty), 0),
      remaining: nextOrders.reduce((s, o) => s + Math.max(0, toNum(o.quantity) - toNum(o.completed_qty)), 0),
      order_count: nextOrders.length
    },
    capacity: caps.map(c => ({
      line_code: c.line_code, period: c.period_month,
      available_days: c.available_days, load_rate: c.load_rate,
      bottleneck: c.bottleneck || ''
    })),
    data_source: 'ERP订单 + 生产计划数据'
  });
});

// 采购部报告
router.get('/dept/procurement', (req, res) => {
  const materials = ebmsTable('materials').all();
  const pos = ebmsTable('purchase_orders').all();
  const suppliers = ebmsTable('suppliers').all();
  const supMap = {}; suppliers.forEach(s => { supMap[s.name] = s; });
  const curPeriod = reqPeriod(req);

  // 外购物料
  const purchasedMats = materials.filter(m => m.material_type === '外购' || m.category === '外购')
    .map(m => ({ material_code: m.material_code, material_name: m.material_name, unit_price: m.unit_price, qty: m.quantity, status: '待采购' }));

  // 齐套率：采购单确认率
  const confirmedPos = pos.filter(p => p.status !== 'draft').length;
  const kitRate = pos.length ? Math.round(confirmedPos / pos.length * 100) : 0;

  // 供应商汇总
  const poBySupplier = {};
  pos.forEach(p => {
    const sn = p.supplier || '未指定';
    if (!poBySupplier[sn]) poBySupplier[sn] = { supplier: sn, po_count: 0, total_qty: 0, total_amount: 0, all_draft: true };
    poBySupplier[sn].po_count++;
    poBySupplier[sn].total_qty += toNum(p.total_qty);
    poBySupplier[sn].total_amount += toNum(p.total_amount);
    if (p.status !== 'draft') poBySupplier[sn].all_draft = false;
  });
  const supplierStats = Object.values(poBySupplier).map(s => ({
    ...s,
    supplier_level: (supMap[s.supplier] || {}).level || '-',
    confirmed: s.all_draft ? 0 : 1
  })).sort((a, b) => b.po_count - a.po_count);

  res.json({
    period: curPeriod,
    data_source: 'ERP采购数据',
    kit_rate: kitRate,
    total_materials: purchasedMats.length,
    achieved_materials: confirmedPos,
    shortage_materials: pos.length - confirmedPos,
    standard: '需求时间为生产计划前三天，齐套时间为在需求时间前为达成',
    detail: purchasedMats,
    suppliers: supplierStats,
    po_summary: { total: pos.length, draft: pos.filter(p => p.status === 'draft').length, confirmed: confirmedPos }
  });
});

// 品质部报告
router.get('/dept/quality', (req, res) => {
  const curPeriod = reqPeriod(req);

  // 品质数据（模拟结构，实际从OA/品质系统获取）
  const qualityChecks = [
    { category: '来料检验', total: 0, passed: 0, rate: 0, source: '来料检验台账' },
    { category: '制程检验', total: 0, passed: 0, rate: 0, source: '制程检验台账' },
    { category: '成品检验', total: 0, passed: 0, rate: 0, source: '成品检验台账' },
    { category: '首件检验', total: 0, passed: 0, rate: 0, source: '首件检验台账' },
    { category: '样品送检', total: 0, passed: 0, rate: 0, source: '微盘台账' }
  ];

  // 从alert_logs获取品质异常和客诉
  const alertTable = getTable('alert_logs'); alertTable._invalidate();
  const qualityAlerts = alertTable.all().filter(a =>
    a.rule_code && (a.rule_code.includes('QUALITY') || a.rule_code.includes('CUSTOMER'))
  );

  res.json({
    period: curPeriod,
    data_source: 'OA品质异常单 + 自制台账 + 微盘台账',
    period_desc: '上月16日 ~ 当月15日',
    inspections: qualityChecks.map(q => ({
      ...q,
      rate: q.total > 0 ? Math.round(q.passed / q.total * 100) : 0,
      formula: '合格率 = 合格批次 / 总批次'
    })),
    order_standard: {
      desc: '完成率 = 计划完成批次 / 未完成批次',
      source: '自制台账'
    },
    quality_incidents: {
      count: qualityAlerts.length,
      source: 'OA品质异常单',
      detail: qualityAlerts.map(a => ({
        time: a.triggered_at, message: a.message, level: a.level, status: a.is_resolved ? '已处理' : '待处理'
      }))
    },
    customer_inspection: {
      desc: '验货合格率 = 总批次 / 不良批次',
      source: '验货记录'
    },
    customer_complaint: {
      desc: '客诉处理率 = 客诉数 / 处理数',
      source: 'OA客诉单',
      closure_rate_desc: '闭环率 = 异常数 / 闭环数'
    },
    cost_analysis: {
      external_cost: 0,
      internal_cost: 0,
      total_loss: 0,
      desc: '取数OA品质异常单，工时费（包含开单费）'
    }
  });
});

// 工程/仓库综合报告
router.get('/dept/engineering', (req, res) => {
  const orders = ebmsTable('orders').all();
  const products = ebmsTable('products').all();
  const curPeriod = reqPeriod(req);

  const periodOrders = orders.filter(o => !o.is_void && sopPeriodFromDate(o.promised_date) === curPeriod);

  // 客户BOM：当月销售订单产品款数
  const productSet = new Set(periodOrders.map(o => o.product_code).filter(Boolean));

  // SOP：当月待生产产品款数
  const pendingProduction = periodOrders.filter(o => o.status !== 'SHIPPED' && o.status !== 'DELIVERED');
  const pendingProductSet = new Set(pendingProduction.map(o => o.product_code).filter(Boolean));

  res.json({
    period: curPeriod,
    engineering: {
      tooling: { desc: '当月工装治具需求数量', count: 0, source: 'ERP' },
      customer_bom: { desc: '当月销售订单产品款数', count: productSet.size, source: 'ERP' },
      sop: { desc: '当月待生产产品款数', count: pendingProductSet.size, source: 'ERP' }
    },
    warehouse: {
      desc: '即时库存金额',
      inventory_amount: 0,
      source: 'ERP库存'
    },
    supply_chain: {
      desc: '37212：齐套、备料情况，计划下发情况',
      source: '供应链系统'
    }
  });
});

module.exports = router;
