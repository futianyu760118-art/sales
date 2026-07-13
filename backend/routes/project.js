const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { resolveDataScope, isInScope } = require('../data-scope');
const { resolveDataScopeV2, buildScopeFilter, combineFilter, logDataPermission } = require('../data-scope-v2');

// ==================== 研发项目主数据库 ====================
// 基于供22模版：1.研发项目数据库 + 7.研发项目数据库 + 3.研发数据库-24年

// 项目列表（支持筛选和排序）
router.get('/', requirePerm('project:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, status, customer, owner, project_type, level, sort_by, sort_order, start_from, start_to, target_from, target_to } = req.query;
  const table = getTable('projects');
  table._invalidate();
  let records = table.all();
  const scope = resolveDataScopeV2(req);
  const scopeLegacy = resolveDataScope(req);
  const scopeFilter = buildScopeFilter(scope, 'projects');
  if (scope.enabled) {
    records = records.filter(r => {
      if (scopeFilter(r)) return true;
      if (scopeLegacy.enabled && isInScope(scopeLegacy, r, { ownerField: 'owner' })) return true;
      return false;
    });
  } else if (scopeLegacy.enabled) {
    records = records.filter(r => isInScope(scopeLegacy, r, { ownerField: 'owner' }));
  }
  if (status) records = records.filter(r => r.status === status);
  if (customer) records = records.filter(r => (r.customer_name || '').includes(customer));
  if (owner) records = records.filter(r => (r.owner || '').includes(owner));
  if (project_type) records = records.filter(r => r.project_type === project_type);
  if (level) records = records.filter(r => r.project_level === level);
  if (keyword) {
    const kw = keyword.toLowerCase();
    records = records.filter(r => {
      const s = [r.project_no, r.project_name, r.customer_name, r.inquiry_no, r.product_code].join(' ').toLowerCase();
      return s.includes(kw);
    });
  }
  // 日期范围筛选
  if (start_from || start_to) {
    records = records.filter(r => {
      const d = r.start_date || '';
      if (start_from && d < start_from) return false;
      if (start_to && d > start_to) return false;
      return true;
    });
  }
  if (target_from || target_to) {
    records = records.filter(r => {
      const d = r.target_date || '';
      if (target_from && d < target_from) return false;
      if (target_to && d > target_to) return false;
      return true;
    });
  }
  // 排序
  const dir = sort_order === 'asc' ? 1 : -1;
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''));
  if (sort_by === 'project_no') records.sort((a,b) => dir * cmp(a.project_no, b.project_no));
  else if (sort_by === 'project_name') records.sort((a,b) => dir * cmp(a.project_name, b.project_name));
  else if (sort_by === 'customer_name') records.sort((a,b) => dir * cmp(a.customer_name, b.customer_name));
  else if (sort_by === 'owner') records.sort((a,b) => dir * cmp(a.owner, b.owner));
  else if (sort_by === 'current_stage') records.sort((a,b) => dir * cmp(a.current_stage, b.current_stage));
  else if (sort_by === 'invest_amount') records.sort((a,b) => dir * ((Number(a.invest_amount)||0) - (Number(b.invest_amount)||0)));
  else if (sort_by === 'order_amount') records.sort((a,b) => dir * ((Number(a.order_amount)||0) - (Number(b.order_amount)||0)));
  else if (sort_by === 'status') records.sort((a,b) => dir * cmp(a.status, b.status));
  else if (sort_by === 'start_date') records.sort((a,b) => dir * cmp(a.start_date, b.start_date));
  else if (sort_by === 'project_type') records.sort((a,b) => dir * cmp(a.project_type, b.project_type));
  else if (sort_by === 'project_level') records.sort((a,b) => dir * cmp(a.project_level, b.project_level));
  else records.sort((a, b) => (b.id || 0) - (a.id || 0));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  logDataPermission(req, 'project.list', { table: 'projects', count: total, scope_mode: scope.mode || 'none' });
  res.json({
    data, total, page: parseInt(page), limit: parseInt(limit),
    scope: scope.enabled
      ? { mode: scope.mode, label: labelScopeProject(scope.mode) }
      : { mode: 'none', label: '全部数据' }
  });
});

function labelScopeProject(mode) {
  return {
    all: '全部数据',
    self: '我的项目',
    dept: '本部门项目',
    dept_and_child: '本部门及下级部门项目',
    custom: '自定义范围项目',
    none: '全部数据'
  }[mode] || '全部数据';
}

// 统计概览
router.get('/stats', requirePerm('project:view'), (req, res) => {
  const table = getTable('projects');
  table._invalidate();
  const all = table.all();
  const byStatus = {};
  const byType = {};
  const byLevel = {};
  let totalAmount = 0, orderAmount = 0;
  all.forEach(p => {
    const st = p.status || 'init';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const tp = p.project_type || 'unknown';
    byType[tp] = (byType[tp] || 0) + 1;
    const lv = p.project_level || '';
    if (lv) byLevel[lv] = (byLevel[lv] || 0) + 1;
    totalAmount += Number(p.project_amount) || 0;
    orderAmount += Number(p.order_amount) || 0;
  });
  // 供应链异常统计
  const issueTable = getTable('rd_supply_issues');
  issueTable._invalidate();
  const issues = issueTable.all();
  const openIssues = issues.filter(i => i.closed !== 1).length;
  res.json({
    total: all.length,
    by_status: byStatus,
    by_type: byType,
    by_level: byLevel,
    total_amount: totalAmount,
    order_amount: orderAmount,
    open_issues: openIssues,
    total_issues: issues.length
  });
});

// 项目详情（含进度节点、复盘）
router.get('/:id', requirePerm('project:view'), (req, res) => {
  if (isNaN(Number(req.params.id))) return res.status(404).json({ error: '无效路径' });
  const table = getTable('projects');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '项目不存在' });
  const scope = resolveDataScopeV2(req);
  let ok = true;
  if (scope.enabled) {
    ok = buildScopeFilter(scope, 'projects')(row);
    if (!ok) {
      const scopeLegacy = resolveDataScope(req);
      if (scopeLegacy.enabled) ok = isInScope(scopeLegacy, row, { ownerField: 'owner' });
    }
  }
  if (!ok) return res.status(403).json({ error: '无访问该项目的权限', code: 'DATA_SCOPE_DENIED' });
  // 关联进度节点
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  row.progress = progTable.all().find(p => p.project_id === row.id) || null;
  // 关联复盘（支持 project_id 或 project_no 关联）
  const reviewTable = getTable('rd_project_reviews');
  reviewTable._invalidate();
  row.review = reviewTable.all().find(r => r.project_id === row.id || (row.project_no && r.project_no === row.project_no)) || null;
  logDataPermission(req, 'project.detail', { table: 'projects', record_id: row.id, scope_mode: scope.mode || 'none' });
  res.json(row);
});

