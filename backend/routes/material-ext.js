const express = require('express');
const logger = require('../lib/logger');
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

router.post('/classification-rules', requirePerm('material:edit'), async (req, res) => {
  const { name, field, operator, value, result_category, priority, enabled, target_field } = req.body;
  if (!name || !field || !operator || !result_category) {
    return res.status(400).json({ error: '规则名称、字段、操作符和结果分类为必填项' });
  }
  const table = getTable('classification_rules');
  const result = await table.insert({
    name, field, operator, value: value || '',
    result_category, priority: priority || 999,
    enabled: enabled !== undefined ? enabled : 1,
    target_field: target_field === 'classification2' ? 'classification2' : 'classification',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '规则创建成功', data: table.findById(result.lastID) });
});

router.put('/classification-rules/:id', requirePerm('material:edit'), (req, res) => {
  const table = getTable('classification_rules');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  const fields = { updated_at: now() };
  ['name', 'field', 'operator', 'value', 'result_category', 'priority', 'enabled', 'target_field'].forEach(f => {
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

router.post('/classification-rules/auto-classify', requirePerm('material:edit'), async (req, res) => {
  const ruleTable = getTable('classification_rules');
  const matTable = getTable('materials');
  ruleTable._invalidate();
  matTable._invalidate();

  const allRules = ruleTable.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));
  // 按目标字段分组：classification(分类1 物理) / classification2(分类2 管理)
  const rules1 = allRules.filter(r => (r.target_field || 'classification') === 'classification');
  const rules2 = allRules.filter(r => r.target_field === 'classification2');
  const def1 = req.body.default_category || '';         // 分类1 兜底（空=不匹配则不改动）
  const def2 = req.body.default_category2 || '通用物料'; // 分类2 兜底
  const materials = matTable.all();
  const results = [];
  const stats1 = {}, stats2 = {};

  function matchRule(mat, rule) {
    const raw = mat[rule.field];
    const val = String(raw === undefined || raw === null ? '' : raw);
    switch (rule.operator) {
      case 'equals': return val === rule.value;
      case 'contains': return val.includes(rule.value);
      case 'containsAny': { const kws = String(rule.value || '').split(',').map(s => s.trim()).filter(Boolean); return kws.some(k => val.includes(k)); }
      case 'startsWith': return val.startsWith(rule.value);
      case 'endsWith': return val.endsWith(rule.value);
      case 'notEquals': return val !== rule.value;
      case 'gte': return raw !== undefined && raw !== null && raw !== '' && Number(val) >= Number(rule.value);
      case 'lte': return raw !== undefined && raw !== null && raw !== '' && Number(val) <= Number(rule.value);
      default: return false;
    }
  }

  materials.forEach(mat => {
    // 分类1（电子/结构/包材/附件）
    let t1 = '';
    for (const rule of rules1) { if (matchRule(mat, rule)) { t1 = rule.result_category; break; } }
    if (!t1) t1 = def1;
    // 分类2（通用/专用）
    let t2 = '';
    for (const rule of rules2) { if (matchRule(mat, rule)) { t2 = rule.result_category; break; } }
    if (!t2) t2 = def2;

    const old1 = mat.classification || '';
    const old2 = mat.classification2 || '';
    const ch1 = t1 && t1 !== old1;
    const ch2 = t2 && t2 !== old2;
    if (ch1 || ch2) {
      results.push({
        id: mat.id, material_code: mat.material_code || '',
        material_name: mat.material_name || '',
        material_type: mat.material_type || '',
        old_classification: old1, new_classification: t1,
        old_classification2: old2, new_classification2: t2
      });
      if (t1) stats1[t1] = (stats1[t1] || 0) + 1;
      if (t2) stats2[t2] = (stats2[t2] || 0) + 1;
    }
  });

  if (req.body.apply && results.length > 0) {
    const ts = now();
    // 批量更新：updateNoSave 只改内存，最后 saveNow 一次性落盘（避免逐条写整表 16MB 的 O(n²) I/O）
    results.forEach(r => {
      const upd = { updated_at: ts };
      if (r.new_classification) upd.classification = r.new_classification;
      if (r.new_classification2) upd.classification2 = r.new_classification2;
      matTable.updateNoSave(r.id, upd);
    });
    await matTable.saveNow();
    matTable._invalidate();
    let bomSynced = 0;
    try {
      const bomTable = getTable('product_bom');
      bomTable._invalidate();
      const codeMap = {};
      matTable.all().forEach(m => { if (m.material_code) codeMap[m.id] = m.material_code; });
      results.forEach(r => {
        const code = codeMap[r.id];
        if (code && r.new_classification) {
          bomTable.all().filter(b => b.code === code).forEach(b => {
            bomTable.update(b.id, { material_category: r.new_classification, updated_at: ts });
            bomSynced++;
          });
        }
      });
    } catch (e) { logger.error('同步BOM分类失败:', e.message); }

    return res.json({
      message: `已按分类标准更新${results.length}条物料分类`,
      updated: results.length, bomSynced, total: materials.length,
      by_classification: stats1, by_classification2: stats2,
      default_category: def1, default_category2: def2, data: results
    });
  }

  res.json({
    data: results, total: materials.length, change_count: results.length,
    by_classification: stats1, by_classification2: stats2,
    default_category: def1, default_category2: def2,
    message: `共${results.length}条物料分类将被调整（分类1兜底：${def1 || '不改'}；分类2兜底：${def2}）`
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
    if (mat && (mat.classification2 || '通用物料') !== '专用物料') {
      matTable.update(matId, { classification2: '专用物料', updated_at: now() });
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

// ===== 仓库分类标准：每个仓库存放品类(分类1) + 物料上限 =====
// 取物料库位文件（与 material.js 同源），用于实际存放分析
const LOCATIONS_FILE = path.join(__dirname, '..', '..', 'database', 'material_locations.json');
let _locCache = null, _locCacheMtime = 0;
function readLocations() {
  try {
    const stat = fs.statSync(LOCATIONS_FILE);
    if (_locCache && stat.mtimeMs === _locCacheMtime) return _locCache;
    const data = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));
    _locCache = data.records || [];
    _locCacheMtime = stat.mtimeMs;
    return _locCache;
  } catch (e) { return _locCache || []; }
}

// 列表
router.get('/warehouse-standards', requirePerm('material:view'), (req, res) => {
  const t = getTable('warehouse_standards');
  t._invalidate();
  res.json({ data: t.all(), total: t.all().length });
});

// 新增
router.post('/warehouse-standards', requirePerm('material:edit'), async (req, res) => {
  const { warehouse, wh_code, allowed_categories, material_limit, remarks, manager } = req.body;
  if (!warehouse) return res.status(400).json({ error: '仓库名为必填项' });
  const t = getTable('warehouse_standards');
  if (t.all().some(s => s.warehouse === warehouse)) return res.status(400).json({ error: '该仓库标准已存在，请直接编辑' });
  const r = await t.insert({
    warehouse, wh_code: wh_code || '',
    allowed_categories: Array.isArray(allowed_categories) ? allowed_categories : [],
    material_limit: Number(material_limit) || 0,
    manager: manager || '',
    remarks: remarks || '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '仓库标准已创建', data: t.findById(r.lastID) });
});

// 更新
router.put('/warehouse-standards/:id', requirePerm('material:edit'), async (req, res) => {
  const t = getTable('warehouse_standards');
  const existing = t.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '仓库标准不存在' });
  const fields = { updated_at: now() };
  ['warehouse', 'wh_code', 'allowed_categories', 'material_limit', 'manager', 'remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = f === 'material_limit' ? Number(req.body[f]) || 0 : req.body[f];
  });
  if (fields.allowed_categories && !Array.isArray(fields.allowed_categories)) fields.allowed_categories = [];
  await t.update(req.params.id, fields);
  res.json({ message: '仓库标准已更新', data: t.findById(req.params.id) });
});

// 删除
router.delete('/warehouse-standards/:id', requirePerm('material:delete'), (req, res) => {
  const t = getTable('warehouse_standards');
  if (!t.findById(req.params.id)) return res.status(404).json({ error: '仓库标准不存在' });
  t.delete(req.params.id);
  res.json({ message: '仓库标准已删除' });
});

// 分析：实际存放 vs 标准（超限/品类不匹配检测）
// 支持按物料筛选：classification(分类1) / classification2(分类2) / keyword(编码或名称)
router.get('/warehouse-standards/analysis', requirePerm('material:view'), (req, res) => {
  const stdTable = getTable('warehouse_standards');
  stdTable._invalidate();
  const standards = stdTable.all();
  const stdByWh = {}; standards.forEach(s => { stdByWh[s.warehouse] = s; });

  // 物料筛选条件
  const fCls = String(req.query.classification || '').trim();       // 分类1
  const fCls2 = String(req.query.classification2 || '').trim();     // 分类2
  const fKw = String(req.query.keyword || '').trim().toLowerCase(); // 编码/名称
  const hasFilter = !!(fCls || fCls2 || fKw);

  const matTable = getTable('materials');
  matTable._invalidate();
  // material_code → {cls, cls2, name}；同时按筛选条件决定是否计入
  const infoByCode = {};
  const selectedCodes = new Set(); // null/空 = 不过滤(全部)
  matTable.all().forEach(m => {
    if (!m.material_code) return;
    const cls = m.classification || '';
    const cls2 = m.classification2 || '通用物料';
    infoByCode[m.material_code] = { cls, cls2, name: m.material_name || '' };
    if (hasFilter) {
      if (fCls && cls !== fCls) return;
      if (fCls2 && cls2 !== fCls2) return;
      if (fKw && !String(m.material_code).toLowerCase().includes(fKw) && !String(m.material_name || '').toLowerCase().includes(fKw)) return;
      selectedCodes.add(m.material_code);
    }
  });

  const locs = readLocations();
  // 按仓库聚合：去重物料 + 品类分布（应用物料筛选）
  const agg = {};
  locs.forEach(l => {
    const wh = l.wh_name || '';
    if (!wh) return;
    const code = l.material_code || '';
    // 物料筛选：若有筛选条件，只计入匹配的物料
    if (hasFilter && code && !selectedCodes.has(code)) return;
    if (!agg[wh]) agg[wh] = { warehouse: wh, codes: new Set(), categories: {} };
    if (code) agg[wh].codes.add(code);
    const info = infoByCode[code] || {};
    const cls = info.cls || '未分类';
    agg[wh].categories[cls] = (agg[wh].categories[cls] || 0) + 1;
  });

  // 合并：所有有实际的仓库 + 所有有标准的仓库
  const whNames = new Set([...Object.keys(agg), ...Object.keys(stdByWh)]);
  const rows = [...whNames].map(wh => {
    const a = agg[wh] || { warehouse: wh, codes: new Set(), categories: {} };
    const std = stdByWh[wh];
    const actualCount = a.codes.size;
    const catDist = Object.entries(a.categories).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ category: k, count: v }));
    const allowed = (std && std.allowed_categories) || [];
    const mismatched = allowed.length ? catDist.filter(c => c.category && c.category !== '未分类' && !allowed.includes(c.category)).map(c => c.category) : [];
    const overLimit = std && std.material_limit > 0 && actualCount > std.material_limit;
    return {
      warehouse: wh,
      has_standard: !!std,
      allowed_categories: allowed,
      material_limit: std ? std.material_limit : 0,
      actual_material_count: actualCount,
      category_distribution: catDist,
      over_limit: overLimit,
      mismatched_categories: mismatched,
      remarks: std ? (std.remarks || '') : '',
      manager: std ? (std.manager || '') : ''
    };
  }).sort((a, b) => b.actual_material_count - a.actual_material_count);

  const summary = {
    warehouses: rows.length,
    with_standard: rows.filter(r => r.has_standard).length,
    over_limit: rows.filter(r => r.over_limit).length,
    category_mismatch: rows.filter(r => r.mismatched_categories.length > 0).length
  };
  res.json({ data: rows, summary, filter: { classification: fCls, classification2: fCls2, keyword: fKw, applied: hasFilter, matched_materials: hasFilter ? selectedCodes.size : null } });
});

// 单物料存放分析：输入物料代码/名称选择某物料，查看其在各仓库的存放与品类标准符合情况
// ?q=关键词   → 返回匹配的物料列表（供输入下拉，最多15条）
// ?code=物料代码 → 返回该物料的完整存放分析
router.get('/warehouse-standards/material-analysis', requirePerm('material:view'), (req, res) => {
  const matTable = getTable('materials');
  matTable._invalidate();
  const all = matTable.all();

  // 模式1：搜索（自动补全）
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) {
    const matches = all.filter(m =>
      String(m.material_code || '').toLowerCase().includes(q) ||
      String(m.material_name || '').toLowerCase().includes(q)
    ).slice(0, 15).map(m => ({
      material_code: m.material_code, material_name: m.material_name,
      classification: m.classification || '', classification2: m.classification2 || '通用物料'
    }));
    return res.json({ mode: 'search', total: matches.length, data: matches });
  }

  // 模式2：单物料分析
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: '请提供 q(搜索) 或 code(物料代码) 参数' });
  const mat = all.find(m => m.material_code === code);
  if (!mat) return res.status(404).json({ error: '物料不存在：' + code });

  const cls1 = mat.classification || '';
  // 仓库标准：warehouse → allowed_categories
  const stdTable = getTable('warehouse_standards');
  stdTable._invalidate();
  const stdByWh = {}; stdTable.all().forEach(s => { stdByWh[s.warehouse] = s; });

  // 该物料的库位记录
  const locs = readLocations().filter(l => l.material_code === code);
  let totalQty = 0;
  // 按仓库聚合
  const whAgg = {};
  locs.forEach(l => {
    const wh = l.wh_name || '';
    if (!wh) return;
    if (!whAgg[wh]) whAgg[wh] = { warehouse: wh, wh_code: l.wh_code || '', qty_on_hand: 0, locations: [] };
    whAgg[wh].qty_on_hand += Number(l.qty_on_hand) || 0;
    if (l.location_name && l.location_name !== '*') whAgg[wh].locations.push(l.location_name);
  });
  const warehouses = Object.values(whAgg).map(w => {
    const std = stdByWh[w.warehouse];
    const allowed = (std && std.allowed_categories) || [];
    // 品类符合：仓库未设标准(不限) 或 允许品类包含该物料分类1 或 物料未分类
    const compliant = !allowed.length || !cls1 || allowed.includes(cls1);
    return Object.assign(w, {
      allowed_categories: allowed,
      manager: std ? (std.manager || '') : '',
      has_standard: !!std,
      compliant,
      locations: [...new Set(w.locations)]
    });
  }).sort((a, b) => b.qty_on_hand - a.qty_on_hand);
  totalQty = warehouses.reduce((s, w) => s + w.qty_on_hand, 0);

  res.json({
    mode: 'analysis',
    material: {
      material_code: mat.material_code, material_name: mat.material_name,
      classification: cls1, classification2: mat.classification2 || '通用物料',
      material_type: mat.material_type || '', unit: mat.unit || '',
      standard_cost: Number(mat.standard_cost) || 0, inventory_qty: Number(mat.inventory_qty) || 0
    },
    total_qty: Math.round(totalQty * 1000) / 1000,
    warehouse_count: warehouses.length,
    locations: warehouses,
    summary: {
      compliant_warehouses: warehouses.filter(w => w.compliant).length,
      mismatch_warehouses: warehouses.filter(w => !w.compliant).length
    }
  });
});

module.exports = router;
