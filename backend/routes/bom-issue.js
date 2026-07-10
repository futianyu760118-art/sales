const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

router.get('/', requirePerm('bom:view'), (req, res) => {
  const { page = 1, limit = 20, status, severity, assignee, category, keyword, product_id } = req.query;
  const table = getTable('bom_issues');
  table._invalidate();
  let items = table.all();

  if (status) items = items.filter(r => r.status === status);
  if (severity) items = items.filter(r => r.severity === severity);
  if (assignee) items = items.filter(r => r.assignee === assignee);
  if (category) items = items.filter(r => r.category === category);
  if (product_id) items = items.filter(r => r.product_id === Number(product_id));
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(r => [r.title, r.description, r.code, r.product_model].join(' ').toLowerCase().includes(kw));
  }

  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const total = items.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const paged = items.slice(start, start + parseInt(limit));

  res.json({ data: paged, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/stats', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_issues');
  table._invalidate();
  const items = table.all();

  const byStatus = {};
  const bySeverity = {};
  const byCategory = {};
  const byAssignee = {};
  let overdue = 0;
  const nowDate = new Date();

  items.forEach(i => {
    byStatus[i.status || 'open'] = (byStatus[i.status || 'open'] || 0) + 1;
    bySeverity[i.severity || 'medium'] = (bySeverity[i.severity || 'medium'] || 0) + 1;
    byCategory[i.category || '其他'] = (byCategory[i.category || '其他'] || 0) + 1;
    if (i.assignee) byAssignee[i.assignee] = (byAssignee[i.assignee] || 0) + 1;
    if (i.due_date && i.status !== 'closed' && i.status !== 'resolved') {
      const due = new Date(i.due_date);
      if (due < nowDate) overdue++;
    }
  });

  res.json({
    total: items.length,
    byStatus, bySeverity, byCategory, byAssignee, overdue,
    openCount: byStatus['open'] || 0,
    inProgressCount: byStatus['in_progress'] || 0,
    resolvedCount: byStatus['resolved'] || 0,
    closedCount: byStatus['closed'] || 0
  });
});

router.get('/:id', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_issues');
  const item = table.findById(req.params.id);
  if (!item) return res.status(404).json({ error: '问题不存在' });

  const trackTable = getTable('bom_issue_tracks');
  trackTable._invalidate();
  const tracks = trackTable.all().filter(t => t.issue_id === Number(req.params.id));
  tracks.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const preventTable = getTable('bom_issue_preventions');
  preventTable._invalidate();
  const preventions = preventTable.all().filter(p => p.issue_id === Number(req.params.id));

  res.json({ ...item, tracks, preventions });
});

router.post('/', requirePerm('bom:create'), (req, res) => {
  const { title, description, category, severity, product_id, product_model,
          code, field, old_value, new_value, assignee, due_date, source } = req.body;
  if (!title) return res.status(400).json({ error: '问题标题为必填项' });

  const table = getTable('bom_issues');
  const result = table.insert({
    title, description: description || '',
    category: category || 'BOM差异', severity: severity || 'medium',
    product_id: product_id || null, product_model: product_model || '',
    code: code || '', field: field || '',
    old_value: old_value || '', new_value: new_value || '',
    assignee: assignee || '', due_date: due_date || '',
    source: source || 'bom_compare',
    status: 'open',
    created_at: now(), updated_at: now()
  });

  const trackTable = getTable('bom_issue_tracks');
  trackTable.insert({
    issue_id: result.lastID, action: 'created',
    comment: '问题创建', operator: req.body.operator || 'system',
    created_at: now()
  });

  res.json({ message: '问题创建成功', data: table.findById(result.lastID) });
});

router.put('/:id', requirePerm('bom:edit'), (req, res) => {
  const table = getTable('bom_issues');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '问题不存在' });

  const fields = { updated_at: now() };
  ['title', 'description', 'category', 'severity', 'assignee', 'due_date', 'status', 'resolution'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });

  if (req.body.status && req.body.status !== existing.status) {
    fields.resolved_at = ['resolved', 'closed'].includes(req.body.status) ? now() : null;
  }

  table.update(req.params.id, fields);

  if (req.body.status && req.body.status !== existing.status) {
    const trackTable = getTable('bom_issue_tracks');
    const statusLabels = { open: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭', rejected: '已驳回' };
    trackTable.insert({
      issue_id: Number(req.params.id),
      action: 'status_change',
      comment: `状态变更: ${statusLabels[existing.status] || existing.status} → ${statusLabels[req.body.status] || req.body.status}`,
      operator: req.body.operator || 'system',
      created_at: now()
    });
  }

  res.json({ message: '问题更新成功', data: table.findById(req.params.id) });
});

router.delete('/:id', requirePerm('bom:delete'), (req, res) => {
  const table = getTable('bom_issues');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '问题不存在' });
  table.delete(req.params.id);

  const trackTable = getTable('bom_issue_tracks');
  trackTable.all().filter(t => t.issue_id === Number(req.params.id)).forEach(t => trackTable.delete(t.id));

  const preventTable = getTable('bom_issue_preventions');
  preventTable.all().filter(p => p.issue_id === Number(req.params.id)).forEach(p => preventTable.delete(p.id));

  res.json({ message: '问题删除成功' });
});

