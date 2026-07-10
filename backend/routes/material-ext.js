const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'drawings');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
    cb(null, `${Date.now()}_${name}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function logDrawingAction(drawingId, action, operator, detail) {
  const logTable = getTable('drawing_audit_logs');
  logTable.insert({
    drawing_id: Number(drawingId),
    action,
    operator: operator || 'system',
    detail: detail || '',
    ip: '',
    created_at: now()
  });
}

function getUserPermissions(userId) {
  if (!userId) return { is_admin: false, perms: new Set() };
  const userTable = getTable('users');
  userTable._invalidate();
  const user = userTable.findById(Number(userId));
  if (!user) return { is_admin: false, perms: new Set() };

  if (user.role === 'admin') return { is_admin: true, perms: null };

  const urTable = getTable('user_roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');
  urTable._invalidate(); rpTable._invalidate(); permTable._invalidate(); roleTable._invalidate();

  // 角色ID集合：user_roles 关联 + 用户直接 role 字段对应角色（双保险）
  const roleIdSet = new Set(urTable.all().filter(ur => ur.user_id === Number(userId)).map(ur => ur.role_id));
  if (user.role) {
    const directRole = roleTable.all().find(r => r.code === user.role);
    if (directRole) roleIdSet.add(directRole.id);
  }
  const userRoleIds = [...roleIdSet];
  const hasAdminRole = userRoleIds.some(rid => {
    const role = roleTable.findById(rid);
    return role && role.code === 'admin';
  });
  if (hasAdminRole) return { is_admin: true, perms: null };

  const permIds = new Set();
  userRoleIds.forEach(rid => {
    rpTable.all().filter(rp => rp.role_id === rid).forEach(rp => permIds.add(rp.permission_id));
  });
  const perms = new Set();
  permIds.forEach(pid => {
    const p = permTable.findById(pid);
    if (p) perms.add(p.code);
  });
  return { is_admin: false, perms };
}

function requireDrawingPerm(code) {
  return (req, res, next) => {
    const userId = req.query.user_id || req.query.operator || req.query.uploaded_by || req.query.approved_by || req.body.user_id || req.body.uploaded_by || req.body.approved_by;
    if (!userId) {
      return res.status(401).json({ error: '未提供用户身份，无法校验权限' });
    }
    const userTable = getTable('users');
    const user = userTable.all().find(u => String(u.username) === String(userId) || u.id === Number(userId));
    const uid = user ? user.id : Number(userId);
    const { is_admin, perms } = getUserPermissions(uid);
    if (is_admin) return next();
    if (perms && perms.has(code)) return next();
    return res.status(403).json({ error: `无权限：${code}` });
  };
}

function checkDrawingPermission(req, res, next) {
  const userId = req.query.user_id || req.query.operator;
  if (!userId) return next();
  const userTable = getTable('users');
  const user = userTable.all().find(u => String(u.username) === String(userId) || u.id === Number(userId));
  const uid = user ? user.id : Number(userId);
  const { is_admin, perms } = getUserPermissions(uid);
  if (is_admin) return next();
  if (perms && perms.has('drawing:preview')) return next();
  return res.status(403).json({ error: '无图纸预览权限' });
}

router.get('/classification-rules', requirePerm('material:view'), (req, res) => {
  const table = getTable('classification_rules');
  table._invalidate();
  const rules = table.all().sort((a, b) => (a.priority || 999) - (b.priority || 999));
  res.json({ data: rules, total: rules.length });
});

router.post('/classification-rules', requirePerm('material:edit'), (req, res) => {
  const { name, field, operator, value, result_category, priority, enabled } = req.body;
  if (!name || !field || !operator || !result_category) {
    return res.status(400).json({ error: '规则名称、字段、操作符和结果分类为必填项' });
  }
  const table = getTable('classification_rules');
  const result = table.insert({
    name, field, operator, value: value || '',
    result_category, priority: priority || 999,
    enabled: enabled !== undefined ? enabled : 1,
    created_at: now(), updated_at: now()
  });
  res.json({ message: '规则创建成功', data: table.findById(result.lastID) });
});

router.put('/classification-rules/:id', requirePerm('material:edit'), (req, res) => {
  const table = getTable('classification_rules');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  const fields = { updated_at: now() };
  ['name', 'field', 'operator', 'value', 'result_category', 'priority', 'enabled'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '规则更新成功', data: table.findById(req.params.id) });
});

router.delete('/classification-rules/:id', requirePerm('material:delete'), (req, res) => {
  const table = getTable('classification_rules');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  table.delete(req.params.id);
  res.json({ message: '规则删除成功' });
});

router.post('/classification-rules/auto-classify', requirePerm('material:edit'), (req, res) => {
  const ruleTable = getTable('classification_rules');
  const matTable = getTable('materials');
  ruleTable._invalidate();
  matTable._invalidate();

  const rules = ruleTable.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));
  const defaultCategory = req.body.default_category || '专用物料';
  const materials = matTable.all();
  const results = [];
  const stats = {};

  function matchRule(mat, rule) {
    const raw = mat[rule.field];
    const val = String(raw === undefined || raw === null ? '' : raw);
    switch (rule.operator) {
      case 'equals': return val === rule.value;
      case 'contains': return val.includes(rule.value);
      case 'startsWith': return val.startsWith(rule.value);
      case 'endsWith': return val.endsWith(rule.value);
      case 'notEquals': return val !== rule.value;
      case 'gte': return raw !== undefined && raw !== null && raw !== '' && Number(val) >= Number(rule.value);
      case 'lte': return raw !== undefined && raw !== null && raw !== '' && Number(val) <= Number(rule.value);
      default: return false;
    }
  }

  materials.forEach(mat => {
    let target = '';
    for (const rule of rules) {
      if (matchRule(mat, rule)) { target = rule.result_category; break; }
    }
    if (!target) target = defaultCategory;
    stats[target] = (stats[target] || 0) + 1;

    const oldCategory = mat.classification || '通用物料';
    if (target !== oldCategory) {
      results.push({
        id: mat.id, material_code: mat.material_code || '',
        material_name: mat.material_name || '',
        material_type: mat.material_type || '',
        old_category: oldCategory, new_category: target
      });
    }
  });

  if (req.body.apply && results.length > 0) {
    const ts = now();
    results.forEach(r => {
      matTable.update(r.id, { classification: r.new_category, updated_at: ts });
    });
    let bomSynced = 0;
    try {
      const bomTable = getTable('product_bom');
      bomTable._invalidate();
      const codeMap = {};
      matTable.all().forEach(m => { if (m.material_code) codeMap[m.id] = m.material_code; });
      results.forEach(r => {
        const code = codeMap[r.id];
        if (code) {
          bomTable.all().filter(b => b.code === code).forEach(b => {
            bomTable.update(b.id, { material_category: r.new_category, updated_at: ts });
            bomSynced++;
          });
        }
      });
    } catch (e) { console.error('同步BOM分类失败:', e.message); }

    return res.json({
      message: `已按分类标准更新${results.length}条物料分类`,
      updated: results.length, bomSynced, total: materials.length,
      by_category: stats, default_category: defaultCategory, data: results
    });
  }

  res.json({
    data: results, total: materials.length, change_count: results.length,
    by_category: stats, default_category: defaultCategory,
    message: `共${results.length}条物料分类将被调整（默认兜底：${defaultCategory}）`
  });
});

router.get('/:id/product-standard', requirePerm('material:view'), (req, res) => {
  const table = getTable('material_standards');
  table._invalidate();
  const standards = table.all().filter(s => s.material_id === Number(req.params.id));
  res.json({ data: standards });
});

router.post('/:id/product-standard', requirePerm('material:edit'), (req, res) => {
  const { standard_name, standard_text, standard_type } = req.body;
  if (!standard_name) return res.status(400).json({ error: '标准名称为必填项' });
  const table = getTable('material_standards');
  const result = table.insert({
    material_id: Number(req.params.id),
    standard_name, standard_text: standard_text || '',
    standard_type: standard_type || 'text',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '标准添加成功', data: table.findById(result.lastID) });
});

router.put('/product-standard/:standardId', requirePerm('material:edit'), (req, res) => {
  const table = getTable('material_standards');
  const existing = table.findById(req.params.standardId);
  if (!existing) return res.status(404).json({ error: '标准不存在' });
  const fields = { updated_at: now() };
  ['standard_name', 'standard_text', 'standard_type'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.standardId, fields);
  res.json({ message: '标准更新成功', data: table.findById(req.params.standardId) });
});

router.delete('/product-standard/:standardId', requirePerm('material:delete'), (req, res) => {
  const table = getTable('material_standards');
  const existing = table.findById(req.params.standardId);
  if (!existing) return res.status(404).json({ error: '标准不存在' });
  table.delete(req.params.standardId);
  res.json({ message: '标准删除成功' });
});

router.get('/:id/drawings', requirePerm('drawing:preview'), (req, res) => {
  const table = getTable('material_drawings');
  table._invalidate();
  const drawings = table.all().filter(d => d.material_id === Number(req.params.id));
  drawings.sort((a, b) => (b.version || 0) - (a.version || 0));
  res.json({ data: drawings });
});

router.post('/:id/drawings', upload.single('file'), requireDrawingPerm('drawing:upload'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const table = getTable('material_drawings');
  const materialId = Number(req.params.id);
  const existing = table.all().filter(d => d.material_id === materialId);
  const version = existing.length > 0 ? Math.max(...existing.map(d => d.version || 0)) + 1 : 1;

  const drawingNo = req.body.drawing_no || '';
  const result = table.insert({
    material_id: materialId,
    file_name: req.file.originalname,
    file_path: req.file.path,
    file_size: req.file.size,
    file_type: path.extname(req.file.originalname).toLowerCase(),
    version,
    drawing_no: drawingNo,
    description: req.body.description || '',
    uploaded_by: req.body.uploaded_by || '',
    status: 'draft',
    approval_status: 'pending',
    approved_by: '',
    approved_at: '',
    created_at: now(), updated_at: now()
  });

  logDrawingAction(result.lastID, 'upload', req.body.uploaded_by || 'system', `上传图纸V${version}: ${req.file.originalname}`);
  res.json({ message: '图纸上传成功', data: table.findById(result.lastID) });
});

router.put('/drawings/:drawingId', requirePerm('drawing:edit'), (req, res) => {
  const table = getTable('material_drawings');
  const existing = table.findById(req.params.drawingId);
  if (!existing) return res.status(404).json({ error: '图纸不存在' });
  const fields = { updated_at: now() };
  ['description', 'drawing_no', 'status', 'approval_status'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.drawingId, fields);
  logDrawingAction(req.params.drawingId, 'update', req.body.operator || 'system', `更新图纸信息`);
  res.json({ message: '图纸更新成功', data: table.findById(req.params.drawingId) });
});

router.delete('/drawings/:drawingId', requireDrawingPerm('drawing:delete'), (req, res) => {
  const table = getTable('material_drawings');
  const drawing = table.findById(req.params.drawingId);
  if (!drawing) return res.status(404).json({ error: '图纸不存在' });
  logDrawingAction(req.params.drawingId, 'delete', req.query.operator || 'system', `删除图纸: ${drawing.file_name}`);
  try { if (fs.existsSync(drawing.file_path)) fs.unlinkSync(drawing.file_path); } catch(e) {}
  table.delete(req.params.drawingId);
  res.json({ message: '图纸删除成功' });
});

router.get('/drawings/:drawingId/download', requireDrawingPerm('drawing:preview'), (req, res) => {
  const table = getTable('material_drawings');
  const drawing = table.findById(req.params.drawingId);
  if (!drawing) return res.status(404).json({ error: '图纸不存在' });
  if (!fs.existsSync(drawing.file_path)) return res.status(404).json({ error: '文件不存在' });
  logDrawingAction(req.params.drawingId, 'download', req.query.operator || 'system', `下载图纸: ${drawing.file_name}`);
  res.download(drawing.file_path, drawing.file_name);
});

router.get('/drawings/:drawingId/preview', checkDrawingPermission, (req, res) => {
  const table = getTable('material_drawings');
  const drawing = table.findById(req.params.drawingId);
  if (!drawing) return res.status(404).json({ error: '图纸不存在' });
  if (!fs.existsSync(drawing.file_path)) return res.status(404).json({ error: '文件不存在' });

  const ext = drawing.file_type;
  const imageTypes = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
  const pdfType = '.pdf';

  logDrawingAction(req.params.drawingId, 'preview', req.query.operator || 'system', `预览图纸V${drawing.version}: ${drawing.file_name}`);

  if (imageTypes.includes(ext) || ext === pdfType) {
    const stat = fs.statSync(drawing.file_path);
    res.setHeader('Content-Length', stat.size);
    if (ext === pdfType) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(drawing.file_name)}"`);
    } else if (ext === '.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else {
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    }
    const fileStream = fs.createReadStream(drawing.file_path);
    fileStream.pipe(res);
  } else {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(drawing.file_name)}"`);
    const fileStream = fs.createReadStream(drawing.file_path);
    fileStream.pipe(res);
  }
});

