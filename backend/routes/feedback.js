const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm, getUserPermissions, extractUserId } = require('../auth-middleware');

ensureTable('feedback');
ensureTable('feedback_followups');

const STATUS_SET = new Set(['open', 'processing', 'resolved', 'closed']);
const TYPE_SET = new Set(['bug', 'feature', 'improvement', 'question']);
const PRIORITY_SET = new Set(['low', 'medium', 'high', 'urgent']);

// 取当前操作人（用于跟进记录署名 / 我的反馈归属）
function operatorOf(req) {
  const uid = extractUserId(req);
  if (!uid) return { id: null, name: (req.body && req.body.submitter) || '匿名' };
  try {
    const u = getTable('users').findById(Number(uid));
    if (u) return { id: u.id, name: u.name || u.username || ('用户' + u.id) };
  } catch (_) {}
  return { id: Number(uid) || null, name: '用户' + uid };
}

// 判断当前请求是否具备处理权限（用于跟进中的状态流转/指派）
function canHandle(req) {
  const uid = extractUserId(req);
  if (!uid) return true; // 与 requirePerm 保持一致：无用户标识时不做限制（内网可信调用）
  try {
    const { isAdmin, perms } = getUserPermissions(uid);
    if (isAdmin) return true;
    return !!(perms && perms.has('feedback:handle'));
  } catch (_) { return false; }
}

function parsePositiveInt(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}

// ===== 跟进时间线（含状态流转记录）=====
function listFollowups(feedbackId) {
  return getTable('feedback_followups').all()
    .filter(r => Number(r.feedback_id) === Number(feedbackId))
    .sort((a, b) => (a.id || 0) - (b.id || 0));
}

function addFollowup(feedbackId, { action, content, status_from, status_to, assignee, operator }) {
  const t = getTable('feedback_followups');
  const rec = {
    feedback_id: Number(feedbackId),
    action: action || 'comment',           // submit/comment/status/assign/resolve/close
    content: content || '',
    status_from: status_from || '',
    status_to: status_to || '',
    assignee: assignee || '',
    operator: operator.name || '匿名',
    operator_id: operator.id || null,
    created_at: now()
  };
  // 注意：本项目 insertNoSave/saveNow 均为异步（Promise），必须 await 才能保证落盘顺序与返回的 id 有效
  return t.insertNoSave(rec).then((id) => {
    rec.id = id;
    return t.saveNow();
  }).then(() => rec);
}

// ===== 反馈列表 =====
router.get('/', requirePerm('feedback:create'), (req, res) => {
  const { page = 1, limit = 15, status, type, priority, keyword, submitter, assignee, module, mine } = req.query;
  const table = getTable('feedback');
  const fuTable = getTable('feedback_followups');
  const fuAll = fuTable.all();
  const op = operatorOf(req);

  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (type && r.type !== type) return false;
    if (priority && r.priority !== priority) return false;
    if (module && !(r.module || '').includes(module)) return false;
    if (submitter && !(r.submitter || '').includes(submitter)) return false;
    if (assignee && !(r.assignee || '').includes(assignee)) return false;
    if (String(mine) === '1') {
      // 我的反馈：优先按提交人ID匹配，历史数据回退按姓名匹配
      if (r.submitter_id != null || op.id != null) {
        const byId = r.submitter_id != null && op.id != null && Number(r.submitter_id) === Number(op.id);
        const byName = r.submitter && op.name && r.submitter === op.name;
        if (!byId && !byName) return false;
      }
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.title, r.description, r.submitter, r.module, r.assignee, r.resolution].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };

  const pg = parsePositiveInt(page, 1), ps = parsePositiveInt(limit, 15);
  const { records, total } = table.findWhere(filter, 'updated_at', 'DESC', ps, (pg - 1) * ps);

  // 附加跟进概要（列表直接展示"跟进情况"）
  const data = records.map(r => {
    const fus = fuAll.filter(f => Number(f.feedback_id) === Number(r.id));
    const last = fus.length ? fus[fus.length - 1] : null;
    return Object.assign({}, r, {
      followup_count: fus.length,
      last_followup_at: last ? last.created_at : null,
      last_followup_by: last ? last.operator : null,
      last_followup: last ? (last.content || '').substring(0, 60) : ''
    });
  });

  res.json({ data, total, page: pg, limit: ps });
});