router.post('/:id/assign', requirePerm('bom:edit'), (req, res) => {
  const { assignee, due_date, operator } = req.body;
  if (!assignee) return res.status(400).json({ error: '责任人为必填项' });

  const table = getTable('bom_issues');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '问题不存在' });

  const fields = { assignee, status: 'in_progress', updated_at: now() };
  if (due_date) fields.due_date = due_date;
  table.update(req.params.id, fields);

  const trackTable = getTable('bom_issue_tracks');
  trackTable.insert({
    issue_id: Number(req.params.id),
    action: 'assigned',
    comment: `分配给: ${assignee}${due_date ? ', 截止: ' + due_date : ''}`,
    operator: operator || 'system',
    created_at: now()
  });

  res.json({ message: '问题分配成功', data: table.findById(req.params.id) });
});

router.post('/:id/track', requirePerm('bom:edit'), (req, res) => {
  const { action, comment, operator } = req.body;
  if (!action) return res.status(400).json({ error: '操作类型为必填项' });

  const trackTable = getTable('bom_issue_tracks');
  trackTable.insert({
    issue_id: Number(req.params.id),
    action, comment: comment || '',
    operator: operator || 'system',
    created_at: now()
  });

  res.json({ message: '跟踪记录添加成功' });
});

router.get('/:id/tracks', requirePerm('bom:view'), (req, res) => {
  const trackTable = getTable('bom_issue_tracks');
  trackTable._invalidate();
  const tracks = trackTable.all().filter(t => t.issue_id === Number(req.params.id));
  tracks.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  res.json({ data: tracks });
});

router.post('/:id/prevention', requirePerm('bom:edit'), (req, res) => {
  const { prevention_measure, prevention_type, operator } = req.body;
  if (!prevention_measure) return res.status(400).json({ error: '预防措施为必填项' });

  const preventTable = getTable('bom_issue_preventions');
  preventTable.insert({
    issue_id: Number(req.params.id),
    prevention_measure, prevention_type: prevention_type || 'process',
    operator: operator || 'system',
    status: 'active',
    created_at: now(), updated_at: now()
  });

  const issueTable = getTable('bom_issues');
  issueTable.update(Number(req.params.id), { updated_at: now() });

  res.json({ message: '预防措施添加成功' });
});

router.put('/prevention/:id', requirePerm('bom:edit'), (req, res) => {
  const preventTable = getTable('bom_issue_preventions');
  const existing = preventTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '预防措施不存在' });
  const fields = { updated_at: now() };
  ['prevention_measure', 'prevention_type', 'status'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  preventTable.update(req.params.id, fields);
  res.json({ message: '预防措施更新成功' });
});

router.delete('/prevention/:id', requirePerm('bom:delete'), (req, res) => {
  const preventTable = getTable('bom_issue_preventions');
  preventTable.delete(req.params.id);
  res.json({ message: '预防措施删除成功' });
});

router.get('/reminders/overdue', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_issues');
  table._invalidate();
  const nowDate = new Date().toISOString().slice(0, 10);
  const overdue = table.all().filter(i =>
    i.due_date && i.status !== 'closed' && i.status !== 'resolved' && i.due_date < nowDate
  );
  res.json({ data: overdue, total: overdue.length });
});

router.get('/reminders/upcoming', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_issues');
  table._invalidate();
  const nowDate = new Date();
  const threeDaysLater = new Date(nowDate.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = nowDate.toISOString().slice(0, 10);
  const upcoming = table.all().filter(i =>
    i.due_date && i.status !== 'closed' && i.status !== 'resolved' &&
    i.due_date >= today && i.due_date <= threeDaysLater
  );
  res.json({ data: upcoming, total: upcoming.length });
});

router.post('/batch-from-compare', requirePerm('bom:create'), (req, res) => {
  const { differences, product_id, product_model, operator } = req.body;
  if (!Array.isArray(differences) || differences.length === 0) {
    return res.status(400).json({ error: '差异数据不能为空' });
  }

  const table = getTable('bom_issues');
  let created = 0;

  differences.forEach(diff => {
    const title = `${diff.code || '未知'} - ${diff.diff_fields.join('/')}差异`;
    const existing = table.all().find(i =>
      i.code === diff.code && i.product_id === Number(product_id) &&
      i.title === title && i.status !== 'closed' && i.status !== 'resolved'
    );
    if (existing) return;

    table.insert({
      title,
      description: `物料${diff.code}在BOM对比中发现差异: ${diff.diff_fields.join(', ')}`,
      category: 'BOM差异',
      severity: diff.diff_fields.includes('数量') ? 'high' : 'medium',
      product_id: Number(product_id),
      product_model: product_model || '',
      code: diff.code || '',
      field: diff.diff_fields.join(','),
      old_value: '',
      new_value: '',
      assignee: '', due_date: '',
      source: 'bom_compare',
      status: 'open',
      created_at: now(), updated_at: now()
    });
    created++;
  });

  res.json({ message: `已创建${created}个问题`, created });
});

router.get('/analysis/similar', requirePerm('bom:view'), (req, res) => {
  const table = getTable('bom_issues');
  table._invalidate();
  const issues = table.all().filter(i => i.status !== 'closed');

  const similarGroups = {};
  issues.forEach(issue => {
    const key = `${issue.code || ''}_${issue.field || ''}_${issue.category || ''}`;
    if (!similarGroups[key]) similarGroups[key] = [];
    similarGroups[key].push(issue);
  });

  const repeatedIssues = Object.entries(similarGroups)
    .filter(([_, group]) => group.length > 1)
    .map(([key, group]) => ({
      key, count: group.length,
      code: group[0].code, field: group[0].field, category: group[0].category,
      issues: group.map(g => ({ id: g.id, title: g.title, status: g.status, created_at: g.created_at }))
    }));

  res.json({ data: repeatedIssues, total: repeatedIssues.length });
});

module.exports = router;