// 新增项目
router.post('/', requirePerm('project:create'), (req, res) => {
  const table = getTable('projects');
  const b = req.body;
  if (!b.project_name) return res.status(400).json({ error: '项目名称必填' });
  const result = table.insert({
    project_no: b.project_no || '',
    project_name: b.project_name || '',
    customer_name: b.customer_name || '',
    project_type: b.project_type || '客制',
    project_level: b.project_level || '',
    urgency: b.urgency || '',
    owner: b.owner || '',
    department: b.department || '研发中心',
    start_date: b.start_date || '',
    target_date: b.target_date || '',
    close_date: b.close_date || '',
    current_stage: b.current_stage || '预项目',
    node_time: b.node_time || '',
    progress_note: b.progress_note || '',
    project_amount: Number(b.project_amount) || 0,
    order_amount: Number(b.order_amount) || 0,
    invest_amount: Number(b.invest_amount) || 0,
    annual_order: b.annual_order || '',
    market_date: b.market_date || '',
    status: b.status || 'init',
    audit_status: b.audit_status || '',
    gantt_link: b.gantt_link || '',
    doc_link: b.doc_link || '',
    remarks: b.remarks || '',
    change_count: Number(b.change_count) || 0,
    created_at: now(),
    updated_at: now()
  });
  const project = table.findById(result.lastID);
  // 自动创建进度节点记录
  const progTable = getTable('rd_project_progress');
  progTable.insert({
    project_id: project.id,
    plan: '', bom: '', spec: '', config: '', mold_drawing: '',
    mold_review: '', hand_sample: '', mold: '', mold_sample: '',
    packaging: '', elec_trial: '', rd_trial: '', eng_trial: '',
    prod_trial: '', test_report: '', tech_transfer: '',
    shipment: '', review: '', other: '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '创建成功', data: project });
});

// 更新项目
router.put('/:id', requirePerm('project:edit'), (req, res) => {
  const table = getTable('projects');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '项目不存在' });
  const fields = { updated_at: now() };
  const strFields = ['project_no','project_name','customer_name','project_type','project_level','urgency','owner','department','start_date','target_date','close_date','current_stage','node_time','progress_note','annual_order','market_date','status','audit_status','gantt_link','doc_link','remarks'];
  strFields.forEach(f => { if (req.body[f] !== undefined) fields[f] = req.body[f]; });
  // 关键文本字段自动 trim 首尾空格，防止统计分析分裂
  ['owner','customer_name','department','remarks','project_no','progress_note'].forEach(f => {
    if (fields[f] !== undefined && typeof fields[f] === 'string') fields[f] = fields[f].trim();
  });
  ['project_amount','order_amount','invest_amount'].forEach(f => { if (req.body[f] !== undefined) fields[f] = Number(req.body[f]) || 0; });
  // 变更次数跟踪：关键字段（目标日期/阶段/金额/等级/状态/日期）发生变化时自增
  if (req.body.change_count !== undefined) {
    // 允许手动校正
    fields.change_count = Number(req.body.change_count) || 0;
  } else {
    const keyChangeFields = ['target_date','close_date','start_date','current_stage','project_level','status','project_amount','invest_amount','order_amount'];
    const norm = v => String(v == null ? '' : v).trim();
    const changed = keyChangeFields.some(f => req.body[f] !== undefined && norm(req.body[f]) !== norm(existing[f]));
    if (changed) fields.change_count = (Number(existing.change_count) || 0) + 1;
  }
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

// 更新项目状态
router.put('/:id/status', requirePerm('project:edit'), (req, res) => {
  const table = getTable('projects');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  const fields = { status: req.body.status, updated_at: now() };
  // 仅在显式传入时更新阶段，避免单独改状态时误清空 current_stage
  if (req.body.current_stage !== undefined) fields.current_stage = req.body.current_stage;
  // 状态变化计入变更次数
  const existing = table.findById(req.params.id);
  if (existing && req.body.status !== undefined && String(req.body.status) !== String(existing.status)) {
    fields.change_count = (Number(existing.change_count) || 0) + 1;
  }
  table.update(req.params.id, fields);
  res.json({ message: '状态更新' });
});

// 删除项目（同时删除关联数据）
router.delete('/:id', requirePerm('project:delete'), (req, res) => {
  const table = getTable('projects');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  progTable.all().filter(p => p.project_id === Number(req.params.id)).forEach(p => progTable.delete(p.id));
  const reviewTable = getTable('rd_project_reviews');
  reviewTable._invalidate();
  reviewTable.all().filter(r => r.project_id === Number(req.params.id)).forEach(r => reviewTable.delete(r.id));
  res.json({ message: '删除成功' });
});

// 批量删除项目
router.post('/batch-delete', requirePerm('project:delete'), (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请提供要删除的项目ID列表' });
  const table = getTable('projects');
  const progTable = getTable('rd_project_progress');
  const reviewTable = getTable('rd_project_reviews');
  let deleted = 0;
  ids.forEach(id => {
    const numId = Number(id);
    if (table.findById(numId)) {
      table.delete(numId);
      progTable._invalidate();
      progTable.all().filter(p => p.project_id === numId).forEach(p => progTable.delete(p.id));
      reviewTable._invalidate();
      reviewTable.all().filter(r => r.project_id === numId).forEach(r => reviewTable.delete(r.id));
      deleted++;
    }
  });
  res.json({ message: `成功删除 ${deleted} 个项目`, deleted });
});

// ==================== 项目进度节点跟踪（技转跟踪） ====================
// 基于供22模版：工作表3 - 项目进度一览表

// 获取所有进度节点
router.get('/progress/list', requirePerm('project:view'), (req, res) => {
  const { project_id } = req.query;
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  let records = progTable.all();
  if (project_id) records = records.filter(r => r.project_id === Number(project_id));
  res.json({ data: records });
});

// 导入进度数据（通过项目编号/名称关联）
router.post('/progress', requirePerm('project:create'), (req, res) => {
  const b = req.body;
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();

  // 查找关联项目
  const projectsTable = getTable('projects');
  projectsTable._invalidate();
  let project = null;
  if (b.project_id) project = projectsTable.findById(b.project_id);
  if (!project && b.project_no) project = projectsTable.all().find(p => p.project_no === b.project_no);
  if (!project && b.project_name) project = projectsTable.all().find(p => p.project_name === b.project_name);

  if (!project) return res.status(400).json({ error: '未找到关联项目' });

  // 检查是否已存在进度记录
  let prog = progTable.all().find(p => p.project_id === project.id);
  if (prog) {
    const fields = { updated_at: now() };
    ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','appearance','structure','mold','mold_sample','packaging','elec_trial','rd_trial','tech_transfer','eng_trial','prod_trial','test_report','shipment','review','other'].forEach(f => {
      if (b[f] !== undefined) fields[f] = b[f];
    });
    progTable.update(prog.id, fields);
    return res.json({ message: '更新成功', updated: true });
  }

  const result = progTable.insert({
    project_id: project.id,
    plan: b.plan || '', bom: b.bom || '', spec: b.spec || '', config: b.config || '',
    mold_drawing: b.mold_drawing || '', mold_review: b.mold_review || '', hand_sample: b.hand_sample || '',
    mold: b.mold || '', mold_sample: b.mold_sample || '', packaging: b.packaging || '',
    elec_trial: b.elec_trial || '', rd_trial: b.rd_trial || '', eng_trial: b.eng_trial || '',
    prod_trial: b.prod_trial || '', test_report: b.test_report || '', tech_transfer: b.tech_transfer || '',
    shipment: b.shipment || '', review: b.review || '', other: b.other || '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '创建成功', data: progTable.findById(result.lastID) });
});
router.put('/:id/progress', requirePerm('project:edit'), (req, res) => {
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  let prog = progTable.all().find(p => p.project_id === Number(req.params.id));
  if (!prog) {
    // 自动创建
    const result = progTable.insert({ project_id: Number(req.params.id), created_at: now(), updated_at: now() });
    prog = progTable.findById(result.lastID);
  }
  const fields = { updated_at: now() };
  // 日期格式标准化函数
  const normDate = (v) => {
    const s = String(v);
    const m = s.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
    return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : v;
  };
  const isDateLike = (v) => /^\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}/.test(String(v));
  const nodeFields = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','appearance','structure','mold','mold_sample','packaging','elec_trial','rd_trial','tech_transfer','eng_trial','prod_trial','test_report','shipment','review','other'];
  let changedCount = 0;
  nodeFields.forEach(f => {
    if (req.body[f] !== undefined) {
      // 如果值是日期格式，标准化为 YYYY-MM-DD
      var newVal = isDateLike(req.body[f]) ? normDate(req.body[f]) : req.body[f];
      var oldVal = String(prog[f] || '').trim();
      // 标准化旧值再比较（避免日期格式差异导致误判）
      if (isDateLike(oldVal)) oldVal = normDate(oldVal);
      if (String(newVal).trim() !== oldVal) changedCount++;
      fields[f] = newVal;
    }
  });
  progTable.update(prog.id, fields);
  // 节点变更计入项目的变更次数（作为统计分析依据）
  if (changedCount > 0) {
    const projTable = getTable('projects');
    const project = projTable.findById(req.params.id);
    if (project) {
      var newChangeCount = (Number(project.change_count) || 0) + changedCount;
      projTable.update(project.id, { change_count: newChangeCount, updated_at: now() });
    }
  }
  res.json({ message: '进度更新成功', changes: changedCount });
});

// 删除单个进度记录（仅清除节点跟踪数据，不删除项目本身）
router.delete('/progress/:id', requirePerm('project:delete'), (req, res) => {
  const progTable = getTable('rd_project_progress');
  if (!progTable.findById(req.params.id)) return res.status(404).json({ error: '进度记录不存在' });
  progTable.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// 批量删除进度记录
router.post('/progress/batch-delete', requirePerm('project:delete'), (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请提供要删除的进度记录ID列表' });
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  let deleted = 0;
  ids.forEach(id => {
    const numId = Number(id);
    if (progTable.findById(numId)) { progTable.delete(numId); deleted++; }
  });
  res.json({ message: `成功删除 ${deleted} 条进度记录`, deleted });
});

// 进度记录去重：同一项目编号(project_no)仅保留一条（合并非空字段，删除冗余）
router.post('/progress/dedup', requirePerm('project:delete'), (req, res) => {
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  const all = progTable.all();
  const totalCount = all.length;
  // 构建 project_id -> project_no 映射
  const projectsTable = getTable('projects');
  projectsTable._invalidate();
  const pNoMap = {};
  projectsTable.all().forEach(p => { pNoMap[p.id] = (p.project_no || '').trim(); });
  const nodeFields = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','appearance','structure','mold','mold_sample','packaging','elec_trial','rd_trial','tech_transfer','eng_trial','prod_trial','test_report','shipment','review','other'];
  const isEmpty = v => !v || ['','/','-','0'].includes(String(v).trim());
  const completeness = rec => nodeFields.reduce((n, f) => n + (isEmpty(rec[f]) ? 0 : 1), 0);

  // 按项目编号分组（跳过无项目编号的记录）
  const groups = {};
  all.forEach(rec => {
    const pno = pNoMap[rec.project_id];
    if (!pno) return;
    if (!groups[pno]) groups[pno] = [];
    groups[pno].push(rec);
  });

  let deletedCount = 0, mergedCount = 0, groupCount = 0;
  Object.values(groups).forEach(group => {
    if (group.length <= 1) return;
    groupCount++;
    group.sort((a, b) => completeness(b) - completeness(a) || (b.id - a.id));
    const keeper = group[0];
    let merged = false;
    nodeFields.forEach(f => {
      if (isEmpty(keeper[f])) {
        for (let i = 1; i < group.length; i++) {
          if (!isEmpty(group[i][f])) { keeper[f] = group[i][f]; merged = true; break; }
        }
      }
    });
    if (merged) {
      const fields = { updated_at: now() };
      nodeFields.forEach(f => { fields[f] = keeper[f]; });
      progTable.update(keeper.id, fields);
      mergedCount++;
    }
    for (let i = 1; i < group.length; i++) {
      progTable.delete(group[i].id);
      deletedCount++;
    }
  });

  res.json({
    message: `去重完成：处理 ${groupCount} 组重复，合并 ${mergedCount} 条，删除 ${deletedCount} 条冗余`,
    groups: groupCount, merged: mergedCount, deleted: deletedCount,
    before: totalCount, after: totalCount - deletedCount
  });
});

// ==================== 供应链品质异常 ====================
// 基于供22模版：供应链项目进度表

router.get('/supply-issues/list', requirePerm('project:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, closed } = req.query;
  const table = getTable('rd_supply_issues');
  table._invalidate();
  let records = table.all();
  if (closed !== undefined) records = records.filter(r => r.closed === Number(closed));
  if (keyword) {
    const kw = keyword.toLowerCase();
    records = records.filter(r => {
      const s = [r.product_name, r.order_no, r.project_no, r.problem_desc, r.proposer].join(' ').toLowerCase();
      return s.includes(kw);
    });
  }
  records.sort((a, b) => (b.id || 0) - (a.id || 0));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/supply-issues', requirePerm('project:create'), (req, res) => {
  const table = getTable('rd_supply_issues');
  const b = req.body;
  const result = table.insert({
    occur_date: b.occur_date || now().substring(0, 10),
    proposer: b.proposer || '',
    product_name: b.product_name || '',
    order_no: b.order_no || '',
    project_no: b.project_no || '',
    problem_desc: b.problem_desc || '',
    temp_measure: b.temp_measure || '',
    cause_analysis: b.cause_analysis || '',
    long_term_measure: b.long_term_measure || '',
    long_term_date: b.long_term_date || '',
    responsible_person: b.responsible_person || '',
    responsible_dept: b.responsible_dept || '',
    plan_complete_date: b.plan_complete_date || '',
    audit: b.audit || '',
    closed: 0,
    remarks: b.remarks || '',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '创建成功', data: table.findById(result.lastID) });
});

router.put('/supply-issues/:id', requirePerm('project:edit'), (req, res) => {
  const table = getTable('rd_supply_issues');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  const fields = { updated_at: now() };
  ['occur_date','proposer','product_name','order_no','project_no','problem_desc','temp_measure','cause_analysis','long_term_measure','long_term_date','responsible_person','responsible_dept','plan_complete_date','audit','remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  if (req.body.closed !== undefined) fields.closed = Number(req.body.closed);
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

router.delete('/supply-issues/:id', requirePerm('project:delete'), (req, res) => {
  const table = getTable('rd_supply_issues');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// ==================== 销售推广进度 ====================
// 基于供22模版：销售项目推广进度表

router.get('/sales-promotion/list', requirePerm('project:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, product_model } = req.query;
  const table = getTable('rd_sales_promotion');
  table._invalidate();
  let records = table.all();
  if (product_model) records = records.filter(r => r.product_model === product_model);
  if (keyword) {
    const kw = keyword.toLowerCase();
    records = records.filter(r => {
      const s = [r.product_model, r.salesperson, r.customer, r.appearance, r.price, r.performance, r.function_feedback, r.progress, r.project_no, r.remarks].join(' ').toLowerCase();
      return s.includes(kw);
    });
  }
  records.sort((a, b) => (b.id || 0) - (a.id || 0));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/sales-promotion', requirePerm('project:create'), (req, res) => {
  const table = getTable('rd_sales_promotion');
  const b = req.body;
  const result = table.insert({
    project_no: b.project_no || '',
    product_model: b.product_model || '',
    salesperson: b.salesperson || '',
    customer: b.customer || '',
    appearance: b.appearance || '',
    price: b.price || '',
    performance: b.performance || '',
    function_feedback: b.function_feedback || '',
    progress: b.progress || '',
    remarks: b.remarks || '',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '创建成功', data: table.findById(result.lastID) });
});

router.put('/sales-promotion/:id', requirePerm('project:edit'), (req, res) => {
  const table = getTable('rd_sales_promotion');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  const fields = { updated_at: now() };
  ['product_model','salesperson','customer','appearance','price','performance','function_feedback','progress','remarks','project_no'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

router.delete('/sales-promotion/:id', requirePerm('project:delete'), (req, res) => {
  const table = getTable('rd_sales_promotion');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// ==================== 项目复盘 ====================
// 基于供22模版：2.复盘经验库

router.get('/reviews/list', requirePerm('project:view'), (req, res) => {
  const { project_id, page = 1, limit = 50 } = req.query;
  const table = getTable('rd_project_reviews');
  table._invalidate();
  let records = table.all();
  if (project_id) records = records.filter(r => r.project_id === Number(project_id));
  records.sort((a, b) => (b.id || 0) - (a.id || 0));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/reviews', requirePerm('project:create'), (req, res) => {
  const table = getTable('rd_project_reviews');
  const b = req.body;
  const result = table.insert({
    project_id: b.project_id || null,
    project_no: b.project_no || '',
    project_name: b.project_name || '',
    // 回顾目标
    goal_original: b.goal_original || '',
    goal_milestone: b.goal_milestone || '',
    // 评估结果
    result_highlights: b.result_highlights || '',
    result_lowlights: b.result_lowlights || '',
    result_actual: b.result_actual || '',
    // 分析原因
    success_factors: b.success_factors || '',
    failure_causes: b.failure_causes || '',
    // 总结规律
    insights: b.insights || '',
    experience: b.experience || '',
    // 行动计划
    action_plan: b.action_plan || '',
    remarks: b.remarks || '',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '创建成功', data: table.findById(result.lastID) });
});

router.put('/reviews/:id', requirePerm('project:edit'), (req, res) => {
  const table = getTable('rd_project_reviews');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  const fields = { updated_at: now() };
  ['project_no','project_name','goal_original','goal_milestone','result_highlights','result_lowlights','result_actual','success_factors','failure_causes','insights','experience','action_plan','remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

router.delete('/reviews/:id', requirePerm('project:delete'), (req, res) => {
  const table = getTable('rd_project_reviews');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// ==================== 统计分析 ====================
// 基于供22模版：5.统计分析 - 月度项目统计

router.get('/analysis/monthly', requirePerm('project:view'), (req, res) => {
  const table = getTable('projects');
  table._invalidate();
  const all = table.all();
  // 按月份分组统计
  const monthMap = {};
  all.forEach(p => {
    const dateStr = p.start_date || p.created_at || '';
    const month = dateStr.substring(0, 7); // YYYY-MM
    if (!month) return;
    if (!monthMap[month]) monthMap[month] = { month, total: 0, in_progress: 0, self_dev: 0, custom: 0, customers: new Set(), has_order: 0 };
    monthMap[month].total++;
    if (p.status !== 'completed' && p.status !== 'cancelled') monthMap[month].in_progress++;
    if (p.project_type === '自研') monthMap[month].self_dev++;
    else monthMap[month].custom++;
    if (p.customer_name) monthMap[month].customers.add(p.customer_name);
    if (Number(p.order_amount) > 0) monthMap[month].has_order++;
  });
  const result = Object.values(monthMap).map(m => ({
    ...m,
    customers: m.customers.size
  })).sort((a, b) => b.month.localeCompare(a.month));
  res.json({ data: result });
});

// 按类别统计
router.get('/analysis/by-category', requirePerm('project:view'), (req, res) => {
  const table = getTable('projects');
  table._invalidate();
  const all = table.all();
  const byCategory = {};
  const byStage = {};
  const byOwner = {};
  all.forEach(p => {
    const cat = p.project_type || '未分类';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const stage = p.current_stage || '未知';
    byStage[stage] = (byStage[stage] || 0) + 1;
    const owner = p.owner || '未分配';
    byOwner[owner] = (byOwner[owner] || 0) + 1;
  });
  res.json({ by_category: byCategory, by_stage: byStage, by_owner: byOwner });
});

// 交付周期与变更分析
router.get('/analysis/delivery', requirePerm('project:view'), (req, res) => {
  const table = getTable('projects');
  table._invalidate();
  const all = table.all();
  const today = new Date();
  const parseDate = (s) => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  };
  const dayDiff = (d1, d2) => {
    if (!d1 || !d2) return null;
    return Math.round((d2 - d1) / 86400000);
  };
  // 从项目编号 HJ.YYxxxx 提取立项年份
  const yearFromNo = (no) => {
    const m = String(no || '').match(/\.(\d{2})\d{2}\./);
    return m ? 2000 + Number(m[1]) : null;
  };

  let cycles = [];
  let totalChanges = 0;
  let overdueCount = 0;
  let dateCompleteCount = 0;

  all.forEach(p => {
    totalChanges += Number(p.change_count) || 0;
    // 交付周期：start→close（实际），其次 start→target（计划）
    let startD = parseDate(p.start_date);
    let endD = parseDate(p.close_date);
    if (!endD) endD = parseDate(p.target_date);
    if (startD && endD) {
      const c = dayDiff(startD, endD);
      if (c !== null && c >= 0 && c < 3650) {
        cycles.push({ id: p.id, no: p.project_no, name: p.project_name, cycle: c, changes: Number(p.change_count) || 0, type: p.project_type });
        dateCompleteCount++;
      }
    }
    // 逾期：有 target_date 且未完成（状态非 completed 且阶段非 完成/复盘）
    if (p.target_date) {
      const td = parseDate(p.target_date);
      const done = p.status === 'completed' || ['完成', '复盘'].includes(String(p.current_stage || '').trim());
      if (td && !isNaN(td) && td < today && !done) overdueCount++;
    }
  });

  const cyclesSorted = cycles.slice().sort((a, b) => b.cycle - a.cycle);
  const avgCycle = cycles.length ? Math.round(cycles.reduce((s, c) => s + c.cycle, 0) / cycles.length) : 0;
  const maxCycle = cycles.length ? cyclesSorted[0].cycle : 0;
  const avgChanges = all.length ? +(totalChanges / all.length).toFixed(1) : 0;
  const completeness = all.length ? Math.round(dateCompleteCount / all.length * 100) : 0;

  // 生成分析与解决方案（规则引擎）
  const insights = [];
  const solutions = [];
  if (cycles.length > 0) {
    if (avgCycle > 180) {
      insights.push(`平均交付周期 ${avgCycle} 天，偏长（基准 180 天），最长 ${maxCycle} 天。`);
      solutions.push('对超长项目拆分里程碑并阶段评审；识别关键路径瓶颈（模具/试产/认证）并前置准备，缩短串行等待。');
    } else {
      insights.push(`平均交付周期 ${avgCycle} 天，处于合理区间，最长 ${maxCycle} 天。`);
    }
  } else {
    insights.push('暂无项目具备完整的立项与结案日期，无法精确计算交付周期。');
    solutions.push('规范立项/结案流程，在项目编辑中补录 start_date 与 close_date，使交付周期可度量。');
  }
  if (totalChanges > 0) {
    if (avgChanges >= 2) {
      insights.push(`项目平均变更 ${avgChanges} 次，累计 ${totalChanges} 次，变更较频繁。`);
      solutions.push('加强立项前需求评审与封样管理；建立变更评审流程，区分重大/轻微变更，控制非必要变更与返工。');
    } else {
      insights.push(`累计变更 ${totalChanges} 次，平均 ${avgChanges} 次/项目，变更可控。`);
    }
  } else {
    insights.push('暂无变更记录，建议持续跟踪关键字段变更。');
  }
  if (overdueCount > 0) {
    insights.push(`当前有 ${overdueCount} 个项目已超过目标日期仍未交付。`);
    solutions.push(`对 ${overdueCount} 个逾期项目专项跟进：重新评估目标日期、调整资源或启动风险升级。`);
  }
  if (completeness < 50 && all.length > 0) {
    insights.push(`仅 ${completeness}% 的项目具备完整交付日期，数据完整性偏低。`);
    solutions.push('将立项/结案日期纳入必填校验，定期清理缺日期项目，保障周期与变更指标可信。');
  }

  const topChanged = all.filter(p => (Number(p.change_count) || 0) > 0)
    .sort((a, b) => (Number(b.change_count) || 0) - (Number(a.change_count) || 0))
    .slice(0, 5)
    .map(p => ({ no: p.project_no, name: p.project_name, changes: Number(p.change_count) || 0 }));

  res.json({
    delivery: {
      avg_cycle_days: avgCycle,
      max_cycle_days: maxCycle,
      sample_count: cycles.length,
      date_completeness: completeness,
      slowest: cyclesSorted.slice(0, 5)
    },
    change: { total: totalChanges, avg_per_project: avgChanges, top_changed: topChanged },
    overdue_count: overdueCount,
    total_projects: all.length,
    insights,
    solutions
  });
});

// 进度跟踪：修改次数与延误次数 + 对标分类分析
router.get('/analysis/progress', requirePerm('project:view'), (req, res) => {
  const table = getTable('projects');
  table._invalidate();
  const all = table.all();

  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  const progAll = progTable.all();
  const progMap = {};
  progAll.forEach(p => { progMap[p.project_id] = p; });
  const nodeFields = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','appearance','structure','mold','mold_sample','packaging','elec_trial','rd_trial','tech_transfer','eng_trial','prod_trial','test_report','shipment','review','other'];
  const today = new Date();
  const parseDate = (s) => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  };
  const isDateVal = v => typeof v === 'string' && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(v);

  const results = all.map(p => {
    const changes = Number(p.change_count) || 0;
    let delays = 0, totalNodes = 0, doneNodes = 0;
    const prog = progMap[p.id];
    if (prog) {
      nodeFields.forEach(f => {
        const v = prog[f];
        totalNodes++;
        if (v === 'V' || v === '√') doneNodes++;
        if (isDateVal(v)) {
          const d = parseDate(v);
          if (d && d < today) delays++;
        }
      });
    }
    // 项目级延误：有 target_date 且未完成
    let projectOverdue = false;
    if (p.target_date) {
      const td = parseDate(p.target_date);
      const done = p.status === 'completed' || ['完成', '复盘'].includes(String(p.current_stage || '').trim());
      if (td && !isNaN(td) && td < today && !done) projectOverdue = true;
    }
    return {
      id: p.id, no: p.project_no, name: p.project_name,
      type: p.project_type || '', level: p.project_level || '',
      owner: p.owner || '', status: p.status || '',
      change_count: changes, delayed_nodes: delays,
      total_nodes: totalNodes, done_nodes: doneNodes,
      target_date: p.target_date || '', close_date: p.close_date || '',
      project_overdue: projectOverdue
    };
  });

  const totalChanges = results.reduce((s, r) => s + r.change_count, 0);
  const totalDelays = results.reduce((s, r) => s + r.delayed_nodes, 0);
  const overdueProjects = results.filter(r => r.project_overdue).length;
  const projectCount = all.length;

  // 按类型分析
  const byType = {};
  results.forEach(r => {
    const t = (r.type || '').trim() || '未分类';
    if (!byType[t]) byType[t] = { type: t, count: 0, changes: 0, delays: 0, overdue: 0, doneNodes: 0, totalNodes: 0 };
    byType[t].count++;
    byType[t].changes += r.change_count;
    byType[t].delays += r.delayed_nodes;
    byType[t].doneNodes += r.done_nodes;
    byType[t].totalNodes += r.total_nodes;
    if (r.project_overdue) byType[t].overdue++;
  });

  // 按负责人分析
  const byOwner = {};
  results.forEach(r => {
    const o = (r.owner || '').trim() || '未分配';
    if (!byOwner[o]) byOwner[o] = { owner: o, count: 0, changes: 0, delays: 0, overdue: 0 };
    byOwner[o].count++;
    byOwner[o].changes += r.change_count;
    byOwner[o].delays += r.delayed_nodes;
    if (r.project_overdue) byOwner[o].overdue++;
  });

  const topDelayed = results.filter(r => r.delayed_nodes > 0)
    .sort((a, b) => b.delayed_nodes - a.delayed_nodes)
    .slice(0, 10);
  const topChanged = results.filter(r => r.change_count > 0)
    .sort((a, b) => b.change_count - a.change_count)
    .slice(0, 10);

  res.json({
    summary: {
      total_projects: projectCount,
      total_changes: totalChanges,
      total_delays: totalDelays,
      avg_changes: projectCount ? +(totalChanges / projectCount).toFixed(2) : 0,
      avg_delays: projectCount ? +(totalDelays / projectCount).toFixed(2) : 0,
      overdue_projects: overdueProjects
    },
    by_type: Object.values(byType),
    by_owner: Object.values(byOwner),
    top_delayed: topDelayed,
    top_changed: topChanged
  });
});

// ==================== 立项申请书 ====================
// 基于立项申请书模版：立项背景 → 研发目标 → 技术方案 → 计划 → 预期效益 → 资源需求 → 风险对策 → 审批

router.get('/initiation/list', requirePerm('project:view'), (req, res) => {
  const table = getTable('rd_project_initiation');
  table._invalidate();
  let records = table.all();
  records.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ data: records });
});

router.get('/initiation/:projectId', requirePerm('project:view'), (req, res) => {
  const table = getTable('rd_project_initiation');
  table._invalidate();
  const row = table.all().find(r => r.project_id === Number(req.params.projectId));
  res.json(row || null);
});

router.post('/initiation', requirePerm('project:create'), (req, res) => {
  const table = getTable('rd_project_initiation');
  const b = req.body;
  const result = table.insert({
    project_id: Number(b.project_id) || null,
    project_no: b.project_no || '',
    project_name: b.project_name || '',
    // 一、基本信息
    project_type: b.project_type || '',
    start_date: b.start_date || '',
    department: b.department || '',
    owner: b.owner || '',
    cooperators: b.cooperators || '',
    other_info: b.other_info || '',
    // 二、客户信息
    customer_no: b.customer_no || '',
    customer_type: b.customer_type || '',
    customer_level: b.customer_level || '',
    customer_win_rate: b.customer_win_rate || '',
    market_status: b.market_status || '',
    customer_pain: b.customer_pain || '',
    key_success: b.key_success || '',
    has_competitor: b.has_competitor || '',
    purchase_cycle: b.purchase_cycle || '',
    dev_type: b.dev_type || '',
    // 三、产品规格对比（JSON）
    product_specs: b.product_specs || '',
    // 四、可实现性评估（JSON）
    feasibility: b.feasibility || '',
    // 五、立项决议（JSON）
    approval_signs: b.approval_signs || '',
    // 六、销售预测（JSON）
    sales_forecast: b.sales_forecast || '',
    // 特殊要求（JSON）
    special_reqs: b.special_reqs || '',
    // 兼容旧字段
    background: b.background || '',
    necessity: b.necessity || '',
    market_analysis: b.market_analysis || '',
    rd_objectives: b.rd_objectives || '',
    rd_content: b.rd_content || '',
    key_innovation: b.key_innovation || '',
    tech_solution: b.tech_solution || '',
    tech_route: b.tech_route || '',
    plan_summary: b.plan_summary || '',
    milestones: b.milestones || '',
    expected_outcome: b.expected_outcome || '',
    economic_benefit: b.economic_benefit || '',
    target_market: b.target_market || '',
    budget_total: Number(b.budget_total) || 0,
    budget_detail: b.budget_detail || '',
    team_requirement: b.team_requirement || '',
    risk_analysis: b.risk_analysis || '',
    risk_measures: b.risk_measures || '',
    // 审批
    applicant: b.applicant || '',
    apply_date: b.apply_date || now().substring(0, 10),
    approval_status: b.approval_status || 'draft',
    approver: b.approver || '',
    approval_date: b.approval_date || '',
    approval_opinion: b.approval_opinion || '',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '创建成功', data: table.findById(result.lastID) });
});

router.put('/initiation/:id', requirePerm('project:edit'), (req, res) => {
  const table = getTable('rd_project_initiation');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  const fields = { updated_at: now() };
  const allFields = [
    'project_id','project_no','project_name',
    // 新字段：基本信息
    'project_type','start_date','department','owner','cooperators','other_info',
    // 新字段：客户信息
    'customer_no','customer_type','customer_level','customer_win_rate',
    'market_status','customer_pain','key_success','has_competitor',
    'purchase_cycle','dev_type',
    // 新字段：多Sheet JSON数据
    'product_specs','feasibility','approval_signs','sales_forecast','special_reqs',
    // 兼容旧字段
    'background','necessity','market_analysis',
    'rd_objectives','rd_content','key_innovation',
    'tech_solution','tech_route',
    'plan_summary','milestones',
    'expected_outcome','economic_benefit','target_market',
    'budget_total','budget_detail','team_requirement',
    'risk_analysis','risk_measures',
    'applicant','apply_date','approval_status','approver','approval_date','approval_opinion'
  ];
  allFields.forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  if (req.body.budget_total !== undefined) fields.budget_total = Number(req.body.budget_total) || 0;
  table.update(req.params.id, fields);
  res.json({ message: '更新成功' });
});

router.delete('/initiation/:id', requirePerm('project:delete'), (req, res) => {
  const table = getTable('rd_project_initiation');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// 立项申请书统计
router.get('/initiation/stats', requirePerm('project:view'), (req, res) => {
  const table = getTable('rd_project_initiation');
  table._invalidate();
  const all = table.all();
  const byStatus = {};
  all.forEach(r => {
    const s = r.approval_status || 'draft';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  res.json({
    total: all.length,
    by_status: byStatus,
    draft: byStatus.draft || 0,
    submitted: byStatus.submitted || 0,
    approved: byStatus.approved || 0,
    rejected: byStatus.rejected || 0
  });
});

// 立项批准 → 自动创建研发项目
router.post('/initiation/:id/approve-to-project', requirePerm('project:create'), (req, res) => {
  const initTable = getTable('rd_project_initiation');
  const rec = initTable.findById(req.params.id);
  if (!rec) return res.status(404).json({ error: '立项申请书不存在' });
  // 设为已批准
  initTable.update(req.params.id, { approval_status: 'approved', approver: req.body.approver || rec.approver || '', approval_date: req.body.approval_date || now().substring(0,10), approval_opinion: req.body.approval_opinion || rec.approval_opinion || '', updated_at: now() });
  // 若已关联项目则跳过
  if (rec.project_id) {
    return res.json({ message: '已批准，项目已存在', project_id: rec.project_id, already: true });
  }
  // 创建研发项目
  const projTable = getTable('projects');
  const projectType = rec.project_type || '客制';
  const projResult = projTable.insert({
    project_no: rec.project_no || '',
    project_name: rec.project_name || '未命名项目',
    customer_name: rec.customer_no || '',
    project_type: projectType === '客户定制+自研' ? '客制' : (projectType === '自研' ? '自研' : '客制'),
    project_level: rec.customer_level || '',
    urgency: '',
    owner: rec.owner || rec.applicant || '',
    department: rec.department || '研发中心',
    start_date: rec.start_date || now().substring(0, 10),
    target_date: '',
    close_date: '',
    current_stage: '预项目',
    node_time: '',
    progress_note: '',
    project_amount: Number(rec.budget_total) || 0,
    order_amount: 0,
    invest_amount: Number(rec.budget_total) || 0,
    annual_order: '',
    market_date: '',
    status: 'init',
    audit_status: '',
    gantt_link: '',
    doc_link: '',
    remarks: '由立项申请书 #' + req.params.id + ' 批准转入',
    change_count: 0,
    created_at: now(),
    updated_at: now()
  });
  const newProject = projTable.findById(projResult.lastID);
  // 回填 project_id 到立项申请书
  initTable.update(req.params.id, { project_id: projResult.lastID, updated_at: now() });
  // 自动创建进度节点记录
  const progTable = getTable('rd_project_progress');
  progTable.insert({
    project_id: projResult.lastID,
    plan: '', bom: '', spec: '', config: '', mold_drawing: '',
    mold_review: '', hand_sample: '', mold: '', mold_sample: '',
    packaging: '', elec_trial: '', rd_trial: '', eng_trial: '',
    prod_trial: '', test_report: '', tech_transfer: '',
    shipment: '', review: '', other: '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '已批准并创建研发项目', project_id: projResult.lastID, project: newProject });
});

// ==================== 项目延误统计分析（时间维度） ====================
router.get('/analysis/delay', requirePerm('project:view'), (req, res) => {
  const table = getTable('projects');
  table._invalidate();
  const all = table.all();
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  const progAll = progTable.all();
  const progMap = {};
  progAll.forEach(p => { progMap[p.project_id] = p; });

  const today = new Date();
  const parseDate = (s) => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  };
  const isDateVal = v => typeof v === 'string' && /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(v);
  const nodeFields = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','appearance','structure','mold','mold_sample','packaging','elec_trial','rd_trial','tech_transfer','eng_trial','prod_trial','test_report','shipment','review','other'];

  // 按月份分组的延误统计
  const monthMap = {};
  // 按季度分组
  const quarterMap = {};
  // 按年份分组
  const yearMap = {};
  // 延误明细列表
  const delayDetails = [];
  // 按负责人
  const ownerMap = {};
  // 按类型
  const typeMap = {};
  // 按等级
  const levelMap = {};

  let totalProjects = 0, overdueProjects = 0, totalDelayedNodes = 0, totalChanges = 0;
  let totalCycleDays = 0, cycleCount = 0;

  all.forEach(p => {
    totalProjects++;
    const prog = progMap[p.id] || {};
    const changes = Number(p.change_count) || 0;
    totalChanges += changes;

    // 节点延误统计
    let delayedNodes = 0, doneNodes = 0, totalNodes = 0;
    let earliestDate = null, latestDate = null;
    nodeFields.forEach(f => {
      const v = prog[f];
      totalNodes++;
      if (v === 'V' || v === '√') doneNodes++;
      if (isDateVal(v)) {
        const d = parseDate(v);
        if (d) {
          if (!earliestDate || d < earliestDate) earliestDate = d;
          if (!latestDate || d > latestDate) latestDate = d;
          if (d < today) delayedNodes++; // 计划日期已过但未完成
        }
      }
    });
    totalDelayedNodes += delayedNodes;

    // 项目级逾期
    let overdue = false, overdueDays = 0;
    if (p.target_date) {
      const td = parseDate(p.target_date);
      const done = p.status === 'completed' || ['完成','复盘'].includes(String(p.current_stage||'').trim());
      if (td && !isNaN(td) && td < today && !done) {
        overdue = true;
        overdueDays = Math.round((today - td) / 86400000);
        overdueProjects++;
      }
    }

    // 交付周期
    let cycleDays = null;
    const sd = parseDate(p.start_date), cd = parseDate(p.close_date);
    if (sd && cd) {
      cycleDays = Math.round((cd - sd) / 86400000);
      if (cycleDays >= 0 && cycleDays < 3650) { totalCycleDays += cycleDays; cycleCount++; }
    }

    // 时间维度 key：用 start_date 或 created_at 的年月
    const dateStr = p.start_date || (p.created_at || '').substring(0, 10);
    const d = parseDate(dateStr);
    const year = d ? d.getFullYear() : (dateStr.substring(0,4) || '未知');
    const month = d ? (d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0')) : (dateStr.substring(0,7) || '未知');
    const quarter = d ? (d.getFullYear() + '-Q' + Math.ceil((d.getMonth()+1)/3)) : '未知';

    // 月度统计
    if (!monthMap[month]) monthMap[month] = { period: month, total: 0, overdue: 0, delayed_nodes: 0, changes: 0, completed: 0, avg_cycle: 0, cycles: [] };
    monthMap[month].total++;
    if (overdue) monthMap[month].overdue++;
    monthMap[month].delayed_nodes += delayedNodes;
    monthMap[month].changes += changes;
    if (p.status === 'completed' || ['完成','复盘'].includes(String(p.current_stage||'').trim())) monthMap[month].completed++;
    if (cycleDays !== null && cycleDays >= 0) monthMap[month].cycles.push(cycleDays);

    // 季度统计
    if (!quarterMap[quarter]) quarterMap[quarter] = { period: quarter, total: 0, overdue: 0, delayed_nodes: 0, changes: 0, completed: 0, avg_cycle: 0, cycles: [] };
    quarterMap[quarter].total++;
    if (overdue) quarterMap[quarter].overdue++;
    quarterMap[quarter].delayed_nodes += delayedNodes;
    quarterMap[quarter].changes += changes;
    if (p.status === 'completed' || ['完成','复盘'].includes(String(p.current_stage||'').trim())) quarterMap[quarter].completed++;
    if (cycleDays !== null && cycleDays >= 0) quarterMap[quarter].cycles.push(cycleDays);

    // 年度统计
    if (!yearMap[year]) yearMap[year] = { period: String(year), total: 0, overdue: 0, delayed_nodes: 0, changes: 0, completed: 0, avg_cycle: 0, cycles: [] };
    yearMap[year].total++;
    if (overdue) yearMap[year].overdue++;
    yearMap[year].delayed_nodes += delayedNodes;
    yearMap[year].changes += changes;
    if (p.status === 'completed' || ['完成','复盘'].includes(String(p.current_stage||'').trim())) yearMap[year].completed++;
    if (cycleDays !== null && cycleDays >= 0) yearMap[year].cycles.push(cycleDays);

    // 按负责人
    const owner = (p.owner || '').trim() || '未分配';
    if (!ownerMap[owner]) ownerMap[owner] = { name: owner, total: 0, overdue: 0, delayed_nodes: 0, changes: 0 };
    ownerMap[owner].total++;
    if (overdue) ownerMap[owner].overdue++;
    ownerMap[owner].delayed_nodes += delayedNodes;
    ownerMap[owner].changes += changes;

    // 按类型
    const ptype = (p.project_type || '').trim() || '未分类';
    if (!typeMap[ptype]) typeMap[ptype] = { name: ptype, total: 0, overdue: 0, delayed_nodes: 0, changes: 0 };
    typeMap[ptype].total++;
    if (overdue) typeMap[ptype].overdue++;
    typeMap[ptype].delayed_nodes += delayedNodes;
    typeMap[ptype].changes += changes;

    // 按等级
    const plevel = (p.project_level || '').trim() || '未分级';
    if (!levelMap[plevel]) levelMap[plevel] = { name: plevel, total: 0, overdue: 0, delayed_nodes: 0, changes: 0 };
    levelMap[plevel].total++;
    if (overdue) levelMap[plevel].overdue++;
    levelMap[plevel].delayed_nodes += delayedNodes;
    levelMap[plevel].changes += changes;

    // 延误明细
    if (overdue || delayedNodes > 0) {
      delayDetails.push({
        id: p.id, no: p.project_no, name: p.project_name,
        type: p.project_type || '', level: p.project_level || '', owner: (p.owner||'').trim(),
        target_date: p.target_date || '', overdue_days: overdueDays,
        delayed_nodes: delayedNodes, total_nodes: totalNodes, done_nodes: doneNodes,
        changes: changes, start_date: p.start_date || '', close_date: p.close_date || '',
        node_complete_rate: totalNodes ? Math.round(doneNodes/totalNodes*100) : 0,
        month: month
      });
    }
  });

  // 计算平均周期并整理数组
  function calcAvg(arr) {
    const periods = Object.values(arr);
    periods.forEach(p => {
      p.avg_cycle = p.cycles.length ? Math.round(p.cycles.reduce((s,c)=>s+c,0)/p.cycles.length) : 0;
      p.overdue_rate = p.total ? Math.round(p.overdue/p.total*100) : 0;
      p.delay_rate = p.total ? Math.round(p.delayed_nodes/p.total*100) : 0;
      delete p.cycles;
    });
    return periods.sort((a,b) => a.period.localeCompare(b.period));
  }

  res.json({
    summary: {
      total_projects: totalProjects,
      overdue_projects: overdueProjects,
      overdue_rate: totalProjects ? Math.round(overdueProjects/totalProjects*100) : 0,
      total_delayed_nodes: totalDelayedNodes,
      total_changes: totalChanges,
      avg_cycle_days: cycleCount ? Math.round(totalCycleDays/cycleCount) : 0,
      cycle_sample_count: cycleCount
    },
    by_month: calcAvg(monthMap),
    by_quarter: calcAvg(quarterMap),
    by_year: calcAvg(yearMap),
    by_owner: Object.values(ownerMap).sort((a,b) => b.overdue - a.overdue),
    by_type: Object.values(typeMap),
    by_level: Object.values(levelMap),
    delay_details: delayDetails.sort((a,b) => b.overdue_days - a.overdue_days || b.delayed_nodes - a.delayed_nodes)
  });
});

module.exports = router;
