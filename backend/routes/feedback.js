const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('feedback');

// ===== 问题反馈列表 =====
router.get('/', requirePerm('feedback:create'), (req, res) => {
  const { page = 1, limit = 15, status, type, priority, keyword, submitter } = req.query;
  const table = getTable('feedback');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (type && r.type !== type) return false;
    if (priority && r.priority !== priority) return false;
    if (submitter && !(r.submitter || '').includes(submitter)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.title, r.description, r.submitter, r.module, r.assignee].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = table.findWhere(filter, 'created_at', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// 反馈详情
router.get('/:id', requirePerm('feedback:create'), (req, res) => {
  const table = getTable('feedback');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '反馈不存在' });
  res.json(row);
});

// 创建反馈
router.post('/', requirePerm('feedback:create'), (req, res) => {
  const { title, description, type, priority, module, submitter, assignee, screenshots } = req.body;
  if (!title) return res.status(400).json({ error: '标题为必填项' });

  const table = getTable('feedback');
  const result = table.insert({
    title,
    description: description || '',
    type: type || 'bug',          // bug/feature/improvement/question
    priority: priority || 'medium', // low/medium/high/urgent
    module: module || '',          // 所属模块
    submitter: submitter || '匿名',
    assignee: assignee || '',
    screenshots: screenshots || '',
    status: 'open',               // open/processing/resolved/closed
    resolution: '',
    resolved_at: null,
    created_at: now(),
    updated_at: now()
  });
  const created = table.findById(result.lastID);
  res.json({ message: '反馈提交成功', data: created });
});

// 更新反馈
router.put('/:id', requirePerm('feedback:handle'), (req, res) => {
  const table = getTable('feedback');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '反馈不存在' });

  const { title, description, type, priority, module, assignee, status, resolution, screenshots } = req.body;
  const updates = { updated_at: now() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (type !== undefined) updates.type = type;
  if (priority !== undefined) updates.priority = priority;
  if (module !== undefined) updates.module = module;
  if (assignee !== undefined) updates.assignee = assignee;
  if (screenshots !== undefined) updates.screenshots = screenshots;
  if (status !== undefined) {
    updates.status = status;
    if (status === 'resolved' || status === 'closed') {
      updates.resolved_at = now();
    }
  }
  if (resolution !== undefined) updates.resolution = resolution;

  table.update(req.params.id, updates);
  res.json({ message: '反馈更新成功', data: table.findById(req.params.id) });
});

// 删除反馈
router.delete('/:id', requirePerm('feedback:delete'), (req, res) => {
  const table = getTable('feedback');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '反馈不存在' });
  table.delete(req.params.id);
  res.json({ message: '反馈删除成功' });
});

// 反馈统计
router.get('/stats/summary', requirePerm('feedback:create'), (req, res) => {
  const table = getTable('feedback');
  const all = table.all();
  const stats = {
    total: all.length,
    open: all.filter(r => r.status === 'open').length,
    processing: all.filter(r => r.status === 'processing').length,
    resolved: all.filter(r => r.status === 'resolved').length,
    closed: all.filter(r => r.status === 'closed').length,
    by_type: {
      bug: all.filter(r => r.type === 'bug').length,
      feature: all.filter(r => r.type === 'feature').length,
      improvement: all.filter(r => r.type === 'improvement').length,
      question: all.filter(r => r.type === 'question').length
    },
    by_priority: {
      urgent: all.filter(r => r.priority === 'urgent').length,
      high: all.filter(r => r.priority === 'high').length,
      medium: all.filter(r => r.priority === 'medium').length,
      low: all.filter(r => r.priority === 'low').length
    }
  };
  res.json(stats);
});

module.exports = router;