router.get('/drawings/:drawingId/versions', requirePerm('drawing:preview'), (req, res) => {
  const table = getTable('material_drawings');
  table._invalidate();
  const drawing = table.findById(req.params.drawingId);
  if (!drawing) return res.status(404).json({ error: '图纸不存在' });
  const versions = table.all().filter(d => d.material_id === drawing.material_id).sort((a, b) => (a.version || 0) - (b.version || 0));
  res.json({ data: versions, current_id: Number(req.params.drawingId) });
});

router.post('/drawings/:drawingId/approve', requireDrawingPerm('drawing:approve'), (req, res) => {
  const table = getTable('material_drawings');
  const drawing = table.findById(req.params.drawingId);
  if (!drawing) return res.status(404).json({ error: '图纸不存在' });
  const { approved_by, action } = req.body;
  if (!approved_by) return res.status(400).json({ error: '审批人为必填项' });

  let approvalStatus, status;
  if (action === 'approve') {
    approvalStatus = 'approved';
    status = 'active';
  } else if (action === 'reject') {
    approvalStatus = 'rejected';
    status = 'draft';
  } else {
    return res.status(400).json({ error: '无效的审批操作' });
  }

  table.update(req.params.drawingId, {
    approval_status: approvalStatus,
    approved_by: approved_by,
    approved_at: now(),
    status,
    updated_at: now()
  });

  logDrawingAction(req.params.drawingId, action === 'approve' ? 'approve' : 'reject', approved_by,
    `${action === 'approve' ? '审批通过' : '审批驳回'}图纸V${drawing.version}`);

  res.json({ message: action === 'approve' ? '图纸审批通过' : '图纸审批驳回', data: table.findById(req.params.drawingId) });
});