// ===== 反馈统计（保持既有字段，补充处理效率指标）=====
router.get('/stats/summary', requirePerm('feedback:create'), (req, res) => {
  const table = getTable('feedback');
  const fuTable = getTable('feedback_followups');
  const all = table.all();
  const fus = fuTable.all();
  const statusCount = (s) => all.filter(r => r.status === s).length;

  // 平均处理时长（小时）：从创建到首次标记 resolved/closed
  let handleSum = 0, handleCnt = 0;
  all.forEach(r => {
    if (!r.resolved_at) return;
    const t0 = Date.parse(String(r.created_at || '').replace(' ', 'T'));
    const t1 = Date.parse(String(r.resolved_at).replace(' ', 'T'));
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) { handleSum += (t1 - t0); handleCnt++; }
  });

  const op = operatorOf(req);
  const mine = all.filter(r =>
    (r.submitter_id != null && op.id != null && Number(r.submitter_id) === Number(op.id)) ||
    (r.submitter && op.name && r.submitter === op.name)
  ).length;

  res.json({
    total: all.length,
    open: statusCount('open'),
    processing: statusCount('processing'),
    resolved: statusCount('resolved'),
    closed: statusCount('closed'),
    by_status: {
      open: statusCount('open'),
      processing: statusCount('processing'),
      resolved: statusCount('resolved'),
      closed: statusCount('closed')
    },
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
    },
    pending: statusCount('open') + statusCount('processing'),
    mine,
    followup_total: fus.length,
    avg_handle_hours: handleCnt ? Math.round(handleSum / handleCnt / 3600000 * 10) / 10 : null
  });
});

// ===== 反馈详情（含跟进时间线）=====
router.get('/:id', requirePerm('feedback:create'), (req, res) => {
  const table = getTable('feedback');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '反馈不存在' });
  res.json(Object.assign({}, row, { followups: listFollowups(row.id) }));
});

// ===== 某反馈的跟进记录 =====
router.get('/:id/followups', requirePerm('feedback:create'), (req, res) => {
  const table = getTable('feedback');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '反馈不存在' });
  res.json({ data: listFollowups(row.id) });
});

// ===== 新增跟进（可同时流转状态 / 指派处理人）=====
router.post('/:id/followups', requirePerm('feedback:create'), async (req, res) => {
  const table = getTable('feedback');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '反馈不存在' });

  const body = req.body || {};
  const content = String(body.content || '').trim();
  const nextStatus = body.status ? String(body.status) : '';
  const nextAssignee = body.assignee !== undefined ? String(body.assignee || '').trim() : undefined;
  const wantsFlow = !!(nextStatus || nextAssignee !== undefined);

  if (!content && !wantsFlow) return res.status(400).json({ error: '请填写跟进内容' });
  if (nextStatus && !STATUS_SET.has(nextStatus)) return res.status(400).json({ error: '无效的状态值' });
  // 状态流转 / 指派处理人需要处理权限
  if (wantsFlow && !canHandle(req)) {
    return res.status(403).json({ error: '无权限处理该反馈（需要 feedback:handle）', code: 'PERMISSION_DENIED' });
  }

  const operator = operatorOf(req);
  const updates = { updated_at: now() };
  let action = 'comment';

  if (nextStatus && nextStatus !== row.status) {
    updates.status = nextStatus;
    if (nextStatus === 'resolved' || nextStatus === 'closed') updates.resolved_at = now();
    else updates.resolved_at = null;
    action = nextStatus === 'resolved' ? 'resolve' : (nextStatus === 'closed' ? 'close' : 'status');
  }
  if (nextAssignee !== undefined && nextAssignee !== row.assignee) {
    updates.assignee = nextAssignee;
    if (action === 'comment') action = 'assign';
  }

  const fu = await addFollowup(row.id, {
    action,
    content,
    status_from: row.status || '',
    status_to: updates.status || row.status || '',
    assignee: nextAssignee !== undefined ? nextAssignee : (row.assignee || ''),
    operator
  });

  if (Object.keys(updates).length > 1) await table.update(row.id, updates);

  res.json({ message: '跟进已记录', data: fu, feedback: table.findById(row.id) });
});