router.get('/drawings/:drawingId/audit-logs', requirePerm('drawing:preview'), (req, res) => {
  const logTable = getTable('drawing_audit_logs');
  logTable._invalidate();
  const logs = logTable.all().filter(l => l.drawing_id === Number(req.params.drawingId));
  logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ data: logs, total: logs.length });
});

router.get('/audit-logs/recent', requirePerm('drawing:preview'), (req, res) => {
  const logTable = getTable('drawing_audit_logs');
  logTable._invalidate();
  const { limit = 50, action, operator } = req.query;
  let logs = logTable.all();
  if (action) logs = logs.filter(l => l.action === action);
  if (operator) logs = logs.filter(l => l.operator === operator);
  logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ data: logs.slice(0, parseInt(limit)), total: logs.length });
});

router.get('/drawings-stats/overview', requirePerm('drawing:preview'), (req, res) => {
  const table = getTable('material_drawings');
  table._invalidate();
  const drawings = table.all();

  const byType = {};
  const byStatus = {};
  const byApproval = {};
  let totalSize = 0;

  drawings.forEach(d => {
    byType[d.file_type || 'other'] = (byType[d.file_type || 'other'] || 0) + 1;
    byStatus[d.status || 'draft'] = (byStatus[d.status || 'draft'] || 0) + 1;
    byApproval[d.approval_status || 'pending'] = (byApproval[d.approval_status || 'pending'] || 0) + 1;
    totalSize += d.file_size || 0;
  });

  res.json({
    total: drawings.length,
    byType, byStatus, byApproval,
    totalSize,
    totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
    pendingApproval: byApproval['pending'] || 0
  });
});

router.post('/drawings-type-materials/classify', requirePerm('material:edit'), (req, res) => {
  const matTable = getTable('materials');
  const drawTable = getTable('material_drawings');
  matTable._invalidate();
  drawTable._invalidate();

  const materialsWithDrawings = new Set();
  drawTable.all().forEach(d => materialsWithDrawings.add(d.material_id));

  let updated = 0;
  materialsWithDrawings.forEach(matId => {
    const mat = matTable.findById(matId);
    if (mat && mat.classification !== '专用物料') {
      matTable.update(matId, { classification: '专用物料', updated_at: now() });
      updated++;
    }
  });

  res.json({
    message: `已将${updated}条图纸类物料标记为专用物料`,
    total_drawing_materials: materialsWithDrawings.size,
    updated,
    material_ids: [...materialsWithDrawings]
  });
});

module.exports = router;