// ===== 创建反馈 =====
router.post('/', requirePerm('feedback:create'), async (req, res) => {
  const { title, description, type, priority, module, submitter, assignee, screenshots, source } = req.body || {};
  if (!title) return res.status(400).json({ error: '标题为必填项' });

  const operator = operatorOf(req);
  const submitterName = submitter || operator.name || '匿名';
  if (type && !TYPE_SET.has(type)) return res.status(400).json({ error: '无效的类型' });
  if (priority && !PRIORITY_SET.has(priority)) return res.status(400).json({ error: '无效的优先级' });

  const table = getTable('feedback');
  const result = await table.insert({
    title,
    description: description || '',
    type: type || 'bug',             // bug/feature/improvement/question
    priority: priority || 'medium',   // low/medium/high/urgent
    module: module || '',             // 所属模块（页面名/功能模块）
    submitter: submitterName,
    submitter_id: operator.id || null,
    assignee: assignee || '',
    screenshots: screenshots || '',
    source: source || 'page',         // widget=悬浮按钮 / page=反馈页
    status: 'open',                   // open/processing/resolved/closed
    resolution: '',
    resolved_at: null,
    created_at: now(),
    updated_at: now()
  });
  const created = table.findById(result.lastID);
  // 提交即写入一条时间线记录，便于后续查看处理过程
  await addFollowup(created.id, {
    action: 'submit',
    content: description || '',
    status_to: created.status,
    assignee: created.assignee || '',
    operator: { id: operator.id || null, name: submitterName }
  });
  res.json({ message: '反馈提交成功', data: created });
});

// ===== 更新反馈（处理权限）=====
router.put('/:id', requirePerm('feedback:handle'), async (req, res) => {
  const table = getTable('feedback');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '反馈不存在' });

  const { title, description, type, priority, module, assignee, status, resolution, screenshots } = req.body || {};
  const updates = { updated_at: now() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (type !== undefined) updates.type = type;
  if (priority !== undefined) updates.priority = priority;
  if (module !== undefined) updates.module = module;
  if (assignee !== undefined) updates.assignee = assignee;
  if (screenshots !== undefined) updates.screenshots = screenshots;
  if (resolution !== undefined) updates.resolution = resolution;
  if (status !== undefined) {
    if (!STATUS_SET.has(status)) return res.status(400).json({ error: '无效的状态值' });
    updates.status = status;
    if (status === 'resolved' || status === 'closed') updates.resolved_at = now();
    else updates.resolved_at = null;
  }

  await table.update(req.params.id, updates);

  // 关键变更写入跟进时间线（处理过程可追溯）
  const operator = operatorOf(req);
  const statusChanged = status !== undefined && status !== existing.status;
  const assigneeChanged = assignee !== undefined && assignee !== existing.assignee;
  if (statusChanged || assigneeChanged || (resolution !== undefined && resolution !== existing.resolution)) {
    await addFollowup(existing.id, {
      action: statusChanged ? (status === 'resolved' ? 'resolve' : (status === 'closed' ? 'close' : 'status')) : (assigneeChanged ? 'assign' : 'comment'),
      content: (resolution !== undefined && resolution !== existing.resolution) ? resolution : '',
      status_from: existing.status || '',
      status_to: updates.status || existing.status || '',
      assignee: assignee !== undefined ? assignee : (existing.assignee || ''),
      operator
    });
  }

  res.json({ message: '反馈更新成功', data: table.findById(req.params.id) });
});

// ===== 删除反馈（同时清理跟进记录）=====
router.delete('/:id', requirePerm('feedback:delete'), async (req, res) => {
  const table = getTable('feedback');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '反馈不存在' });
  await table.delete(req.params.id);
  try {
    const fu = getTable('feedback_followups');
    await fu.deleteWhereNoSave(r => Number(r.feedback_id) === Number(req.params.id));
    await fu.saveNow();
  } catch (_) {}
  res.json({ message: '反馈删除成功' });
});

module.exports = router;
